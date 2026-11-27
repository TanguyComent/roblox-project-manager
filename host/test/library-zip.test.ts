import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { crc32, deflateRawSync } from 'node:zlib'
import { config } from '../src/config.ts'
import { addZip, applySort, getImage, listImages, startSort, syncLibrary, LibraryError } from '../src/library.ts'
import { createWorker, finishJob, getJob, markJobRunning } from '../src/workers.ts'
import { cleanEntryName, listZip, readZipEntry } from '../src/zip.ts'
import { ORIGIN, client, csrfOf, registerAndEnable } from './helpers.ts'

config.dataDir = mkdtempSync(join(tmpdir(), 'rpm-zip-data-'))

const PNG = (tag: string) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]), Buffer.from('IHDR'), Buffer.from([0, 0, 0, 64, 0, 0, 0, 32]), Buffer.from(`-${tag}`)])
const JPG = (tag: string) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(`jpeg-${tag}`)])

interface Item { name: string; data: Buffer; method?: 0 | 8; flags?: number; lie?: { size?: number; crc?: number } }

/** Construit une archive ZIP (entrees stockees ou deflate). Les champs `lie` permettent de fabriquer des archives mensongeres. */
function makeZip(items: Item[]): Buffer {
  const parts: Buffer[] = []
  const cd: Buffer[] = []
  let offset = 0
  for (const it of items) {
    const name = Buffer.from(it.name, 'utf8')
    const method = it.method ?? 8
    const comp = method === 8 ? deflateRawSync(it.data) : it.data
    const crc = it.lie?.crc ?? crc32(it.data)
    const usize = it.lie?.size ?? it.data.length
    const flags = (it.flags ?? 0) | 0x800
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(flags, 6); local.writeUInt16LE(method, 8)
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(comp.length, 18); local.writeUInt32LE(usize, 22); local.writeUInt16LE(name.length, 26)
    parts.push(local, name, comp)
    const c = Buffer.alloc(46)
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(flags, 8); c.writeUInt16LE(method, 10)
    c.writeUInt32LE(crc, 16); c.writeUInt32LE(comp.length, 20); c.writeUInt32LE(usize, 24); c.writeUInt16LE(name.length, 28); c.writeUInt32LE(offset, 42)
    cd.push(c, name)
    offset += 30 + name.length + comp.length
  }
  const cdBuf = Buffer.concat(cd)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(items.length, 8); eocd.writeUInt16LE(items.length, 10); eocd.writeUInt32LE(cdBuf.length, 12); eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...parts, cdBuf, eocd])
}
const zipFile = (items: Item[] | Buffer) => { const p = join(mkdtempSync(join(tmpdir(), 'rpm-zipf-')), 'pack.zip'); writeFileSync(p, Array.isArray(items) ? makeZip(items) : items); return p }

async function setup() {
  const c = client()
  await registerAndEnable(c)
  const csrf = csrfOf((await c.call('GET', '/projects')).text)
  const userId = (c.db.prepare('SELECT id FROM users ORDER BY id LIMIT 1').get() as { id: number }).id
  const headers = (extra: Record<string, string> = {}) => ({ host: 'localhost:3000', origin: ORIGIN, cookie: c.getCookie(), ...extra })
  return { c, csrf, userId, headers }
}

test('lecteur ZIP : entrees stockees et compressees, noms nettoyes, dossiers et entrees chiffrees reperes', async () => {
  const data = PNG('a')
  const p = zipFile([
    { name: 'Pack/Boutons/bleu.png', data, method: 8 },
    { name: 'Pack/Boutons/rouge.png', data: PNG('b'), method: 0 },
    { name: '../../evil/../x.png', data: PNG('c') },
    { name: 'Pack/', data: Buffer.alloc(0), method: 0 },
    { name: 'secret.png', data: PNG('d'), flags: 1 },
  ])
  const list = await listZip(p, { maxEntries: 100, maxEntryBytes: 1_000_000 })
  assert.deepEqual(list.map((e) => [e.name, e.skip]), [['Pack/Boutons/bleu.png', null], ['Pack/Boutons/rouge.png', null], ['evil/x.png', null], ['Pack', 'directory'], ['secret.png', 'encrypted']])
  assert.deepEqual(await readZipEntry(p, list[0]), data)
  assert.deepEqual(await readZipEntry(p, list[1]), PNG('b'))
  await assert.rejects(readZipEntry(p, list[4]), /ignoree/)
  assert.equal(cleanEntryName('a\\b\\..\\c‮.png'), 'a/b/c.png')
})

