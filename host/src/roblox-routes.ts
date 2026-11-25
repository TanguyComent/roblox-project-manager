// Connexion des comptes Roblox (OAuth 2.0, code d'autorisation + PKCE) depuis la page Compte.
import type { Context, Hono } from 'hono'
import type { Env } from './app.ts'
import { renderAccount } from './account-view.ts'
import type { Db } from './db.ts'
import {
  beginAuthorization, consumeAuthorization, deleteAccount, getAccount, getRefreshToken, projectsUsingAccount, saveAccount,
} from './roblox-accounts.ts'
import { RobloxError, type RobloxClient } from './roblox.ts'

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
  const back = async (c: Context, a: Auth, robloxError: string, status: Status) =>
    html(c, await renderAccount(db, roblox, a, { robloxError }), status)

  // Demarre la connexion : redirige vers Roblox. (Lien et non formulaire : la CSP interdit a un formulaire de rediriger hors du site.)
  app.get('/account/roblox/connect', async (c) => {
    const a = requireFull(c)
    if (a instanceof Response) return a
    if (!roblox.enabled) return back(c, a, "La connexion Roblox n'est pas configuree sur cette instance.", 400)
    return c.redirect(beginAuthorization(db, roblox, a.user.id, a.session.id), 302)
  })

  // Retour de Roblox : ?code=...&state=... (ou ?error=...)
  app.get('/account/roblox/callback', async (c) => {
    const a = requireFull(c)
    if (a instanceof Response) return a
    const error = c.req.query('error')
    const state = c.req.query('state') ?? ''
    const code = c.req.query('code') ?? ''
    // l'etat est consomme dans tous les cas (usage unique), y compris quand Roblox renvoie une erreur
    const verifier = state ? consumeAuthorization(db, state, a.user.id, a.session.id) : null
    if (error) {
      const reason = error === 'access_denied' ? 'Autorisation refusee sur Roblox.' : `Roblox a refuse la connexion (${c.req.query('error_description') ?? error}).`
      return back(c, a, reason, 400)
    }
    if (!verifier || !code) return back(c, a, 'La connexion a expire ou ne vient pas de cette session. Recommence.', 400)
    try {
      const tokens = await roblox.exchangeCode(code, verifier)
      const profile = await roblox.getProfile(tokens.accessToken)
      saveAccount(db, a.user.id, profile, tokens)
    } catch (e) {
      return back(c, a, `Connexion impossible : ${e instanceof RobloxError ? e.message : 'Roblox ne repond pas'}.`, e instanceof RobloxError && e.status < 500 ? 400 : 502)
    }
    return c.redirect('/account?r=connected', 303)
  })

  app.post('/account/roblox/:id{[0-9]+}/disconnect', async (c) => {
    const a = requireFull(c)
    if (a instanceof Response) return a
    const f = await form(c)
    if (!csrfOk(c, f.s('csrf'))) return c.text('Jeton invalide', 403)
    const id = Number(c.req.param('id'))
    const account = getAccount(db, a.user.id, id)
    if (!account) return c.redirect('/account', 303)
    const used = projectsUsingAccount(db, id)
    if (used.length) {
      return back(c, a, `Ce compte est utilise par ${used.length > 1 ? 'les projets' : 'le projet'} : ${used.join(', ')}. Change leur compte Roblox avant de le deconnecter.`, 400)
    }
    const refresh = getRefreshToken(db, a.user.id, id)
    if (refresh) await roblox.revoke(refresh) // meilleur effort : on supprime de toute facon
    deleteAccount(db, a.user.id, id)
    return c.redirect('/account?r=disconnected', 303)
  })
}
