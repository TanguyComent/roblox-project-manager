import assert from 'node:assert/strict'
import { test } from 'node:test'
import { base32Decode, base32Encode, totpAt, verifyTotp } from '../src/crypto.ts'
import { client, csrfOf, registerAndEnable, secretOf, step } from './helpers.ts'

test('TOTP : vecteur RFC 6238 et base32', () => {
  const secret = base32Encode(Buffer.from('12345678901234567890'))
  assert.equal(secret, 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ')
  assert.equal(totpAt(secret, Math.floor(59 / 30)), '287082')
  assert.equal(totpAt(secret, Math.floor(1111111109 / 30)), '081804')
  assert.deepEqual(base32Decode(secret), Buffer.from('12345678901234567890'))
  assert.equal(verifyTotp(secret, '287 082', 59_000), Math.floor(59 / 30))
  assert.equal(verifyTotp(secret, '000000', 59_000), null)
})

test('la page de connexion est servie avec des en-tetes de securite', async () => {
  const { call } = client()
  const { res, text } = await call('GET', '/login')
  assert.equal(res.status, 200)
  assert.match(text, /Connexion/)
  assert.match(res.headers.get('content-security-policy')!, /default-src 'none'/)
  assert.equal(res.headers.get('x-frame-options'), 'DENY')
})

test('une page protegee renvoie vers la connexion', async () => {
  const { call } = client()
  const { res } = await call('GET', '/')
  assert.equal(res.status, 302)
  assert.equal(res.headers.get('location'), '/login')
})

test('inscription -> A2F obligatoire -> codes de secours -> accueil', async () => {
  const c = client()
  const r = await c.call('POST', '/register', { email: 'Me@Example.com', password: 'correct horse battery', confirm: 'correct horse battery' })
  assert.equal(r.res.status, 302)
  assert.equal(r.res.headers.get('location'), '/2fa/setup')
  assert.match(r.res.headers.get('set-cookie')!, /HttpOnly/i)
  assert.match(r.res.headers.get('set-cookie')!, /SameSite=Lax/i)
  // tant que l'A2F n'est pas active, l'accueil est inaccessible
  assert.equal((await c.call('GET', '/')).res.headers.get('location'), '/2fa/setup')
  const setup = await c.call('GET', '/2fa/setup')
  assert.match(setup.text, /<svg/)
  // mauvais code
  const bad = await c.call('POST', '/2fa/setup', { csrf: csrfOf(setup.text), code: '000000' })
  assert.equal(bad.res.status, 400)
  const ok = await c.call('POST', '/2fa/setup', { csrf: csrfOf(setup.text), code: totpAt(secretOf(c.db), step()) })
  assert.equal(ok.res.status, 200)
  assert.equal([...ok.text.matchAll(/<code>/g)].length, 10)
  assert.equal((await c.call('GET', '/')).res.headers.get('location'), '/projects')
  const home = await c.call('GET', '/account')
  assert.equal(home.res.status, 200)
  assert.match(home.text, /me@example\.com/)
  assert.match(home.text, /10 \/ 10/)
})

test('le secret A2F est chiffre en base', async () => {
  const c = client()
  await registerAndEnable(c)
  const raw = (c.db.prepare('SELECT totp_secret, password_hash FROM users').get() as { totp_secret: string; password_hash: string })
  assert.notEqual(raw.totp_secret, secretOf(c.db))
  assert.match(raw.password_hash, /^scrypt\$/)
})

test('deconnexion : le cookie cesse de fonctionner, CSRF exige', async () => {
  const c = client()
  await registerAndEnable(c)
  const home = await c.call('GET', '/account')
  const cookie = c.getCookie()
  assert.equal((await c.call('POST', '/logout', { csrf: 'faux' })).res.status, 403)
  assert.equal((await c.call('GET', '/account')).res.status, 200)
  const out = await c.call('POST', '/logout', { csrf: csrfOf(home.text) })
  assert.equal(out.res.status, 303)
  assert.equal(out.res.headers.get('location'), '/login?out=1')
  assert.match((await c.call('GET', '/login?out=1')).text, /deconnecte/)
  c.setCookie(cookie) // un ancien cookie vole ne doit plus servir
  assert.equal((await c.call('GET', '/')).res.headers.get('location'), '/login')
})

test('connexion avec mot de passe + code A2F, le rejeu d\'un code est refuse', async () => {
  const c = client()
  const { password, email } = await registerAndEnable(c)
  const home = await c.call('GET', '/account')
  await c.call('POST', '/logout', { csrf: csrfOf(home.text) })

  const wrong = await c.call('POST', '/login', { email, password: 'mauvais mot de passe' })
  assert.equal(wrong.res.status, 401)
  assert.match(wrong.text, /incorrect/)

  const login = await c.call('POST', '/login', { email, password })
  assert.equal(login.res.headers.get('location'), '/login/2fa')
  // pas d'acces tant que le 2e facteur manque
  assert.equal((await c.call('GET', '/')).res.headers.get('location'), '/login/2fa')
  const page = await c.call('GET', '/login/2fa')
  // le code du pas actuel a deja servi a l'activation : refuse (rejeu)
  const replay = await c.call('POST', '/login/2fa', { csrf: csrfOf(page.text), code: totpAt(secretOf(c.db), step()) })
  assert.equal(replay.res.status, 401)
  const good = await c.call('POST', '/login/2fa', { csrf: csrfOf(page.text), code: totpAt(secretOf(c.db), step() + 1) })
  assert.equal(good.res.status, 302)
  assert.equal(good.res.headers.get('location'), '/')
  assert.equal((await c.call('GET', '/account')).res.status, 200)
})

test('code de secours : valable une seule fois', async () => {
  const c = client()
  const { password, email, codes } = await registerAndEnable(c)
  for (let i = 0; i < 2; i++) {
    const home = await c.call('GET', '/account')
    if (i === 0) await c.call('POST', '/logout', { csrf: csrfOf(home.text) })
    else await c.call('POST', '/logout', { csrf: csrfOf(home.text) })
    await c.call('POST', '/login', { email, password })
    const page = await c.call('GET', '/login/2fa')
    const r = await c.call('POST', '/login/2fa', { csrf: csrfOf(page.text), code: codes[0] })
    if (i === 0) {
      assert.equal(r.res.status, 302, 'premiere utilisation acceptee')
      assert.match((await c.call('GET', '/account')).text, /9 \/ 10/)
    } else {
      assert.equal(r.res.status, 401, 'deuxieme utilisation refusee')
    }
  }
})

test('5 codes A2F faux detruisent la session', async () => {
  const c = client()
  const { password, email } = await registerAndEnable(c)
  const home = await c.call('GET', '/account')
  await c.call('POST', '/logout', { csrf: csrfOf(home.text) })
  await c.call('POST', '/login', { email, password })
  const page = await c.call('GET', '/login/2fa')
  const csrf = csrfOf(page.text)
  let last = 401
  for (let i = 0; i < 5; i++) last = (await c.call('POST', '/login/2fa', { csrf, code: '111111' })).res.status
  assert.equal(last, 429)
  assert.equal((await c.call('GET', '/login/2fa')).res.headers.get('location'), '/login')
})

test('limitation : 5 echecs sur un e-mail bloquent meme le bon mot de passe', async () => {
  const c = client()
  const { password, email } = await registerAndEnable(c)
  for (let i = 0; i < 5; i++) await c.call('POST', '/login', { email, password: 'incorrect-incorrect' })
  const blocked = await c.call('POST', '/login', { email, password })
  assert.equal(blocked.res.status, 429)
})

test('les formulaires venant d\'un autre site sont refuses', async () => {
  const { call } = client()
  const r = await call('POST', '/login', { email: 'a@b.fr', password: 'x' }, { origin: 'https://evil.example' })
  assert.equal(r.res.status, 403)
  const noOrigin = await call('POST', '/login', { email: 'a@b.fr', password: 'x' }, { origin: '' })
  assert.equal(noOrigin.res.status, 403)
})

test('inscriptions fermees apres le premier compte', async () => {
  const c = client()
  await registerAndEnable(c)
  c.setCookie('') // visiteur anonyme
  assert.equal((await c.call('GET', '/register')).res.status, 403)
  const post = await c.call('POST', '/register', { email: 'x@y.fr', password: 'another long password', confirm: 'another long password' })
  assert.equal(post.res.status, 403)
  assert.equal(c.db.prepare('SELECT COUNT(*) AS n FROM users').get()!.n, 1)
})

test('mots de passe faibles ou differents refuses', async () => {
  const { call } = client()
  assert.equal((await call('POST', '/register', { email: 'a@b.fr', password: 'court', confirm: 'court' })).res.status, 400)
  assert.equal((await call('POST', '/register', { email: 'a@b.fr', password: 'long enough password', confirm: 'long enough passworx' })).res.status, 400)
  assert.equal((await call('POST', '/register', { email: 'pas-un-email', password: 'long enough password', confirm: 'long enough password' })).res.status, 400)
})
