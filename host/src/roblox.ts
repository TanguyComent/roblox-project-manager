// Client Open Cloud de Roblox construit autour d'UNE cle d'API (celle d'un compte Roblox connecte au site).
// Documentation : https://create.roblox.com/docs/cloud/auth/api-keys  et  https://create.roblox.com/docs/cloud/reference
const BASE = 'https://apis.roblox.com'

export interface KeyScope { name: string; operations: string[]; userIds: string[]; groupIds: string[]; universeIds: string[] }
export interface KeyInfo {
  name: string
  /** Compte Roblox auquel appartient la cle (pour une cle de groupe : le dernier compte qui l'a generee). */
  authorizedUserId: string
  scopes: KeyScope[]
  enabled: boolean
  expired: boolean
  expirationTimeUtc: string | null
}
export interface UniverseInfo { universeId: string; name: string; rootPlaceId: string | null; owner: { type: 'User' | 'Group'; id: string } | null }
export interface PlaceInfo { placeId: string; name: string }
export interface GroupMembership { groupId: string; roleId: string | null }

/** Resultat d'une recherche qui peut etre « introuvable » ou « impossible a savoir » (cle sans la permission de lecture, panne...). */
export type Lookup<T> = { kind: 'found'; value: T } | { kind: 'missing' } | { kind: 'unknown' }

export class RobloxError extends Error {
  status: number
  constructor(message: string, status: number) { super(message); this.status = status }
}

export interface RobloxClient {
  /** Informations sur une cle (valide ? expiree ? a qui ? quelles permissions ?). Leve RobloxError si Roblox ne la reconnait pas. */
  introspectKey(apiKey: string): Promise<KeyInfo>
  /** Nom d'utilisateur d'un compte Roblox (API publique) ; null si indisponible. */
  getUsername(userId: string): Promise<string | null>
  getGroup(apiKey: string, groupId: string): Promise<Lookup<{ name: string }>>
  /** Groupes dont le compte est membre. Leve RobloxError si la cle n'a pas le droit de le lire. */
  listMemberships(apiKey: string, userId: string): Promise<GroupMembership[]>
  getUniverse(apiKey: string, universeId: string): Promise<Lookup<UniverseInfo>>
  /** Verifie qu'une place appartient bien a l'experience. */
  getPlace(apiKey: string, universeId: string, placeId: string): Promise<Lookup<PlaceInfo>>
  /** Les places d'une experience (API publique ; liste vide si indisponible). */
  listUniversePlaces(universeId: string): Promise<PlaceInfo[]>
  /** Experiences PUBLIQUES d'un proprietaire (utilisateur ou groupe) ; liste vide si indisponible. */
  listPublicGames(ownerType: 'User' | 'Group', ownerId: string): Promise<UniverseInfo[]>
}

interface Options { fetchImpl?: typeof fetch }

const ids = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => String(x)) : [])

