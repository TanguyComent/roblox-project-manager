import { createApp } from '../src/app.ts'
import { decryptSecret, totpAt, TOTP_STEP } from '../src/crypto.ts'
import { openDb } from '../src/db.ts'
import { resetRobloxCaches } from '../src/roblox-accounts.ts'
import { WorkerHub } from '../src/worker-hub.ts'

export const ORIGIN = 'http://localhost:3000'

export function client(opts: Parameters<typeof createApp>[1] = {}) {
  resetRobloxCaches()
  const db = openDb(':memory:')
  const hub = new WorkerHub(db)
  const app = createApp(db, { hub, ...opts })
  let cookie = ''
  const call = async (method: string, path: string, body?: Record<string, string>, headers: Record<string, string> = {}) => {
    const res = await app.request(`${ORIGIN}${path}`, {
      method,
      headers: { host: 'localhost:3000', origin: ORIGIN, ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/x-www-form-urlencoded' } : {}), ...headers },
      body: body ? new URLSearchParams(body).toString() : undefined,
      redirect: 'manual',
    })
    const set = res.headers.get('set-cookie')
    if (set) cookie = set.startsWith('sid=;') || /max-age=0/i.test(set) ? '' : set.split(';')[0]
    return { res, text: await res.text() }
  }
  return { db, app, hub, call, setCookie: (c: string) => { cookie = c }, getCookie: () => cookie }
}

export const csrfOf = (html: string) => /name="csrf" value="([^"]+)"/.exec(html)![1]
export const secretOf = (db: ReturnType<typeof openDb>) =>
  decryptSecret((db.prepare('SELECT totp_secret FROM users').get() as { totp_secret: string }).totp_secret)
export const step = () => Math.floor(Date.now() / 1000 / TOTP_STEP)

export async function registerAndEnable(c: ReturnType<typeof client>, email = 'me@example.com', password = 'correct horse battery') {
  await c.call('POST', '/register', { email, password, confirm: password })
  const setup = await c.call('GET', '/2fa/setup')
  const used = step() // pas de 30 s utilise pour l'activation (un meme pas ne peut pas servir deux fois)
  const done = await c.call('POST', '/2fa/setup', { csrf: csrfOf(setup.text), code: totpAt(secretOf(c.db), used) })
  const codes = [...done.text.matchAll(/<code>([a-z0-9]{5}-[a-z0-9]{5})<\/code>/g)].map((m) => m[1])
  return { done, codes, password, email, step: used }
}

