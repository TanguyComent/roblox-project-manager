import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createSession, createUser } from '../src/auth.ts'
import { parseRepo, parseRobloxId, slugify } from '../src/projects.ts'
import { fakeGithub } from './fake-github.ts'
import { fakeRoblox } from './fake-roblox.ts'
import { client, csrfOf, registerAndEnable } from './helpers.ts'
import { connectRoblox } from './roblox-helpers.ts'

type Client = ReturnType<typeof client>

// Utilisateur connecte, avec un compte Roblox deja connecte (faux Roblox : groupes 123456 et 777 autorises).
async function loggedIn(opts: Parameters<typeof client>[0] = {}) {
  const rb = fakeRoblox()
  const c = client({ roblox: rb.client, ...opts })
  await registerAndEnable(c)
  const csrf = csrfOf((await c.call('GET', '/projects')).text)
  await connectRoblox(c)
  return { c, csrf, rb }
}

const projectIdFrom = (res: Response) => Number(/\/projects\/(\d+)/.exec(res.headers.get('location') ?? '')![1])

async function newProject(c: Client, csrf: string, fields: Record<string, string> = {}) {
  const acc = c.db.prepare('SELECT id FROM roblox_accounts ORDER BY id LIMIT 1').get() as { id: number } | undefined
  return c.call('POST', '/projects', { csrf, name: 'Steal Treasure', repoMode: 'none', robloxAccountId: String(acc?.id ?? ''), ...fields })
}

test('helpers de validation', () => {
  assert.equal(slugify('Steal Treasure!'), 'steal-treasure')
  assert.equal(slugify('Épée & Bouclier'), 'epee-bouclier')
  assert.equal(slugify('***'), 'projet')
  assert.equal(parseRobloxId('123456'), 123456)
  assert.equal(parseRobloxId('12 3'), null)
  assert.equal(parseRobloxId('0'), null)
  assert.equal(parseRobloxId('99999999999999999'), null)
  assert.equal(parseRepo('https://github.com/TanguyComent/my-repo.git'), 'TanguyComent/my-repo')
  assert.equal(parseRepo('foo/bar'), 'foo/bar')
  assert.equal(parseRepo('pas un depot'), null)
  assert.equal(parseRepo('../../etc/passwd'), null)
})

test('les pages projets exigent une session complete', async () => {
  const c = client()
  for (const path of ['/projects', '/projects/new', '/projects/1']) {
    const r = await c.call('GET', path)
    assert.equal(r.res.status, 302, path)
    assert.equal(r.res.headers.get('location'), '/login', path)
  }
})

test('liste vide, creation, detail', async () => {
  const { c, csrf } = await loggedIn()
  assert.match((await c.call('GET', '/projects')).text, /Aucun projet/)
  const r = await newProject(c, csrf, { groupId: '123456', groupName: 'Boilr', repoMode: 'existing', existing: 'https://github.com/acme/steal-treasure' })
  assert.equal(r.res.status, 303)
  const id = projectIdFrom(r.res)
  const detail = await c.call('GET', `/projects/${id}?n=created`)
  assert.equal(detail.res.status, 200)
  assert.match(detail.text, /Steal Treasure/)
  assert.match(detail.text, /Boilr · groupe 123456/)
  assert.match(detail.text, /github\.com\/acme\/steal-treasure/)
  assert.match(detail.text, /Projet cree/)
  const list = await c.call('GET', '/projects')
  assert.match(list.text, /Steal Treasure/)
  assert.match(list.text, /0 experience/)
})

test('deux projets du meme nom recoivent des identifiants distincts', async () => {
  const { c, csrf } = await loggedIn()
  await newProject(c, csrf)
  await newProject(c, csrf)
  const slugs = (c.db.prepare('SELECT slug FROM projects ORDER BY id').all() as { slug: string }[]).map((r) => r.slug)
  assert.deepEqual(slugs, ['steal-treasure', 'steal-treasure-2'])
})

test('validation du formulaire de creation', async () => {
  const { c, csrf } = await loggedIn()
  assert.equal((await newProject(c, csrf, { name: '   ' })).res.status, 400)
  assert.equal((await newProject(c, csrf, { name: 'x'.repeat(61) })).res.status, 400)
  const badGroup = await newProject(c, csrf, { groupId: 'abc' })
  assert.equal(badGroup.res.status, 400)
  assert.match(badGroup.text, /groupe invalide/)
  assert.equal((await newProject(c, csrf, { repoMode: 'existing', existing: 'nimporte quoi' })).res.status, 400)
  assert.equal((await c.call('POST', '/projects', { csrf: 'faux', name: 'X' })).res.status, 403)
  assert.equal(c.db.prepare('SELECT COUNT(*) AS n FROM projects').get()!.n, 0)
})

