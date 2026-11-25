// Comptes Roblox connectes par un utilisateur : stockage chiffre des jetons, rafraichissement, controle d'acces aux groupes.
import { decryptSecret, encryptSecret, randomToken, sha256 } from './crypto.ts'
import type { Db } from './db.ts'
import { newPkce, RobloxError, type RobloxClient, type RobloxProfile, type RobloxTokens } from './roblox.ts'

export interface RobloxAccount {
  id: number
  user_id: number
  roblox_user_id: string
  username: string
  display_name: string | null
  scopes: string
  status: 'ok' | 'needs_reauth'
  created_at: number
}

const now = () => Date.now()
// Colonnes publiques : les jetons n'en font volontairement pas partie.
const PUBLIC = 'id, user_id, roblox_user_id, username, display_name, scopes, status, created_at'

// --- lecture ------------------------------------------------------------------------------------------------------------------
export const listAccounts = (db: Db, userId: number) =>
  db.prepare(`SELECT ${PUBLIC} FROM roblox_accounts WHERE user_id = ? ORDER BY created_at, id`).all(userId) as unknown as RobloxAccount[]

export const getAccount = (db: Db, userId: number, id: number) =>
  db.prepare(`SELECT ${PUBLIC} FROM roblox_accounts WHERE id = ? AND user_id = ?`).get(id, userId) as unknown as RobloxAccount | undefined

export const projectsUsingAccount = (db: Db, accountId: number) =>
  (db.prepare('SELECT name FROM projects WHERE roblox_account_id = ? ORDER BY name').all(accountId) as unknown as { name: string }[]).map((r) => r.name)

// --- connexion / deconnexion ----------------------------------------------------------------------------------------------------
// Enregistre (ou met a jour : meme compte Roblox, meme utilisateur) ; l'identifiant interne est conserve, donc les projets restent lies.
export function saveAccount(db: Db, userId: number, profile: RobloxProfile, tokens: RobloxTokens): number {
  db.prepare(
    `INSERT INTO roblox_accounts (user_id, roblox_user_id, username, display_name, refresh_token_enc, access_token_enc, access_expires_at, scopes, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ok', ?)
     ON CONFLICT(user_id, roblox_user_id) DO UPDATE SET
       username = excluded.username, display_name = excluded.display_name, refresh_token_enc = excluded.refresh_token_enc,
       access_token_enc = excluded.access_token_enc, access_expires_at = excluded.access_expires_at, scopes = excluded.scopes, status = 'ok'`,
  ).run(
    userId, profile.sub, profile.username, profile.displayName, encryptSecret(tokens.refreshToken), encryptSecret(tokens.accessToken),
    now() + tokens.expiresIn * 1000, tokens.scope, now(),
  )
  const row = db.prepare('SELECT id FROM roblox_accounts WHERE user_id = ? AND roblox_user_id = ?').get(userId, profile.sub) as { id: number }
  groupCache.delete(row.id)
  return row.id
}

export function getRefreshToken(db: Db, userId: number, id: number): string | null {
  const r = db.prepare('SELECT refresh_token_enc FROM roblox_accounts WHERE id = ? AND user_id = ?').get(id, userId) as { refresh_token_enc: string } | undefined
  return r ? decryptSecret(r.refresh_token_enc) : null
}

export function deleteAccount(db: Db, userId: number, id: number): boolean {
  groupCache.delete(id)
  return Number(db.prepare('DELETE FROM roblox_accounts WHERE id = ? AND user_id = ?').run(id, userId).changes) > 0
}

// --- etat OAuth (anti-CSRF + PKCE) --------------------------------------------------------------------------------------------------
const STATE_TTL_MS = 10 * 60_000
const MAX_PENDING_STATES = 5

export function beginAuthorization(db: Db, client: RobloxClient, userId: number, sessionId: string): string {
  db.prepare('DELETE FROM oauth_states WHERE expires_at <= ?').run(now())
  const pending = (db.prepare('SELECT COUNT(*) AS n FROM oauth_states WHERE user_id = ?').get(userId) as { n: number }).n
  if (pending >= MAX_PENDING_STATES) {
    db.prepare('DELETE FROM oauth_states WHERE state_hash IN (SELECT state_hash FROM oauth_states WHERE user_id = ? ORDER BY expires_at LIMIT 1)').run(userId)
  }
  const state = randomToken(24)
  const { verifier, challenge } = newPkce()
  db.prepare('INSERT INTO oauth_states (state_hash, user_id, session_id, code_verifier_enc, expires_at) VALUES (?, ?, ?, ?, ?)')
    .run(sha256(state), userId, sessionId, encryptSecret(verifier), now() + STATE_TTL_MS)
  return client.authorizeUrl(state, challenge)
}

