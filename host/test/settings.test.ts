import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createSession, createUser } from '../src/auth.ts'
import { config } from '../src/config.ts'
import { KEYS, getSetting } from '../src/settings.ts'
import { fakeRoblox } from './fake-roblox.ts'
import { client, csrfOf, registerAndEnable } from './helpers.ts'
import { connectRoblox } from './roblox-helpers.ts'

// Instance SANS identifiants Roblox : le client par defaut lit les reglages en base (le faux Roblox sert de reseau).
async function setup() {
  const rb = fakeRoblox()
  const c = client({ robloxFetch: rb.fetchImpl })
  await registerAndEnable(c)
  const csrf = csrfOf((await c.call('GET', '/settings')).text)
  return { c, csrf, rb }
}
const save = (c: ReturnType<typeof client>, csrf: string, f: Record<string, string> = {}) =>
  c.call('POST', '/settings/roblox', { csrf, clientId: 'cid-placeholder', clientSecret: 'secret', scopes: 'openid profile group:read', ...f })
// Le faux Roblox n'accepte que client_id = "cid" et secret = "secret", alors que le formulaire exige un Client ID numerique :
// on enregistre ces valeurs directement en base (la validation du formulaire a ses propres tests).
function storeFakeCreds(c: ReturnType<typeof client>) {
  c.db.exec('DELETE FROM settings')
  return import('../src/settings.ts').then(({ setSetting }) => {
    setSetting(c.db, KEYS.robloxClientId, 'cid')
    setSetting(c.db, KEYS.robloxClientSecret, 'secret')
    setSetting(c.db, KEYS.robloxScopes, 'openid profile group:read')
  })
}

test('le premier compte est administrateur, pas les suivants', async () => {
  const { c } = await setup()
  const rows = () => c.db.prepare('SELECT email, is_admin FROM users ORDER BY id').all() as { email: string; is_admin: number }[]
  assert.deepEqual(rows().map((r) => r.is_admin), [1])
  await createUser(c.db, 'benoit@example.com', 'another long password')
  assert.deepEqual(rows().map((r) => r.is_admin), [1, 0])
  assert.match((await c.call('GET', '/projects')).text, /href="\/settings"/) // lien « Reglages » pour l'admin
})

