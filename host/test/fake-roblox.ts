import { createRobloxClient } from '../src/roblox.ts'

export interface FakeUniverse { id: string; name: string; rootPlaceId: string; places: { id: string; name: string }[]; public?: boolean }
export interface FakeRobloxUser {
  sub: string
  username: string
  displayName?: string
  groups: { id: string; name: string }[]
  /** Experiences que l'utilisateur a cochees sur l'ecran d'autorisation (identifiants explicites). */
  authorizedUniverses?: FakeUniverse[]
  /** Experiences PUBLIQUES de chaque groupe (listees via l'API publique quand « toutes les experiences » est autorise). */
  publicGames?: Record<string, FakeUniverse[]>
}

const U_STEAL: FakeUniverse = {
  id: '3828411582', name: 'Steal Treasure', rootPlaceId: '9100000001',
  places: [{ id: '9100000001', name: 'Steal Treasure' }, { id: '9100000002', name: 'Lobby' }],
}
const U_HUB: FakeUniverse = {
  id: '5550001', name: 'Boilr Hub', rootPlaceId: '6660001', public: true,
  places: [{ id: '6660001', name: 'Hub' }, { id: '6660002', name: 'Hub - arene' }],
}

export const DEFAULT_USERS: FakeRobloxUser[] = [
  {
    sub: '1001', username: 'tanguy_dev', displayName: 'Tanguy',
    groups: [{ id: '123456', name: 'Boilr' }, { id: '777', name: 'Studio' }],
    authorizedUniverses: [U_STEAL],
    publicGames: { '123456': [U_HUB] },
  },
  { sub: '1002', username: 'alt_account', displayName: 'Alt', groups: [{ id: '888', name: 'Autre groupe' }] },
]