// Usage unique : l'etat est supprime des qu'il est lu. Il doit venir du meme utilisateur ET de la meme session.
export function consumeAuthorization(db: Db, state: string, userId: number, sessionId: string): string | null {
  const h = sha256(state)
  const row = db.prepare('SELECT user_id, session_id, code_verifier_enc, expires_at FROM oauth_states WHERE state_hash = ?').get(h) as
    { user_id: number; session_id: string; code_verifier_enc: string; expires_at: number } | undefined
  db.prepare('DELETE FROM oauth_states WHERE state_hash = ?').run(h)
  if (!row || row.expires_at <= now() || row.user_id !== userId || row.session_id !== sessionId) return null
  return decryptSecret(row.code_verifier_enc)
}

// --- jeton d'acces (rafraichi a la demande) --------------------------------------------------------------------------------------------
// Le jeton de rafraichissement de Roblox est a usage unique : deux rafraichissements simultanes en invalideraient un.
// Les appels concurrents pour un meme compte partagent donc la meme operation.
const inflight = new Map<number, Promise<string>>()

export function getAccessToken(db: Db, client: RobloxClient, accountId: number): Promise<string> {
  const running = inflight.get(accountId)
  if (running) return running
  const p = (async () => {
    const row = db.prepare('SELECT user_id, status, refresh_token_enc, access_token_enc, access_expires_at FROM roblox_accounts WHERE id = ?').get(accountId) as
      { user_id: number; status: string; refresh_token_enc: string; access_token_enc: string | null; access_expires_at: number } | undefined
    if (!row) throw new RobloxError('Compte Roblox introuvable.', 404)
    if (row.status !== 'ok') throw new RobloxError('Ce compte Roblox doit etre reconnecte.', 401, 'needs_reauth')
    if (row.access_token_enc && row.access_expires_at > now() + 60_000) return decryptSecret(row.access_token_enc)
    let tokens: RobloxTokens
    try {
      tokens = await client.refresh(decryptSecret(row.refresh_token_enc))
    } catch (e) {
      // refresh refuse (revoque, expire apres 90 jours, deja utilise) : le compte doit etre reconnecte
      if (e instanceof RobloxError && (e.code === 'invalid_grant' || e.status === 400 || e.status === 401)) {
        db.prepare(`UPDATE roblox_accounts SET status = 'needs_reauth', access_token_enc = NULL WHERE id = ?`).run(accountId)
        throw new RobloxError('Ce compte Roblox doit etre reconnecte (autorisation expiree ou revoquee).', 401, 'needs_reauth')
      }
      throw e
    }
    db.prepare('UPDATE roblox_accounts SET refresh_token_enc = ?, access_token_enc = ?, access_expires_at = ?, scopes = COALESCE(NULLIF(?, \'\'), scopes) WHERE id = ?')
      .run(encryptSecret(tokens.refreshToken), encryptSecret(tokens.accessToken), now() + tokens.expiresIn * 1000, tokens.scope, accountId)
    return tokens.accessToken
  })()
  inflight.set(accountId, p)
  const done = () => { inflight.delete(accountId) }
  p.then(done, done)
  return p
}

// --- groupes -----------------------------------------------------------------------------------------------------------------------
export interface AuthorizedGroup { id: string; name: string | null }
const GROUP_CACHE_MS = 5 * 60_000
const groupCache = new Map<number, { at: number; groups: AuthorizedGroup[] }>()

// Groupes que le compte a autorises pour l'application (avec leur nom quand Roblox le donne).
export async function listAuthorizedGroups(db: Db, client: RobloxClient, accountId: number, opts: { fresh?: boolean } = {}): Promise<AuthorizedGroup[]> {
  const cached = groupCache.get(accountId)
  if (!opts.fresh && cached && now() - cached.at < GROUP_CACHE_MS) return cached.groups
  const token = await getAccessToken(db, client, accountId)
  const { groupIds } = await client.getResources(token)
  const groups = await Promise.all(groupIds.map(async (id) => ({ id, name: await client.getGroupName(token, id) })))
  groupCache.set(accountId, { at: now(), groups })
  return groups
}

export type GroupCheck = { ok: true; name: string | null } | { ok: false; error: string; status: 400 | 502 }

// Le groupe doit etre accessible via le jeton de ce compte Roblox (autorise lors de la connexion).
export async function checkGroupAccess(db: Db, client: RobloxClient, account: Pick<RobloxAccount, 'id' | 'username'>, groupId: number): Promise<GroupCheck> {
  try {
    // verification « fraiche » : on ne se fie pas au cache pour valider un choix
    const groups = await listAuthorizedGroups(db, client, account.id, { fresh: true })
    const found = groups.find((g) => g.id === String(groupId))
    if (!found) {
      return {
        ok: false, status: 400,
        error: `Le compte Roblox « ${account.username} » n'a pas acces au groupe ${groupId}. Reconnecte ce compte (page Compte) en autorisant ce groupe, ou choisis un autre compte.`,
      }
    }
    return { ok: true, name: found.name }
  } catch (e) {
    if (e instanceof RobloxError && e.code === 'needs_reauth') return { ok: false, status: 400, error: `${e.message} (page Compte).` }
    return { ok: false, status: 502, error: `Impossible de verifier l'acces au groupe : ${e instanceof RobloxError ? e.message : 'Roblox ne repond pas'}.` }
  }
}
