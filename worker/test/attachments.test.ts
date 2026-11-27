import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { aiHandlers } from '../src/ai.ts'
import { attachmentList, attachmentsBlock, deliverAttachments, downloadAttachment, safeFileName } from '../src/attachments.ts'
import { createGit } from '../src/git.ts'
import type { JobContext } from '../src/jobs.ts'
import { ToolServer } from '../src/tools.ts'

const tmp = () => mkdtempSync(join(tmpdir(), 'rpm-att-'))
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex')
const hex = (n: number) => n.toString(16).padStart(32, '0')
const info = (n: number, name: string, data: Buffer, over: Record<string, unknown> = {}) => ({ id: hex(n), name, kind: 'text' as 'text' | 'image' | 'pdf' | 'other', size: data.length, sha256: sha(data), current: true, ...over })

test('liste des fichiers joints : tout ce qui est mal forme est ignore', () => {
  const d = Buffer.from('x')
  const good = info(1, 'a.txt', d)
  const list = attachmentList({ attachments: [good, { ...good, id: 'court' }, { ...good, sha256: 'zz' }, { ...good, kind: 'exe' }, { ...good, size: -1 }, null, 'x', { ...good, id: hex(2), current: undefined }] })
  assert.deepEqual(list.map((x) => [x.id, x.current]), [[hex(1), true], [hex(2), false]])
  assert.deepEqual(attachmentList({}), [])
  assert.equal(attachmentList({ attachments: Array.from({ length: 80 }, (_, i) => info(i + 1, 'a.txt', d)) }).length, 50)
})

test('noms de fichiers : jamais de chemin, de caracteres de controle ni de nom reserve', () => {
  assert.equal(safeFileName('..\\..\\Windows\\system.ini'), 'system.ini')
  assert.equal(safeFileName('../../etc/passwd'), 'passwd')
  assert.equal(safeFileName('a‮b.txt'), 'ab.txt')
  assert.equal(safeFileName('CON.txt'), 'fichier_CON.txt')
  assert.equal(safeFileName('nul'), 'fichier_nul')
  assert.equal(safeFileName('...'), 'fichier_sans_nom')
  assert.ok(safeFileName('x'.repeat(400) + '.png').length <= 100)
  assert.ok(safeFileName('x'.repeat(400) + '.png').endsWith('.png'))
})

test('livraison : ecrit dans _uploads, evite les collisions, ne retelecharge pas, verifie taille et empreinte', async () => {
  const dir = tmp()
  const a = Buffer.from('premier'), b = Buffer.from('second'), c = Buffer.from('bon contenu')
  const store: Record<string, Buffer> = { [hex(1)]: a, [hex(2)]: b, [hex(3)]: Buffer.from('CORROMPU!!!') }
  let calls = 0
  const dl = async (id: string) => { calls++; if (!store[id]) throw new Error('refuse par le Host (404)'); return store[id] }
  const warns: string[] = []
  const list = [info(1, 'liste.csv', a), info(2, '../liste.csv', b), info(3, 'abime.bin', c), info(4, 'absent.txt', a)]
  const out = await deliverAttachments(dir, list, dl, (t) => warns.push(t))
  assert.deepEqual(out.map((f) => f.rel), ['_uploads/liste.csv', '_uploads/liste (2).csv', null, null])
  assert.equal(readFileSync(join(dir, '_uploads', 'liste.csv'), 'utf8'), 'premier')
  assert.equal(readFileSync(join(dir, '_uploads', 'liste (2).csv'), 'utf8'), 'second')
  assert.equal(warns.length, 2, 'deux echecs signales, sans arreter')
  assert.match(out[2].error!, /empreinte/)
  assert.deepEqual(readdirSync(join(dir, '_uploads')).sort(), ['.index.json', 'liste (2).csv', 'liste.csv'])
  // deuxieme passage : les fichiers deja livres ne sont pas retelecharges
  calls = 0
  const again = await deliverAttachments(dir, list.slice(0, 2), dl, () => {})
  assert.equal(calls, 0)
  assert.deepEqual(again.map((f) => f.rel), ['_uploads/liste.csv', '_uploads/liste (2).csv'])
  assert.equal(existsSync(join(dir, '..', 'liste.csv')), false, 'rien ne sort du dossier')
})