test('Reglages : invisibles et inaccessibles pour un non-administrateur', async () => {
  const { c } = await setup()
  const other = await createUser(c.db, 'benoit@example.com', 'another long password')
  const { token, session } = createSession(c.db, other.id, 'full')
  c.setCookie(`sid=${token}`)
  assert.doesNotMatch((await c.call('GET', '/projects')).text, /href="\/settings"/)
  assert.equal((await c.call('GET', '/settings')).res.status, 404)
  for (const path of ['/settings/roblox', '/settings/roblox/check', '/settings/roblox/clear']) {
    assert.equal((await c.call('POST', path, { csrf: session.csrf, clientId: '12345', clientSecret: 'x', scopes: 'openid' })).res.status, 404, path)
  }
  assert.equal(c.db.prepare('SELECT COUNT(*) AS n FROM settings').get()!.n, 0)
  // et la carte Roblox lui explique a qui s'adresser
  const account = (await c.call('GET', '/account')).text
  assert.match(account, /Demande a l(?:'|&#39;)administrateur/)
  assert.doesNotMatch(account, /href="\/settings"/)
})

test('Reglages : sans session complete, redirection vers la connexion', async () => {
  const c = client()
  const r = await c.call('GET', '/settings')
  assert.equal(r.res.status, 302)
  assert.equal(r.res.headers.get('location'), '/login')
})

test('Reglages : page de l\'admin (adresse de redirection, permissions, etat « non configure »)', async () => {
  const { c } = await setup()
  const page = (await c.call('GET', '/settings')).text
  assert.match(page, /Non configure/)
  assert.match(page, /http:\/\/localhost:3000\/account\/roblox\/callback/)
  assert.match(page, /openid profile group:read universe.place:read universe.place:write/)
  assert.doesNotMatch(page, /Verifier les identifiants/) // rien a verifier tant que ce n'est pas configure
  assert.match((await c.call('GET', '/account')).text, /Configure-la dans les Reglages/)
})

test('enregistrement : chiffre en base, jamais reaffiche, actif sans redemarrer', async () => {
  const { c, csrf } = await setup()
  const r = await save(c, csrf, { clientId: '816547628409595165', clientSecret: 'RBX-SUPER-SECRET', scopes: 'openid  profile group:read' })
  assert.equal(r.res.status, 303)
  assert.equal(r.res.headers.get('location'), '/settings?n=saved')
  assert.equal(getSetting(c.db, KEYS.robloxClientId), '816547628409595165')
  assert.equal(getSetting(c.db, KEYS.robloxClientSecret), 'RBX-SUPER-SECRET')
  assert.equal(getSetting(c.db, KEYS.robloxScopes), 'openid profile group:read') // espaces normalises
  const raw = c.db.prepare('SELECT value_enc FROM settings').all() as { value_enc: string }[]
  for (const row of raw) assert.doesNotMatch(row.value_enc, /RBX-SUPER-SECRET|816547628409595165/)

  for (const path of ['/settings', '/settings?n=saved', '/account', '/projects/new']) {
    assert.doesNotMatch((await c.call('GET', path)).text, /RBX-SUPER-SECRET/, path)
  }
  const page = (await c.call('GET', '/settings?n=saved')).text
  assert.match(page, /Reglages enregistres/)
  assert.match(page, /value="816547628409595165"/)
  assert.match(page, /deja enregistre/)
  // le bouton « Connecter » apparait tout de suite, avec les permissions enregistrees
  const account = (await c.call('GET', '/account')).text
  assert.match(account, /Connecter un compte Roblox/)
  const start = await c.call('GET', '/account/roblox/connect')
  assert.equal(start.res.status, 302)
  const q = new URL(start.res.headers.get('location')!).searchParams
  assert.equal(q.get('client_id'), '816547628409595165')
  assert.equal(q.get('scope'), 'openid profile group:read')
})

test('enregistrement : secret conserve si le champ est vide, valeurs invalides refusees', async () => {
  const { c, csrf } = await setup()
  assert.equal((await save(c, csrf, { clientSecret: '' })).res.status, 400) // premier enregistrement : secret obligatoire
  assert.equal((await save(c, csrf, { clientId: 'abc' })).res.status, 400)
  assert.equal((await save(c, csrf, { scopes: '' })).res.status, 400)
  assert.equal((await save(c, csrf, { scopes: 'openid;rm -rf' })).res.status, 400)
  assert.equal((await save(c, csrf, { clientSecret: 'a b' })).res.status, 400)
  assert.equal((await c.call('POST', '/settings/roblox', { csrf: 'faux', clientId: '12345', clientSecret: 'x', scopes: 'openid' })).res.status, 403)
  assert.equal(c.db.prepare('SELECT COUNT(*) AS n FROM settings').get()!.n, 0)

  await save(c, csrf, { clientId: '11111', clientSecret: 'premier-secret' })
  assert.equal((await save(c, csrf, { clientId: '22222', clientSecret: '' })).res.status, 303)
  assert.equal(getSetting(c.db, KEYS.robloxClientId), '22222')
  assert.equal(getSetting(c.db, KEYS.robloxClientSecret), 'premier-secret') // inchange
  assert.equal((await save(c, csrf, { clientId: '22222', clientSecret: 'nouveau-secret' })).res.status, 303)
  assert.equal(getSetting(c.db, KEYS.robloxClientSecret), 'nouveau-secret')
})

test('connexion de bout en bout avec des identifiants saisis dans les Reglages', async () => {
  const { c } = await setup()
  await storeFakeCreds(c)
  const flow = await connectRoblox(c)
  assert.equal(flow.back.res.status, 303)
  assert.equal(flow.accountId !== undefined, true)
  assert.match((await c.call('GET', '/account')).text, /@tanguy_dev/)
})

test('verification des identifiants aupres de Roblox', async () => {
  const { c, csrf } = await setup()
  await storeFakeCreds(c)
  const ok = await c.call('POST', '/settings/roblox/check', { csrf })
  assert.equal(ok.res.status, 200)
  assert.match(ok.text, /Roblox accepte ces identifiants/)

  await save(c, csrf, { clientId: '99999', clientSecret: 'mauvais-secret' })
  const bad = await c.call('POST', '/settings/roblox/check', { csrf })
  assert.equal(bad.res.status, 400)
  assert.match(bad.text, /Roblox refuse ces identifiants/)
  assert.equal((await c.call('POST', '/settings/roblox/check', { csrf: 'faux' })).res.status, 403)
})

test('suppression de la configuration', async () => {
  const { c, csrf } = await setup()
  await storeFakeCreds(c)
  assert.match((await c.call('GET', '/account')).text, /Connecter un compte Roblox/)
  const r = await c.call('POST', '/settings/roblox/clear', { csrf })
  assert.equal(r.res.status, 303)
  assert.equal(c.db.prepare('SELECT COUNT(*) AS n FROM settings').get()!.n, 0)
  assert.match((await c.call('GET', '/account')).text, /pas encore configuree/)
  assert.equal((await c.call('POST', '/settings/roblox/clear', { csrf: 'faux' })).res.status, 403)
})

test('le .env reste une solution de secours, la base a priorite', async () => {
  const { c, csrf } = await setup()
  const saved = { id: config.robloxClientId, secret: config.robloxClientSecret }
  try {
    config.robloxClientId = 'cid'
    config.robloxClientSecret = 'secret'
    const page = (await c.call('GET', '/settings')).text
    assert.match(page, /Configure via le fichier .env/)
    assert.match((await c.call('GET', '/account')).text, /Connecter un compte Roblox/)
    assert.match((await c.call('POST', '/settings/roblox/check', { csrf })).text, /Roblox accepte/)
    // la base prime : des identifiants faux en base l'emportent sur le .env
    await save(c, csrf, { clientId: '99999', clientSecret: 'autre' })
    assert.equal((await c.call('POST', '/settings/roblox/check', { csrf })).res.status, 400)
  } finally {
    config.robloxClientId = saved.id
    config.robloxClientSecret = saved.secret
  }
})