async function connectGithub(c: Client, csrf: string, token = 'ghp_test') {
  return c.call('POST', '/account/github', { csrf, token })
}

test('creation depuis un template GitHub, avec le compte de l\'utilisateur', async () => {
  const gh = fakeGithub({ login: 'acme' })
  const { c, csrf } = await loggedIn({ githubFor: gh.githubFor })
  assert.equal((await connectGithub(c, csrf)).res.status, 303)
  gh.calls.length = 0
  const r = await newProject(c, csrf, { repoMode: 'template', template: 'acme/roblox-template', owner: 'acme', isPrivate: '1' })
  assert.equal(r.res.status, 303)
  assert.equal(gh.calls.length, 1)
  assert.equal(gh.calls[0].url, 'https://api.github.com/repos/acme/roblox-template/generate')
  const sent = JSON.parse(gh.calls[0].init.body as string)
  assert.deepEqual({ name: sent.name, owner: sent.owner, private: sent.private }, { name: 'steal-treasure', owner: 'acme', private: true })
  assert.equal((gh.calls[0].init.headers as Record<string, string>).authorization, 'Bearer ghp_test')
  assert.match((await c.call('GET', `/projects/${projectIdFrom(r.res)}`)).text, /github\.com\/acme\/steal-treasure/)
})

test('echec GitHub : message clair, aucun projet cree', async () => {
  const gh = fakeGithub({ generate: () => new Response(JSON.stringify({ message: 'name already exists on this account' }), { status: 422 }) })
  const { c, csrf } = await loggedIn({ githubFor: gh.githubFor })
  await connectGithub(c, csrf)
  const r = await newProject(c, csrf, { repoMode: 'template', template: 'acme/roblox-template' })
  assert.equal(r.res.status, 502)
  assert.match(r.text, /nom deja utilise/)
  assert.equal(c.db.prepare('SELECT COUNT(*) AS n FROM projects').get()!.n, 0)
})

