import assert from 'node:assert/strict'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { cleanName, isInline, purgeStaged, sniff, STAGED_TTL_MS } from '../src/attachments.ts'
import { createUser } from '../src/auth.ts'
import { createChat, listMessages } from '../src/chats.ts'
import { config } from '../src/config.ts'
import { createProject } from '../src/projects.ts'
import { createWorker, getJob, markJobRunning } from '../src/workers.ts'
import { ORIGIN, client, csrfOf, registerAndEnable } from './helpers.ts'

config.dataDir = mkdtempSync(join(tmpdir(), 'rpm-att-data-'))

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('fake-png-body')])
const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n')
const TXT = Buffer.from('objet,prix\nepee,120\n')

async function setup() {
  const c = client()
  await registerAndEnable(c)
  const csrf = csrfOf((await c.call('GET', '/projects')).text)
  const userId = (c.db.prepare('SELECT id FROM users ORDER BY id LIMIT 1').get() as { id: number }).id
  const project = createProject(c.db, userId, { name: 'Mon Jeu', groupId: null, groupName: null, githubRepo: 'acme/jeu', robloxAccountId: null })
  const chat = createChat(c.db, project.id, 'Test')
  const base = `/projects/${project.id}/chats/${chat.id}`
  const up = (name: string, data: Buffer, over: Record<string, string> = {}) =>
    c.app.request(`${ORIGIN}${base}/attachments`, {
      method: 'POST', headers: { host: 'localhost:3000', origin: ORIGIN, cookie: c.getCookie(), 'x-csrf': csrf, 'x-file-name': encodeURIComponent(name), ...over }, body: new Uint8Array(data),
    })
  return { c, csrf, userId, project, chat, base, up }
}

test('type deduit des octets, executables et scripts refuses, noms nettoyes', () => {
  assert.deepEqual(sniff(PNG, 'a.png'), { ok: true, kind: 'image', mime: 'image/png' })
  assert.deepEqual(sniff(PNG, 'renomme.txt'), { ok: true, kind: 'image', mime: 'image/png' }, 'le contenu fait foi, pas le nom')
  assert.equal(sniff(PDF, 'x.pdf').ok && (sniff(PDF, 'x.pdf') as { kind: string }).kind, 'pdf')
  assert.deepEqual(sniff(TXT, 'liste.csv'), { ok: true, kind: 'text', mime: 'text/plain' })
  assert.equal(sniff(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1]), 'p.jpg').ok, true)
  assert.equal(sniff(Buffer.from('RIFF1234WEBPVP8 '), 'p.webp').ok, true)
  assert.equal(sniff(Buffer.alloc(0), 'vide.txt').ok, false, 'fichier vide')
  for (const [data, name] of [
    [Buffer.from('MZ\x90\x00'), 'inoffensif.png'], [Buffer.from('\x7fELF'), 'a.bin'], [Buffer.from('#!/bin/sh\necho'), 'note.txt'], [TXT, 'installer.exe'], [TXT, 'run.BAT'], [TXT, 'x.ps1'], [TXT, 'a.sh'], [TXT, 'a.lnk'],
  ] as [Buffer, string][]) assert.equal(sniff(data, name).ok, false, name)
  assert.equal(isInline({ kind: 'image', mime: 'image/png' }), true)
  assert.equal(isInline({ kind: 'text', mime: 'text/plain' }), false)
  assert.equal(cleanName('..\\..\\etc/passwd'), 'passwd')
  assert.equal(cleanName('a‮b.exe'), 'ab.exe')
  assert.equal(cleanName('  ...'), 'fichier')
  assert.ok(cleanName('x'.repeat(300) + '.png').length <= 120)
  assert.ok(cleanName('x'.repeat(300) + '.png').endsWith('.png'))
})

test('televersement : succes, refus, limites, CSRF, authentification', async () => {
  const t = await setup()
  const ok = await t.up('maquette.png', PNG)
  assert.equal(ok.status, 200)
  const f = (await ok.json()) as { id: string; kind: string; url: string | null }
  assert.match(f.id, /^[0-9a-f]{32}$/)
  assert.equal(f.kind, 'image')
  assert.equal(f.url, `${t.base}/attachments/${f.id}`)
  assert.equal(((await (await t.up('note.pdf', PDF)).json()) as { url: string | null }).url, null, 'seules les images sont affichees en ligne')

  assert.equal((await t.up('virus.exe', TXT)).status, 400)
  assert.equal((await t.up('camoufle.png', Buffer.from('MZ\x90\x00pe'))).status, 400)
  assert.equal((await t.up('vide.txt', Buffer.alloc(0))).status, 400)
  assert.equal((await t.up('a.txt', TXT, { 'x-csrf': 'mauvais' })).status, 403, 'CSRF')
  assert.equal((await t.up('a.txt', TXT, { cookie: '' })).status, 302, 'sans session : redirection vers la connexion')
  assert.equal((await t.up('a.txt', TXT, { origin: 'http://evil.example' })).status, 403, 'origine')

  config.attach.maxFile = 100
  try { assert.equal((await t.up('gros.txt', Buffer.alloc(500, 97))).status, 413) } finally { config.attach.maxFile = 20 * 1048576 }
  const prev = config.attach.maxPerMessage
  config.attach.maxPerMessage = 2
  try { assert.equal((await t.up('3.txt', TXT)).status, 409, '2 fichiers deja en attente') } finally { config.attach.maxPerMessage = prev }
  const q = config.attach.userQuota
  config.attach.userQuota = 100
  try { assert.equal((await t.up('4.txt', Buffer.alloc(200, 97))).status, 413, 'quota utilisateur') } finally { config.attach.userQuota = q }
})

