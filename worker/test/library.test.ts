import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { JobContext } from '../src/jobs.ts'
import { downloadLibraryImage, libraryHandlers, sortPayload } from '../src/library.ts'

const FAKE = join(import.meta.dirname, 'fake-claude-library.mjs')
const tmp = () => mkdtempSync(join(tmpdir(), 'rpm-lib-'))
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex')
const hex = (n: number) => n.toString(16).padStart(32, '0')
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('png-body')])
const img = (n: number, name: string, data = PNG, over: Record<string, unknown> = {}) => ({ id: hex(n), name, mime: 'image/png', size: data.length, sha256: sha(data), ...over })

function run(payload: unknown, mode = 'ok', over: Partial<JobContext> = {}) {
  const log = join(tmp(), 'lib.jsonl')
  process.env.FAKE_LIB_LOG = log
  process.env.FAKE_LIB_MODE = mode
  const events: string[] = []
  const h = libraryHandlers({ claude: { cmd: process.execPath, args: [FAKE] } })
  const ctx: JobContext = { jobId: 1, payload, signal: new AbortController().signal, event: (_l, t) => { events.push(t) }, downloadLibraryImage: async () => PNG, ...over }
  const calls = () => readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) as { args: string[]; cwd: string; prompt: string; inbox: string[]; vault: string[]; settings: { permissions: { allow: string[]; deny: string[] } }; mcp: unknown; inboxBytes: number[] }[]
  return { result: h['library.sort'](ctx) as Promise<{ sorted: Record<string, unknown>[] }>, events, calls }
}

test('charge utile : images mal formees ignorees, notes du vault validees', () => {
  const p = sortPayload({
    images: [img(1, 'a.png', PNG, { width: 160, height: 120, origin: 'pack\nX' }), { ...img(2, 'b.png'), mime: 'image/svg+xml' }, { ...img(3, 'c.png'), id: 'court' }, null],
    vault: {
      scopes: ['icon', '../evil', 'Bad Scope'], traits: ['cartoon', 'x y'], subjects: ['epee'], styles: [{ name: 'cartoon-a', definition: 'Contours\nepais' }, { name: '../x', definition: 'y' }],
      items: [{ scope: 'icon', title: 'epee', style: 'cartoon-a', subject: 'epee', description: 'x\ny' }, { scope: '../evil', title: 'e', description: 'x' }, { scope: 'ok', title: '', description: 'x' }],
    },
  })
  assert.deepEqual(p.images.map((i) => [i.id, i.width, i.height, i.origin]), [[hex(1), 160, 120, 'pack X']])
  assert.deepEqual(p.notes, [{ scope: 'icon', title: 'epee', style: 'cartoon-a', subject: 'epee', description: 'x y' }])
  assert.deepEqual(p.vocab, { scopes: ['icon'], traits: ['cartoon'], subjects: ['epee'], styles: [{ name: 'cartoon-a', definition: 'Contours epais' }] })
})