test('template sans GitHub connecte : renvoie vers la page Compte', async () => {
  const { c, csrf } = await loggedIn({ githubFor: fakeGithub().githubFor })
  const r = await newProject(c, csrf, { repoMode: 'template', template: 'acme/roblox-template' })
  assert.equal(r.res.status, 400)
  assert.match(r.text, /Connecte d(?:'|&#39;)abord ton compte GitHub/)
  assert.match((await c.call('GET', '/projects/new')).text, /Connecter GitHub/)
})

test('experiences : une release, un dev, des bancs d\'essai numerotes', async () => {
  const { c, csrf } = await loggedIn()
  const id = projectIdFrom((await newProject(c, csrf)).res)
  const add = (fields: Record<string, string>) => c.call('POST', `/projects/${id}/experiences`, { csrf, universeId: '1111', placeId: '2222', ...fields })

  assert.equal((await add({ kind: 'release' })).res.status, 303)
  const dupRelease = await add({ kind: 'release' })
  assert.equal(dupRelease.res.status, 400)
  assert.match(dupRelease.text, /deja une experience Release/)
  assert.equal((await add({ kind: 'dev', placeId: '3333' })).res.status, 303)
  for (let i = 0; i < 3; i++) await add({ kind: 'bench', placeId: String(4000 + i) })

  const labels = (c.db.prepare(`SELECT label FROM experiences WHERE kind = 'bench' ORDER BY id`).all() as { label: string }[]).map((r) => r.label)
  assert.deepEqual(labels, ['Bench 1', 'Bench 2', 'Bench 3'])

  // un numero libere est reutilise
  const second = c.db.prepare(`SELECT id FROM experiences WHERE label = 'Bench 2'`).get() as { id: number }
  assert.equal((await c.call('POST', `/projects/${id}/experiences/${second.id}/delete`, { csrf })).res.status, 303)
  await add({ kind: 'bench', placeId: '5000' })
  assert.deepEqual((c.db.prepare(`SELECT label FROM experiences WHERE kind = 'bench' ORDER BY id`).all() as { label: string }[]).map((r) => r.label), ['Bench 1', 'Bench 3', 'Bench 2'])

  const dupName = await add({ kind: 'bench', label: 'Bench 1' })
  assert.equal(dupName.res.status, 400)

  const page = await c.call('GET', `/projects/${id}`)
  assert.match(page.text, /roblox\.com\/games\/3333/)
  assert.match(page.text, /Release/)
  assert.match((await c.call('GET', '/projects')).text, /5 experiences/)
})

test('experiences : identifiants invalides refuses', async () => {
  const { c, csrf } = await loggedIn()
  const id = projectIdFrom((await newProject(c, csrf)).res)
  const bad = await c.call('POST', `/projects/${id}/experiences`, { csrf, kind: 'dev', universeId: 'abc', placeId: '1' })
  assert.equal(bad.res.status, 400)
  const badKind = await c.call('POST', `/projects/${id}/experiences`, { csrf, kind: 'nimporte', universeId: '1', placeId: '1' })
  assert.equal(badKind.res.status, 400)
  assert.equal(c.db.prepare('SELECT COUNT(*) AS n FROM experiences').get()!.n, 0)
})

test('modification d\'un projet', async () => {
  const { c, csrf } = await loggedIn()
  const id = projectIdFrom((await newProject(c, csrf)).res)
  const accountId = String((c.db.prepare('SELECT id FROM roblox_accounts').get() as { id: number }).id)
  const r = await c.call('POST', `/projects/${id}`, { csrf, name: 'Steal Treasure 2', robloxAccountId: accountId, groupId: '777', groupName: 'Studio', repo: 'acme/st2' })
  assert.equal(r.res.status, 303)
  const row = c.db.prepare('SELECT name, slug, roblox_group_id, github_repo FROM projects WHERE id = ?').get(id) as Record<string, unknown>
  assert.deepEqual({ ...row }, { name: 'Steal Treasure 2', slug: 'steal-treasure', roblox_group_id: 777, github_repo: 'acme/st2' })
  assert.equal((await c.call('POST', `/projects/${id}`, { csrf, name: 'X', robloxAccountId: accountId, groupId: 'zz' })).res.status, 400)
})

test('suppression : le nom doit etre saisi, les experiences partent avec', async () => {
  const { c, csrf } = await loggedIn()
  const id = projectIdFrom((await newProject(c, csrf)).res)
  await c.call('POST', `/projects/${id}/experiences`, { csrf, kind: 'dev', universeId: '1', placeId: '2' })
  const wrong = await c.call('POST', `/projects/${id}/delete`, { csrf, confirm: 'autre chose' })
  assert.equal(wrong.res.status, 400)
  assert.equal(c.db.prepare('SELECT COUNT(*) AS n FROM projects').get()!.n, 1)
  const ok = await c.call('POST', `/projects/${id}/delete`, { csrf, confirm: 'Steal Treasure' })
  assert.equal(ok.res.status, 303)
  assert.equal(c.db.prepare('SELECT COUNT(*) AS n FROM projects').get()!.n, 0)
  assert.equal(c.db.prepare('SELECT COUNT(*) AS n FROM experiences').get()!.n, 0)
})

test('un utilisateur ne voit ni ne modifie les projets d\'un autre', async () => {
  const { c, csrf } = await loggedIn()
  const id = projectIdFrom((await newProject(c, csrf)).res)
  await c.call('POST', `/projects/${id}/experiences`, { csrf, kind: 'dev', universeId: '1', placeId: '2' })

  // deuxieme utilisateur, session complete creee directement
  const other = await createUser(c.db, 'benoit@example.com', 'another long password')
  const { token, session } = createSession(c.db, other.id, 'full')
  c.setCookie(`sid=${token}`)

  assert.doesNotMatch((await c.call('GET', '/projects')).text, /Steal Treasure/)
  assert.equal((await c.call('GET', `/projects/${id}`)).res.status, 404)
  assert.equal((await c.call('POST', `/projects/${id}`, { csrf: session.csrf, name: 'Pirate' })).res.status, 404)
  assert.equal((await c.call('POST', `/projects/${id}/experiences`, { csrf: session.csrf, kind: 'bench', universeId: '1', placeId: '2' })).res.status, 404)
  assert.equal((await c.call('POST', `/projects/${id}/delete`, { csrf: session.csrf, confirm: 'Steal Treasure' })).res.status, 404)
  assert.equal(c.db.prepare('SELECT COUNT(*) AS n FROM projects').get()!.n, 1)
  assert.equal(c.db.prepare('SELECT name FROM projects').get()!.name, 'Steal Treasure')
})

test('le nom du projet est echappe dans les pages', async () => {
  const { c, csrf } = await loggedIn()
  const id = projectIdFrom((await newProject(c, csrf, { name: '<img src=x onerror=alert(1)>' })).res)
  const page = (await c.call('GET', `/projects/${id}`)).text
  assert.doesNotMatch(page, /<img src=x/)
  assert.match(page, /&lt;img src=x/)
})

test('template : branche par defaut (ou vide) -> copie simple, sans toucher aux branches', async () => {
  for (const branch of ['', 'main']) {
    const gh = fakeGithub()
    const { c, csrf } = await loggedIn({ githubFor: gh.githubFor })
    await connectGithub(c, csrf)
    const r = await newProject(c, csrf, { repoMode: 'template', template: 'acme/roblox-template', branch, owner: 'acme' })
    assert.equal(r.res.status, 303, `branche « ${branch} »`)
    assert.equal(gh.generateBody().include_all_branches, false)
    assert.ok(!gh.calls.some((x) => x.method === 'PATCH' || x.method === 'DELETE'))
    assert.deepEqual(gh.repos.get('acme/steal-treasure')!.branches, ['main'])
  }
})

test('template : une autre branche devient la branche principale du nouveau depot', async () => {
  const gh = fakeGithub()
  const { c, csrf } = await loggedIn({ githubFor: gh.githubFor })
  await connectGithub(c, csrf)
  const r = await newProject(c, csrf, { repoMode: 'template', template: 'acme/roblox-template', branch: 'v2', owner: 'acme' })
  assert.equal(r.res.status, 303)
  assert.equal(gh.generateBody().include_all_branches, true)
  const created = gh.repos.get('acme/steal-treasure')!
  assert.equal(created.default_branch, 'v2')
  assert.deepEqual(created.branches, ['v2']) // main et legacy retirees du NOUVEAU depot
  // le depot template, lui, n'est pas modifie
  const tpl = gh.repos.get('acme/roblox-template')!
  assert.equal(tpl.default_branch, 'main')
  assert.deepEqual(tpl.branches, ['main', 'v2', 'legacy'])
  assert.ok(gh.calls.every((x) => !(x.method !== 'GET' && x.url.includes('/repos/acme/roblox-template') && !x.url.endsWith('/generate'))))
  // aucun avertissement
  assert.doesNotMatch((await c.call('GET', `/projects/${projectIdFrom(r.res)}?n=created`)).text, /n(?:'|&#39;)a pas pu devenir/)
})

test('template : depot pas encore pret -> on attend que la branche apparaisse', async () => {
  const gh = fakeGithub({ notReadyListings: 3 })
  const { c, csrf } = await loggedIn({ githubFor: gh.githubFor })
  await connectGithub(c, csrf)
  const r = await newProject(c, csrf, { repoMode: 'template', template: 'acme/roblox-template', branch: 'v2', owner: 'acme' })
  assert.equal(r.res.status, 303)
  assert.equal(gh.repos.get('acme/steal-treasure')!.default_branch, 'v2')
})

test('template : branche non applicable -> projet cree avec un avertissement visible une fois', async () => {
  const gh = fakeGithub({ patchStatus: 403 })
  const { c, csrf } = await loggedIn({ githubFor: gh.githubFor })
  await connectGithub(c, csrf)
  const r = await newProject(c, csrf, { repoMode: 'template', template: 'acme/roblox-template', branch: 'v2', owner: 'acme' })
  assert.equal(r.res.status, 303)
  assert.equal(c.db.prepare('SELECT COUNT(*) AS n FROM projects').get()!.n, 1)
  const id = projectIdFrom(r.res)
  const first = (await c.call('GET', `/projects/${id}?n=created`)).text
  assert.match(first, /Depot cree, mais la branche/)
  assert.match(first, /github\.com\/acme\/steal-treasure/)
  assert.doesNotMatch((await c.call('GET', `/projects/${id}`)).text, /Depot cree, mais la branche/)
  // aucune branche n'est supprimee tant que la branche principale n'a pas change
  assert.ok(!gh.calls.some((x) => x.method === 'DELETE'))
})

test('template : branche absente du template -> avertissement, rien de supprime', async () => {
  const gh = fakeGithub()
  const { c, csrf } = await loggedIn({ githubFor: gh.githubFor })
  await connectGithub(c, csrf)
  const r = await newProject(c, csrf, { repoMode: 'template', template: 'acme/roblox-template', branch: 'nope', owner: 'acme' })
  assert.equal(r.res.status, 303)
  assert.match((await c.call('GET', `/projects/${projectIdFrom(r.res)}?n=created`)).text, /n(?:'|&#39;)existe pas dans le template/)
  assert.deepEqual(gh.repos.get('acme/steal-treasure')!.branches, ['main', 'v2', 'legacy'])
})

test('template : nom de branche invalide refuse', async () => {
  const gh = fakeGithub()
  const { c, csrf } = await loggedIn({ githubFor: gh.githubFor })
  await connectGithub(c, csrf)
  const r = await newProject(c, csrf, { repoMode: 'template', template: 'acme/roblox-template', branch: 'a b;rm -rf' })
  assert.equal(r.res.status, 400)
  assert.equal(gh.calls.filter((x) => x.url.endsWith('/generate')).length, 0)
})