test('service : proprietaire seulement, en-tetes sans risque, retrait d\'un fichier en attente', async () => {
  const t = await setup()
  const png = (await (await t.up('a.png', PNG)).json()) as { id: string }
  const txt = (await (await t.up('<b>x</b>.svg', Buffer.from('<svg onload=alert(1)></svg>'))).json()) as { id: string }
  const get = (id: string, cookie = t.c.getCookie()) => t.c.app.request(`${ORIGIN}${t.base}/attachments/${id}`, { headers: { host: 'localhost:3000', cookie } })
  const r = await get(png.id)
  assert.equal(r.status, 200)
  assert.equal(r.headers.get('content-type'), 'image/png')
  assert.match(r.headers.get('content-disposition')!, /^inline;/)
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff')
  assert.match(r.headers.get('content-security-policy')!, /sandbox/)
  assert.deepEqual(Buffer.from(await r.arrayBuffer()), PNG)
  const s = await get(txt.id)
  assert.equal(s.headers.get('content-type'), 'application/octet-stream', 'un SVG ne s\'affiche jamais : telechargement')
  assert.match(s.headers.get('content-disposition')!, /^attachment;/)
  assert.doesNotMatch(s.headers.get('content-disposition')!, /[<>]/)
  assert.notEqual((await get(png.id, '')).status, 200, 'sans session')
  assert.equal((await get('0'.repeat(32))).status, 404)
  assert.equal((await get('zz')).status, 404)
  // un autre chat du meme projet ne voit pas le fichier
  const other = createChat(t.c.db, t.project.id, 'Autre')
  const cross = await t.c.app.request(`${ORIGIN}/projects/${t.project.id}/chats/${other.id}/attachments/${png.id}`, { headers: { host: 'localhost:3000', cookie: t.c.getCookie() } })
  assert.equal(cross.status, 404)

  const del = (id: string) => t.c.app.request(`${ORIGIN}${t.base}/attachments/${id}/delete`, { method: 'POST', headers: { host: 'localhost:3000', origin: ORIGIN, cookie: t.c.getCookie(), 'x-csrf': t.csrf } })
  assert.equal((await del(png.id)).status, 200)
  assert.equal((await get(png.id)).status, 404)
  assert.equal((await del(png.id)).status, 404)
})

test('envoi : fichiers rattaches au message, message sans texte accepte, payload de la tache, pas de reutilisation', async () => {
  const t = await setup()
  const a = (await (await t.up('maquette.png', PNG)).json()) as { id: string }
  const b = (await (await t.up('note.pdf', PDF)).json()) as { id: string }
  const send = (fields: Record<string, string>) => t.c.call('POST', `${t.base}/messages`, { csrf: t.csrf, prompt: '', model: '', effort: '', ...fields }, { accept: 'application/json' })

  assert.equal((await send({ attachments: 'pas-un-id' })).res.status, 400)
  assert.equal((await send({ attachments: '0'.repeat(32) })).res.status, 404, 'inconnu')
  assert.equal((await send({ attachments: `${a.id},${a.id}` })).res.status, 400, 'doublon')
  assert.equal((await send({})).res.status, 400, 'ni texte ni fichier')

  const r = await send({ attachments: `${a.id},${b.id}` })
  assert.equal(r.res.status, 200, r.text)
  const msgs = listMessages(t.c.db, t.chat.id)
  const user = msgs.find((m) => m.role === 'user')!
  assert.equal(user.content, 'Voici des fichiers.')
  const rows = t.c.db.prepare('SELECT message_id FROM chat_attachments WHERE chat_id = ?').all(t.chat.id) as { message_id: number }[]
  assert.ok(rows.length === 2 && rows.every((x) => x.message_id === user.id))
  const job = getJob(t.c.db, t.userId, msgs.find((m) => m.role === 'assistant')!.job_id!)!
  const payload = job.payload as { attachments: { id: string; name: string; current: boolean; sha256: string }[] }
  assert.deepEqual(payload.attachments.map((x) => [x.id, x.name, x.current]), [[a.id, 'maquette.png', true], [b.id, 'note.pdf', true]])
  assert.match(payload.attachments[0].sha256, /^[0-9a-f]{64}$/)

  // deja envoyes : ne peuvent pas etre rattaches a un second message
  t.c.db.prepare("UPDATE chat_messages SET status = 'done' WHERE role = 'assistant'").run()
  t.c.db.prepare("UPDATE jobs SET status = 'succeeded'").run()
  assert.equal((await send({ prompt: 'encore', attachments: a.id })).res.status, 404)
  // un message suivant retransmet les fichiers precedents (current = false)
  const next = await send({ prompt: 'regarde encore' })
  assert.equal(next.res.status, 200, next.text)
  const last = t.c.db.prepare('SELECT payload_json FROM jobs ORDER BY id DESC LIMIT 1').get() as { payload_json: string }
  assert.deepEqual((JSON.parse(last.payload_json) as { attachments: { current: boolean }[] }).attachments.map((x) => x.current), [false, false])
  // la page affiche vignette et pastille
  const page = (await t.c.call('GET', t.base)).text
  assert.match(page, new RegExp(`class="athumb" href="${t.base}/attachments/${a.id}"`))
  assert.match(page, /class="achip"[^>]*>.*note\.pdf/s)
})