test('tri : images dans inbox/, vault reconstruit, droits minimaux, resultat relie aux identifiants, dossier temporaire supprime', async () => {
  const t = run({ images: [img(1, 'Epee Acier.png', PNG, { width: 160, height: 120, origin: 'pack Fantasy' }), img(2, '../fond.png')], vault: { scopes: ['icon', 'background'], traits: ['cartoon', 'saturee'], subjects: ['hache'], styles: [{ name: 'cartoon-test', definition: 'Contours epais.' }], items: [{ scope: 'icon', title: 'hache', style: 'cartoon-test', subject: 'hache', description: 'Une hache.' }] } })
  const r = await t.result
  assert.deepEqual(r.sorted.map((s) => [s.id, s.scope, s.title, s.style, s.subject]), [[hex(1), 'icon', 'image-1', 'cartoon-test', 'sujet-1'], [hex(2), 'background', 'image-2', 'cartoon-test', 'sujet-2']])
  assert.ok(JSON.stringify(r.sorted).length < 3000, 'valeurs inattendues ecartees, valeurs connues bornees')
  const c = t.calls()[0]
  assert.deepEqual(c.inbox, ['01-Epee-Acier.png', '02-fond.png'], 'noms nettoyes, numerotes, sans chemin')
  assert.deepEqual([...c.vault].sort(), ['_styles/cartoon-test.md', 'icon/hache.md'])
  assert.match(c.prompt, /1\. inbox\/01-Epee-Acier\.png/)
  assert.match(c.prompt, /scopes : icon, background/)
  assert.match(c.prompt, /cartoon-test \(Contours epais\.\)/)
  assert.match(c.prompt, /\(160x120\) — provenance : pack Fantasy/)
  assert.match(c.prompt, /sujets deja utilises : hache/)
  assert.match(c.prompt, /DONNEE/)
  assert.deepEqual(c.settings.permissions.allow, ['Read', 'Write', 'Glob', 'Grep'])
  assert.ok(c.settings.permissions.deny.includes('Bash') && c.settings.permissions.deny.includes('WebFetch'))
  assert.deepEqual(c.mcp, { mcpServers: {} })
  assert.ok(c.args.includes('--strict-mcp-config') && !c.args.includes('--plugin-dir'))
  assert.ok(c.inboxBytes.every((b) => b === PNG.length))
  assert.equal(existsSync(c.cwd), false, 'dossier de travail supprime')
  assert.ok(t.events.some((e) => /2 image\(s\) rangee\(s\) sur 2/.test(e)))
})

test('tri : echecs clairs (empreinte, CLI en erreur, result.json absent ou illisible, pas de telechargeur)', async () => {
  const rejects = (p: Promise<unknown>, re: RegExp) => assert.rejects(p, (e: Error) => { assert.match(e.message, re); return true })
  await rejects(run({ images: [img(1, 'a.png', PNG, { sha256: 'f'.repeat(64) })] }).result, /corrompue/)
  await rejects(run({ images: [img(1, 'a.png')] }, 'crash').result, /code 2/)
  await rejects(run({ images: [img(1, 'a.png')] }, 'none').result, /result\.json manquant/)
  await rejects(run({ images: [img(1, 'a.png')] }, 'bad').result, /illisible/)
  await rejects(run({ images: [img(1, 'a.png')] }, 'ok', { downloadLibraryImage: undefined }).result, /ne sait pas telecharger/)
})

test('tri : entrees inconnues, doublons et valeurs etranges sont transmises telles quelles au Host (qui revalide), sans identifiant invente', async () => {
  const r = await run({ images: [img(1, 'a.png')] }, 'odd').result
  assert.equal(r.sorted.length, 1, 'n inconnu, doublon et non-objets ecartes')
  assert.equal(r.sorted[0].id, hex(1))
  assert.equal(r.sorted[0].scope, '../../etc', 'valeur brute : c est le Host qui nettoie')
  assert.ok(String(r.sorted[0].style_definition).length <= 200, 'longueurs bornees')
})

test('telechargement d une image : jeton en Authorization et adresse du Host', async () => {
  let seen = ''
  const f = (async (u: URL, init: RequestInit) => { seen = `${u} ${new Headers(init.headers).get('authorization')}`; return new Response(PNG, { status: 200 }) }) as unknown as typeof fetch
  assert.deepEqual(await downloadLibraryImage('http://h:3000', 'rpmw_t', hex(5), f), PNG)
  assert.equal(seen, `http://h:3000/api/worker/library/${hex(5)} Bearer rpmw_t`)
  await assert.rejects(downloadLibraryImage('http://h', 't', hex(5), (async () => new Response('', { status: 404 })) as unknown as typeof fetch), /404/)
  assert.ok(readdirSync(tmpdir()).length >= 0)
})

// --- library.find : recherche par description ------------------------------------------------------------------------------------------------------

import { ToolServer } from '../src/tools.ts'

const FAKE_FIND = join(import.meta.dirname, 'fake-claude-find.mjs')
const entry = (n: number, title: string) => ({ id: hex(n), scope: 'icon', folder: 'icon', title, description: `Icone ${title}`, tags: [title], style: 'flat', traits: ['flat'], subject: title, colors: ['rouge'], width: 64, height: 64, ratio: 'carre', mime: 'image/png', size: PNG.length, sha256: sha(PNG), roblox_status: 'unpublished', roblox_asset_id: null })

