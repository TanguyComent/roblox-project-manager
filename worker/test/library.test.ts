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
