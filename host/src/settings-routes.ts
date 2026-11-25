// Page Reglages : reservee a l'administrateur de l'instance.
import type { Context, Hono } from 'hono'
import type { Env } from './app.ts'
import type { Db } from './db.ts'
import type { RobloxClient } from './roblox.ts'
import { settingsPage } from './settings-view.ts'
import { KEYS, deleteSettings, getSetting, robloxSource, setSetting } from './settings.ts'
import { messagePage } from './views.ts'

type Auth = NonNullable<Context<Env>['var']['auth']>
type Status = 200 | 400 | 403 | 404 | 502

interface Ctx {
  db: Db
  roblox: RobloxClient
  html: (c: Context, body: string, status?: Status) => Response
  form: (c: Context) => Promise<{ s: (k: string) => string }>
  csrfOk: (c: Context, given: string) => boolean
  requireFull: (c: Context) => Auth | Response
}

const NOTICES: Record<string, string> = { saved: 'Reglages enregistres.', cleared: 'Configuration supprimee.' }
const SCOPES = /^[\w.:-]+(?: [\w.:-]+)*$/

export function settingsRoutes(app: Hono<Env>, ctx: Ctx) {
  const { db, roblox, html, form, csrfOk, requireFull } = ctx

  // Garde : session complete, administrateur, et CSRF pour les POST. Un non-admin recoit un 404 (la page « n'existe pas » pour lui).
  const guard = async (c: Context, post: boolean) => {
    const a = requireFull(c)
    if (a instanceof Response) return { res: a } as const
    if (a.user.is_admin !== 1) return { res: html(c, messagePage('Page introuvable', 'Cette page n\'existe pas.', 404).html, 404) } as const
    const f = post ? await form(c) : { s: (_: string) => '' }
    if (post && !csrfOk(c, f.s('csrf'))) return { res: c.text('Jeton invalide', 403) } as const
    return { a, f } as const
  }

  const render = (c: Context, a: Auth, extra: { error?: string; notice?: string } = {}, status: Status = 200) => {
    const src = robloxSource(db)
    return html(c, settingsPage({
      email: a.user.email, csrf: a.session.csrf, admin: true, redirectUri: roblox.redirectUri,
      roblox: { ...src, enabled: roblox.enabled }, ...extra,
    }), status)
  }

  app.get('/settings', async (c) => {
    const g = await guard(c, false)
    if ('res' in g) return g.res
    return render(c, g.a, { notice: NOTICES[c.req.query('n') ?? ''] })
  })

  app.post('/settings/roblox', async (c) => {
    const g = await guard(c, true)
    if ('res' in g) return g.res
    const { a, f } = g
    const clientId = f.s('clientId').trim()
    const secret = f.s('clientSecret').trim()
    const scopes = f.s('scopes').trim().replace(/\s+/g, ' ')
    if (!/^\d{5,40}$/.test(clientId)) return render(c, a, { error: 'Client ID invalide : il ne contient que des chiffres.' }, 400)
    const hasStoredSecret = !!getSetting(db, KEYS.robloxClientSecret)
    if (!secret && !hasStoredSecret) return render(c, a, { error: 'Le secret est obligatoire.' }, 400)
    if (secret && (secret.length > 300 || /\s/.test(secret))) return render(c, a, { error: 'Secret invalide.' }, 400)
    if (!scopes || scopes.length > 400 || !SCOPES.test(scopes)) return render(c, a, { error: 'Permissions invalides : des noms separes par des espaces (ex. openid profile group:read).' }, 400)
    setSetting(db, KEYS.robloxClientId, clientId)
    if (secret) setSetting(db, KEYS.robloxClientSecret, secret) // vide = on garde le secret existant
    setSetting(db, KEYS.robloxScopes, scopes)
    return c.redirect('/settings?n=saved', 303)
  })

  app.post('/settings/roblox/check', async (c) => {
    const g = await guard(c, true)
    if ('res' in g) return g.res
    const result = await roblox.checkCredentials()
    if (result === 'valid') return render(c, g.a, { notice: 'Roblox accepte ces identifiants.' })
    if (result === 'rejected') return render(c, g.a, { error: 'Roblox refuse ces identifiants : verifie le Client ID et le secret.' }, 400)
    return render(c, g.a, { error: 'Verification impossible (reponse inattendue de Roblox). Essaie une vraie connexion depuis la page Compte.' }, 502)
  })

  app.post('/settings/roblox/clear', async (c) => {
    const g = await guard(c, true)
    if ('res' in g) return g.res
    deleteSettings(db, [KEYS.robloxClientId, KEYS.robloxClientSecret, KEYS.robloxScopes])
    return c.redirect('/settings?n=cleared', 303)
  })
}
