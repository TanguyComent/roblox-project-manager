import { createRobloxClient } from '../src/roblox.ts'

export interface FakeUniverse { id: string; name: string; owner: { type: 'User' | 'Group'; id: string }; public: boolean; rootPlaceId: string; places: { id: string; name: string }[] }
export interface FakeKeyScope { name: string; operations: string[]; universeIds?: string[]; groupIds?: string[]; userIds?: string[] }
export interface FakeKey {
  key: string
  name: string
  userId: string
  scopes: FakeKeyScope[]
  enabled?: boolean
  expired?: boolean
  expirationTimeUtc?: string | null
}
export interface FakeUser { id: string; username: string; groups: { id: string; name: string }[] }

export const KEYS = {
  tanguy: 'rbx-key-tanguy-AAAAAAAAAAAAAAAAAAAA',
  tanguy2: 'rbx-key-tanguy2-BBBBBBBBBBBBBBBBBBB',
  alt: 'rbx-key-alt-CCCCCCCCCCCCCCCCCCCCCCCC',
  expired: 'rbx-key-expired-DDDDDDDDDDDDDDDDDDD',
  disabled: 'rbx-key-disabled-EEEEEEEEEEEEEEEEEE',
  unknown: 'rbx-key-unknown-FFFFFFFFFFFFFFFFFFFF',
} as const

const UNIVERSES: FakeUniverse[] = [
  { id: '3828411582', name: 'Steal Treasure', owner: { type: 'User', id: '1001' }, public: false, rootPlaceId: '9100000001',
    places: [{ id: '9100000001', name: 'Steal Treasure' }, { id: '9100000002', name: 'Lobby' }, ...[3, 4, 5, 6].map((n) => ({ id: `910000000${n}`, name: `Salle ${n}` }))] },
  { id: '5550001', name: 'Boilr Hub', owner: { type: 'Group', id: '123456' }, public: true, rootPlaceId: '6660001',
    places: [{ id: '6660001', name: 'Hub' }, { id: '6660002', name: 'Hub - arene' }] },
  { id: '7770001', name: 'Jeu de alt', owner: { type: 'User', id: '1002' }, public: true, rootPlaceId: '7770002', places: [{ id: '7770002', name: 'Alt' }] },
]
const USERS: FakeUser[] = [
  { id: '1001', username: 'tanguy_dev', groups: [{ id: '123456', name: 'Boilr' }, { id: '777', name: 'Studio' }] },
  { id: '1002', username: 'alt_account', groups: [{ id: '888', name: 'Autre groupe' }] },
]
const PUBLISH = { name: 'universe-places', operations: ['write'] }
const KEY_LIST: FakeKey[] = [
  { key: KEYS.tanguy, name: 'steal-treasure key', userId: '1001', scopes: [PUBLISH, { name: 'universe', operations: ['read'] }] },
  { key: KEYS.tanguy2, name: 'cle limitee', userId: '1001', scopes: [{ name: 'universe-places', operations: ['write'], universeIds: ['3828411582'] }] },
  { key: KEYS.alt, name: 'alt key', userId: '1002', scopes: [{ name: 'universe', operations: ['read'] }] },
  { key: KEYS.expired, name: 'vieille cle', userId: '1001', scopes: [PUBLISH], expired: true },
  { key: KEYS.disabled, name: 'cle coupee', userId: '1001', scopes: [PUBLISH], enabled: false },
]

