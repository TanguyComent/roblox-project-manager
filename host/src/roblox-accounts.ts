// Comptes Roblox d'un utilisateur : chacun = une cle d'API Open Cloud (chiffree en base), verifiee aupres de Roblox.
// Une cle accede a tout ce que son proprietaire peut faire, y compris les experiences creees plus tard (si elle n'est pas restreinte par experience).
import { decryptSecret, encryptSecret, sha256 } from './crypto.ts'
import type { Db } from './db.ts'
import { RobloxError, type KeyInfo, type KeyScope, type RobloxClient } from './roblox.ts'

export interface RobloxAccount {
  id: number
  user_id: number
  label: string
  key_name: string | null
  roblox_user_id: string
  username: string | null
  scopes: KeyScope[]
  expires_at: number | null
  status: 'ok' | 'invalid'
  status_detail: string | null
  checked_at: number
  created_at: number
}

const now = () => Date.now()
// Colonnes publiques : la cle n'en fait volontairement pas partie.
const PUBLIC = 'id, user_id, label, key_name, roblox_user_id, username, scopes_json, expires_at, status, status_detail, checked_at, created_at'

type Row = Omit<RobloxAccount, 'scopes'> & { scopes_json: string }
const toAccount = (r: Row): RobloxAccount => {
  const { scopes_json, ...rest } = r
  let scopes: KeyScope[] = []
  try { scopes = JSON.parse(scopes_json) as KeyScope[] } catch { /* illisible : aucune permission connue */ }
  return { ...rest, scopes }
}

// --- lecture ------------------------------------------------------------------------------------------------------------------
export const listAccounts = (db: Db, userId: number) =>
  (db.prepare(`SELECT ${PUBLIC} FROM roblox_accounts WHERE user_id = ? ORDER BY created_at, id`).all(userId) as unknown as Row[]).map(toAccount)

export const getAccount = (db: Db, userId: number, id: number) => {
  const r = db.prepare(`SELECT ${PUBLIC} FROM roblox_accounts WHERE id = ? AND user_id = ?`).get(id, userId) as unknown as Row | undefined
  return r ? toAccount(r) : undefined
}

export const projectsUsingAccount = (db: Db, accountId: number) =>
  (db.prepare('SELECT name FROM projects WHERE roblox_account_id = ? ORDER BY name').all(accountId) as unknown as { name: string }[]).map((r) => r.name)

// La cle en clair : usage interne uniquement (appels vers Roblox), jamais dans une vue.
function getApiKey(db: Db, accountId: number): string {
  const r = db.prepare('SELECT api_key_enc FROM roblox_accounts WHERE id = ?').get(accountId) as { api_key_enc: string } | undefined
  if (!r) throw new RobloxError('Compte Roblox introuvable.', 404)
  return decryptSecret(r.api_key_enc)
}

// Cle utilisable : un compte dont Roblox ne reconnait plus la cle ne doit pas servir a verifier quoi que ce soit.
function usableKey(db: Db, account: Pick<RobloxAccount, 'id' | 'status'>): string {
  if (account.status !== 'ok') throw new RobloxError("La cle de ce compte Roblox n'est plus valide : mets-la a jour (page Compte).", 401)
  return getApiKey(db, account.id)
}

// --- permissions ---------------------------------------------------------------------------------------------------------------------
export const scopeLabels = (scopes: KeyScope[]) => [...new Set(scopes.flatMap((s) => s.operations.length ? s.operations.map((o) => `${s.name}:${o}`) : [s.name]))].sort()
export const canPublish = (scopes: KeyScope[]) => scopes.some((s) => /universe-places/.test(s.name) && s.operations.includes('write'))
export const EXPIRY_WARNING_MS = 14 * 24 * 3600_000

// --- connexion / mise a jour / verification ---------------------------------------------------------------------------------------------
export type Result<T> = { ok: true; value: T } | { ok: false; error: string; status: 400 | 502 }

