import { createGithubClient } from '../src/github.ts'

export interface FakeRepo { full_name: string; default_branch: string; is_template?: boolean; private?: boolean; branches: string[] }

const DEFAULT_REPOS: FakeRepo[] = [
  { full_name: 'acme/notes', default_branch: 'main', branches: ['main'] },
  { full_name: 'acme/roblox-template', default_branch: 'main', is_template: true, branches: ['main', 'v2', 'legacy'] },
  { full_name: 'acme/old-template', default_branch: 'master', is_template: true, private: true, branches: ['master'] },
]

// Faux GitHub avec un petit etat (depots, branches) : /user, /user/repos, branches, generate, PATCH, DELETE de branche.
export function fakeGithub(o: {
  login?: string
  userStatus?: number
  repos?: FakeRepo[]
  generate?: () => Response
  patchStatus?: number
  /** Nombre de listes de branches qui renvoient un depot encore vide apres generate (depot « pas pret »). */
  notReadyListings?: number
} = {}) {
  const calls: { method: string; url: string; init: RequestInit }[] = []
  const repos = new Map<string, FakeRepo>((o.repos ?? DEFAULT_REPOS).map((r) => [r.full_name, { ...r, branches: [...r.branches] }]))
  let notReady = 0
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

  const fetchImpl = (async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET'
    calls.push({ method, url, init })
    const u = new URL(url)
    const path = u.pathname

    if (path === '/user') return o.userStatus && o.userStatus !== 200 ? json({ message: 'Bad credentials' }, o.userStatus) : json({ login: o.login ?? 'acme' })
    if (path === '/user/repos') {
      if (u.searchParams.get('page') !== '1') return json([])
      return json([...repos.values()].map((r) => ({ full_name: r.full_name, default_branch: r.default_branch, is_template: !!r.is_template, private: !!r.private })))
    }
    let m = /^\/repos\/([^/]+\/[^/]+)\/generate$/.exec(path)
    if (m && method === 'POST') {
      if (o.generate) return o.generate()
      const tpl = repos.get(m[1])
      if (!tpl) return json({ message: 'Not Found' }, 404)
      const body = JSON.parse(init.body as string)
      const full = `${body.owner ?? o.login ?? 'acme'}/${body.name}`
      repos.set(full, { full_name: full, default_branch: tpl.default_branch, private: body.private, branches: body.include_all_branches ? [...tpl.branches] : [tpl.default_branch] })
      notReady = o.notReadyListings ?? 0
      return json({ full_name: full, html_url: `https://github.com/${full}` }, 201)
    }
    m = /^\/repos\/([^/]+\/[^/]+)\/branches$/.exec(path)
    if (m) {
      const r = repos.get(m[1])
      if (!r) return json({ message: 'Not Found' }, 404)
      if (notReady > 0) { notReady--; return json([]) }
      return json(r.branches.map((name) => ({ name })))
    }
    m = /^\/repos\/([^/]+\/[^/]+)\/git\/refs\/heads\/(.+)$/.exec(path)
    if (m && method === 'DELETE') {
      const r = repos.get(m[1])
      if (!r) return json({ message: 'Not Found' }, 404)
      r.branches = r.branches.filter((b) => b !== decodeURIComponent(m![2]))
      return new Response(null, { status: 204 })
    }
    m = /^\/repos\/([^/]+\/[^/]+)$/.exec(path)
    if (m) {
      const r = repos.get(m[1])
      if (!r) return json({ message: 'Not Found' }, 404)
      if (method === 'PATCH') {
        if (o.patchStatus && o.patchStatus !== 200) return json({ message: 'Resource not accessible by personal access token' }, o.patchStatus)
        r.default_branch = JSON.parse(init.body as string).default_branch
        return json({ default_branch: r.default_branch, is_template: !!r.is_template })
      }
      return json({ default_branch: r.default_branch, is_template: !!r.is_template })
    }
    return json({ message: 'Not Found' }, 404)
  }) as unknown as typeof fetch

  return {
    calls,
    repos,
    githubFor: (token: string) => createGithubClient(token, fetchImpl, async () => {}),
    generateBody: () => JSON.parse(calls.find((c) => c.url.endsWith('/generate'))!.init.body as string) as Record<string, unknown>,
  }
}
