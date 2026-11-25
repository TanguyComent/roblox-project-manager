// Connexion du compte GitHub de l'utilisateur (page Compte).
import type { Context, Hono } from 'hono'
import type { Env } from './app.ts'
import { RateLimiter } from './auth.ts'
import { deleteConnection, getConnection, saveConnection, updateSettings } from './github-connection.ts'
import { GithubError, type GithubFactory } from './github.ts'
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
    const template = f.s('template').trim()
    const owner = f.s('owner').trim()
    if (template && !REPO.test(template)) return back(c, a, { githubError: 'Depot template invalide : attendu « proprietaire/depot ».' }, 400)
    if (owner && !OWNER.test(owner)) return back(c, a, { githubError: 'Proprietaire GitHub invalide.' }, 400)
    updateSettings(db, a.user.id, { templateRepo: template || null, defaultOwner: owner || null })
    return c.redirect('/account?g=saved', 303)
  })

  app.post('/account/github/disconnect', async (c) => {
    const g = await guard(c)
    if ('res' in g) return g.res
    deleteConnection(db, g.a.user.id)
    return c.redirect('/account?g=disconnected', 303)
  })
}
