import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createSession, createUser } from '../src/auth.ts'
import { listKnownPlaces } from '../src/roblox-accounts.ts'
import { fakeRoblox } from './fake-roblox.ts'
import { client, csrfOf, registerAndEnable } from './helpers.ts'
import { connectRoblox } from './roblox-helpers.ts'

// Faux Roblox : « tanguy_dev » a autorise l'experience « Steal Treasure » (2 places) et « toutes les experiences » du groupe 123456
// (dont « Boilr Hub », publique, 2 places) ; « alt_account » n'a autorise que son groupe 888 (aucune experience).
async function setup(o: Parameters<typeof fakeRoblox>[0] = {}) {
  const rb = fakeRoblox(o)
  const c = client({ roblox: rb.client })
  await registerAndEnable(c)
  const csrf = csrfOf((await c.call('GET', '/account')).text)
  const a = await connectRoblox(c, '1001')
  return { c, csrf, rb, accountId: a.accountId! }
}
const STEAL = '3828411582'
const rows = (c: ReturnType<typeof client>) =>
  (c.db.prepare('SELECT kind, label, universe_id AS u, place_id AS p FROM experiences ORDER BY id').all() as { kind: string; label: string; u: number; p: number }[]).map((r) => ({ ...r }))
const projectCount = (c: ReturnType<typeof client>) => (c.db.prepare('SELECT COUNT(*) AS n FROM projects').get() as { n: number }).n
const create = (c: ReturnType<typeof client>, csrf: string, accountId: number, f: Record<string, string> = {}) =>
  c.call('POST', '/projects', { csrf, name: 'Steal Treasure', repoMode: 'none', robloxAccountId: String(accountId), ...f })
const projectId = (res: Response) => Number(/\/projects\/(\d+)/.exec(res.headers.get('location') ?? '')![1])

test('places connues : experiences autorisees + experiences publiques du groupe, places d\'accueil en tete', async () => {
  const { c, rb, accountId } = await setup()
  const places = await listKnownPlaces(c.db, rb.client, accountId)
  assert.deepEqual(
    places.map((p) => `${p.universeName}|${p.placeName}|${p.placeId}|${p.isRoot}`),
    ['Boilr Hub|Hub|6660001|true', 'Boilr Hub|Hub - arene|6660002|false', 'Steal Treasure|Steal Treasure|9100000001|true', 'Steal Treasure|Lobby|9100000002|false'],
  )
  const n = rb.calls.length
  await listKnownPlaces(c.db, rb.client, accountId)
  assert.equal(rb.calls.length, n, 'resultat mis en cache')
  await listKnownPlaces(c.db, rb.client, accountId, { fresh: true })
  assert.ok(rb.calls.length > n, 'relecture forcee')
})

test('places connues : un compte sans experience autorisee n\'a aucune place', async () => {
  const { c, rb } = await setup()
  const alt = await connectRoblox(c, '1002')
  assert.deepEqual(await listKnownPlaces(c.db, rb.client, alt.accountId!), [])
})