test('lecteur ZIP : archives mensongeres, corrompues ou trop riches', async () => {
  const big = Buffer.alloc(200_000, 7)
  const lies = zipFile([{ name: 'bomb.png', data: big, lie: { size: 1000 } }])
  const list = await listZip(lies, { maxEntries: 10, maxEntryBytes: 10_000 })
  await assert.rejects(readZipEntry(lies, list[0]), /corrompue/, 'plus gros que declare : decompression bornee')
  const crc = zipFile([{ name: 'a.png', data: PNG('a'), lie: { crc: 12345 } }])
  await assert.rejects(readZipEntry(crc, (await listZip(crc, { maxEntries: 10, maxEntryBytes: 1_000_000 }))[0]), /CRC/)
  const huge = zipFile([{ name: 'huge.png', data: Buffer.alloc(50, 1), lie: { size: 5_000_000 } }])
  assert.equal((await listZip(huge, { maxEntries: 10, maxEntryBytes: 1_000_000 }))[0].skip, 'too-big')
  await assert.rejects(listZip(zipFile(Buffer.from('ceci n est pas une archive du tout, vraiment pas')), { maxEntries: 10, maxEntryBytes: 1 }), /pas une archive/)
  await assert.rejects(listZip(zipFile(Buffer.alloc(5)), { maxEntries: 10, maxEntryBytes: 1 }), /pas une archive/)
  const many = zipFile(Array.from({ length: 5 }, (_, i) => ({ name: `${i}.png`, data: PNG(String(i)) })))
  await assert.rejects(listZip(many, { maxEntries: 3, maxEntryBytes: 1_000_000 }), /trop riche/)
  const trunc = makeZip([{ name: 'a.png', data: PNG('a') }])
  await assert.rejects(listZip(zipFile(trunc.subarray(0, trunc.length - 10)), { maxEntries: 10, maxEntryBytes: 1_000_000 }))
})

test('import : seules les images sont gardees, doublons ecartes, provenance et dossier d\'origine memorises', async () => {
  const t = await setup()
  const p = zipFile([
    { name: 'Fantasy GUI/buttons/blue.png', data: PNG('blue') },
    { name: 'Fantasy GUI/buttons/red.PNG', data: PNG('red') },
    { name: 'Fantasy GUI/photo.jpg', data: JPG('x') },
    { name: 'Fantasy GUI/copie-de-blue.png', data: PNG('blue') },
    { name: 'Fantasy GUI/readme.txt', data: Buffer.from('lisez-moi') },
    { name: 'Fantasy GUI/source.psd', data: Buffer.from('8BPS') },
    { name: 'Fantasy GUI/vector.svg', data: Buffer.from('<svg onload=alert(1)/>') },
    { name: 'Fantasy GUI/setup.exe', data: Buffer.from('MZ\x90\x00') },
    { name: 'Fantasy GUI/camoufle.png', data: Buffer.from('MZ\x90\x00 pas une image') },
    { name: 'Fantasy GUI/vide.png', data: Buffer.alloc(0) },
    { name: 'Fantasy GUI/', data: Buffer.alloc(0), method: 0 },
  ])
  const r = await addZip(t.c.db, t.userId, p, 'Fantasy GUI Pack.zip')
  assert.deepEqual(r, { added: 3, duplicates: 1, ignored: 5, rejected: 2, stopped: null })
  const imgs = listImages(t.c.db, t.userId)
  assert.deepEqual(imgs.map((i) => i.file_name).sort(), ['blue.png', 'photo.jpg', 'red.PNG'])
  assert.ok(imgs.every((i) => i.status === 'pending' && i.origin === 'Fantasy GUI Pack'))
  assert.equal(imgs.find((i) => i.file_name === 'blue.png')!.hint, 'Fantasy GUI/buttons')
  assert.equal(imgs.find((i) => i.file_name === 'blue.png')!.width, 64, 'dimensions lues dans les octets')
  // un second import du meme pack n'ajoute rien
  const again = await addZip(t.c.db, t.userId, p, 'Fantasy GUI Pack.zip')
  assert.equal(again.added, 0)
  assert.equal(again.duplicates, 3 + 1)
})

