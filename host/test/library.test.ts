import assert from 'node:assert/strict'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createUser } from '../src/auth.ts'
import { config } from '../src/config.ts'
import { cleanDescription, cleanFolder, cleanTags, cleanTitle, getImage, listImages, searchImages, syncLibrary } from '../src/library.ts'
import { createWorker, finishJob, getJob, markJobRunning } from '../src/workers.ts'
import { ORIGIN, client, csrfOf, registerAndEnable } from './helpers.ts'

config.dataDir = mkdtempSync(join(tmpdir(), 'rpm-lib-data-'))

const PNG = (tag = 'a') => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(`png-${tag}`)])

async function setup() {
  const c = client()
  await registerAndEnable(c)
  const csrf = csrfOf((await c.call('GET', '/projects')).text)
  const userId = (c.db.prepare('SELECT id FROM users ORDER BY id LIMIT 1').get() as { id: number }).id
  const headers = (extra: Record<string, string> = {}) => ({ host: 'localhost:3000', origin: ORIGIN, cookie: c.getCookie(), ...extra })
  const up = (name: string, data: Buffer, over: Record<string, string> = {}) =>
    c.app.request(`${ORIGIN}/library/upload`, { method: 'POST', headers: headers({ 'x-csrf': csrf, 'x-file-name': encodeURIComponent(name), ...over }), body: new Uint8Array(data) })
  const add = async (name: string, tag = name) => ((await (await up(name, PNG(tag))).json()) as { id: string }).id
  const post = (path: string, body: Record<string, string> = {}) => c.call('POST', path, { csrf, ...body }, { accept: 'application/json' })
  return { c, csrf, userId, headers, up, add, post }
}

test('nettoyage des valeurs : dossiers, noms, descriptions, mots-cles', () => {
  assert.equal(cleanFolder('Icons/Armes Épées'), 'icons/armes-epees')
  assert.equal(cleanFolder('../../etc/passwd'), 'etc/passwd')
  assert.equal(cleanFolder('a/b/c/d/e'), 'a/b/c')
  assert.equal(cleanFolder(''), 'divers')
  assert.equal(cleanFolder(42), 'divers')
  assert.equal(cleanTitle('Épée Acier.PNG'), 'epee-acier')
  assert.equal(cleanTitle('', 'fond.jpg'), 'fond')
  assert.equal(cleanTitle('***'), 'image')
  assert.ok(cleanTitle('x'.repeat(200)).length <= 60)
  assert.equal(cleanDescription('  une\n\n  phrase‮ '), 'une phrase')
  assert.equal(cleanDescription('x'.repeat(500)).length, 300)
  assert.equal(cleanTags(['Épée', 'epee', 'Arme Blanche', '', 5, 'a', 'b', 'c', 'd', 'e', 'f', 'g']), 'epee,arme-blanche,a,b,c,d,e,f')
  assert.equal(cleanTags('un, deux;trois'), 'un,deux,trois')
})

test('ajout : images verifiees seulement, limites, CSRF, authentification', async () => {
  const t = await setup()
  const ok = await t.up('Epee.png', PNG())
  assert.equal(ok.status, 200)
  const { id } = (await ok.json()) as { id: string }
  const img = getImage(t.c.db, t.userId, id)!
  assert.equal(img.status, 'pending')
  assert.equal(img.mime, 'image/png')
  assert.equal(img.title, 'epee')
  assert.equal(img.folder, '')
  assert.equal((await t.up('x.svg', Buffer.from('<svg onload=alert(1)/>'))).status, 400, 'SVG refuse')
  assert.equal((await t.up('x.pdf', Buffer.from('%PDF-1.4\n'))).status, 400, 'PDF refuse')
  assert.equal((await t.up('x.exe', PNG())).status, 400)
  assert.equal((await t.up('x.png', Buffer.from('MZ\x90\x00'))).status, 400, 'executable deguise')
  assert.equal((await t.up('x.png', Buffer.alloc(0))).status, 400)
  assert.equal((await t.up('a.png', PNG(), { 'x-csrf': 'faux' })).status, 403)
  assert.equal((await t.up('a.png', PNG(), { cookie: '' })).status, 302)
  assert.equal((await t.up('a.png', PNG(), { origin: 'http://evil.example' })).status, 403)
  const keep = { ...config.library }
  try {
    config.library.maxFile = 10
    assert.equal((await t.up('gros.png', PNG('x'.repeat(50)))).status, 413)
    config.library.maxFile = keep.maxFile
    config.library.maxImages = 1
    assert.equal((await t.up('b.png', PNG('b'))).status, 413, 'nombre maximal')
    config.library.maxImages = keep.maxImages
    config.library.userQuota = 20
    assert.equal((await t.up('c.png', PNG('c'))).status, 413, 'quota')
  } finally { Object.assign(config.library, keep) }
})

