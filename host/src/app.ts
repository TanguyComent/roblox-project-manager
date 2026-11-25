import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Hono, type Context } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { getConnInfo } from '@hono/node-server/conninfo'
import QRCode from 'qrcode'
import {
  MAX_MFA_ATTEMPTS, RateLimiter, beginTotpSetup, checkCredentials, confirmTotpSetup, countUsers, createSession, createUser,
  deleteSession, deleteUserSessions, findUserByEmail, getSession, isEmail, noteMfaAttempt, normalizeEmail, passwordProblem,
  promoteSession, purgeExpiredSessions, remainingRecoveryCodes, verifySecondFactor, type Session, type User,
} from './auth.ts'
import { config } from './config.ts'
import { otpauthUrl, safeEqual, sha256 } from './crypto.ts'
import type { Db } from './db.ts'
import { createGithubClient, type GithubClient } from './github.ts'
import { projectRoutes } from './project-routes.ts'
import { accountPage, loginPage, mfaPage, recoveryPage, registerPage, setupPage } from './views.ts'

const COOKIE = config.secureCookies ? '__Host-sid' : 'sid'
const CSS_PATH = join(import.meta.dirname, '..', 'public', 'app.css')

export type Env = { Variables: { auth: { session: Session; user: User; token: string } | null } }