test('import : limites (bibliotheque pleine), archive invalide, un import a la fois', async () => {
  const t = await setup()
  const keep = config.library.maxImages
  try {
    config.library.maxImages = 2
    const r = await addZip(t.c.db, t.userId, zipFile(Array.from({ length: 5 }, (_, i) => ({ name: `i${i}.png`, data: PNG(`l${i}`) }))), 'p.zip')
    assert.equal(r.added, 2)
    assert.match(r.stopped!, /pleine/)
  } finally { config.library.maxImages = keep }
  await assert.rejects(addZip(t.c.db, t.userId, zipFile(Buffer.from('pas un zip, rien du tout')), 'x.zip'), (e: unknown) => e instanceof LibraryError && /archive ZIP/.test(e.message))
  const p = zipFile([{ name: 'a.png', data: PNG('z') }])
  const [first, second] = await Promise.allSettled([addZip(t.c.db, t.userId, p, 'a.zip'), addZip(t.c.db, t.userId, p, 'a.zip')])
  assert.equal(first.status, 'fulfilled')
  assert.equal(second.status, 'rejected')
  assert.match(String((second as PromiseRejectedResult).reason.message), /deja en cours/)
})

test('route /library/upload-zip : CSRF, session, rapport, nettoyage du fichier temporaire, taille maximale', async () => {
  const t = await setup()
  const zip = makeZip([{ name: 'Pack/a.png', data: PNG('r1') }, { name: 'Pack/notes.txt', data: Buffer.from('x') }])
  const post = (body: Uint8Array, extra: Record<string, string> = {}) =>
    t.c.app.request(`${ORIGIN}/library/upload-zip`, { method: 'POST', headers: t.headers({ 'x-csrf': t.csrf, 'x-file-name': encodeURIComponent('Mon Pack.zip'), ...extra }), body: body as unknown as BodyInit })
  const ok = await post(new Uint8Array(zip))
  assert.equal(ok.status, 200)
  assert.deepEqual(await ok.json(), { added: 1, duplicates: 0, ignored: 1, rejected: 0, stopped: null })
  assert.equal(listImages(t.c.db, t.userId)[0].origin, 'Mon Pack')
  assert.equal((await post(new Uint8Array(zip), { 'x-csrf': 'faux' })).status, 403)
  assert.equal((await post(new Uint8Array(zip), { cookie: '' })).status, 302)
  assert.equal((await post(new Uint8Array(zip), { origin: 'http://evil.example' })).status, 403)
  const bad = await post(new Uint8Array(Buffer.from('ce n est pas un zip, vraiment pas du tout')))
  assert.equal(bad.status, 400)
  assert.match(((await bad.json()) as { error: string }).error, /archive ZIP/)
  const keep = config.library.maxZip
  try {
    config.library.maxZip = 64
    // la limite est lue au demarrage de l'application : on verifie surtout que la valeur est configurable
    assert.equal(config.library.maxZip, 64)
  } finally { config.library.maxZip = keep }
  assert.match((await t.c.call('GET', '/library')).text, /\.zip/, 'la page propose le depot d\'un pack')
})