const keyProblem = (info: KeyInfo): string | null =>
  !info.enabled ? 'Cette cle est desactivee sur Roblox : active-la dans le Creator Dashboard.'
  : info.expired ? 'Cette cle est expiree : genere-en une nouvelle dans le Creator Dashboard.'
  : null

const expiryOf = (info: KeyInfo) => (info.expirationTimeUtc ? Date.parse(info.expirationTimeUtc) || null : null)

async function introspect(client: RobloxClient, apiKey: string): Promise<Result<KeyInfo>> {
  try {
    const info = await client.introspectKey(apiKey)
    const problem = keyProblem(info)
    return problem ? { ok: false, error: problem, status: 400 } : { ok: true, value: info }
  } catch (e) {
    if (e instanceof RobloxError && (e.status === 400 || e.status === 401 || e.status === 403 || e.status === 404)) {
      return { ok: false, status: 400, error: "Roblox ne reconnait pas cette cle : verifie que tu as copie la cle en entier (elle ne s'affiche qu'a sa creation)." }
    }
    return { ok: false, status: 502, error: `Impossible de verifier la cle aupres de Roblox (${e instanceof RobloxError ? e.message : 'Roblox ne repond pas'}).` }
  }
}

const cleanKey = (raw: string) => raw.trim()
const keyShapeProblem = (k: string) => (k.length < 20 || k.length > 4000 || /\s/.test(k) ? 'Colle la cle d\'API en entier, sans espace.' : null)

export async function connectAccount(db: Db, client: RobloxClient, userId: number, label: string, rawKey: string): Promise<Result<RobloxAccount>> {
  const apiKey = cleanKey(rawKey)
  const shape = keyShapeProblem(apiKey)
  if (shape) return { ok: false, error: shape, status: 400 }
  if (label.length > 60) return { ok: false, error: 'Le nom est trop long (60 caracteres maximum).', status: 400 }
  const hash = sha256(apiKey)
  if (db.prepare('SELECT 1 FROM roblox_accounts WHERE user_id = ? AND key_hash = ?').get(userId, hash)) {
    return { ok: false, error: 'Cette cle est deja connectee.', status: 400 }
  }
  const r = await introspect(client, apiKey)
  if (!r.ok) return r
  const info = r.value
  const username = await client.getUsername(info.authorizedUserId)
  const name = label.trim() || info.name || username || `Compte ${info.authorizedUserId}`
  const res = db.prepare(
    `INSERT INTO roblox_accounts (user_id, label, api_key_enc, key_hash, key_name, roblox_user_id, username, scopes_json, expires_at, status, checked_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ok', ?, ?)`,
  ).run(userId, name.slice(0, 60), encryptSecret(apiKey), hash, info.name || null, info.authorizedUserId, username, JSON.stringify(info.scopes), expiryOf(info), now(), now())
  return { ok: true, value: getAccount(db, userId, Number(res.lastInsertRowid))! }
}

// Remplace la cle d'un compte (renouvellement, regeneration, nouvelles permissions) : ce doit etre le meme compte Roblox.
export async function replaceKey(db: Db, client: RobloxClient, userId: number, accountId: number, rawKey: string): Promise<Result<RobloxAccount>> {
  const account = getAccount(db, userId, accountId)
  if (!account) return { ok: false, error: 'Compte Roblox introuvable.', status: 400 }
  const apiKey = cleanKey(rawKey)
  const shape = keyShapeProblem(apiKey)
  if (shape) return { ok: false, error: shape, status: 400 }
  const r = await introspect(client, apiKey)
  if (!r.ok) return r
  if (r.value.authorizedUserId !== account.roblox_user_id) {
    return { ok: false, status: 400, error: `Cette cle appartient a un autre compte Roblox (${r.value.authorizedUserId}) que « ${account.label} » (${account.roblox_user_id}). Connecte-la comme un nouveau compte.` }
  }
  const hash = sha256(apiKey)
  const clash = db.prepare('SELECT id FROM roblox_accounts WHERE user_id = ? AND key_hash = ? AND id != ?').get(userId, hash, accountId)
  if (clash) return { ok: false, error: 'Cette cle est deja connectee sur un autre compte.', status: 400 }
  db.prepare(
    `UPDATE roblox_accounts SET api_key_enc = ?, key_hash = ?, key_name = ?, scopes_json = ?, expires_at = ?, status = 'ok', status_detail = NULL, checked_at = ? WHERE id = ? AND user_id = ?`,
  ).run(encryptSecret(apiKey), hash, r.value.name || null, JSON.stringify(r.value.scopes), expiryOf(r.value), now(), accountId, userId)
  caches.clear(accountId)
  return { ok: true, value: getAccount(db, userId, accountId)! }
}