test('telechargement par un Worker : jeton, tache en cours qui cite le fichier, meme utilisateur', async () => {
  const t = await setup()
  const a = (await (await t.up('maquette.png', PNG)).json()) as { id: string }
  const w = createWorker(t.c.db, t.userId, 'PC', null)
  assert.ok(w.ok)
  const get = (id: string, token: string) => t.c.app.request(`${ORIGIN}/api/worker/attachments/${id}`, { headers: { authorization: `Bearer ${token}` } })
  assert.equal((await get(a.id, w.token)).status, 404, 'aucune tache ne le cite')
  const jobId = t.c.hub.enqueue(t.userId, 'ai.chat', { attachments: [{ id: a.id }] }, { requires: [] })
  assert.equal((await get(a.id, w.token)).status, 404, 'tache pas en cours')
  markJobRunning(t.c.db, jobId, w.id)
  const r = await get(a.id, w.token)
  assert.equal(r.status, 200)
  assert.deepEqual(Buffer.from(await r.arrayBuffer()), PNG)
  assert.match(r.headers.get('x-content-sha256')!, /^[0-9a-f]{64}$/)
  assert.equal((await get(a.id, 'rpmw_' + 'x'.repeat(43))).status, 403)
  assert.equal((await t.c.app.request(`${ORIGIN}/api/worker/attachments/${a.id}`)).status, 403)
  const b = (await (await t.up('b.txt', TXT)).json()) as { id: string }
  assert.equal((await get(b.id, w.token)).status, 404, 'non cite par la tache')

  // un Worker d'un autre utilisateur, meme avec une tache qui cite le fichier
  const uid = (await createUser(t.c.db, 'autre@example.com', 'correct horse battery')).id
  const w2 = createWorker(t.c.db, uid, 'PC2', null)
  assert.ok(w2.ok)
  const j2 = t.c.hub.enqueue(uid, 'ai.chat', { attachments: [{ id: a.id }] }, { requires: [] })
  markJobRunning(t.c.db, j2, w2.id)
  assert.equal((await get(a.id, w2.token)).status, 404)
})

test('nettoyage : fichiers jamais envoyes purges apres 24 h, fichiers supprimes avec le chat', async () => {
  const t = await setup()
  const a = (await (await t.up('a.png', PNG)).json()) as { id: string }
  const path = join(config.dataDir, 'attachments', a.id)
  assert.ok(existsSync(path))
  assert.equal(purgeStaged(t.c.db), 0)
  assert.equal(purgeStaged(t.c.db, Date.now() + STAGED_TTL_MS + 1000), 1)
  assert.equal(existsSync(path), false)

  const b = (await (await t.up('b.png', PNG)).json()) as { id: string }
  await t.c.call('POST', `${t.base}/messages`, { csrf: t.csrf, prompt: 'x', model: '', effort: '', attachments: b.id }, { accept: 'application/json' })
  assert.equal(purgeStaged(t.c.db, Date.now() + 10 * STAGED_TTL_MS), 0, 'un fichier envoye n\'est jamais purge')
  t.c.db.prepare("UPDATE chat_messages SET status = 'done'").run()
  t.c.db.prepare("UPDATE jobs SET status = 'succeeded'").run()
  const del = await t.c.call('POST', `${t.base}/delete`, { csrf: t.csrf })
  assert.equal(del.res.status, 303)
  assert.equal(existsSync(join(config.dataDir, 'attachments', b.id)), false)
  assert.equal((t.c.db.prepare('SELECT COUNT(*) AS n FROM chat_attachments').get() as { n: number }).n, 0)
})
