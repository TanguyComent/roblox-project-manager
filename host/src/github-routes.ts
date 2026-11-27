// Connexion du compte GitHub de l'utilisateur (page Compte).
import type { Context, Hono } from 'hono'
import type { Env } from './app.ts'
import { RateLimiter } from './auth.ts'
import { deleteConnection, getConnection, getToken, saveConnection, updateOwner, updateTemplate, updateUiTemplate } from './github-connection.ts'
import { GithubError, type GithubFactory } from './github.ts'
import { templatePickerPage, type TemplateKind, type TemplatePickerData } from './github-template-view.ts'
import { renderAccount } from './account-view.ts'
import type { Db } from './db.ts'
import type { RobloxClient } from './roblox.ts'

type Auth = NonNullable<Context<Env>['var']['auth']>
type Status = 200 | 400 | 403 | 502

interface Ctx {
  db: Db
  githubFor: GithubFactory
  roblox: RobloxClient
  html: (c: Context, body: string, status?: Status) => Response
  form: (c: Context) => Promise<{ s: (k: string) => string }>
  csrfOk: (c: Context, given: string) => boolean
  requireFull: (c: Context) => Auth | Response
}

const REPO = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/

export function githubRoutes(app: Hono<Env>, ctx: Ctx) {
  const { db, githubFor, roblox, html, form, csrfOk, requireFull } = ctx
  const connectLimit = new RateLimiter(10, 60 * 60_000) // essais de jeton par utilisateur et par heure

  const guard = async (c: Context) => {
    const a = requireFull(c)
    if (a instanceof Response) return { res: a } as const
    const f = await form(c)
    if (!csrfOk(c, f.s('csrf'))) return { res: c.text('Jeton invalide', 403) } as const
    return { a, f } as const
  }
  const back = async (c: Context, a: Auth, extra: { githubError?: string; githubNotice?: string }, status: Status = 200) =>
    html(c, await renderAccount(db, roblox, a, extra), status)

  app.post('/account/github', async (c) => {
    const g = await guard(c)
    if ('res' in g) return g.res
    const { a, f } = g
    const token = f.s('token').trim()
    if (!token || token.length > 400 || /\s/.test(token)) return back(c, a, { githubError: 'Colle un jeton d\'acces GitHub valide.' }, 400)
    if (!connectLimit.hit(`u:${a.user.id}`)) return back(c, a, { githubError: 'Trop d\'essais. Reessaie plus tard.' }, 400)
    try {
      const { login } = await githubFor(token).getViewer()
      saveConnection(db, a.user.id, login, token)
    } catch (e) {
      const msg = e instanceof GithubError ? e.message : 'GitHub ne repond pas.'
      return back(c, a, { githubError: `Connexion impossible : ${msg}.` }, e instanceof GithubError && e.status < 500 ? 400 : 502)
    }
    return c.redirect('/account?g=connected', 303)
  })

  app.post('/account/github/settings', async (c) => {
    const g = await guard(c)
    if ('res' in g) return g.res
    const { a, f } = g
    if (!getConnection(db, a.user.id)) return c.redirect('/account', 303)
    const owner = f.s('owner').trim()
    if (owner && !OWNER.test(owner)) return back(c, a, { githubError: 'Proprietaire GitHub invalide.' }, 400)
    updateOwner(db, a.user.id, owner || null)
    return c.redirect('/account?g=saved', 303)
  })

  // --- choix d'un template : depot, puis branche. Meme parcours pour deux reglages : le template des nouveaux projets et le depot de maquette UI ---
  const KINDS: Record<TemplateKind, {
    path: string
    current: (c: NonNullable<ReturnType<typeof getConnection>>) => { repo: string; branch: string } | null
    save: (userId: number, repo: string | null, branch: string | null) => void
    key: string
  }> = {
    project: {
      path: '/account/github/template', key: 'template',
      current: (c) => (c.template_repo ? { repo: c.template_repo, branch: c.template_branch ?? '' } : null),
      save: (u, repo, branch) => updateTemplate(db, u, repo, branch),
    },
    ui: {
      path: '/account/github/ui-template', key: 'ui-template',
      current: (c) => (c.ui_template_repo ? { repo: c.ui_template_repo, branch: c.ui_template_branch ?? '' } : null),
      save: (u, repo, branch) => updateUiTemplate(db, u, repo, branch),
    },
  }

  const picker = async (c: Context, a: Auth, kind: TemplateKind, repoParam: string | undefined, error?: string, status: Status = 200) => {
    const token = getToken(db, a.user.id)
    const conn = getConnection(db, a.user.id)
    if (!token || !conn) return c.redirect('/account', 303)
    const client = githubFor(token)
    const current = KINDS[kind].current(conn)
    const data: TemplatePickerData = { kind, repos: [], selected: null, branches: [], branch: null, error, current }
    try {
      data.repos = await client.listRepos()
      const wanted = repoParam && REPO.test(repoParam) ? repoParam : current?.repo
      const repo = data.repos.find((r) => r.fullName.toLowerCase() === wanted?.toLowerCase())
      if (repo) {
        data.selected = repo.fullName
        data.branches = await client.listBranches(repo.fullName)
        // branche preselectionnee : celle deja enregistree pour ce depot, sinon la branche par defaut du depot
        data.branch = current?.repo === repo.fullName && current.branch && data.branches.includes(current.branch)
          ? current.branch : data.branches.includes(repo.defaultBranch) ? repo.defaultBranch : (data.branches[0] ?? null)
      }
    } catch (e) {
      data.error = `${e instanceof GithubError ? e.message : 'GitHub ne repond pas'}.`
      status = 502
    }
    return html(c, templatePickerPage({ email: a.user.email, csrf: a.session.csrf, ...data }), status)
  }

  for (const kind of ['project', 'ui'] as const) {
    const { path, key, save } = KINDS[kind]

    app.get(path, async (c) => {
      const a = requireFull(c)
      if (a instanceof Response) return a
      return picker(c, a, kind, c.req.query('repo'))
    })

    app.post(path, async (c) => {
      const g = await guard(c)
      if ('res' in g) return g.res
      const { a, f } = g
      const repo = f.s('repo').trim()
      const branch = f.s('branch').trim()
      const token = getToken(db, a.user.id)
      if (!token) return c.redirect('/account', 303)
      if (!REPO.test(repo) || !branch) return picker(c, a, kind, repo, 'Choisis un depot et une branche.', 400)
      try {
        // verifie aupres de GitHub que le depot est accessible et que la branche existe
        const branches = await githubFor(token).listBranches(repo)
        if (!branches.includes(branch)) return picker(c, a, kind, repo, `La branche « ${branch} » n'existe pas dans ${repo}.`, 400)
      } catch (e) {
        return picker(c, a, kind, repo, `${e instanceof GithubError ? e.message : 'GitHub ne repond pas'}.`, 502)
      }
      save(a.user.id, repo, branch)
      return c.redirect(`/account?g=${key}`, 303)
    })

    app.post(`${path}/clear`, async (c) => {
      const g = await guard(c)
      if ('res' in g) return g.res
      save(g.a.user.id, null, null)
      return c.redirect(`/account?g=${key}-cleared`, 303)
    })
  }

  app.post('/account/github/disconnect', async (c) => {
    const g = await guard(c)
    if ('res' in g) return g.res
    deleteConnection(db, g.a.user.id)
    return c.redirect('/account?g=disconnected', 303)
  })
}