// Relit les informations de la cle chez Roblox (permissions, expiration, validite).
export async function verifyAccount(db: Db, client: RobloxClient, userId: number, accountId: number): Promise<Result<RobloxAccount>> {
  const account = getAccount(db, userId, accountId)
  if (!account) return { ok: false, error: 'Compte Roblox introuvable.', status: 400 }
  const apiKey = getApiKey(db, accountId)
  const r = await introspect(client, apiKey)
  if (!r.ok) {
    if (r.status === 400) { // Roblox refuse ou la cle est desactivee / expiree : le compte n'est plus utilisable
      db.prepare(`UPDATE roblox_accounts SET status = 'invalid', status_detail = ?, checked_at = ? WHERE id = ?`).run(r.error, now(), accountId)
      caches.clear(accountId)
      return { ok: true, value: getAccount(db, userId, accountId)! }
    }
    return r // panne reseau : on ne change rien
  }
  db.prepare(`UPDATE roblox_accounts SET scopes_json = ?, expires_at = ?, key_name = ?, status = 'ok', status_detail = NULL, checked_at = ? WHERE id = ?`)
    .run(JSON.stringify(r.value.scopes), expiryOf(r.value), r.value.name || null, now(), accountId)
  return { ok: true, value: getAccount(db, userId, accountId)! }
}

export function deleteAccount(db: Db, userId: number, id: number): boolean {
  caches.clear(id)
  return Number(db.prepare('DELETE FROM roblox_accounts WHERE id = ? AND user_id = ?').run(id, userId).changes) > 0
}

// --- groupes -----------------------------------------------------------------------------------------------------------------------
/**
 * Un groupe dont le proprietaire de la cle est membre. `canManage` : son role lui permet de gerer les experiences du groupe
 * (`manageGroupUniverses`) ; `null` = impossible a savoir (la cle n'a pas la permission group:read, donc les permissions du role sont masquees).
 */
export interface AuthorizedGroup { id: string; name: string | null; role: string | null; canManage: boolean | null }
const CACHE_MS = 5 * 60_000
const MAX_GROUPS = 10
const MAX_GROUPS_CHECKED = 60 // groupes dont on lit les roles (un compte peut avoir rejoint des dizaines de groupes)
const caches = {
  groups: new Map<number, { at: number; value: AuthorizedGroup[] }>(),
  places: new Map<number, { at: number; value: KnownPlace[] }>(),
  clear(id: number) { this.groups.delete(id); this.places.delete(id) },
}

// Vide tous les caches (les tests recreent des bases dont les numeros de compte repartent de 1).
export function resetRobloxCaches() { caches.groups.clear(); caches.places.clear() }

/** Groupes ou l'on peut travailler : ceux ou le role permet de gerer les experiences, et ceux dont on ne peut pas savoir (benefice du doute). */
export const manageableGroups = (groups: AuthorizedGroup[]) => groups.filter((g) => g.canManage !== false)