test('fichier : proprietaire seulement, en-tetes sans risque ; modification et suppression', async () => {
  const t = await setup()
  const id = await t.add('a.png')
  const get = (i: string, cookie = t.c.getCookie()) => t.c.app.request(`${ORIGIN}/library/${i}/file`, { headers: { host: 'localhost:3000', cookie } })
  const r = await get(id)
  assert.equal(r.status, 200)
  assert.equal(r.headers.get('content-type'), 'image/png')
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff')
  assert.match(r.headers.get('content-security-policy')!, /sandbox/)
  assert.deepEqual(Buffer.from(await r.arrayBuffer()), PNG('a.png'))
  assert.notEqual((await get(id, '')).status, 200)
  assert.equal((await get('0'.repeat(32))).status, 404)

  const e = await t.post(`/library/${id}/edit`, { title: 'Mon Icone', folder: 'Icons/Shop', description: 'Une icone', tags: 'a, b' })
  assert.equal(e.res.status, 303)
  const edited = getImage(t.c.db, t.userId, id)!
  assert.deepEqual([edited.status, edited.folder, edited.title, edited.description, edited.tags], ['pending', 'icons/shop', 'mon-icone', 'Une icone', 'a,b'], 'une image en attente reste en attente')
  assert.equal((await t.c.call('POST', `/library/${id}/edit`, { csrf: 'faux', title: 'x' }, { accept: 'application/json' })).res.status, 403)

  assert.equal((await t.post(`/library/${id}/delete`)).res.status, 303)
  assert.equal(getImage(t.c.db, t.userId, id), undefined)
  assert.equal(existsSync(join(config.dataDir, 'library', id)), false, 'fichier supprime')
  assert.equal((await t.post(`/library/${id}/delete`)).res.status, 404)
})

test('tri : tache envoyee avec les images en attente, resultat applique et revalide, noms uniques, images laissees en attente', async () => {
  const t = await setup()
  assert.equal((await t.post('/library/sort')).res.status, 409, 'rien a trier')
  const [a, b, c] = [await t.add('a.png'), await t.add('b.png'), await t.add('c.png')]
  const s = await t.post('/library/sort')
  assert.equal(s.res.status, 200, s.text)
  const job = t.c.db.prepare("SELECT id, kind, requires FROM jobs WHERE kind = 'library.sort'").get() as { id: number; kind: string; requires: string }
  assert.equal(job.requires, 'claude')
  const payload = getJob(t.c.db, t.userId, job.id)!.payload as { images: { id: string; name: string; sha256: string }[]; vault: { items: unknown[] } }
  assert.deepEqual(payload.images.map((i) => i.id), [a, b, c])
  assert.deepEqual(payload.vault.items, [])
  assert.ok(listImages(t.c.db, t.userId).every((i) => i.status === 'sorting'))
  assert.equal((await t.post('/library/sort')).res.status, 409, 'un tri est deja en cours')
  assert.equal((await t.post(`/library/${a}/delete`)).res.status, 409, 'pas de suppression pendant le tri')

  // l'agent repond : valeurs etranges nettoyees, doublon de nom renomme, une image sans description reste en attente, une image inconnue ignoree
  markJobRunning(t.c.db, job.id, createWorkerFor(t).id)
  finishJob(t.c.db, job.id, 'succeeded', { sorted: [
    { id: a, folder: '../Icons/Armes', title: 'Epee Acier', description: '  Une epee\n en acier ', tags: ['Epee', 'arme'] },
    { id: b, folder: 'icons/armes', title: 'epee-acier', description: 'Une autre epee', tags: 'x, y' },
    { id: c, folder: 'x', title: 'x', description: '' },
    { id: 'f'.repeat(32), folder: 'x', title: 'x', description: 'inconnue' },
    { id: a, folder: 'autre', title: 'autre', description: 'doublon' },
  ] })
  syncLibrary(t.c.db, t.userId)
  const rows = Object.fromEntries(listImages(t.c.db, t.userId).map((i) => [i.id, i]))
  assert.deepEqual([rows[a].status, rows[a].folder, rows[a].title, rows[a].description, rows[a].tags], ['sorted', 'etc/icons/armes'.replace('etc/', ''), 'epee-acier', 'Une epee en acier', 'epee,arme'])
  assert.deepEqual([rows[b].status, rows[b].folder, rows[b].title], ['sorted', 'icons/armes', 'epee-acier-2'], 'nom unique dans le dossier')
  assert.equal(rows[c].status, 'pending')
  assert.equal(rows[c].sort_job_id, null)

  // un deuxieme tri voit le vault existant
  await t.post('/library/sort')
  const job2 = t.c.db.prepare("SELECT id FROM jobs WHERE kind = 'library.sort' ORDER BY id DESC LIMIT 1").get() as { id: number }
  const p2 = getJob(t.c.db, t.userId, job2.id)!.payload as { images: unknown[]; vault: { folders: string[]; items: { title: string }[] } }
  assert.deepEqual(p2.images.length, 1)
  assert.deepEqual(p2.vault.folders, ['icons/armes'])
  assert.deepEqual(p2.vault.items.map((i) => i.title), ['epee-acier', 'epee-acier-2'])
})