test('formulaire de projet : listes des places par compte, release et dev facultatives', async () => {
  const { c } = await setup()
  await connectRoblox(c, '1002')
  const page = (await c.call('GET', '/projects/new')).text
  for (const name of ['releaseKnown', 'devKnown']) {
    const select = page.slice(page.indexOf(`<select name="${name}">`), page.indexOf('</select>', page.indexOf(`<select name="${name}">`)))
    assert.match(select, /Aucune pour l(?:'|&#39;)instant/)
    assert.match(select, /<optgroup label="@tanguy_dev">/)
    assert.match(select, new RegExp(`value="${STEAL}:9100000002"`))
    assert.match(select, /Steal Treasure › Lobby · 9100000002/)
    assert.match(select, /Boilr Hub › Hub \(accueil\) · 6660001/)
    assert.doesNotMatch(select, /@alt_account/) // aucun compte « alt » sans place
  }
  assert.match(page, /name="releaseUniverseId"/)
  assert.match(page, /ne pas exister encore/)
})

test('creation avec une release et une dev choisies dans la liste', async () => {
  const { c, csrf, accountId } = await setup()
  const r = await create(c, csrf, accountId, { releaseKnown: `${STEAL}:9100000001`, devKnown: `${STEAL}:9100000002` })
  assert.equal(r.res.status, 303)
  assert.deepEqual(rows(c), [
    { kind: 'release', label: 'Release', u: Number(STEAL), p: 9100000001 },
    { kind: 'dev', label: 'Dev', u: Number(STEAL), p: 9100000002 },
  ])
  const page = (await c.call('GET', `/projects/${projectId(r.res)}`)).text
  assert.match(page, /roblox\.com\/games\/9100000001/)
  assert.match(page, /roblox\.com\/games\/9100000002/)
})

test('creation sans aucune place : les places sont facultatives (elles peuvent ne pas exister encore)', async () => {
  const { c, csrf, accountId } = await setup()
  assert.equal((await create(c, csrf, accountId)).res.status, 303)
  assert.deepEqual(rows(c), [])
})

test('creation avec des identifiants saisis a la main', async () => {
  const { c, csrf, accountId } = await setup()
  const r = await create(c, csrf, accountId, { releaseUniverseId: '111', releasePlaceId: '222', devUniverseId: '333', devPlaceId: '444' })
  assert.equal(r.res.status, 303)
  assert.deepEqual(rows(c).map((x) => `${x.kind}:${x.u}:${x.p}`), ['release:111:222', 'dev:333:444'])
})

test('creation : saisies incompletes ou invalides refusees, rien n\'est cree', async () => {
  const { c, csrf, accountId } = await setup()
  const half = await create(c, csrf, accountId, { releaseUniverseId: '111' })
  assert.equal(half.res.status, 400)
  assert.match(half.text, /Release : renseigne l(?:'|&#39;)identifiant d(?:'|&#39;)univers ET celui de place/)
  const bad = await create(c, csrf, accountId, { devUniverseId: 'abc', devPlaceId: '1' })
  assert.equal(bad.res.status, 400)
  assert.match(bad.text, /Dev : les identifiants doivent etre des nombres/)
  assert.equal((await create(c, csrf, accountId, { releaseKnown: 'pas-une-place' })).res.status, 400)
  assert.equal(projectCount(c), 0)
  // les valeurs saisies restent dans le formulaire
  assert.match(half.text, /name="releaseUniverseId" value="111"/)
})

test('creation : la place choisie est re-verifiee cote serveur (valeur falsifiee ou place d\'un autre compte)', async () => {
  const { c, csrf, rb, accountId } = await setup()
  const alt = await connectRoblox(c, '1002')
  // valeur inventee
  const forged = await create(c, csrf, accountId, { releaseKnown: '999:888' })
  assert.equal(forged.res.status, 400)
  assert.match(forged.text, /n(?:'|&#39;)est pas accessible avec le compte Roblox « tanguy_dev »/)
  // place reelle de tanguy_dev, mais avec le compte alt_account
  const other = await create(c, csrf, alt.accountId!, { devKnown: `${STEAL}:9100000001` })
  assert.equal(other.res.status, 400)
  assert.match(other.text, /alt_account/)
  assert.equal(projectCount(c), 0)
  void rb
})

test('creation : la release et la dev ne peuvent pas etre la meme place', async () => {
  const { c, csrf, accountId } = await setup()
  const r = await create(c, csrf, accountId, { releaseKnown: `${STEAL}:9100000001`, devUniverseId: STEAL, devPlaceId: '9100000001' })
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
  const { accountId } = await connectRoblox(c, '1001')
  await c.call('POST', '/account/github', { csrf, token: 'tok' })
  gh.calls.length = 0
  const r = await create(c, csrf, accountId!, { repoMode: 'template', template: 'acme/roblox-template', releaseKnown: '999:888' })
  assert.equal(r.res.status, 400)
  assert.ok(!gh.calls.some((x) => x.url.endsWith('/generate')))
})

test('Roblox indisponible : le formulaire reste utilisable (identifiants a la main), la liste est refusee', async () => {
  const { c, csrf, accountId } = await setup({ resourcesStatus: 500 })
  const page = await c.call('GET', '/projects/new')
  assert.equal(page.res.status, 200)
  assert.match(page.text, /Liste des places indisponible/)
  assert.equal((await create(c, csrf, accountId, { releaseUniverseId: '111', releasePlaceId: '222' })).res.status, 303)
  const listed = await create(c, csrf, accountId, { devKnown: `${STEAL}:9100000001` })
  assert.equal(listed.res.status, 502)
  assert.match(listed.text, /impossible de lire les places/)
})

// --- page du projet ------------------------------------------------------------------------------------------------------------------
test('page projet : ajouter une experience depuis la liste des places', async () => {
  const { c, csrf, accountId } = await setup()
  const id = projectId((await create(c, csrf, accountId)).res)
  const page = (await c.call('GET', `/projects/${id}`)).text
  assert.match(page, /<select name="known">/)
  assert.match(page, /Steal Treasure › Lobby · 9100000002/)
  const add = (f: Record<string, string>) => c.call('POST', `/projects/${id}/experiences`, { csrf, kind: 'bench', ...f })
  assert.equal((await add({ known: `${STEAL}:9100000002` })).res.status, 303)
  assert.deepEqual(rows(c).map((x) => `${x.label}:${x.p}`), ['Bench 1:9100000002'])
  const none = await add({})
  assert.equal(none.res.status, 400)
  assert.match(none.text, /Choisis une place/)
  const dup = await add({ universeId: STEAL, placeId: '9100000002' })
  assert.equal(dup.res.status, 400)
  assert.match(dup.text, /deja utilisee par « Bench 1 »/)
  assert.equal((await add({ known: '5:6' })).res.status, 400)
})

test('page projet : changer la place de la release ou de la dev (elles peuvent n\'exister que plus tard)', async () => {
  const { c, csrf, accountId } = await setup()
  const id = projectId((await create(c, csrf, accountId, { releaseUniverseId: '111', releasePlaceId: '222', devKnown: `${STEAL}:9100000002` })).res)
  const [release, dev] = c.db.prepare('SELECT id FROM experiences ORDER BY id').all() as { id: number }[]
  const page = (await c.call('GET', `/projects/${id}`)).text
  assert.match(page, new RegExp(`action="/projects/${id}/experiences/${release.id}/place"`))
  assert.match(page, /Changer la place/)

  // la release (ids saisis plus tot) devient une vraie place de la liste
  const ok = await c.call('POST', `/projects/${id}/experiences/${release.id}/place`, { csrf, known: `${STEAL}:9100000001` })
  assert.equal(ok.res.status, 303)
  assert.equal(ok.res.headers.get('location'), `/projects/${id}?n=placechanged`)
  assert.deepEqual(rows(c).map((x) => `${x.kind}:${x.label}:${x.p}`), ['release:Release:9100000001', 'dev:Dev:9100000002'])
  assert.match((await c.call('GET', `/projects/${id}?n=placechanged`)).text, /Place mise a jour/)

  // refus : place deja prise par la dev, place inaccessible, aucune place, CSRF
  assert.equal((await c.call('POST', `/projects/${id}/experiences/${release.id}/place`, { csrf, universeId: STEAL, placeId: '9100000002' })).res.status, 400)
  assert.equal((await c.call('POST', `/projects/${id}/experiences/${dev.id}/place`, { csrf, known: '9:9' })).res.status, 400)
  assert.equal((await c.call('POST', `/projects/${id}/experiences/${dev.id}/place`, { csrf })).res.status, 400)
  assert.equal((await c.call('POST', `/projects/${id}/experiences/${dev.id}/place`, { csrf: 'faux', known: `${STEAL}:9100000001` })).res.status, 403)
  assert.equal((await c.call('POST', `/projects/${id}/experiences/99999/place`, { csrf, known: `${STEAL}:9100000001` })).res.status, 404)
  assert.deepEqual(rows(c).map((x) => x.p), [9100000001, 9100000002])
})

test('page projet : sans compte Roblox rattache, seules les identifiants saisis a la main sont possibles', async () => {
  const { c, csrf, accountId } = await setup()
  const id = projectId((await create(c, csrf, accountId)).res)
  c.db.prepare('UPDATE projects SET roblox_account_id = NULL').run() // projet ancien, cree avant les comptes Roblox
  assert.equal((await c.call('POST', `/projects/${id}/experiences`, { csrf, kind: 'dev', known: `${STEAL}:9100000001` })).res.status, 400)
  assert.equal((await c.call('POST', `/projects/${id}/experiences`, { csrf, kind: 'dev', universeId: '1', placeId: '2' })).res.status, 303)
})

test('page projet : les places d\'un autre utilisateur ne sont ni visibles ni modifiables', async () => {
  const { c, csrf, accountId } = await setup()
  const id = projectId((await create(c, csrf, accountId, { devUniverseId: '111', devPlaceId: '222' })).res)
  const exp = (c.db.prepare('SELECT id FROM experiences').get() as { id: number }).id
  const other = await createUser(c.db, 'benoit@example.com', 'another long password')
  const { token, session } = createSession(c.db, other.id, 'full')
  c.setCookie(`sid=${token}`)
  assert.equal((await c.call('POST', `/projects/${id}/experiences/${exp}/place`, { csrf: session.csrf, universeId: '5', placeId: '6' })).res.status, 404)
  assert.deepEqual(rows(c).map((x) => x.p), [222])
  void csrf
})
