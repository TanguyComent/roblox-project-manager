import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createSession, createUser } from '../src/auth.ts'
import { getAccount, listKnownPlaces } from '../src/roblox-accounts.ts'
import { KEYS, fakeRoblox } from './fake-roblox.ts'
import { client, csrfOf, registerAndEnable } from './helpers.ts'
import { connectRoblox } from './roblox-helpers.ts'

// Faux Roblox : la cle « tanguy » est celle du compte 1001, membre des groupes Boilr (123456, experience publique « Boilr Hub ») et Studio (777) ;
// il possede aussi « Steal Treasure », une experience PRIVEE (donc absente des listes publiques, mais accessible avec sa cle).
async function setup(key: string = KEYS.tanguy) {
  const rb = fakeRoblox()
  const c = client({ roblox: rb.client })
  await registerAndEnable(c)
  const csrf = csrfOf((await c.call('GET', '/account')).text)
  const a = await connectRoblox(c, key)
  const userId = (c.db.prepare('SELECT user_id FROM roblox_accounts').get() as { user_id: number }).user_id
  return { c, csrf, rb, accountId: a.accountId!, account: () => getAccount(c.db, userId, a.accountId!)! }
}
const HUB = '5550001'
const STEAL = '3828411582'
const rows = (c: ReturnType<typeof client>) =>
  (c.db.prepare('SELECT kind, label, universe_id AS u, place_id AS p FROM experiences ORDER BY id').all() as { kind: string; label: string; u: number; p: number }[]).map((r) => ({ ...r }))
const projectCount = (c: ReturnType<typeof client>) => (c.db.prepare('SELECT COUNT(*) AS n FROM projects').get() as { n: number }).n
const create = (c: ReturnType<typeof client>, csrf: string, accountId: number, f: Record<string, string> = {}) =>
  c.call('POST', '/projects', { csrf, name: 'Steal Treasure', repoMode: 'none', robloxAccountId: String(accountId), ...f })
const projectId = (res: Response) => Number(/\/projects\/(\d+)/.exec(res.headers.get('location') ?? '')![1])
const brief = (places: Awaited<ReturnType<typeof listKnownPlaces>>) => places.map((p) => `${p.universeName}|${p.placeName}|${p.placeId}|${p.isRoot}`)

test('places connues : experiences publiques des groupes du compte (les privees ne sont pas listables)', async () => {
  const { c, rb, account } = await setup()
  const places = await listKnownPlaces(c.db, rb.client, account())
  assert.deepEqual(brief(places), ['Boilr Hub|Hub|6660001|true', 'Boilr Hub|Hub - arene|6660002|false'])
  const n = rb.calls.length
  await listKnownPlaces(c.db, rb.client, account())
  assert.equal(rb.calls.length, n, 'resultat mis en cache')
  await listKnownPlaces(c.db, rb.client, account(), { fresh: true })
  assert.ok(rb.calls.length > n, 'relecture forcee')
})

test('places connues : les groupes sans droit de gestion sont ecartes (benefice du doute si les roles sont illisibles)', async () => {
  const { c, rb, account } = await setup()
  const ids = (places: Awaited<ReturnType<typeof listKnownPlaces>>) => [...new Set(places.map((p) => p.universeName))]
  assert.deepEqual(ids(await listKnownPlaces(c.db, rb.client, account())), ['Boilr Hub']) // « Fan Hub » (groupe Fan club) en est absent
  rb.state.hideRolePermissions = true
  rb.state.canManageStatus = 403
  assert.deepEqual(ids(await listKnownPlaces(c.db, rb.client, account(), { fresh: true })).sort(), ['Boilr Hub', 'Fan Hub'])
})

test('places connues : une cle limitee a une experience la nomme, meme privee', async () => {
  const { c, rb, account } = await setup(KEYS.tanguy2)
  assert.deepEqual(brief(await listKnownPlaces(c.db, rb.client, account())), [
    'Boilr Hub|Hub|6660001|true', 'Boilr Hub|Hub - arene|6660002|false', 'Steal Treasure|Steal Treasure|9100000001|true',
  ])
})

test('places connues : un autre compte n\'a que ses propres experiences publiques', async () => {
  const { c, rb, account } = await setup(KEYS.alt)
  assert.deepEqual(brief(await listKnownPlaces(c.db, rb.client, account())), ['Jeu de alt|Alt|7770002|true'])
})