function createWorkerFor(t: Awaited<ReturnType<typeof setup>>) {
  const w = createWorker(t.c.db, t.userId, `PC${Math.random()}`, null)
  assert.ok(w.ok)
  return w
}

test('tri : echec ou annulation remettent les images en attente', async () => {
  const t = await setup()
  const a = await t.add('a.png')
  await t.post('/library/sort')
  const job = t.c.db.prepare("SELECT id FROM jobs WHERE kind = 'library.sort'").get() as { id: number }
  finishJob(t.c.db, job.id, 'failed', undefined, 'Claude indisponible')
  const r = syncLibrary(t.c.db, t.userId)
  assert.match(r.error!, /Claude indisponible/)
  assert.equal(getImage(t.c.db, t.userId, a)!.status, 'pending')

  await t.post('/library/sort')
  assert.equal(getImage(t.c.db, t.userId, a)!.status, 'sorting')
  assert.equal((await t.post('/library/sort/cancel')).res.status, 200)
  assert.equal(getImage(t.c.db, t.userId, a)!.status, 'pending')
})

test('page et suivi en direct : images, boutons, aucune fuite HTML', async () => {
  const t = await setup()
  const empty = (await t.c.call('GET', '/library')).text
  assert.match(empty, /Ta bibliotheque est vide/)
  const id = await t.add('<b>x</b>.png')
  await t.post(`/library/${id}/edit`, { description: '<script>alert(1)</script>' })
  const page = (await t.c.call('GET', '/library')).text
  for (const m of page.matchAll(/<script src="(\/static\/[^"?]+)/g)) assert.equal((await t.c.call('GET', m[1])).res.status, 200, `script servi : ${m[1]}`)
  assert.match(page, /En attente/)
  assert.match(page, new RegExp(`/library/${id}/file`))
  assert.doesNotMatch(page, /<script>alert\(1\)/)
  assert.doesNotMatch(page, /<b>x<\/b>/)
  assert.match(page, /Trier 1 image\(s\)/)
  const live = await t.c.call('GET', '/library/live', undefined, { accept: 'application/json' })
  const j = JSON.parse(live.text) as { html: string; counts: { pending: number } }
  assert.equal(j.counts.pending, 1)
  assert.match(j.html, /lib-card/)
  assert.match((await t.c.call('GET', '/projects')).text, /href="\/library"/, 'lien dans la barre laterale')
})

test('telechargement par un Worker : jeton, tache de tri en cours qui cite l image, meme utilisateur', async () => {
  const t = await setup()
  const a = await t.add('a.png')
  const b = await t.add('b.png')
  const w = createWorkerFor(t)
  const get = (id: string, token: string) => t.c.app.request(`${ORIGIN}/api/worker/library/${id}`, { headers: { authorization: `Bearer ${token}` } })
  assert.equal((await get(a, w.token)).status, 404, 'aucune tache')
  await t.post('/library/sort')
  const job = t.c.db.prepare("SELECT id FROM jobs WHERE kind = 'library.sort'").get() as { id: number }
  assert.equal((await get(a, w.token)).status, 404, 'tache pas en cours')
  markJobRunning(t.c.db, job.id, w.id)
  const r = await get(a, w.token)
  assert.equal(r.status, 200)
  assert.deepEqual(Buffer.from(await r.arrayBuffer()), PNG('a.png'))
  assert.match(r.headers.get('x-content-sha256')!, /^[0-9a-f]{64}$/)
  assert.equal((await get(a, 'rpmw_' + 'x'.repeat(43))).status, 403)
  assert.equal((await t.c.app.request(`${ORIGIN}/api/worker/library/${a}`)).status, 403)
  assert.equal((await get('1'.repeat(32), w.token)).status, 404)
  // l'image n'est pas citee par la tache si elle a ete ajoutee apres
  const late = await t.add('late.png')
  assert.equal((await get(late, w.token)).status, 404)
  assert.ok(b)

  const other = await createUser(t.c.db, 'autre@example.com', 'correct horse battery')
  const w2 = createWorker(t.c.db, other.id, 'PC2', null)
  assert.ok(w2.ok)
  t.c.db.prepare("UPDATE jobs SET worker_id = ? WHERE id = ?").run(w2.id, job.id)
  assert.equal((await get(a, w2.token)).status, 404, 'Worker d un autre utilisateur')
})