export function createApp(db: Db, opts: { github?: GithubClient } = {}) {
  const app = new Hono<Env>()
  // Tentatives de connexion : par adresse IP (large) et par e-mail (strict, uniquement les echecs).
  const ipLimit = new RateLimiter(30, 15 * 60_000)
  const emailLimit = new RateLimiter(5, 15 * 60_000)
  const signupLimit = new RateLimiter(10, 60 * 60_000)

  const clientIp = (c: Context) => {
    if (config.trustProxy) {
      const xff = c.req.header('x-forwarded-for')?.split(',')[0]?.trim()
      if (xff) return xff
    }
    try { return getConnInfo(c).remote.address ?? 'unknown' } catch { return 'unknown' }
  }

  const html = (c: Context, body: string, status: 200 | 400 | 401 | 403 | 404 | 429 | 502 = 200) => {
    c.header('Cache-Control', 'no-store')
    return c.html(body, status)
  }

  // --- en-tetes de securite -------------------------------------------------------------------------------------------------
  app.use('*', async (c, next) => {
    await next()
    c.header('Content-Security-Policy', "default-src 'none'; style-src 'self'; img-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'")
    c.header('X-Content-Type-Options', 'nosniff')
    c.header('Referrer-Policy', 'same-origin')
    c.header('X-Frame-Options', 'DENY')
    c.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')
    if (config.secureCookies) c.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains')
  })

  app.use('*', bodyLimit({ maxSize: 16 * 1024, onError: (c) => c.text('Requete trop volumineuse', 413) }))

  // --- controle d'origine : toute requete qui modifie l'etat doit venir de ce site ----------------------------------------------
  app.use('*', async (c, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) return next()
    const origin = c.req.header('origin')
    const fetchSite = c.req.header('sec-fetch-site')
    let ok = false
    if (origin) {
      try {
        const host = new URL(origin).host
        ok = host === c.req.header('host') || host === new URL(config.publicUrl).host
      } catch { ok = false }
    } else if (fetchSite) ok = fetchSite === 'same-origin' || fetchSite === 'none'
    if (!ok) return c.text('Origine refusee', 403)
    return next()
  })

  // --- session ----------------------------------------------------------------------------------------------------------------
  app.use('*', async (c, next) => {
    const token = getCookie(c, COOKIE)
    const found = getSession(db, token)
    c.set('auth', found && token ? { ...found, token } : null)
    if (token && !found) deleteCookie(c, COOKIE, { path: '/' })
    await next()
  })

  const startSession = (c: Context, token: string, full: boolean) =>
    setCookie(c, COOKIE, token, {
      httpOnly: true, secure: config.secureCookies, sameSite: 'Lax', path: '/',
      ...(full ? { maxAge: 14 * 24 * 3600 } : {}), // cookie de session tant que l'authentification n'est pas terminee
    })

  const ua = (c: Context) => c.req.header('user-agent') ?? ''
  const auth = (c: Context) => (c as Context<Env>).get('auth')
  const form = async (c: Context) => {
    const b = await c.req.parseBody()
    const s = (k: string) => (typeof b[k] === 'string' ? (b[k] as string) : '')
    return { s }
  }
  const csrfOk = (c: Context, given: string) => {
    const a = auth(c)
    return !!a && safeEqual(a.session.csrf, given)
  }
  // Redirige vers l'etape qui correspond a l'etat de la session.
  const home = (c: Context) => {
    const a = auth(c)
    if (!a) return c.redirect('/login')
    if (a.session.stage === 'mfa') return c.redirect('/login/2fa')
    if (a.session.stage === 'setup') return c.redirect('/2fa/setup')
    return null
  }

  const signupOpen = () => config.allowSignup || countUsers(db) === 0

  // --- pages ------------------------------------------------------------------------------------------------------------------
  // Feuille de style : relue a chaque requete en dehors de la production (modification visible sans redemarrer), revalidee par ETag.
  app.get('/static/app.css', (c) => {
    const css = readFileSync(CSS_PATH)
    const etag = `"${sha256(css.toString('latin1')).slice(0, 16)}"`
    if (c.req.header('if-none-match') === etag) return c.body(null, 304, { ETag: etag, 'Cache-Control': 'no-cache' })
    return c.body(css, 200, { 'Content-Type': 'text/css; charset=utf-8', ETag: etag, 'Cache-Control': 'no-cache' })
  })
  app.get('/healthz', (c) => c.json({ ok: true }))

  app.get('/', (c) => home(c) ?? c.redirect('/projects'))

  app.get('/account', (c) => {
    const a = auth(c)
    const redirect = home(c)
    if (redirect) return redirect
    return html(c, accountPage({
      email: a!.user.email, csrf: a!.session.csrf, recoveryLeft: remainingRecoveryCodes(db, a!.user.id),
      notice: c.req.query('others') ? 'Les autres appareils ont ete deconnectes.' : undefined,
    }))
  })

  // Projets, experiences, depots GitHub (sessions completes uniquement)
  projectRoutes(app, {
    db, html, form, csrfOk,
    github: opts.github ?? createGithubClient(),
    requireFull: (c) => { const a = auth(c); return a && a.session.stage === 'full' ? a : (home(c) ?? c.redirect('/login')) },
  })

  // Connexion --------------------------------------------------------------------------------------------------------------------
  app.get('/login', (c) => {
    const a = auth(c)
    if (a) return home(c) ?? c.redirect('/')
    return html(c, loginPage({ canSignup: signupOpen(), notice: c.req.query('out') ? 'Tu es deconnecte.' : undefined }))
  })

  app.post('/login', async (c) => {
    const { s } = await form(c)
    const email = normalizeEmail(s('email'))
    const password = s('password')
    const ip = clientIp(c)
    const fail = (msg: string, status: 400 | 401 | 429 = 401) => html(c, loginPage({ error: msg, email, canSignup: signupOpen() }), status)
    if (emailLimit.blocked(`e:${email}`) || !ipLimit.hit(`i:${ip}`)) {
      return fail('Trop de tentatives. Reessaie dans quelques minutes.', 429)
    }
    if (!email || !password || password.length > 200) return fail('E-mail ou mot de passe incorrect.')
    const user = await checkCredentials(db, email, password)
    if (!user) { emailLimit.hit(`e:${email}`); return fail('E-mail ou mot de passe incorrect.') }
    emailLimit.reset(`e:${email}`)
    // Une ancienne session eventuelle est remplacee (pas de fixation de session).
    const old = auth(c)
    if (old) deleteSession(db, old.token)
    const stage = user.totp_enabled ? 'mfa' : 'setup'
    const { token } = createSession(db, user.id, stage, ua(c))
    startSession(c, token, false)
    return c.redirect(stage === 'mfa' ? '/login/2fa' : '/2fa/setup')
  })

  // Inscription ------------------------------------------------------------------------------------------------------------------
  app.get('/register', (c) => {
    if (auth(c)) return home(c) ?? c.redirect('/')
    if (!signupOpen()) return html(c, loginPage({ error: 'Les inscriptions sont fermees.', canSignup: false }), 403)
    return html(c, registerPage({ first: countUsers(db) === 0 }))
  })

  app.post('/register', async (c) => {
    if (!signupOpen()) return html(c, loginPage({ error: 'Les inscriptions sont fermees.', canSignup: false }), 403)
    const { s } = await form(c)
    const email = normalizeEmail(s('email'))
    const first = countUsers(db) === 0
    const fail = (msg: string, status: 400 | 429 = 400) => html(c, registerPage({ error: msg, email, first }), status)
    if (!signupLimit.hit(`i:${clientIp(c)}`)) return fail('Trop de creations de compte depuis cette adresse. Reessaie plus tard.', 429)
    if (!isEmail(email)) return fail('Adresse e-mail invalide.')
    const problem = passwordProblem(s('password'))
    if (problem) return fail(problem)
    if (s('password') !== s('confirm')) return fail('Les deux mots de passe ne correspondent pas.')
    if (findUserByEmail(db, email)) return fail('Impossible de creer ce compte avec ces informations.') // message neutre : pas d'enumeration trop evidente
    const user = await createUser(db, email, s('password'))
    const { token } = createSession(db, user.id, 'setup', ua(c))
    startSession(c, token, false)
    return c.redirect('/2fa/setup')
  })

  // Configuration de l'A2F ----------------------------------------------------------------------------------------------------
  const setupView = async (c: Context, a: NonNullable<ReturnType<typeof auth>>, error?: string, status: 200 | 400 | 429 = 200) => {
    const secret = beginTotpSetup(db, a.user.id)
    const qrSvg = await QRCode.toString(otpauthUrl(a.user.email, secret), { type: 'svg', margin: 0, errorCorrectionLevel: 'M' })
    return html(c, setupPage({ error, csrf: a.session.csrf, email: a.user.email, secret, qrSvg: qrSvg.replace(/<\?xml[^>]*>/, '') }), status)
  }

  app.get('/2fa/setup', async (c) => {
    const a = auth(c)
    if (!a) return c.redirect('/login')
    if (a.session.stage !== 'setup') return home(c) ?? c.redirect('/')
    return setupView(c, a)
  })

  app.post('/2fa/setup', async (c) => {
    const a = auth(c)
    if (!a || a.session.stage !== 'setup') return c.redirect('/login')
    const { s } = await form(c)
    if (!csrfOk(c, s('csrf'))) return c.text('Jeton invalide', 403)
    if (!noteMfaAttempt(db, a.session)) {
      deleteCookie(c, COOKIE, { path: '/' })
      return html(c, loginPage({ error: 'Trop d\'essais. Reconnecte-toi.', canSignup: signupOpen() }), 429)
    }
    const codes = confirmTotpSetup(db, a.user.id, s('code'))
    if (!codes) return setupView(c, a, 'Code incorrect. Verifie l\'heure de ton telephone et reessaie.', 400)
    const { token } = promoteSession(db, a.token, a.user.id, 'full', ua(c))
    startSession(c, token, true)
    return html(c, recoveryPage({ codes }))
  })

  // Verification A2F a la connexion --------------------------------------------------------------------------------------------
  app.get('/login/2fa', (c) => {
    const a = auth(c)
    if (!a) return c.redirect('/login')
    if (a.session.stage !== 'mfa') return home(c) ?? c.redirect('/')
    return html(c, mfaPage({ csrf: a.session.csrf, email: a.user.email }))
  })

  app.post('/login/2fa', async (c) => {
    const a = auth(c)
    if (!a || a.session.stage !== 'mfa') return c.redirect('/login')
    const { s } = await form(c)
    if (!csrfOk(c, s('csrf'))) return c.text('Jeton invalide', 403)
    const stillAllowed = noteMfaAttempt(db, a.session)
    const method = verifySecondFactor(db, a.user.id, s('code'))
    if (!method) {
      if (!stillAllowed) {
        deleteCookie(c, COOKIE, { path: '/' })
        return html(c, loginPage({ error: `Trop de codes incorrects (${MAX_MFA_ATTEMPTS}). Reconnecte-toi.`, canSignup: signupOpen() }), 429)
      }
      return html(c, mfaPage({ csrf: a.session.csrf, email: a.user.email, error: 'Code incorrect ou deja utilise.' }), 401)
    }
    const { token } = promoteSession(db, a.token, a.user.id, 'full', ua(c))
    startSession(c, token, true)
    purgeExpiredSessions(db)
    return c.redirect('/')
  })

  // Deconnexion ------------------------------------------------------------------------------------------------------------------
  app.post('/logout', async (c) => {
    const a = auth(c)
    if (a) {
      const { s } = await form(c)
      if (!csrfOk(c, s('csrf'))) return c.text('Jeton invalide', 403)
      deleteSession(db, a.token)
    }
    deleteCookie(c, COOKIE, { path: '/' })
    return c.redirect('/login?out=1', 303)
  })

  app.post('/logout-all', async (c) => {
    const a = auth(c)
    if (!a || a.session.stage !== 'full') return c.redirect('/login')
    const { s } = await form(c)
    if (!csrfOk(c, s('csrf'))) return c.text('Jeton invalide', 403)
    deleteUserSessions(db, a.user.id, a.session.id)
    return c.redirect('/account?others=1', 303)
  })

  app.notFound((c) => c.text('Page introuvable', 404))
  app.onError((err, c) => {
    console.error('[host] erreur', err)
    return c.text('Erreur interne', 500)
  })

  return app
}