// Faux Roblox OAuth : echange de code, userinfo, ressources autorisees, groupes, experiences, places, revocation.
// Le jeton de rafraichissement est a USAGE UNIQUE (comme chez Roblox) : le reutiliser donne invalid_grant.
export function fakeRoblox(o: { users?: FakeRobloxUser[]; resourcesStatus?: number; enabled?: boolean } = {}) {
  const users = new Map((o.users ?? DEFAULT_USERS).map((u) => [u.sub, u]))
  const calls: { method: string; path: string; host: string; body?: URLSearchParams; auth?: string }[] = []
  const accessTokens = new Map<string, string>() // access token -> sub
  const refreshTokens = new Map<string, string>() // refresh token (valide) -> sub
  let counter = 0
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
  const state = { revoked: [] as string[], expiresIn: 899, blockRefresh: false }

  const issue = (sub: string) => {
    counter++
    const access = `at-${sub}-${counter}`
    const refresh = `rt-${sub}-${counter}`
    accessTokens.set(access, sub)
    refreshTokens.set(refresh, sub)
    return { access_token: access, refresh_token: refresh, token_type: 'Bearer', expires_in: state.expiresIn, scope: 'openid profile group:read' }
  }
  const allUniverses = () => {
    const out = new Map<string, FakeUniverse>()
    for (const u of users.values()) {
      for (const x of u.authorizedUniverses ?? []) out.set(x.id, x)
      for (const list of Object.values(u.publicGames ?? {})) for (const x of list) out.set(x.id, x)
    }
    return out
  }

  const fetchImpl = (async (url: string, init: RequestInit = {}) => {
    const u = new URL(url)
    const method = init.method ?? 'GET'
    const headers = (init.headers ?? {}) as Record<string, string>
    const body = typeof init.body === 'string' || init.body instanceof URLSearchParams ? new URLSearchParams(String(init.body)) : undefined
    calls.push({ method, path: u.pathname, host: u.host, body, auth: headers.authorization })

    // --- API publiques (sans jeton) -----------------------------------------------------------------------------------------
    if (u.host === 'develop.roblox.com') {
      const m = /^\/v1\/universes\/(\d+)\/places$/.exec(u.pathname)
      const uni = m ? allUniverses().get(m[1]) : undefined
      return uni && uni.public !== false ? json({ data: uni.places.map((p) => ({ id: Number(p.id), universeId: Number(uni.id), name: p.name })) }) : json({ errors: [{ message: 'not found' }] }, 404)
    }
    if (u.host === 'games.roblox.com') {
      const g = /^\/v2\/groups\/(\d+)\/games$/.exec(u.pathname)
      if (g) {
        const list = [...users.values()].flatMap((x) => x.publicGames?.[g[1]] ?? [])
        return json({ data: list.map((x) => ({ id: Number(x.id), name: x.name, rootPlace: { id: Number(x.rootPlaceId) } })) })
      }
      return json({ data: [] })
    }

    // --- OAuth / Open Cloud -------------------------------------------------------------------------------------------------
    if (u.pathname === '/oauth/v1/token' && method === 'POST') {
      if (body!.get('client_id') !== 'cid' || body!.get('client_secret') !== 'secret') return json({ error: 'invalid_client' }, 401)
      if (body!.get('grant_type') === 'authorization_code') {
        const m = /^code-(\d+)$/.exec(body!.get('code') ?? '')
        if (!m || !users.has(m[1]) || !body!.get('code_verifier')) return json({ error: 'invalid_grant', error_description: 'bad code' }, 400)
        return json(issue(m[1]))
      }
      if (body!.get('grant_type') === 'refresh_token') {
        const rt = body!.get('refresh_token') ?? ''
        const sub = refreshTokens.get(rt)
        if (!sub || state.blockRefresh) return json({ error: 'invalid_grant', error_description: 'refresh token invalid or used' }, 400)
        refreshTokens.delete(rt) // usage unique
        return json(issue(sub))
      }
    }
    if (u.pathname === '/oauth/v1/userinfo') {
      const sub = accessTokens.get((headers.authorization ?? '').replace('Bearer ', ''))
      const user = sub ? users.get(sub) : undefined
      return user ? json({ sub: user.sub, preferred_username: user.username, nickname: user.displayName ?? user.username }) : json({ error: 'invalid_token' }, 401)
    }
    if (u.pathname === '/oauth/v1/token/resources' && method === 'POST') {
      if (o.resourcesStatus && o.resourcesStatus !== 200) return json({ message: 'boom' }, o.resourcesStatus)
      const sub = accessTokens.get(body!.get('token') ?? '')
      const user = sub ? users.get(sub) : undefined
      if (!user) return json({ error: 'invalid_token' }, 401)
      return json({
        resource_infos: [
          { owner: { id: user.sub, type: 'User' }, resources: { universe: { ids: (user.authorizedUniverses ?? []).map((x) => x.id) } } },
          ...user.groups.map((g) => ({ owner: { id: g.id, type: 'Group' }, resources: { universe: { ids: ['U'] } } })),
        ],
      })
    }
    let m = /^\/cloud\/v2\/universes\/(\d+)$/.exec(u.pathname)
    if (m) {
      const sub = accessTokens.get((headers.authorization ?? '').replace('Bearer ', ''))
      const user = sub ? users.get(sub) : undefined
      const uni = user?.authorizedUniverses?.find((x) => x.id === m![1])
      if (!user) return json({ error: 'invalid_token' }, 401)
      if (!uni) return json({ message: 'forbidden' }, 403)
      return json({ path: `universes/${uni.id}`, displayName: uni.name, rootPlace: `universes/${uni.id}/places/${uni.rootPlaceId}` })
    }
    m = /^\/cloud\/v2\/groups\/(\d+)$/.exec(u.pathname)
    if (m) {
      for (const user of users.values()) {
        const found = user.groups.find((x) => x.id === m![1])
        if (found) return json({ id: found.id, displayName: found.name })
      }
      return json({ message: 'not found' }, 404)
    }
    if (u.pathname === '/oauth/v1/token/revoke' && method === 'POST') {
      state.revoked.push(body!.get('token') ?? '')
      return new Response('', { status: 200 })
    }
    return json({ message: 'not found' }, 404)
  }) as unknown as typeof fetch

  const client = createRobloxClient({
    clientId: o.enabled === false ? undefined : 'cid',
    clientSecret: o.enabled === false ? undefined : 'secret',
    redirectUri: 'http://localhost:3000/account/roblox/callback',
    scopes: 'openid profile group:read',
    fetchImpl,
  })
  return { client, calls, state, refreshTokens, accessTokens, fetchImpl }
}

export type FakeRoblox = ReturnType<typeof fakeRoblox>