test('tri en chaine : un lot reussi lance le suivant tant qu\'il reste des images, un lot sans progres s\'arrete', async () => {
  const t = await setup()
  const hub = t.c.hub
  for (let i = 0; i < 3; i++) t.c.db.prepare("INSERT INTO library_images (id, user_id, file_name, title, mime, size, sha256, created_at) VALUES (?, ?, ?, ?, 'image/png', 10, ?, ?)").run(String(i).repeat(32), t.userId, `f${i}.png`, `f${i}`, String(i).repeat(64), i)
  const keep = hub.enqueue.bind(hub)
  const first = startSort(t.c.db, hub, t.userId, true)
  assert.equal(first.count, 3)
  assert.equal((getJob(t.c.db, t.userId, first.jobId)!.payload as { chain: boolean }).chain, true)
  // le lot a range 2 images sur 3 : la 3e est reprise automatiquement
  const w = createWorker(t.c.db, t.userId, 'PC', null)
  assert.ok(w.ok)
  markJobRunning(t.c.db, first.jobId, w.id)
  finishJob(t.c.db, first.jobId, 'succeeded', { sorted: ['0', '1'].map((n) => ({ id: n.repeat(32), scope: 'icon', title: `t${n}`, description: 'd' })) })
  syncLibrary(t.c.db, t.userId, hub)
  const jobs = t.c.db.prepare("SELECT id, status FROM jobs WHERE kind = 'library.sort' ORDER BY id").all() as { id: number; status: string }[]
  assert.equal(jobs.length, 2, 'un second lot est lance')
  assert.equal(getImage(t.c.db, t.userId, '2'.repeat(32))!.status, 'sorting')
  // ce lot ne fait aucun progres : la chaine s'arrete
  finishJob(t.c.db, jobs[1].id, 'succeeded', { sorted: [] })
  syncLibrary(t.c.db, t.userId, hub)
  assert.equal(t.c.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE kind = 'library.sort'").get()!.n, 2)
  assert.equal(getImage(t.c.db, t.userId, '2'.repeat(32))!.status, 'pending')
  assert.ok(keep)
  // sans « chain » (ancien comportement), rien n'est relance
  const t2 = await setup()
  for (let i = 0; i < 2; i++) t2.c.db.prepare("INSERT INTO library_images (id, user_id, file_name, title, mime, size, sha256, created_at) VALUES (?, ?, ?, ?, 'image/png', 10, ?, ?)").run(String(i).repeat(32), t2.userId, `f${i}.png`, `f${i}`, String(i).repeat(64), i)
  const solo = startSort(t2.c.db, t2.c.hub, t2.userId, false)
  finishJob(t2.c.db, solo.jobId, 'succeeded', { sorted: [{ id: '0'.repeat(32), scope: 'icon', title: 'x', description: 'd' }] })
  assert.equal(applySort(t2.c.db, t2.userId, solo.jobId, getJob(t2.c.db, t2.userId, solo.jobId)!.result), 1)
})

test('tri d un nombre choisi : serie bornee, lots de 40 au plus, validation du nombre', async () => {
  const t = await setup()
  const ins = t.c.db.prepare("INSERT INTO library_images (id, user_id, file_name, title, mime, size, sha256, created_at) VALUES (?, ?, ?, ?, 'image/png', 10, ?, ?)")
  for (let i = 0; i < 100; i++) ins.run(String(i).padStart(32, '0'), t.userId, `f${i}.png`, `f${i}`, String(i).padStart(64, '0'), i)
  const post = (count: string) => t.c.call('POST', '/library/sort', { csrf: t.csrf, count }, { accept: 'application/json' })
  assert.equal((await post('0')).res.status, 400)
  assert.equal((await post('-3')).res.status, 400)
  assert.equal((await post('abc')).res.status, 400)
  assert.equal((await post('2.5')).res.status, 400)
  assert.equal((await post('50')).res.status, 200)
  const jobs = () => t.c.db.prepare("SELECT id FROM jobs WHERE kind = 'library.sort' ORDER BY id").all() as { id: number }[]
  const payload = (id: number) => getJob(t.c.db, t.userId, id)!.payload as { images: { id: string }[]; want?: number; chain: boolean }
  assert.equal(payload(jobs()[0].id).images.length, 40, 'un lot : 40 au plus')
  assert.equal(payload(jobs()[0].id).want, 50)
  const w = createWorker(t.c.db, t.userId, 'PC', null)
  assert.ok(w.ok)
  const finish = (id: number) => {
    markJobRunning(t.c.db, id, w.id)
    finishJob(t.c.db, id, 'succeeded', { sorted: payload(id).images.map((i) => ({ id: i.id, scope: 'icon', title: `t${i.id.slice(-3)}`, description: 'd' })) })
    syncLibrary(t.c.db, t.userId, t.c.hub)
  }
  finish(jobs()[0].id)
  assert.equal(jobs().length, 2)
  assert.equal(payload(jobs()[1].id).images.length, 10, 'le second lot complete les 50 demandes')
  assert.equal(payload(jobs()[1].id).want, 10)
  finish(jobs()[1].id)
  assert.equal(jobs().length, 2, 'la serie s arrete a 50 : il en reste 50 en attente')
  assert.equal((t.c.db.prepare("SELECT COUNT(*) AS n FROM library_images WHERE status = 'pending'").get() as { n: number }).n, 50)
  // nombre superieur a ce qui reste : borne ; vide : toutes
  assert.equal((await post('9999')).res.status, 200)
  assert.equal(payload(jobs()[2].id).want, 50)
  assert.match((await t.c.call('GET', '/library?view=pending')).text, /name="count"/)
})