// Faux Roblox pour les cles d'API : introspection, groupes, appartenances, experiences, places, API publiques.
export function fakeRoblox() {
  const keys = new Map(KEY_LIST.map((k) => [k.key, { ...k }]))
  const calls: { method: string; host: string; path: string; search: string; key?: string }[] = []
  const state = { introspectStatus: 200, membershipsForbidden: false, universeForbidden: false }
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
  const user = (id: string) => USERS.find((u) => u.id === id)
  const canAccess = (userId: string, u: FakeUniverse) =>
    u.owner.type === 'User' ? u.owner.id === userId : !!user(userId)?.groups.some((g) => g.id === u.owner.id)

  const fetchImpl = (async (url: string, init: RequestInit = {}) => {
    const u = new URL(url)
    const method = init.method ?? 'GET'
    const apiKey = (init.headers as Record<string, string> | undefined)?.['x-api-key']
    calls.push({ method, host: u.host, path: u.pathname, search: u.search, key: apiKey })

    // --- API publiques -------------------------------------------------------------------------------------------------------
    if (u.host === 'users.roblox.com') {
      const m = /^\/v1\/users\/(\d+)$/.exec(u.pathname)
      const usr = m ? user(m[1]) : undefined
      return usr ? json({ id: Number(usr.id), name: usr.username }) : json({ errors: [] }, 404)
    }
    if (u.host === 'develop.roblox.com') {
      const m = /^\/v1\/universes\/(\d+)\/places$/.exec(u.pathname)
      const uni = m ? UNIVERSES.find((x) => x.id === m[1]) : undefined
      return uni && uni.public ? json({ data: uni.places.map((p) => ({ id: Number(p.id), universeId: Number(uni.id), name: p.name })) }) : json({ errors: [] }, 404)
    }
    if (u.host === 'games.roblox.com') {
      const m = /^\/v2\/(users|groups)\/(\d+)\/games$/.exec(u.pathname)
      if (!m) return json({ data: [] })
      const list = UNIVERSES.filter((x) => x.public && x.owner.type === (m[1] === 'users' ? 'User' : 'Group') && x.owner.id === m[2])
      return json({ data: list.map((x) => ({ id: Number(x.id), name: x.name, rootPlace: { id: Number(x.rootPlaceId) } })) })
    }

    // --- Open Cloud ------------------------------------------------------------------------------------------------------------
    if (u.pathname === '/api-keys/v1/introspect' && method === 'POST') {
      if (state.introspectStatus !== 200) return json({ message: 'boom' }, state.introspectStatus)
      const k = keys.get(JSON.parse(init.body as string).apiKey)
      if (!k) return json({ message: 'API key not found' }, 404)
      return json({
        name: k.name, authorizedUserId: Number(k.userId), scopes: k.scopes, enabled: k.enabled !== false, expired: k.expired === true,
        expirationTimeUtc: k.expirationTimeUtc ?? null,
      })
    }
    const k = apiKey ? keys.get(apiKey) : undefined
    if (u.host === 'apis.roblox.com' && !k) return json({ message: 'invalid api key' }, 401)

    let m = /^\/cloud\/v2\/groups\/(\d+)$/.exec(u.pathname)
    if (m) {
      const g = USERS.flatMap((x) => x.groups).find((x) => x.id === m![1])
      return g ? json({ id: g.id, displayName: g.name }) : json({ message: 'not found' }, 404)
    }
    if (u.pathname === '/cloud/v2/groups/-/memberships') {
      if (state.membershipsForbidden) return json({ message: 'forbidden' }, 403)
      const uid = /users\/(\d+)/.exec(u.searchParams.get('filter') ?? '')?.[1]
      const usr = uid ? user(uid) : undefined
      return json({ groupMemberships: (usr?.groups ?? []).map((g) => ({ path: `groups/${g.id}/memberships/${uid}`, role: `groups/${g.id}/roles/1` })) })
    }
    m = /^\/cloud\/v2\/universes\/(\d+)$/.exec(u.pathname)
    if (m) {
      const uni = UNIVERSES.find((x) => x.id === m![1])
      if (!uni) return json({ message: 'not found' }, 404)
      if (state.universeForbidden || !canAccess(k!.userId, uni)) return json({ message: 'forbidden' }, 403)
      return json({ path: `universes/${uni.id}`, displayName: uni.name, rootPlace: `universes/${uni.id}/places/${uni.rootPlaceId}`, [uni.owner.type === 'User' ? 'user' : 'group']: `${uni.owner.type === 'User' ? 'users' : 'groups'}/${uni.owner.id}` })
    }
    m = /^\/cloud\/v2\/universes\/(\d+)\/places\/(\d+)$/.exec(u.pathname)
    if (m) {
      const uni = UNIVERSES.find((x) => x.id === m![1])
      if (!uni) return json({ message: 'not found' }, 404)
      if (!canAccess(k!.userId, uni)) return json({ message: 'forbidden' }, 403)
      const p = uni.places.find((x) => x.id === m![2])
      return p ? json({ path: `universes/${uni.id}/places/${p.id}`, displayName: p.name }) : json({ message: 'not found' }, 404)
    }
    return json({ message: 'not found' }, 404)
  }) as unknown as typeof fetch

  const client = createRobloxClient({ fetchImpl })
  return {
    client, calls, state, fetchImpl,
    /** Modifie une cle (la desactiver, l'expirer, ou la retirer : `null`). */
    setKey: (key: string, patch: Partial<FakeKey> | null) => { if (patch === null) keys.delete(key); else keys.set(key, { ...keys.get(key)!, ...patch }) },
  }
}

export type FakeRoblox = ReturnType<typeof fakeRoblox>
