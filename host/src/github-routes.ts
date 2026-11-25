// Connexion du compte GitHub de l'utilisateur (page Compte).
import type { Context, Hono } from 'hono'
import type { Env } from './app.ts'
import { RateLimiter } from './auth.ts'
import { deleteConnection, getConnection, getToken, saveConnection, updateOwner, updateTemplate } from './github-connection.ts'
import { GithubError, type GithubFactory } from './github.ts'
import { templatePickerPage, type TemplatePickerData } from './github-template-view.ts'
import { renderAccount } from './account-view.ts'
import type { Db } from './db.ts'

type Auth = NonNullable<Context<Env>['var']['auth']>
type Status = 200 | 400 | 403 | 502

interface Ctx {
  db: Db
  githubFor: GithubFactory
  html: (c: Context, body: string, status?: Status) => Response
  form: (c: Context) => Promise<{ s: (k: string) => string }>
  csrfOk: (c: Context, given: string) => boolean
  requireFull: (c: Context) => Auth | Response
}

const REPO = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/

export function githubRoutes(app: Hono<Env>, ctx: Ctx) {
  const { db, githubFor, html, form, csrfOk, requireFull } = ctx
  const connectLimit = new RateLimiter(10, 60 * 60_000) // essais de jeton par utilisateur et par heure

  const guard = async (c: Context) => {
    const a = requireFull(c)
    if (a instanceof Response) return { res: a } as const
    const f = await form(c)
    if (!csrfOk(c, f.s('csrf'))) return { res: c.text('Jeton invalide', 403) } as const
    return { a, f } as const
  }
  const back = (c: Context, a: Auth, extra: { githubError?: string; githubNotice?: string }, status: Status = 200) =>
    html(c, renderAccount(db, a, extra), status)

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

  // --- choix du template par defaut : depot, puis branche ------------------------------------------------------------------
  const picker = async (c: Context, a: Auth, repoParam: string | undefined, error?: string, status: Status = 200) => {
    const token = getToken(db, a.user.id)
    const conn = getConnection(db, a.user.id)
    if (!token || !conn) return c.redirect('/account', 303)
    const client = githubFor(token)
    const data: TemplatePickerData = {
      repos: [], selected: null, branches: [], branch: null, error,
      current: conn.template_repo ? { repo: conn.template_repo, branch: conn.template_branch ?? '' } : null,
    }
    try {
      data.repos = await client.listRepos()
      const wanted = repoParam && REPO.test(repoParam) ? repoParam : conn.template_repo
      const repo = data.repos.find((r) => r.fullName.toLowerCase() === wanted?.toLowerCase())
      if (repo) {
        data.selected = repo.fullName
        data.branches = await client.listBranches(repo.fullName)
        // branche preselectionnee : celle deja enregistree pour ce depot, sinon la branche par defaut du depot
        data.branch = conn.template_repo === repo.fullName && conn.template_branch && data.branches.includes(conn.template_branch)
          ? conn.template_branch : data.branches.includes(repo.defaultBranch) ? repo.defaultBranch : (data.branches[0] ?? null)
      }
    } catch (e) {
      data.error = `${e instanceof GithubError ? e.message : 'GitHub ne repond pas'}.`
      status = 502
    }
    return html(c, templatePickerPage({ email: a.user.email, csrf: a.session.csrf, ...data }), status)
  }

  app.get('/account/github/template', async (c) => {
    const a = requireFull(c)
    if (a instanceof Response) return a
    return picker(c, a, c.req.query('repo'))
  })

  app.post('/account/github/template', async (c) => {
    const g = await guard(c)
    if ('res' in g) return g.res
    const { a, f } = g
    const repo = f.s('repo').trim()
    const branch = f.s('branch').trim()
    const token = getToken(db, a.user.id)
    if (!token) return c.redirect('/account', 303)
    if (!REPO.test(repo) || !branch) return picker(c, a, repo, 'Choisis un depot et une branche.', 400)
    try {
      // verifie aupres de GitHub que le depot est accessible et que la branche existe
      const branches = await githubFor(token).listBranches(repo)
      if (!branches.includes(branch)) return picker(c, a, repo, `La branche « ${branch} » n'existe pas dans ${repo}.`, 400)
    } catch (e) {
      return picker(c, a, repo, `${e instanceof GithubError ? e.message : 'GitHub ne repond pas'}.`, 502)
    }
    updateTemplate(db, a.user.id, repo, branch)
    return c.redirect('/account?g=template', 303)
  })

  app.post('/account/github/template/clear', async (c) => {
    const g = await guard(c)
    if ('res' in g) return g.res
    updateTemplate(db, g.a.user.id, null, null)
    return c.redirect('/account?g=template-cleared', 303)
  })

  app.post('/account/github/disconnect', async (c) => {
    const g = await guard(c)
    if ('res' in g) return g.res
    deleteConnection(db, g.a.user.id)
    return c.redirect('/account?g=disconnected', 303)
  })
}