test('formulaire de projet : listes des places par compte, release et dev facultatives', async () => {
  const { c } = await setup()
  await connectRoblox(c, KEYS.alt, 'Secondaire')
  const page = (await c.call('GET', '/projects/new')).text
  for (const name of ['releaseKnown', 'devKnown']) {
    const start = page.indexOf(`<select name="${name}" data-place-select>`)
    assert.ok(start > 0, name)
    const select = page.slice(start, page.indexOf('</select>', start))
    assert.match(select, /Aucune pour l(?:'|&#39;)instant/)
    assert.match(select, /<optgroup label="steal-treasure key">/)
    assert.match(select, /<optgroup label="Secondaire">/)
    assert.match(select, new RegExp(`value="${HUB}:6660002"`))
    assert.match(select, /Boilr Hub › Hub \(accueil\) · 6660001/)
    assert.match(select, /Jeu de alt › Alt \(accueil\) · 7770002/)
  }
  assert.match(page, /name="releaseUniverseId"/)
  assert.match(page, /ne pas exister encore/)
})

test('creation avec une release et une dev choisies dans la liste', async () => {
  const { c, csrf, accountId } = await setup()
  const r = await create(c, csrf, accountId, { releaseKnown: `${HUB}:6660001`, devKnown: `${HUB}:6660002` })
  assert.equal(r.res.status, 303)
  assert.deepEqual(rows(c), [
    { kind: 'release', label: 'Release', u: Number(HUB), p: 6660001 },
    { kind: 'dev', label: 'Dev', u: Number(HUB), p: 6660002 },
  ])
  const page = (await c.call('GET', `/projects/${projectId(r.res)}`)).text
  assert.match(page, /roblox\.com\/games\/6660001/)
  assert.match(page, /roblox\.com\/games\/6660002/)
})

test('creation sans aucune place : les places sont facultatives (elles peuvent ne pas exister encore)', async () => {
  const { c, csrf, accountId } = await setup()
  assert.equal((await create(c, csrf, accountId)).res.status, 303)
  assert.deepEqual(rows(c), [])
})

test('une place PRIVEE ou toute nouvelle se saisit par identifiants : verifiee avec la cle, sans nouvelle autorisation', async () => {
  const { c, csrf, rb, accountId } = await setup()
  const r = await create(c, csrf, accountId, { releaseUniverseId: STEAL, releasePlaceId: '9100000001', devUniverseId: STEAL, devPlaceId: '9100000002' })
  assert.equal(r.res.status, 303)
  assert.deepEqual(rows(c).map((x) => `${x.kind}:${x.u}:${x.p}`), [`release:${STEAL}:9100000001`, `dev:${STEAL}:9100000002`])
  const lookups = rb.calls.filter((x) => x.path === `/cloud/v2/universes/${STEAL}`)
  assert.ok(lookups.length >= 1)
  assert.equal(lookups[0].key, KEYS.tanguy, 'verification faite avec la cle du compte')
  assert.ok(rb.calls.some((x) => x.path === `/cloud/v2/universes/${STEAL}/places/9100000002`))
})

test('creation : saisies incompletes, invalides ou introuvables refusees, rien n\'est cree', async () => {
  const { c, csrf, accountId } = await setup()
  const half = await create(c, csrf, accountId, { releaseUniverseId: '111' })
  assert.equal(half.res.status, 400)
  assert.match(half.text, /Release : renseigne l(?:'|&#39;)identifiant d(?:'|&#39;)univers ET celui de place/)
  const bad = await create(c, csrf, accountId, { devUniverseId: 'abc', devPlaceId: '1' })
  assert.equal(bad.res.status, 400)
  assert.match(bad.text, /Dev : les identifiants doivent etre des nombres/)
  assert.equal((await create(c, csrf, accountId, { releaseKnown: 'pas-une-place' })).res.status, 400)
  const missing = await create(c, csrf, accountId, { releaseUniverseId: '424242', releasePlaceId: '1' })
  assert.equal(missing.res.status, 400)
  assert.match(missing.text, /L(?:'|&#39;)experience 424242 est introuvable/)
  const wrongPlace = await create(c, csrf, accountId, { devUniverseId: STEAL, devPlaceId: '6660001' }) // place d'une autre experience
  assert.equal(wrongPlace.res.status, 400)
  assert.match(wrongPlace.text, /n(?:'|&#39;)appartient pas a l(?:'|&#39;)experience/)
  assert.equal(projectCount(c), 0)
  assert.match(half.text, /name="releaseUniverseId" value="111"/) // les valeurs saisies restent dans le formulaire
})

test('creation : une experience hors de portee de la cle est acceptee « non verifiee », pas inventee', async () => {
  const { c, csrf, rb, accountId } = await setup(KEYS.alt)
  // le compte « alt » n'a pas acces a l'experience privee de 1001 : Roblox repond 403 (impossible de trancher)
  const r = await create(c, csrf, accountId, { releaseUniverseId: STEAL, releasePlaceId: '9100000001' })
  assert.equal(r.res.status, 303)
  assert.equal(rows(c).length, 1)
  void rb
})

test('creation : la release et la dev ne peuvent pas etre la meme place', async () => {
  const { c, csrf, accountId } = await setup()
  const r = await create(c, csrf, accountId, { releaseKnown: `${HUB}:6660001`, devUniverseId: HUB, devPlaceId: '6660001' })
  assert.equal(r.res.status, 400)
  assert.match(r.text, /meme place/)
  assert.equal(projectCount(c), 0)
})

test('creation : les places sont verifiees AVANT de creer le depot GitHub', async () => {
  const { fakeGithub } = await import('./fake-github.ts')
  const rb = fakeRoblox()
  const gh = fakeGithub()
  const c = client({ roblox: rb.client, githubFor: gh.githubFor })
  await registerAndEnable(c)
  const csrf = csrfOf((await c.call('GET', '/account')).text)
  const { accountId } = await connectRoblox(c)
  await c.call('POST', '/account/github', { csrf, token: 'tok' })
  gh.calls.length = 0
  const r = await create(c, csrf, accountId!, { repoMode: 'template', template: 'acme/roblox-template', releaseUniverseId: '424242', releasePlaceId: '1' })
  assert.equal(r.res.status, 400)
  assert.ok(!gh.calls.some((x) => x.url.endsWith('/generate')))
})

test('creation : un compte dont la cle est invalide ne peut verifier aucune place', async () => {
  const { c, csrf, rb, accountId } = await setup()
  rb.setKey(KEYS.tanguy, null)
  await c.call('POST', `/account/roblox/${accountId}/verify`, { csrf })
  const r = await create(c, csrf, accountId, { releaseUniverseId: STEAL, releasePlaceId: '9100000001' })
  assert.equal(r.res.status, 400)
  assert.equal(projectCount(c), 0)
})

// --- page du projet ------------------------------------------------------------------------------------------------------------------
test('page projet : ajouter une experience depuis la liste des places', async () => {
  const { c, csrf, accountId } = await setup()
  const id = projectId((await create(c, csrf, accountId, { groupId: '123456' })).res) // projet du groupe Boilr : on y voit ses places
  const page = (await c.call('GET', `/projects/${id}`)).text
  assert.match(page, /<select name="known" data-place-select>/)
  assert.match(page, /Boilr Hub › Hub - arene · 6660002/)
  const add = (f: Record<string, string>) => c.call('POST', `/projects/${id}/experiences`, { csrf, kind: 'bench', ...f })
  assert.equal((await add({ known: `${HUB}:6660002` })).res.status, 303)
  assert.deepEqual(rows(c).map((x) => `${x.label}:${x.p}`), ['Bench 1:6660002'])
  const none = await add({})
  assert.equal(none.res.status, 400)
  assert.match(none.text, /Choisis une place/)
  const dup = await add({ universeId: HUB, placeId: '6660002' })
  assert.equal(dup.res.status, 400)
  assert.match(dup.text, /deja utilisee par « Bench 1 »/)
  assert.equal((await add({ known: '5:6' })).res.status, 400)
})

test('page projet : changer la place de la release ou de la dev (elles peuvent n\'exister que plus tard)', async () => {
  const { c, csrf, accountId } = await setup()
  const id = projectId((await create(c, csrf, accountId, { releaseUniverseId: STEAL, releasePlaceId: '9100000001', devKnown: `${HUB}:6660002` })).res)
  const [release, dev] = c.db.prepare('SELECT id FROM experiences ORDER BY id').all() as { id: number }[]
  const page = (await c.call('GET', `/projects/${id}`)).text
  assert.match(page, new RegExp(`action="/projects/${id}/experiences/${release.id}/place"`))
  assert.match(page, /Changer la place/)

  const ok = await c.call('POST', `/projects/${id}/experiences/${release.id}/place`, { csrf, known: `${HUB}:6660001` })
  assert.equal(ok.res.status, 303)
  assert.equal(ok.res.headers.get('location'), `/projects/${id}?n=placechanged`)
  assert.deepEqual(rows(c).map((x) => `${x.kind}:${x.label}:${x.p}`), ['release:Release:6660001', 'dev:Dev:6660002'])
  assert.match((await c.call('GET', `/projects/${id}?n=placechanged`)).text, /Place mise a jour/)

  assert.equal((await c.call('POST', `/projects/${id}/experiences/${release.id}/place`, { csrf, universeId: HUB, placeId: '6660002' })).res.status, 400) // prise par la dev
  assert.equal((await c.call('POST', `/projects/${id}/experiences/${dev.id}/place`, { csrf, universeId: '424242', placeId: '1' })).res.status, 400) // introuvable
  assert.equal((await c.call('POST', `/projects/${id}/experiences/${dev.id}/place`, { csrf })).res.status, 400)
  assert.equal((await c.call('POST', `/projects/${id}/experiences/${dev.id}/place`, { csrf: 'faux', known: `${HUB}:6660001` })).res.status, 403)
  assert.equal((await c.call('POST', `/projects/${id}/experiences/99999/place`, { csrf, known: `${HUB}:6660001` })).res.status, 404)
  assert.deepEqual(rows(c).map((x) => x.p), [6660001, 6660002])
})

test('page projet : sans compte Roblox rattache, les identifiants saisis sont acceptes sans verification', async () => {
  const { c, csrf, accountId } = await setup()
  const id = projectId((await create(c, csrf, accountId)).res)
  c.db.prepare('UPDATE projects SET roblox_account_id = NULL').run() // projet ancien, cree avant les comptes Roblox
  assert.equal((await c.call('POST', `/projects/${id}/experiences`, { csrf, kind: 'dev', universeId: '1', placeId: '2' })).res.status, 303)
})

test('page projet : les places d\'un autre utilisateur ne sont ni visibles ni modifiables', async () => {
  const { c, csrf, accountId } = await setup()
  const id = projectId((await create(c, csrf, accountId, { devUniverseId: STEAL, devPlaceId: '9100000001' })).res)
  const exp = (c.db.prepare('SELECT id FROM experiences').get() as { id: number }).id
  const other = await createUser(c.db, 'benoit@example.com', 'another long password')
  const { token, session } = createSession(c.db, other.id, 'full')
  c.setCookie(`sid=${token}`)
  assert.equal((await c.call('POST', `/projects/${id}/experiences/${exp}/place`, { csrf: session.csrf, universeId: '5', placeId: '6' })).res.status, 404)
  assert.deepEqual(rows(c).map((x) => x.p), [9100000001])
  void csrf
})

// --- menu des groupes et filtrage des places ---------------------------------------------------------------------------------------------
test('formulaire de projet : le groupe se choisit dans un menu, la saisie manuelle reste possible', async () => {
  const { c, csrf, accountId } = await setup()
  const page = (await c.call('GET', '/projects/new')).text
  const start = page.indexOf('<select name="groupId">')
  const select = page.slice(start, page.indexOf('</select>', start))
  assert.match(select, /Aucun groupe \(experiences personnelles\)/)
  assert.match(select, /value="123456" data-account="\d+">Boilr \(Owner\) · 123456/)
  assert.doesNotMatch(select, /Studio|Fan club/)
  assert.match(page, /name="groupIdManual"/)
  assert.doesNotMatch(page, /name="groupName"/)
  assert.match(page, /<form method="post" action="\/projects" autocomplete="off" data-cascade>/)

  // depuis le menu : le nom vient de Roblox, meme si un nom est envoye
  const ok = await create(c, csrf, accountId, { groupId: '123456', groupName: 'Nom bidon' })
  assert.equal(ok.res.status, 303)
  assert.deepEqual({ ...(c.db.prepare('SELECT roblox_group_id AS g, roblox_group_name AS n FROM projects').get() as object) }, { g: 123456, n: 'Boilr' })
  // saisie a la main (si la liste est indisponible)
  const manual = await create(c, csrf, accountId, { groupIdManual: '123456' })
  assert.equal(manual.res.status, 303)
  assert.equal(projectCount(c), 2)
  // un groupe sans droit de gestion reste refuse, meme saisi a la main
  assert.equal((await create(c, csrf, accountId, { groupIdManual: '777' })).res.status, 400)
})

test('les places proposees portent leur compte et leur proprietaire (le script filtre sur le groupe choisi)', async () => {
  const { c } = await setup()
  await connectRoblox(c, KEYS.alt, 'Secondaire')
  const page = (await c.call('GET', '/projects/new')).text
  const start = page.indexOf('<select name="releaseKnown" data-place-select>')
  const select = page.slice(start, page.indexOf('</select>', start))
  assert.match(select, /value="5550001:6660001" data-account="\d+" data-owner="group:123456"/) // experience du groupe Boilr
  assert.match(select, /value="7770001:7770002" data-account="\d+" data-owner="user"/) // experience personnelle de alt_account
})

test('le script de filtrage est servi par le site (CSP : script-src \'self\', toujours aucun script en ligne)', async () => {
  const { c } = await setup()
  const page = await c.call('GET', '/projects/new')
  assert.match(page.res.headers.get('content-security-policy')!, /script-src 'self'/)
  assert.match(page.res.headers.get('content-security-policy')!, /default-src 'none'/)
  assert.match(page.text, /<script src="\/static\/app\.js\?v=\d+" defer><\/script>/)
  assert.doesNotMatch(page.text.replace(/<script src="[^"]+" defer><\/script>/, ''), /<script/) // aucun autre script
  const js = await c.call('GET', '/static/app.js')
  assert.equal(js.res.status, 200)
  assert.match(js.res.headers.get('content-type')!, /javascript/)
  assert.match(js.text, /form\[data-cascade\]/)
  const etag = js.res.headers.get('etag')!
  assert.equal((await c.call('GET', '/static/app.js', undefined, { 'if-none-match': etag })).res.status, 304)
})

test('creation : l\'experience doit appartenir au groupe choisi', async () => {
  const { c, csrf, accountId } = await setup()
  // « Steal Treasure » est une experience PERSONNELLE de 1001 : refusee pour un projet du groupe Boilr
  const personal = await create(c, csrf, accountId, { groupId: '123456', releaseUniverseId: STEAL, releasePlaceId: '9100000001' })
  assert.equal(personal.res.status, 400)
  assert.match(personal.text, /n(?:'|&#39;)appartient pas au groupe 123456 \(elle est personnelle\)/)
  // « Boilr Hub » appartient au groupe : accepte
  assert.equal((await create(c, csrf, accountId, { groupId: '123456', devKnown: `${HUB}:6660001` })).res.status, 303)
  // sans groupe : pas de controle de proprietaire (le groupe peut etre ajoute plus tard)
  assert.equal((await create(c, csrf, accountId, { devKnown: `${HUB}:6660002` })).res.status, 303)
  assert.equal(projectCount(c), 2)
})

test('page projet : seules les places du groupe du projet sont proposees, et imposees', async () => {
  const { c, csrf, accountId } = await setup(KEYS.tanguy2) // cle limitee a « Steal Treasure » (personnelle) + membre de Boilr
  const select = async (id: number) => {
    const page = (await c.call('GET', `/projects/${id}`)).text
    const start = page.indexOf('<select name="known" data-place-select>')
    return page.slice(start, page.indexOf('</select>', start))
  }
  const personal = projectId((await create(c, csrf, accountId)).res)
  const inGroup = projectId((await create(c, csrf, accountId, { groupId: '123456' })).res)
  assert.match(await select(personal), /Steal Treasure › Steal Treasure/)
  assert.doesNotMatch(await select(personal), /Boilr Hub/)
  assert.match(await select(inGroup), /Boilr Hub › Hub/)
  assert.doesNotMatch(await select(inGroup), /Steal Treasure ›/)

  // ajouter une place personnelle a un projet de groupe est refuse
  const bad = await c.call('POST', `/projects/${inGroup}/experiences`, { csrf, kind: 'dev', universeId: STEAL, placeId: '9100000001' })
  assert.equal(bad.res.status, 400)
  assert.match(bad.text, /n(?:'|&#39;)appartient pas au groupe 123456/)
  assert.equal((await c.call('POST', `/projects/${inGroup}/experiences`, { csrf, kind: 'dev', known: `${HUB}:6660001` })).res.status, 303)
})

test('page projet : le groupe se change avec un menu (groupes du compte du projet)', async () => {
  const { c, csrf, accountId } = await setup()
  const id = projectId((await create(c, csrf, accountId)).res)
  const page = (await c.call('GET', `/projects/${id}`)).text
  assert.match(page, /<form method="post" action="\/projects\/\d+" autocomplete="off" data-cascade>/)
  assert.match(page, /<select name="groupId">/)
  assert.match(page, /value="123456" data-account="\d+">Boilr/)
  const r = await c.call('POST', `/projects/${id}`, { csrf, name: 'Steal Treasure', robloxAccountId: String(accountId), groupId: '123456' })
  assert.equal(r.res.status, 303)
  assert.equal((c.db.prepare('SELECT roblox_group_name AS n FROM projects').get() as { n: string }).n, 'Boilr')
  const none = await c.call('POST', `/projects/${id}`, { csrf, name: 'Steal Treasure', robloxAccountId: String(accountId), groupId: '' })
  assert.equal(none.res.status, 303)
  assert.deepEqual({ ...(c.db.prepare('SELECT roblox_group_id AS g, roblox_group_name AS n FROM projects').get() as object) }, { g: null, n: null })
})