export function createRobloxClient(opts: Options = {}): RobloxClient {
  const doFetch = opts.fetchImpl ?? fetch
  const get = (url: string, apiKey?: string) =>
    doFetch(url, { headers: { accept: 'application/json', ...(apiKey ? { 'x-api-key': apiKey } : {}) }, signal: AbortSignal.timeout(8000) })

  return {
    async introspectKey(apiKey) {
      const res = await doFetch(`${BASE}/api-keys/v1/introspect`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ apiKey }),
        signal: AbortSignal.timeout(8000),
      })
      if (!res.ok) throw await failure(res)
      const j = (await res.json()) as {
        name?: string; authorizedUserId?: number | string; enabled?: boolean; expired?: boolean; expirationTimeUtc?: string | null
        scopes?: { name?: string; operations?: string[]; userIds?: unknown; groupIds?: unknown; universeIds?: unknown; universes?: { universeId?: string | number }[]; universeDatastores?: { universeId?: string | number }[] }[]
      }
      if (j.authorizedUserId === undefined || j.authorizedUserId === null) throw new RobloxError("Roblox n'a pas reconnu cette cle.", 404)
      return {
        name: j.name ?? '',
        authorizedUserId: String(j.authorizedUserId),
        enabled: j.enabled !== false,
        expired: j.expired === true,
        expirationTimeUtc: j.expirationTimeUtc ?? null,
        scopes: (j.scopes ?? []).map((s) => ({
          name: s.name ?? '',
          operations: ids(s.operations),
          userIds: ids(s.userIds),
          groupIds: ids(s.groupIds),
          universeIds: [...ids(s.universeIds), ...(s.universes ?? []).map((u) => String(u.universeId ?? '')), ...(s.universeDatastores ?? []).map((u) => String(u.universeId ?? ''))].filter(Boolean),
        })),
      }
    },

    async getUsername(userId) {
      if (!/^\d+$/.test(userId)) return null
      try {
        const res = await get(`https://users.roblox.com/v1/users/${userId}`)
        if (!res.ok) return null
        return ((await res.json()) as { name?: string }).name ?? null
      } catch { return null }
    },

    async getGroup(apiKey, groupId) {
      if (!/^\d+$/.test(groupId)) return { kind: 'missing' }
      try {
        const res = await get(`${BASE}/cloud/v2/groups/${groupId}`, apiKey)
        if (res.status === 404) return { kind: 'missing' }
        if (!res.ok) return { kind: 'unknown' }
        return { kind: 'found', value: { name: ((await res.json()) as { displayName?: string }).displayName ?? `Groupe ${groupId}` } }
      } catch { return { kind: 'unknown' } }
    },

    async listMemberships(apiKey, userId) {
      if (!/^\d+$/.test(userId)) return []
      const out: GroupMembership[] = []
      let pageToken = ''
      for (let page = 0; page < 3; page++) {
        const filter = encodeURIComponent(`user == 'users/${userId}'`)
        const res = await get(`${BASE}/cloud/v2/groups/-/memberships?maxPageSize=100&filter=${filter}${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`, apiKey)
        if (!res.ok) throw await failure(res)
        const j = (await res.json()) as { groupMemberships?: { path?: string; role?: string }[]; nextPageToken?: string }
        for (const m of j.groupMemberships ?? []) {
          const g = /groups\/(\d+)/.exec(m.path ?? '')?.[1]
          if (g) out.push({ groupId: g, roleId: /roles\/(\d+)/.exec(m.role ?? '')?.[1] ?? null })
        }
        if (!j.nextPageToken) break
        pageToken = j.nextPageToken
      }
      return out
    },

    async getUniverse(apiKey, universeId) {
      if (!/^\d+$/.test(universeId)) return { kind: 'missing' }
      try {
        const res = await get(`${BASE}/cloud/v2/universes/${universeId}`, apiKey)
        if (res.status === 404) return { kind: 'missing' }
        if (!res.ok) return { kind: 'unknown' }
        const j = (await res.json()) as { displayName?: string; rootPlace?: string; user?: string; group?: string }
        const owner = j.group ? { type: 'Group' as const, id: /(\d+)/.exec(j.group)?.[1] ?? '' } : j.user ? { type: 'User' as const, id: /(\d+)/.exec(j.user)?.[1] ?? '' } : null
        return {
          kind: 'found',
          value: { universeId, name: j.displayName ?? `Experience ${universeId}`, rootPlaceId: /places\/(\d+)/.exec(j.rootPlace ?? '')?.[1] ?? null, owner: owner && owner.id ? owner : null },
        }
      } catch { return { kind: 'unknown' } }
    },

    async getPlace(apiKey, universeId, placeId) {
      if (!/^\d+$/.test(universeId) || !/^\d+$/.test(placeId)) return { kind: 'missing' }
      try {
        const res = await get(`${BASE}/cloud/v2/universes/${universeId}/places/${placeId}`, apiKey)
        if (res.status === 404) return { kind: 'missing' }
        if (!res.ok) return { kind: 'unknown' }
        return { kind: 'found', value: { placeId, name: ((await res.json()) as { displayName?: string }).displayName ?? `Place ${placeId}` } }
      } catch { return { kind: 'unknown' } }
    },

    async listUniversePlaces(universeId) {
      if (!/^\d+$/.test(universeId)) return []
      try {
        const res = await get(`https://develop.roblox.com/v1/universes/${universeId}/places?limit=100`)
        if (!res.ok) return []
        const j = (await res.json()) as { data?: { id: number | string; name?: string }[] }
        return (j.data ?? []).map((p) => ({ placeId: String(p.id), name: p.name ?? `Place ${p.id}` }))
      } catch { return [] }
    },

    async listPublicGames(ownerType, ownerId) {
      if (!/^\d+$/.test(ownerId)) return []
      try {
        const res = await get(`https://games.roblox.com/v2/${ownerType === 'Group' ? 'groups' : 'users'}/${ownerId}/games?limit=50`)
        if (!res.ok) return []
        const j = (await res.json()) as { data?: { id: number | string; name?: string; rootPlace?: { id?: number | string } }[] }
        return (j.data ?? []).map((g) => ({
          universeId: String(g.id), name: g.name ?? `Experience ${g.id}`, rootPlaceId: g.rootPlace?.id !== undefined ? String(g.rootPlace.id) : null,
          owner: { type: ownerType, id: ownerId },
        }))
      } catch { return [] }
    },
  }
}

async function failure(res: Response): Promise<RobloxError> {
  let detail = ''
  try {
    const j = (await res.json()) as { error?: string; error_description?: string; message?: string }
    detail = j.message ?? j.error_description ?? j.error ?? ''
  } catch { /* corps non JSON */ }
  const hint = res.status === 400 || res.status === 404 ? 'cle non reconnue par Roblox' : res.status === 401 ? 'cle refusee par Roblox' : res.status === 403 ? 'acces refuse par Roblox' : res.status === 429 ? 'trop de requetes vers Roblox' : 'erreur Roblox'
  return new RobloxError(`${hint}${detail ? ` (${detail})` : ''}`, res.status)
}