// Groupes dont le proprietaire de la cle est membre, avec leur nom, son role et son droit de gerer les experiences.
// Leve RobloxError si la cle ne permet pas de lire les appartenances.
export async function listAuthorizedGroups(db: Db, client: RobloxClient, account: RobloxAccount, opts: { fresh?: boolean } = {}): Promise<AuthorizedGroup[]> {
  const cached = caches.groups.get(account.id)
  if (!opts.fresh && cached && now() - cached.at < CACHE_MS) return cached.value
  const key = usableKey(db, account)
  const memberships = await client.listMemberships(key, account.roblox_user_id)
  const byGroup = new Map<string, Set<string>>()
  for (const m of memberships) {
    const roles = byGroup.get(m.groupId) ?? new Set<string>()
    for (const r of m.roleIds) roles.add(r)
    byGroup.set(m.groupId, roles)
  }

  const describe = async ([id, roleIds]: [string, Set<string>], index: number): Promise<AuthorizedGroup> => {
    const g = await client.getGroup(key, id)
    const group: AuthorizedGroup = { id, name: g.kind === 'found' ? g.value.name : null, role: null, canManage: null }
    if (index >= MAX_GROUPS_CHECKED) return group
    const roles = await Promise.all([...roleIds].map((r) => client.getRole(key, id, r)))
    const found = roles.flatMap((r) => (r.kind === 'found' ? [r.value] : []))
    const top = [...found].sort((x, y) => (y.rank ?? -1) - (x.rank ?? -1))[0]
    group.role = top?.name ?? null
    const readable = found.filter((r) => r.permissions !== null)
    // plusieurs roles : il suffit qu'un seul donne le droit
    if (readable.length) group.canManage = readable.some((r) => r.permissions!.manageGroupUniverses === true)
    return group
  }
  const groups: AuthorizedGroup[] = []
  const entries = [...byGroup]
  for (let i = 0; i < entries.length; i += 8) { // par paquets : un compte dans 80 groupes ne doit pas declencher 160 requetes d'un coup
    groups.push(...await Promise.all(entries.slice(i, i + 8).map((e, j) => describe(e, i + j))))
  }
  groups.sort((x, y) => Number(y.canManage === true) - Number(x.canManage === true) || (x.name ?? '~').localeCompare(y.name ?? '~'))
  caches.groups.set(account.id, { at: now(), value: groups })
  return groups
}

export type GroupCheck = { ok: true; name: string | null; verified: boolean } | { ok: false; error: string; status: 400 | 502 }

// Le groupe doit etre accessible avec la cle de ce compte : son proprietaire en est membre ET son role permet de gerer les experiences du groupe.
// Si la cle n'a pas le droit de lire ces informations, on ne peut pas trancher : le groupe est accepte « non verifie ».
export async function checkGroupAccess(db: Db, client: RobloxClient, account: RobloxAccount, groupId: number): Promise<GroupCheck> {
  let key: string
  try { key = usableKey(db, account) } catch (e) { return { ok: false, status: 400, error: (e as Error).message } }
  const group = await client.getGroup(key, String(groupId))
  if (group.kind === 'missing') return { ok: false, status: 400, error: `Le groupe ${groupId} n'existe pas.` }
  const name = group.kind === 'found' ? group.value.name : null
  const label = name ? ` (« ${name} »)` : ''
  try {
    const groups = await listAuthorizedGroups(db, client, account, { fresh: true })
    const found = groups.find((g) => g.id === String(groupId))
    if (!found) {
      return { ok: false, status: 400, error: `Le compte Roblox « ${account.label} » n'est pas membre du groupe ${groupId}${label} : sa cle ne peut donc pas y acceder. Ajoute ce compte au groupe, ou choisis un autre compte.` }
    }
    if (found.canManage === false) {
      return { ok: false, status: 400, error: `Le compte Roblox « ${account.label} » est membre du groupe ${groupId}${label} mais son role${found.role ? ` « ${found.role} »` : ''} ne permet pas de gerer les experiences du groupe. Choisis un compte qui en a le droit.` }
    }
    return { ok: true, name, verified: found.canManage === true }
  } catch (e) {
    if (e instanceof RobloxError && (e.status === 401 || e.status === 403)) return { ok: true, name, verified: false }
    return { ok: false, status: 502, error: `Impossible de verifier l'acces au groupe : ${e instanceof RobloxError ? e.message : 'Roblox ne repond pas'}.` }
  }
}

