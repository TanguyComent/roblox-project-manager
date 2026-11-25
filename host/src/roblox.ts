// Client OAuth 2.0 / Open Cloud de Roblox (code d'autorisation + PKCE, application « confidentielle »).
// Documentation : https://create.roblox.com/docs/cloud/auth/oauth2-reference
import { createHash, randomBytes } from 'node:crypto'
import { config } from './config.ts'

const BASE = 'https://apis.roblox.com'

export interface RobloxTokens { accessToken: string; refreshToken: string; expiresIn: number; scope: string }
export interface RobloxProfile { sub: string; username: string; displayName: string | null }
export interface AuthorizedResources { groupIds: string[]; universeIds: string[] }

export class RobloxError extends Error {
  status: number
  /** Code d'erreur OAuth (ex. « invalid_grant ») quand Roblox en fournit un. */
  code?: string
  constructor(message: string, status: number, code?: string) { super(message); this.status = status; this.code = code }
}

export interface RobloxClient {
  /** false tant que ROBLOX_CLIENT_ID / ROBLOX_CLIENT_SECRET ne sont pas configures. */
  enabled: boolean
  redirectUri: string
  scopes: string
  authorizeUrl(state: string, codeChallenge: string): string
  exchangeCode(code: string, codeVerifier: string): Promise<RobloxTokens>
  refresh(refreshToken: string): Promise<RobloxTokens>
  getProfile(accessToken: string): Promise<RobloxProfile>
  /** Ressources (groupes, univers) que l'utilisateur a autorisees pour ce jeton. */
  getResources(accessToken: string): Promise<AuthorizedResources>
  getGroupName(accessToken: string, groupId: string): Promise<string | null>
  /** Teste les identifiants de l'application aupres de Roblox (sans autorisation d'utilisateur). */
  checkCredentials(): Promise<'valid' | 'rejected' | 'unknown'>
  revoke(refreshToken: string): Promise<void>
}

// --- PKCE ---------------------------------------------------------------------------------------------------------------------
const b64url = (b: Buffer) => b.toString('base64url')
export function newPkce() {
  const verifier = b64url(randomBytes(32)) // 43 caracteres, alphabet autorise
  return { verifier, challenge: b64url(createHash('sha256').update(verifier).digest()) }
}

export interface RobloxCredentials { clientId?: string; clientSecret?: string; scopes?: string }

interface Options extends RobloxCredentials {
  /** Lu a CHAQUE appel : les identifiants peuvent donc changer (page Reglages) sans redemarrer le Host. */
  credentials?: () => RobloxCredentials
  redirectUri?: string
  fetchImpl?: typeof fetch
}