function runFind(payload: unknown, mode = 'ok', over: Partial<JobContext> = {}) {
  const log = join(tmp(), 'find.jsonl')
  process.env.FAKE_FIND_LOG = log
  process.env.FAKE_FIND_MODE = mode
  const queries: unknown[] = []
  const server = new ToolServer()
  const h = libraryHandlers({ claude: { cmd: process.execPath, args: [FAKE_FIND] }, toolServer: server })
  const ctx: JobContext = {
    jobId: 1, payload, signal: new AbortController().signal, event: () => {},
    searchLibrary: async (q) => { queries.push(q); const id = (q as { id?: string }).id; return { images: [entry(1, 'epee'), entry(2, 'bouclier')].filter((e) => !id || e.id === id) } },
    downloadLibraryImage: async () => PNG, ...over,
  }
  const calls = () => readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) as { args: string[]; cwd: string; prompt: string; settings: { permissions: { allow: string[]; deny: string[] } }; mcpKeys: string[]; toolNames: string[]; tools: { name: string; args: Record<string, unknown>; isError: boolean; images: number }[] }[]
  return { result: h['library.find'](ctx) as Promise<{ matches: { id: string; why: string }[] }>, calls, queries }
}

test('recherche par description : l agent utilise library_search / library_get, droits minimaux, resultat borne', async () => {
  const t = runFind({ query: 'une epee rouge', limit: 12 })
  const r = await t.result
  assert.deepEqual(r.matches.map((m) => m.id), [hex(1), hex(2)])
  assert.match(r.matches[0].why, /Correspond a « une epee rouge »/)
  const c = t.calls()[0]
  assert.deepEqual(c.toolNames, ['library_search', 'library_get'], 'ni library_publish ni ui_preview')
  assert.deepEqual(c.settings.permissions.allow, ['Write', 'mcp__rpm__library_search', 'mcp__rpm__library_get'])
  assert.ok(c.settings.permissions.deny.includes('Bash') && c.settings.permissions.deny.includes('WebFetch'))
  assert.deepEqual(c.mcpKeys, ['rpm'])
  assert.ok(c.args.includes('--strict-mcp-config'))
  assert.match(c.prompt, /« une epee rouge »/)
  assert.match(c.prompt, /DONNEES/)
  assert.deepEqual(c.tools.map((x) => [x.name, x.isError]), [['library_search', false], ['library_get', false]])
  assert.equal(c.tools[1].images, 1, 'l agent VOIT l image')
  assert.deepEqual(t.queries[0], { query: 'une epee rouge', scope: '', style: '', subject: '', color: '', ratio: '' })
  assert.equal(existsSync(c.cwd), false, 'dossier temporaire supprime')
})

test('recherche par description : resultats hostiles ecartes (inconnus tels quels pour le Host, doublons, chemins, trop nombreux), echecs clairs', async () => {
  const r = await runFind({ query: 'epee', limit: 5 }, 'odd').result
  assert.equal(r.matches.length, 5, 'borne par limit')
  assert.ok(r.matches.every((m) => /^[0-9a-f]{32}$/.test(m.id)))
  assert.equal(new Set(r.matches.map((m) => m.id)).size, r.matches.length, 'sans doublon')
  assert.ok(r.matches.every((m) => m.why.length <= 160))
  const rejects = (p: Promise<unknown>, re: RegExp) => assert.rejects(p, (e: Error) => { assert.match(e.message, re); return true })
  await rejects(runFind({ query: 'epee' }, 'none').result, /result\.json manquant/)
  await rejects(runFind({ query: 'epee' }, 'bad').result, /illisible/)
  await rejects(runFind({ query: 'epee' }, 'crash').result, /code 2/)
  await rejects(runFind({ query: 'a' }).result, /Decris l'image/)
  await rejects(runFind({ query: 'epee' }, 'ok', { searchLibrary: undefined }).result, /ne sait pas chercher/)
})