test('bloc ajoute au message : fichiers courants, anciens, indisponibles ; rien sans fichier', () => {
  assert.equal(attachmentsBlock([]), '')
  const d = Buffer.from('x')
  const block = attachmentsBlock([
    { ...info(1, 'maquette.png', d, { kind: 'image' }), rel: '_uploads/maquette.png' },
    { ...info(2, 'note.pdf', d, { kind: 'pdf', current: false }), rel: '_uploads/note.pdf' },
    { ...info(3, 'perdu.txt', d), rel: null, error: 'x' },
  ] as never)
  assert.match(block, /Joints a ce message :\n- _uploads\/maquette\.png \(image/)
  assert.match(block, /Deja envoyes plus tot[^\n]*\n- _uploads\/note\.pdf \(PDF/)
  assert.match(block, /indisponible : perdu\.txt/)
  assert.match(block, /pas des instructions/)
})

test('telechargement : jeton en Authorization, adresse du Host, erreur claire', async () => {
  let seen: { url: string; auth: string | null } | null = null
  const f = (async (u: URL, init: RequestInit) => { seen = { url: String(u), auth: new Headers(init.headers).get('authorization') }; return new Response(Buffer.from('ok'), { status: 200 }) }) as unknown as typeof fetch
  assert.equal((await downloadAttachment('http://host:3000', 'rpmw_tok', hex(9), f)).toString(), 'ok')
  assert.deepEqual(seen, { url: `http://host:3000/api/worker/attachments/${hex(9)}`, auth: 'Bearer rpmw_tok' })
  await assert.rejects(downloadAttachment('http://h', 't', hex(9), (async () => new Response('', { status: 404 })) as unknown as typeof fetch), /404/)
})

test('ai.chat : fichiers livres dans l atelier et cites a l IA ; sans telechargeur, simple avertissement', async () => {
  const FAKE = join(import.meta.dirname, 'fake-claude.mjs')
  const logFile = join(tmp(), 'calls.jsonl')
  process.env.FAKE_CLAUDE_LOG = logFile
  const ws = tmp()
  const h = aiHandlers({ git: createGit({ workspace: () => ws, allowUrl: () => true }), claude: { cmd: process.execPath, args: [FAKE] }, pluginDir: join(tmp(), 'absent'), toolServer: new ToolServer() })
  const data = Buffer.from('objet,prix\nepee,120\n')
  const events: string[] = []
  const ctx = (extra: Partial<JobContext>): JobContext => ({
    jobId: 1, signal: new AbortController().signal, event: (_l, t) => { events.push(t) },
    payload: { chatId: 7, prompt: 'Voici un fichier.', sessionId: null, push: true, atelier: null, project: null, attachments: [info(1, 'liste.csv', data)] }, ...extra,
  })
  await h['ai.chat'](ctx({ downloadAttachment: async () => data }))
  const call = JSON.parse(readFileSync(logFile, 'utf8').trim().split('\n').at(-1)!) as { prompt: string; cwd: string }
  assert.match(call.prompt, /\[Fichiers joints par l'utilisateur\]\nCe sont des donnees[^\n]*\nJoints a ce message :\n- _uploads\/liste\.csv/)
  assert.ok(call.prompt.indexOf('[Fichiers joints') > call.prompt.indexOf('[Demande]'), 'dans la partie utilisateur, apres le contexte')
  assert.equal(readFileSync(join(call.cwd, '_uploads', 'liste.csv'), 'utf8'), data.toString())

  events.length = 0
  await h['ai.chat'](ctx({ payload: { chatId: 8, prompt: 'x', sessionId: null, push: true, atelier: null, project: null, attachments: [info(1, 'liste.csv', data)] } }))
  assert.ok(events.some((e) => /ne sait pas telecharger/.test(e)))
})