export function createRobloxClient(opts: Options = {}): RobloxClient {
  const cred = () => {
    const c = opts.credentials?.() ?? {}
    return {
      clientId: c.clientId ?? opts.clientId ?? config.robloxClientId,
      clientSecret: c.clientSecret ?? opts.clientSecret ?? config.robloxClientSecret,
      scopes: c.scopes ?? opts.scopes ?? config.robloxScopes,
    }
  }
  const redirectUri = opts.redirectUri ?? `${config.publicUrl}/account/roblox/callback`
  const doFetch = opts.fetchImpl ?? fetch

  const form = async <T>(path: string, params: Record<string, string>): Promise<T> => {
    const res = await doFetch(`${BASE}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({ client_id: cred().clientId ?? '', client_secret: cred().clientSecret ?? '', ...params }),
    })
    if (!res.ok) throw await failure(res)
    const text = await res.text()
    return (text ? JSON.parse(text) : {}) as T
  }
  const authed = async <T>(path: string, accessToken: string): Promise<T> => {
    const res = await doFetch(`${BASE}${path}`, { headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' } })
    if (!res.ok) throw await failure(res)
    return (await res.json()) as T
  }
  const toTokens = (j: { access_token: string; refresh_token: string; expires_in: number; scope?: string }): RobloxTokens => ({
    accessToken: j.access_token, refreshToken: j.refresh_token, expiresIn: j.expires_in, scope: j.scope ?? '',
  })

  return {
    get enabled() { const c = cred(); return !!c.clientId && !!c.clientSecret },
    redirectUri,
    get scopes() { return cred().scopes },
    authorizeUrl(state, codeChallenge) {
      const u = new URL(`${BASE}/oauth/v1/authorize`)
      u.search = new URLSearchParams({
        client_id: cred().clientId ?? '', redirect_uri: redirectUri, scope: cred().scopes, response_type: 'code',
        state, code_challenge: codeChallenge, code_challenge_method: 'S256',
        prompt: 'select_account consent', // choisir le compte (pas forcement celui deja ouvert) ; l'ecran de consentement est obligatoire pour une application tierce
      }).toString()
      return u.toString()
    },
    async exchangeCode(code, codeVerifier) {
      return toTokens(await form('/oauth/v1/token', { grant_type: 'authorization_code', code, code_verifier: codeVerifier }))
    },
    async refresh(refreshToken) {
      return toTokens(await form('/oauth/v1/token', { grant_type: 'refresh_token', refresh_token: refreshToken }))
    },
    async getProfile(accessToken) {
      const j = await authed<{ sub: string; preferred_username?: string; nickname?: string; name?: string }>('/oauth/v1/userinfo', accessToken)
      if (!j.sub) throw new RobloxError('Roblox n\'a pas renvoye d\'identifiant de compte (la portee « openid » est-elle activee ?)', 502)
      return { sub: String(j.sub), username: j.preferred_username ?? j.name ?? String(j.sub), displayName: j.nickname ?? j.name ?? null }
    },
    async getResources(accessToken) {
      type Info = { owner?: { id?: string; type?: string }; resources?: Record<string, { ids?: string[] }> }
      const j = await form<{ resource_infos?: Info[] }>('/oauth/v1/token/resources', { token: accessToken })
      const groups = new Set<string>()
      const universes = new Set<string>()
      for (const info of j.resource_infos ?? []) {
        // un groupe est accessible quand il apparait comme proprietaire autorise, ou comme ressource « group » de la portee
        if (info.owner?.type?.toLowerCase() === 'group' && info.owner.id) groups.add(String(info.owner.id))
        for (const id of info.resources?.group?.ids ?? []) if (/^\d+$/.test(id)) groups.add(id)
        for (const id of info.resources?.universe?.ids ?? []) if (/^\d+$/.test(id)) universes.add(id)
      }
      return { groupIds: [...groups], universeIds: [...universes] }
    },
    async getGroupName(accessToken, groupId) {
      try {
        const j = await authed<{ displayName?: string }>(`/cloud/v2/groups/${encodeURIComponent(groupId)}`, accessToken)
        return j.displayName ?? null
      } catch { return null } // le nom est un confort : jamais bloquant
    },
    // Envoie un code bidon : « invalid_client » = identifiants refuses ; « invalid_grant » = identifiants acceptes, c'est le code qui est faux.
    async checkCredentials() {
      try {
        await form('/oauth/v1/token', { grant_type: 'authorization_code', code: 'verification', code_verifier: 'x'.repeat(43) })
        return 'unknown'
      } catch (e) {
        if (e instanceof RobloxError) {
          if (e.code === 'invalid_client' || e.status === 401) return 'rejected'
          if (e.code === 'invalid_grant') return 'valid'
        }
        return 'unknown'
      }
    },
    async revoke(refreshToken) {
      try { await form('/oauth/v1/token/revoke', { token: refreshToken }) } catch { /* meilleur effort */ }
    },
  }
}

async function failure(res: Response): Promise<RobloxError> {
  let code: string | undefined
  let detail = ''
  try {
    const j = (await res.json()) as { error?: string; error_description?: string; message?: string }
    code = j.error
    detail = j.error_description ?? j.message ?? j.error ?? ''
  } catch { /* corps non JSON */ }
  const hint = res.status === 401 ? 'jeton Roblox refuse ou expire' : res.status === 403 ? 'acces refuse par Roblox' : res.status === 429 ? 'trop de requetes vers Roblox' : 'erreur Roblox'
  return new RobloxError(`${hint}${detail ? ` (${detail})` : ''}`, res.status, code)
}