// --- places --------------------------------------------------------------------------------------------------------------------------
export interface KnownPlace { universeId: string; universeName: string; placeId: string; placeName: string; isRoot: boolean }

// Places que le site connait pour ce compte : les experiences nommees par la cle (restriction par experience), les experiences PUBLIQUES de
// son proprietaire et de ses groupes. Les experiences privees ne sont pas listables par l'API : il reste la saisie des identifiants (verifies).
export async function listKnownPlaces(db: Db, client: RobloxClient, account: RobloxAccount, opts: { fresh?: boolean } = {}): Promise<KnownPlace[]> {
  const cached = caches.places.get(account.id)
  if (!opts.fresh && cached && now() - cached.at < CACHE_MS) return cached.value
  const key = usableKey(db, account)

  const universes = new Map<string, { name: string; rootPlaceId: string | null }>()
  const add = (id: string, name: string, root: string | null) => { if (universes.size < 40 && !universes.has(id)) universes.set(id, { name, rootPlaceId: root }) }

  const explicit = [...new Set(account.scopes.flatMap((s) => s.universeIds).filter((id) => /^\d+$/.test(id)))]
  await Promise.all(explicit.slice(0, 20).map(async (id) => {
    const u = await client.getUniverse(key, id)
    if (u.kind === 'found') add(id, u.value.name, u.value.rootPlaceId)
  }))
  for (const g of await client.listPublicGames('User', account.roblox_user_id)) add(g.universeId, g.name, g.rootPlaceId)
  const groups = await listAuthorizedGroups(db, client, account, { fresh: opts.fresh }).catch(() => [] as AuthorizedGroup[])
  for (const grp of manageableGroups(groups).slice(0, MAX_GROUPS)) for (const g of await client.listPublicGames('Group', grp.id)) add(g.universeId, g.name, g.rootPlaceId)

  const places: KnownPlace[] = []
  await Promise.all([...universes].map(async ([universeId, u]) => {
    const list = await client.listUniversePlaces(universeId)
    if (u.rootPlaceId && !list.some((p) => p.placeId === u.rootPlaceId)) list.unshift({ placeId: u.rootPlaceId, name: u.name })
    for (const p of list) places.push({ universeId, universeName: u.name, placeId: p.placeId, placeName: p.name, isRoot: p.placeId === u.rootPlaceId })
  }))
  places.sort((a, b) => a.universeName.localeCompare(b.universeName) || Number(b.isRoot) - Number(a.isRoot) || a.placeName.localeCompare(b.placeName))
  caches.places.set(account.id, { at: now(), value: places })
  return places
}

export type PlaceCheck = { ok: true; verified: boolean } | { ok: false; error: string; status: 400 | 502 }

// Verifie une place aupres de Roblox avec la cle du compte : l'experience existe-t-elle, la place en fait-elle partie ?
// « Introuvable » est refuse ; « impossible a savoir » (la cle n'a pas la permission de lecture, panne) est accepte comme non verifie.
export async function verifyPlace(db: Db, client: RobloxClient, account: RobloxAccount, universeId: number, placeId: number): Promise<PlaceCheck> {
  let key: string
  try { key = usableKey(db, account) } catch (e) { return { ok: false, status: 400, error: (e as Error).message } }
  const u = await client.getUniverse(key, String(universeId))
  if (u.kind === 'missing') return { ok: false, status: 400, error: `L'experience ${universeId} est introuvable (ou inaccessible avec la cle de « ${account.label} »).` }
  if (u.kind === 'unknown') return { ok: true, verified: false }
  const p = await client.getPlace(key, String(universeId), String(placeId))
  if (p.kind === 'missing') return { ok: false, status: 400, error: `La place ${placeId} n'appartient pas a l'experience ${universeId} (« ${u.value.name} »).` }
  return { ok: true, verified: true }
}
