// Comptes Roblox (cles d'API) depuis la page Compte : connecter, changer la cle, verifier, deconnecter.
import type { Context, Hono } from 'hono'
import type { Env } from './app.ts'
import { renderAccount } from './account-view.ts'
import type { Db } from './db.ts'
import { RateLimiter } from './auth.ts'
import { connectAccount, deleteAccount, getAccount, projectsUsingAccount, replaceKey, verifyAccount } from './roblox-accounts.ts'
import type { RobloxClient } from './roblox.ts'

type Auth = NonNullable<Context<Env>['var']['auth']>
type Status = 200 | 400 | 403 | 502

interface Ctx {
  db: Db
  roblox: RobloxClient
  html: (c: Context, body: string, status?: Status) => Response
  form: (c: Context) => Promise<{ s: (k: string) => string }>
  csrfOk: (c: Context, given: string) => boolean
  requireFull: (c: Context) => Auth | Response
}

export function robloxRoutes(app: Hono<Env>, ctx: Ctx) {
  const { db, roblox, html, form, csrfOk, requireFull } = ctx
  const attempts = new RateLimiter(20, 60 * 60_000) // essais de cle par utilisateur et par heure (evite de s'en servir pour tester des cles)

  const guard = async (c: Context) => {
    const a = requireFull(c)
    if (a instanceof Response) return { res: a } as const
    const f = await form(c)
    if (!csrfOk(c, f.s('csrf'))) return { res: c.text('Jeton invalide', 403) } as const
    return { a, f } as const
  }
  const back = async (c: Context, a: Auth, robloxError: string, status: Status) =>
    html(c, await renderAccount(db, roblox, a, { robloxError }), status)

  app.post('/account/roblox', async (c) => {
    const g = await guard(c)
    if ('res' in g) return g.res
    const { a, f } = g
    if (!attempts.hit(`u:${a.user.id}`)) return back(c, a, 'Trop d\'essais. Reessaie plus tard.', 400)
    const r = await connectAccount(db, roblox, a.user.id, f.s('label').trim(), f.s('apiKey'))
    if (!r.ok) return back(c, a, r.error, r.status)
    return c.redirect('/account?r=connected', 303)
  })

  app.post('/account/roblox/:id{[0-9]+}/key', async (c) => {
    const g = await guard(c)
    if ('res' in g) return g.res
    const { a, f } = g
    if (!getAccount(db, a.user.id, Number(c.req.param('id')))) return c.redirect('/account', 303)
    if (!attempts.hit(`u:${a.user.id}`)) return back(c, a, 'Trop d\'essais. Reessaie plus tard.', 400)
    const r = await replaceKey(db, roblox, a.user.id, Number(c.req.param('id')), f.s('apiKey'))
    if (!r.ok) return back(c, a, r.error, r.status)
    return c.redirect('/account?r=updated', 303)
  })

  app.post('/account/roblox/:id{[0-9]+}/verify', async (c) => {
    const g = await guard(c)
    if ('res' in g) return g.res
    const { a } = g
    const id = Number(c.req.param('id'))
    if (!getAccount(db, a.user.id, id)) return c.redirect('/account', 303)
    const r = await verifyAccount(db, roblox, a.user.id, id)
    if (!r.ok) return back(c, a, r.error, r.status)
    return c.redirect(r.value.status === 'ok' ? '/account?r=verified' : '/account?r=invalid', 303)
  })

  app.post('/account/roblox/:id{[0-9]+}/disconnect', async (c) => {
    const g = await guard(c)
    if ('res' in g) return g.res
    const { a } = g
    const id = Number(c.req.param('id'))
    if (!getAccount(db, a.user.id, id)) return c.redirect('/account', 303)
    const used = projectsUsingAccount(db, id)
    if (used.length) {
      return back(c, a, `Ce compte est utilise par ${used.length > 1 ? 'les projets' : 'le projet'} : ${used.join(', ')}. Change leur compte Roblox avant de le deconnecter.`, 400)
    }
    deleteAccount(db, a.user.id, id)
    return c.redirect('/account?r=disconnected', 303)
  })
}