test('recherche : classement par nom / mots-cles / dossier / description, images triees seulement, id et dossier', async () => {
  const t = await setup()
  const sorted = async (name: string, f: Record<string, string>) => {
    const id = await t.add(name)
    t.c.db.prepare("UPDATE library_images SET status = 'sorted', folder = ?, title = ?, description = ?, tags = ? WHERE id = ?").run(f.folder, f.title, f.description, f.tags, id)
    return id
  }
  const sword = await sorted('a.png', { folder: 'icons/armes', title: 'epee-acier', description: 'Icone d epee en acier', tags: 'epee,arme,acier' })
  const shield = await sorted('b.png', { folder: 'icons/armes', title: 'bouclier', description: 'Un bouclier rond avec une epee gravee', tags: 'bouclier,defense' })
  const bg = await sorted('c.png', { folder: 'backgrounds', title: 'foret', description: 'Foret sombre', tags: 'foret,nature' })
  await t.add('en-attente.png') // pas triee : jamais renvoyee
  const ids = (o: Parameters<typeof searchImages>[2]) => searchImages(t.c.db, t.userId, o).map((h) => h.id)
  assert.deepEqual(ids({ query: 'epee' }), [sword, shield], 'le nom et les mots-cles priment sur la description')
  assert.deepEqual(ids({ query: 'ÉPÉE arme' }), [sword, shield])
  assert.deepEqual(ids({ query: 'dragon' }), [])
  assert.deepEqual(ids({ query: '', folder: 'icons' }), [shield, sword], 'sans requete : tout le dossier')
  assert.deepEqual(ids({ folder: 'backgrounds' }), [bg])
  assert.deepEqual(ids({ id: bg }), [bg])
  assert.equal(searchImages(t.c.db, t.userId, {}).length, 3)
  assert.equal(searchImages(t.c.db, t.userId, { limit: 2 }).length, 2)
  assert.deepEqual(searchImages(t.c.db, t.userId + 1, { query: 'epee' }), [], 'jamais les images d un autre')
})

test('routes Worker de la bibliotheque pour un chat : recherche et telechargement, chat en cours obligatoire, meme utilisateur', async () => {
  const t = await setup()
  const id = await t.add('a.png')
  const pending = await t.add('b.png')
  t.c.db.prepare("UPDATE library_images SET status = 'sorted', folder = 'icons', title = 'icone', description = 'Une icone', tags = 'icone' WHERE id = ?").run(id)
  const w = createWorkerFor(t)
  const call = (path: string, token = w.token) => t.c.app.request(`${ORIGIN}${path}`, { headers: { authorization: `Bearer ${token}` } })
  assert.equal((await call('/api/worker/library-search?q=icone')).status, 403, 'aucun chat en cours')
  assert.equal((await call(`/api/worker/library/${id}`)).status, 404)
  const job = t.c.hub.enqueue(t.userId, 'ai.chat', {}, { requires: [] })
  markJobRunning(t.c.db, job, w.id)
  const r = await call('/api/worker/library-search?q=icone')
  assert.equal(r.status, 200)
  const j = (await r.json()) as { images: { id: string; title: string }[] }
  assert.deepEqual(j.images.map((i) => i.id), [id])
  assert.deepEqual(((await (await call(`/api/worker/library-search?id=${pending}`)).json()) as { images: unknown[] }).images, [], 'image en attente : invisible')
  assert.equal((await call(`/api/worker/library/${id}`)).status, 200)
  assert.equal((await call(`/api/worker/library/${pending}`)).status, 404, 'image non triee')
  assert.equal((await call('/api/worker/library-search?q=icone', 'rpmw_' + 'x'.repeat(43))).status, 403)
  assert.equal((await t.c.app.request(`${ORIGIN}/api/worker/library-search`)).status, 403)

  const other = await createUser(t.c.db, 'autre2@example.com', 'correct horse battery')
  const w2 = createWorker(t.c.db, other.id, 'PC9', null)
  assert.ok(w2.ok)
  markJobRunning(t.c.db, t.c.hub.enqueue(other.id, 'ai.chat', {}, { requires: [] }), w2.id)
  assert.equal((await call(`/api/worker/library/${id}`, w2.token)).status, 404, 'image d un autre utilisateur')
  assert.deepEqual(((await (await call('/api/worker/library-search?q=icone', w2.token)).json()) as { images: unknown[] }).images, [])
})
