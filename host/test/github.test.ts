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

test('proprietaire des nouveaux depots : valide et enregistre', async () => {
  const { c, csrf } = await loggedIn(fakeGithub({ login: 'tanguy-dev' }))
  await c.call('POST', '/account/github', { csrf, token: 'tok' })
  assert.equal((await c.call('POST', '/account/github/settings', { csrf, owner: 'bad owner!' })).res.status, 400)
  assert.equal((await c.call('POST', '/account/github/settings', { csrf, owner: 'my-org' })).res.status, 303)
  assert.match((await c.call('GET', '/projects/new')).text, /name="owner" value="my-org"/)
})

test('choix du template : liste des depots (templates d\'abord) puis branches', async () => {
  const { c, csrf } = await loggedIn()
  await c.call('POST', '/account/github', { csrf, token: 'tok' })
  const step1 = await c.call('GET', '/account/github/template')
  assert.equal(step1.res.status, 200)
  const templates = step1.text.slice(step1.text.indexOf('marques'), step1.text.indexOf('Autres depots'))
  assert.match(templates, /acme\/roblox-template/)
  assert.match(templates, /acme\/old-template/)
  assert.match(templates, /\(prive\)/)
  assert.match(step1.text.slice(step1.text.indexOf('Autres depots')), /acme\/notes/)
  assert.match(step1.text, /Choisis d'abord un depot|Choisis d&#39;abord un depot/)

  const step2 = await c.call('GET', '/account/github/template?repo=acme/roblox-template')
  assert.match(step2.text, /<option value="main" selected>main<\/option>/)
  assert.match(step2.text, /<option value="v2">v2<\/option>/)
  assert.match(step2.text, /<option value="legacy">legacy<\/option>/)
  // un autre depot : sa branche par defaut est preselectionnee
  assert.match((await c.call('GET', '/account/github/template?repo=acme/old-template')).text, /<option value="master" selected>master<\/option>/)
})

test('choix du template : enregistrement, preselection, prefill du formulaire projet', async () => {
  const { c, csrf } = await loggedIn()
  await c.call('POST', '/account/github', { csrf, token: 'tok' })
  const save = await c.call('POST', '/account/github/template', { csrf, repo: 'acme/roblox-template', branch: 'v2' })
  assert.equal(save.res.status, 303)
  assert.equal(save.res.headers.get('location'), '/account?g=template')

  const account = (await c.call('GET', '/account?g=template')).text
  assert.match(account, /acme\/roblox-template/)
  assert.match(account, /<code>v2<\/code>/)
  assert.match(account, /Template par defaut enregistre/)
  // la page de choix preselectionne le template et la branche enregistres
  const picker = (await c.call('GET', '/account/github/template')).text
  assert.match(picker, /<option value="acme\/roblox-template" selected>/)
  assert.match(picker, /<option value="v2" selected>v2<\/option>/)
  // le formulaire de projet est prerempli
  const form = (await c.call('GET', '/projects/new')).text
  assert.match(form, /name="template" value="acme\/roblox-template"/)
  assert.match(form, /name="branch" value="v2"/)
})

test('choix du template : branche inconnue, depot invalide, erreur GitHub', async () => {
  const { c, csrf } = await loggedIn()
  await c.call('POST', '/account/github', { csrf, token: 'tok' })
  const noBranch = await c.call('POST', '/account/github/template', { csrf, repo: 'acme/roblox-template', branch: 'inexistante' })
  assert.equal(noBranch.res.status, 400)
  assert.match(noBranch.text, /n(?:'|&#39;)existe pas/)
  assert.equal((await c.call('POST', '/account/github/template', { csrf, repo: '../../etc', branch: 'main' })).res.status, 400)
  const unknown = await c.call('POST', '/account/github/template', { csrf, repo: 'acme/introuvable', branch: 'main' })
  assert.equal(unknown.res.status, 502)
  assert.match(unknown.text, /depot introuvable/)
  assert.equal((c.db.prepare('SELECT template_repo FROM github_connections').get() as { template_repo: string | null }).template_repo, null)
  assert.equal((await c.call('POST', '/account/github/template', { csrf: 'faux', repo: 'acme/roblox-template', branch: 'main' })).res.status, 403)
})

test('retirer le template par defaut', async () => {
  const { c, csrf } = await loggedIn()
  await c.call('POST', '/account/github', { csrf, token: 'tok' })
  await c.call('POST', '/account/github/template', { csrf, repo: 'acme/roblox-template', branch: 'main' })
  assert.equal((await c.call('POST', '/account/github/template/clear', { csrf })).res.status, 303)
  assert.match((await c.call('GET', '/account')).text, /Choisir un template/)
  assert.match((await c.call('GET', '/projects/new')).text, /name="template" value=""/)
})

test('la page de choix exige GitHub connecte', async () => {
  const { c } = await loggedIn()
  const r = await c.call('GET', '/account/github/template')
  assert.equal(r.res.status, 303)
  assert.equal(r.res.headers.get('location'), '/account')
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
  const benoitAccount = Number(c.db.prepare("INSERT INTO roblox_accounts (user_id, label, api_key_enc, key_hash, roblox_user_id, username, status, checked_at, created_at) VALUES (?, 'benoit', 'x', 'h', '2000', 'benoit', 'ok', 0, 0)").run(other.id).lastInsertRowid)
  const r = await c.call('POST', '/projects', { csrf: session.csrf, name: 'Projet de Benoit', robloxAccountId: String(benoitAccount), repoMode: 'template', template: 'acme/tpl' })
  assert.equal(r.res.status, 400)
  assert.match(r.text, /Connecte d(?:'|&#39;)abord ton compte GitHub/)
})

test('sans session complete, les routes GitHub renvoient vers la connexion', async () => {
  const c = client()
  for (const path of ['/account/github', '/account/github/settings', '/account/github/disconnect']) {
    const r = await c.call('POST', path, { csrf: 'x', token: 'x' })
    assert.equal(r.res.status, 302, path)
  }
})

// --- depot de maquette UI (second reglage, meme parcours que le template des projets) -----------------------------------------------------

test('depot de maquette UI : liste des depots, branches, enregistrement, preselection', async () => {
  const { c, csrf } = await loggedIn()
  await c.call('POST', '/account/github', { csrf, token: 'tok' })
  assert.match((await c.call('GET', '/account')).text, /Choisir un depot de maquette/)

  const step1 = await c.call('GET', '/account/github/ui-template')
  assert.equal(step1.res.status, 200)
  assert.match(step1.text, /<h1>Depot de maquette UI<\/h1>/)
  assert.match(step1.text, /action="\/account\/github\/ui-template"/, 'le formulaire envoie vers ce reglage, pas vers celui des projets')
  assert.match(step1.text, /acme\/roblox-template/)
  const step2 = await c.call('GET', '/account/github/ui-template?repo=acme/roblox-template')
  assert.match(step2.text, /<option value="v2">v2<\/option>/)
  assert.match(step2.text, /jamais modifie ni pousse|Chaque maquette part de cette branche/)

  const save = await c.call('POST', '/account/github/ui-template', { csrf, repo: 'acme/roblox-template', branch: 'v2' })
  assert.equal(save.res.status, 303)
  assert.equal(save.res.headers.get('location'), '/account?g=ui-template')
  const account = (await c.call('GET', '/account?g=ui-template')).text
  assert.match(account, /Depot de maquette UI enregistre/)
  assert.match(account, /<strong>acme\/roblox-template<\/strong>[^]*<code>v2<\/code>[^]*href="\/account\/github\/ui-template">Changer/)
  const picker = (await c.call('GET', '/account/github/ui-template')).text
  assert.match(picker, /<option value="acme\/roblox-template" selected>/)
  assert.match(picker, /<option value="v2" selected>v2<\/option>/)

  const conn = getConnection(c.db, (c.db.prepare('SELECT id FROM users').get() as { id: number }).id)!
  assert.deepEqual([conn.ui_template_repo, conn.ui_template_branch], ['acme/roblox-template', 'v2'])
  assert.equal(conn.template_repo, null, 'le template des projets n\'est pas touche')
})

test('les deux templates sont independants', async () => {
  const { c, csrf } = await loggedIn()
  await c.call('POST', '/account/github', { csrf, token: 'tok' })
  await c.call('POST', '/account/github/template', { csrf, repo: 'acme/roblox-template', branch: 'main' })
  await c.call('POST', '/account/github/ui-template', { csrf, repo: 'acme/old-template', branch: 'master' })
  const conn = getConnection(c.db, (c.db.prepare('SELECT id FROM users').get() as { id: number }).id)!
  assert.deepEqual([conn.template_repo, conn.template_branch, conn.ui_template_repo, conn.ui_template_branch], ['acme/roblox-template', 'main', 'acme/old-template', 'master'])
  // retirer l'un laisse l'autre
  assert.equal((await c.call('POST', '/account/github/ui-template/clear', { csrf })).res.headers.get('location'), '/account?g=ui-template-cleared')
  const after = getConnection(c.db, conn.user_id)!
  assert.deepEqual([after.template_repo, after.ui_template_repo], ['acme/roblox-template', null])
  assert.match((await c.call('GET', '/account?g=ui-template-cleared')).text, /Depot de maquette UI retire/)
  // le formulaire de nouveau projet ne prend QUE le template des projets
  assert.match((await c.call('GET', '/projects/new')).text, /name="template" value="acme\/roblox-template"/)
})

test('depot de maquette UI : branche inconnue, depot invalide, jeton CSRF, GitHub non connecte', async () => {
  const { c, csrf } = await loggedIn()
  assert.equal((await c.call('GET', '/account/github/ui-template')).res.status, 303, 'GitHub doit etre connecte')
  await c.call('POST', '/account/github', { csrf, token: 'tok' })
  const noBranch = await c.call('POST', '/account/github/ui-template', { csrf, repo: 'acme/roblox-template', branch: 'inexistante' })
  assert.equal(noBranch.res.status, 400)
  assert.match(noBranch.text, /n(?:'|&#39;)existe pas/)
  assert.equal((await c.call('POST', '/account/github/ui-template', { csrf, repo: '../../etc', branch: 'main' })).res.status, 400)
  assert.equal((await c.call('POST', '/account/github/ui-template', { csrf, repo: 'acme/introuvable', branch: 'main' })).res.status, 502)
  assert.equal((await c.call('POST', '/account/github/ui-template', { csrf: 'faux', repo: 'acme/roblox-template', branch: 'main' })).res.status, 403)
  assert.equal((await c.call('POST', '/account/github/ui-template/clear', { csrf: 'faux' })).res.status, 403)
  assert.equal((c.db.prepare('SELECT ui_template_repo FROM github_connections').get() as { ui_template_repo: string | null }).ui_template_repo, null)
})
