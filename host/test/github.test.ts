import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createSession, createUser } from '../src/auth.ts'
import { getConnection, getToken } from '../src/github-connection.ts'
import { fakeGithub } from './fake-github.ts'
import { client, csrfOf, registerAndEnable } from './helpers.ts'

async function loggedIn(gh = fakeGithub()) {
  const c = client({ githubFor: gh.githubFor })
  await registerAndEnable(c)
  const csrf = csrfOf((await c.call('GET', '/account')).text)
  return { c, csrf, gh }
}

test('la page Compte propose de connecter GitHub', async () => {
  const { c } = await loggedIn()
  const page = (await c.call('GET', '/account')).text
  assert.match(page, /Connecter GitHub/)
  assert.match(page, /type="password" name="token"/)
})

test('connexion : le jeton est verifie, chiffre en base et jamais reaffiche', async () => {
  const { c, csrf, gh } = await loggedIn(fakeGithub({ login: 'tanguy-dev' }))
  const r = await c.call('POST', '/account/github', { csrf, token: 'github_pat_SECRET123' })
  assert.equal(r.res.status, 303)
  assert.equal(r.res.headers.get('location'), '/account?g=connected')
  assert.equal(gh.calls[0].url, 'https://api.github.com/user')
  assert.equal((gh.calls[0].init.headers as Record<string, string>).authorization, 'Bearer github_pat_SECRET123')

  const userId = (c.db.prepare('SELECT id FROM users').get() as { id: number }).id
  assert.equal(getConnection(c.db, userId)!.login, 'tanguy-dev')
  assert.equal(getToken(c.db, userId), 'github_pat_SECRET123')
  assert.doesNotMatch((c.db.prepare('SELECT token_enc FROM github_connections').get() as { token_enc: string }).token_enc, /SECRET123/)

  for (const path of ['/account', '/account?g=connected', '/projects/new', '/projects']) {
    assert.doesNotMatch((await c.call('GET', path)).text, /SECRET123/, path)
  }
  const page = (await c.call('GET', '/account?g=connected')).text
  assert.match(page, /tanguy-dev/)
  assert.match(page, /GitHub connecte/)
})

test('jeton refuse par GitHub : rien n\'est enregistre', async () => {
  const { c, csrf } = await loggedIn(fakeGithub({ userStatus: 401 }))
  const r = await c.call('POST', '/account/github', { csrf, token: 'mauvais' })
  assert.equal(r.res.status, 400)
  assert.match(r.text, /jeton GitHub invalide/)
  assert.equal(c.db.prepare('SELECT COUNT(*) AS n FROM github_connections').get()!.n, 0)
})

test('jeton vide ou avec des espaces refuse sans appeler GitHub', async () => {
  const { c, csrf, gh } = await loggedIn()
  assert.equal((await c.call('POST', '/account/github', { csrf, token: '   ' })).res.status, 400)
  assert.equal((await c.call('POST', '/account/github', { csrf, token: 'a b' })).res.status, 400)
  assert.equal(gh.calls.length, 0)
})

test('reglages du template : enregistres, valides, preremplissent le formulaire projet', async () => {
  const { c, csrf } = await loggedIn(fakeGithub({ login: 'tanguy-dev' }))
  await c.call('POST', '/account/github', { csrf, token: 'tok' })
  assert.equal((await c.call('POST', '/account/github/settings', { csrf, template: 'pas valide', owner: '' })).res.status, 400)
  assert.equal((await c.call('POST', '/account/github/settings', { csrf, template: 'acme/tpl', owner: 'bad owner!' })).res.status, 400)
  const ok = await c.call('POST', '/account/github/settings', { csrf, template: 'acme/roblox-ts-template', owner: 'my-org' })
  assert.equal(ok.res.status, 303)
  const form = (await c.call('GET', '/projects/new')).text
  assert.match(form, /value="acme\/roblox-ts-template"/)
  assert.match(form, /value="my-org"/)
  // une reconnexion (nouveau jeton) garde les reglages
  await c.call('POST', '/account/github', { csrf, token: 'tok2' })
  assert.match((await c.call('GET', '/projects/new')).text, /value="acme\/roblox-ts-template"/)
})

test('le proprietaire par defaut est le compte GitHub connecte', async () => {
  const { c, csrf } = await loggedIn(fakeGithub({ login: 'tanguy-dev' }))
  await c.call('POST', '/account/github', { csrf, token: 'tok' })
  assert.match((await c.call('GET', '/projects/new')).text, /name="owner" value="tanguy-dev"/)
})

test('deconnexion de GitHub : le jeton est supprime', async () => {
  const { c, csrf } = await loggedIn()
  await c.call('POST', '/account/github', { csrf, token: 'tok' })
  const r = await c.call('POST', '/account/github/disconnect', { csrf })
  assert.equal(r.res.status, 303)
  assert.equal(c.db.prepare('SELECT COUNT(*) AS n FROM github_connections').get()!.n, 0)
})

test('CSRF exige, et chaque utilisateur a sa propre connexion', async () => {
  const { c, csrf } = await loggedIn()
  assert.equal((await c.call('POST', '/account/github', { csrf: 'faux', token: 'tok' })).res.status, 403)
  await c.call('POST', '/account/github', { csrf, token: 'token-de-tanguy' })

  const other = await createUser(c.db, 'benoit@example.com', 'another long password')
  const { token, session } = createSession(c.db, other.id, 'full')
  c.setCookie(`sid=${token}`)
  const page = (await c.call('GET', '/account')).text
  assert.match(page, /Connecter GitHub/) // Benoit n'est pas connecte...
  assert.doesNotMatch(page, /token-de-tanguy/)
  // ...et ses actions ne touchent pas la connexion de Tanguy
  await c.call('POST', '/account/github/disconnect', { csrf: session.csrf })
  assert.equal(c.db.prepare('SELECT COUNT(*) AS n FROM github_connections').get()!.n, 1)
  // un projet de Benoit ne peut pas utiliser le jeton de Tanguy
  const r = await c.call('POST', '/projects', { csrf: session.csrf, name: 'Projet de Benoit', repoMode: 'template', template: 'acme/tpl' })
  assert.equal(r.res.status, 400)
  assert.match(r.text, /Connecte d(?:'|&#39;)abord/)
})

test('sans session complete, les routes GitHub renvoient vers la connexion', async () => {
  const c = client()
  for (const path of ['/account/github', '/account/github/settings', '/account/github/disconnect']) {
    const r = await c.call('POST', path, { csrf: 'x', token: 'x' })
    assert.equal(r.res.status, 302, path)
  }
})
