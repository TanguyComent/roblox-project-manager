import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { LIBRARY_DIR, libraryTools, parseEntries, referenceOf } from '../src/library-tools.ts'
import { searchLibrary } from '../src/library.ts'

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('png-body')])
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex')
const hex = (n: number) => n.toString(16).padStart(32, '0')
const entry = (n: number, over: Record<string, unknown> = {}) => ({
  id: hex(n), scope: 'icon', title: 'epee-acier', description: 'Icone d epee', tags: ['epee', 'arme'], style: 'cartoon-a', traits: ['cartoon'], subject: 'epee', colors: ['bleu-acier'], width: 160, height: 120, ratio: 'large', mime: 'image/png', size: PNG.length, sha256: sha(PNG), roblox_status: 'unpublished', roblox_asset_id: null, ...over,
})

function setup(entries: unknown[], over: Record<string, unknown> = {}) {
  const atelier = mkdtempSync(join(tmpdir(), 'rpm-libtools-'))
  const queries: unknown[] = []
  const ctx = {
    signal: new AbortController().signal, event: () => {},
    searchLibrary: async (q: unknown) => { queries.push(q); const id = (q as { id?: string }).id; return { images: id ? entries.filter((e) => (e as { id: string }).id === id) : entries } },
    downloadLibraryImage: async () => PNG, ...over,
  }
  const [search, get] = libraryTools({ ctx: ctx as never, atelier })
  const run = (t: typeof search, args: Record<string, unknown>) => t.run(args, ctx.signal)
  return { atelier, search, get, run, queries }
}
const textOf = (r: { content: { type: string; text?: string }[] }) => r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n')

test('reponse du Host : entrees mal formees ignorees, id Roblox seulement si publiee', () => {
  const list = parseEntries({ images: [entry(1), entry(2, { mime: 'image/svg+xml' }), entry(3, { id: 'court' }), entry(4, { sha256: 'x' }), entry(5, { roblox_status: 'published', roblox_asset_id: '123456' }), entry(6, { roblox_status: 'published', roblox_asset_id: 'abc; rm' }), entry(7, { roblox_status: 'unpublished', roblox_asset_id: '99' }), null] })
  assert.deepEqual(list.map((e) => e.id), [hex(1), hex(5), hex(6), hex(7)])
  assert.deepEqual(list.map((e) => e.roblox_asset_id), [null, '123456', null, null])
  assert.equal(referenceOf(list[1]), 'rbxassetid://123456')
  assert.equal(referenceOf(list[0]), `rbxlib://${hex(1)}`)
  assert.deepEqual(parseEntries('n importe quoi'), [])
})

test('library_search : liste lisible, requete transmise, aucun resultat explique', async () => {
  const t = setup([entry(1), entry(2, { title: 'bouclier', roblox_status: 'published', roblox_asset_id: '777' })])
  const r = textOf(await t.run(t.search, { query: 'epee', scope: 'icon', ratio: 'large' }))
  assert.match(r, /2 image\(s\)/)
  assert.match(r, new RegExp(`icon/epee-acier \\[id ${hex(1)}\\] : Icone d epee\n.*pas encore publiee`))
  assert.match(r, /publiee : rbxassetid:\/\/777/)
  assert.deepEqual(t.queries[0], { query: 'epee', scope: 'icon', style: '', subject: '', color: '', ratio: 'large' })
  assert.match(r, /sujet : epee · style : cartoon-a \(cartoon\) · couleurs : bleu-acier · 160x120 large/)
  const none = setup([])
  assert.match(textOf(await none.run(none.search, { query: 'dragon' })), /Aucune image trouvee pour « dragon »/)
  const off = setup([], { searchLibrary: undefined })
  assert.equal((await off.run(off.search, {})).isError, true)
})

test('library_get : image copiee dans l atelier, index pour l emulateur, reference, image vue par l IA', async () => {
  const t = setup([entry(1), entry(2, { title: 'bouclier', roblox_status: 'published', roblox_asset_id: '777' })])
  const r = await t.run(t.get, { id: hex(1) })
  assert.ok(!r.isError, textOf(r))
  assert.match(textOf(r), new RegExp(`Reference a utiliser dans Image : rbxlib://${hex(1)}`))
  assert.equal(r.content.find((c) => c.type === 'image')!.type, 'image')
  const dir = join(t.atelier, LIBRARY_DIR)
  const files = readdirSync(dir).filter((f) => f !== 'index.json')
  assert.deepEqual(files, [`${hex(1).slice(0, 8)}-epee-acier.png`])
  assert.deepEqual(readFileSync(join(dir, files[0])), PNG)
  const r2 = await t.run(t.get, { id: hex(2) })
  assert.match(textOf(r2), /rbxassetid:\/\/777/)
  const index = JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8'))
  assert.deepEqual(Object.keys(index).sort(), [`rbxassetid://777`, `rbxlib://${hex(1)}`, `rbxlib://${hex(2)}`].sort())
})

test('library_get : identifiant invalide, inconnu, image corrompue ; rien n est ecrit', async () => {
  const t = setup([entry(1)])
  assert.equal((await t.run(t.get, { id: '../../x' })).isError, true)
  assert.match(textOf(await t.run(t.get, { id: hex(9) })), /introuvable/)
  const bad = setup([entry(1)], { downloadLibraryImage: async () => Buffer.from('autre contenu') })
  assert.match(textOf(await bad.run(bad.get, { id: hex(1) })), /corrompue/)
  assert.equal(existsSync(join(bad.atelier, LIBRARY_DIR)), false)
})

test('recherche cote Worker : adresse, parametres et jeton', async () => {
  let seen = ''
  const f = (async (u: URL, init: RequestInit) => { seen = `${u.pathname}${u.search} ${new Headers(init.headers).get('authorization')}`; return Response.json({ images: [] }) }) as unknown as typeof fetch
  await searchLibrary('http://h:3000', 'rpmw_t', { query: 'epee rouge', scope: 'icon', style: 'cartoon-a', ratio: 'carre', similar: hex(3) }, f)
  assert.equal(seen, `/api/worker/library-search?q=epee+rouge&scope=icon&style=cartoon-a&ratio=carre&similar=${hex(3)} Bearer rpmw_t`)
  await assert.rejects(searchLibrary('http://h', 't', {}, (async () => new Response('', { status: 403 })) as unknown as typeof fetch), /403/)
})
