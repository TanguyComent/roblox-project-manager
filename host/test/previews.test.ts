import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { serve } from '@hono/node-server'
import { createUser } from '../src/auth.ts'
import { createChat, listMessages } from '../src/chats.ts'
import { config } from '../src/config.ts'
import { PreviewError, previewFile, previewsForJobs, safePath, savePreview } from '../src/previews.ts'
import { createProject } from '../src/projects.ts'
import { createWorker, getJob, insertJob, markJobRunning } from '../src/workers.ts'
import { startWorker, type RunningWorker } from '../../worker/src/worker.ts'
import type { JobHandler } from '../../worker/src/jobs.ts'
import { client, csrfOf, registerAndEnable } from './helpers.ts'

config.dataDir = mkdtempSync(join(tmpdir(), 'rpm-host-data-')) // les apercus de ces tests n'ecrivent jamais dans le vrai dossier de donnees

async function waitFor(cond: () => boolean, what: string, ms = 4000) {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) assert.fail(`delai depasse : ${what}`)
    await new Promise((r) => setTimeout(r, 15))
  }
}

const b64 = (s: string) => Buffer.from(s).toString('base64')
const files = (extra: Record<string, string> = {}) => [{ path: 'index.html', data: b64('<html>apercu</html>') }, { path: 'assets/app.js', data: b64('console.log(1)') }, ...Object.entries(extra).map(([path, data]) => ({ path, data: b64(data) }))]
const meta = (n = 0, over: Record<string, unknown> = {}) => ({ n, title: 'Boutique', file: 'src/shop.story.tsx', viewport: 'Telephone', ok: true, error: null, checked: true, nodes: 12, errors: [], missing: ['@flamework/networking'], ...over })

async function setup() {
  const c = client()
  await registerAndEnable(c)
  const csrf = csrfOf((await c.call('GET', '/projects')).text)
  const userId = (c.db.prepare('SELECT id FROM users ORDER BY id LIMIT 1').get() as { id: number }).id
  const project = createProject(c.db, userId, { name: 'Mon Jeu', groupId: null, groupName: null, githubRepo: 'acme/jeu', robloxAccountId: null })
  const server = await new Promise<Server>((resolve) => { const s = serve({ fetch: c.app.fetch, port: 0, hostname: '127.0.0.1' }, () => resolve(s as Server)) })
  c.hub.attach(server)
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const running: RunningWorker[] = []
  const worker = createWorker(c.db, userId, 'PC', null)
  assert.ok(worker.ok)
  // une tache « en cours » sur ce Worker, pour les depots directs (sans passer par un vrai Worker)
  const runningJob = (uid = userId, wid = worker.id) => {
    const id = insertJob(c.db, uid, 'ai.chat', {}, {})
    markJobRunning(c.db, id, wid)
    return id
  }
  const upload = (jobId: number, body: Record<string, unknown>, token = worker.token) =>
    fetch(`${url}/api/worker/previews`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ jobId, ...body }) })
  const base = `/projects/${project.id}/chats`
  const close = async () => { await Promise.all(running.map((w) => w.stop())); c.hub.close(); server.closeAllConnections(); await new Promise((r) => server.close(r)) }
  return { c, csrf, userId, project, url, worker, runningJob, upload, base, running, close }
}

test('chemins de paquet : relatifs, sans « .. », sans fichier cache, extensions connues', () => {
  for (const ok of ['index.html', 'assets/app-Ab1_2.js', 'a/b/c.css', 'thumb.png', 'f.woff2']) assert.equal(safePath(ok), ok)
  for (const bad of ['../x.js', 'a/../b.js', '/etc/passwd', 'C:/x.js', 'a\\b.js', '.env', 'a/.hidden.js', 'run.php', 'x.exe', 'x.svg', 'noext', 'a//b.js', 'a/', '', 'x'.repeat(201) + '.js', 'a b.js', 'a\u0000.js', 'a%2e%2e/b.js', 42, null]) {
    assert.equal(safePath(bad), null, JSON.stringify(bad))
  }
})

test('depot : authentification du Worker, tache en cours obligatoire, utilisateur et Worker verifies', async () => {
  const t = await setup()
  try {
    const job = t.runningJob()
    assert.equal((await t.upload(job, { ...meta(), files: files() }, 'rpmw_' + 'x'.repeat(43))).status, 403, 'jeton inconnu')
    assert.equal((await fetch(`${t.url}/api/worker/previews`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 403, 'sans jeton')
    const bad = await fetch(`${t.url}/api/worker/previews`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${t.worker.token}` }, body: 'pas du json' })
    assert.equal(bad.status, 400)

    const ok = await t.upload(job, { ...meta(), files: files() })
    assert.equal(ok.status, 200)
    const { id } = (await ok.json()) as { id: string }
    assert.match(id, /^[0-9a-f]{32}$/)

    // une tache qui n'est pas en cours, ou qui est a un autre Worker / un autre utilisateur, est refusee
    const done = insertJob(t.c.db, t.userId, 'ai.chat', {}, {})
    assert.equal((await t.upload(done, { ...meta(1), files: files() })).status, 403, 'tache pas en cours')
    const other = await createUser(t.c.db, 'autre@example.com', 'correct horse battery')
    const theirs = t.runningJob(other.id, t.worker.id)
    assert.equal((await t.upload(theirs, { ...meta(0), files: files() })).status, 403, 'tache d\'un autre utilisateur')
    const w2 = createWorker(t.c.db, t.userId, 'Autre PC', null)
    assert.ok(w2.ok)
    const onW2 = t.runningJob(t.userId, w2.id)
    assert.equal((await t.upload(onW2, { ...meta(0), files: files() })).status, 403, 'tache d\'un autre Worker')
    assert.equal((await t.upload(999999, { ...meta(0), files: files() })).status, 403, 'tache inconnue')
    assert.equal((await t.upload('abc' as unknown as number, { ...meta(0), files: files() })).status, 403)
  } finally { await t.close() }
})

test('depot : fichiers refuses (chemins, types, tailles, index manquant, doublons)', async () => {
  const t = await setup()
  try {
    const job = t.runningJob()
    const attempt = async (n: number, fs: unknown, over: Record<string, unknown> = {}) => (await t.upload(job, { ...meta(n, over), files: fs })).status
    assert.equal(await attempt(0, [...files(), { path: '../evil.js', data: b64('x') }]), 400)
    assert.equal(await attempt(0, [...files(), { path: 'run.php', data: b64('x') }]), 400)
    assert.equal(await attempt(0, [...files(), { path: '.env', data: b64('x') }]), 400)
    assert.equal(await attempt(0, [...files(), { path: 'ok.js' }]), 400, 'fichier sans contenu')
    assert.equal(await attempt(0, [{ path: 'assets/app.js', data: b64('x') }]), 400, 'index.html manquant')
    assert.equal(await attempt(0, [...files(), { path: 'index.html', data: b64('y') }]), 400, 'doublon')
    assert.equal(await attempt(0, 'pas un tableau'), 400)
    assert.equal(await attempt(0, files(), { ok: false, error: 'x' }), 400, 'un echec ne porte pas de fichiers')
    assert.equal(await attempt(99, files()), 400, 'rang invalide')
    assert.equal(await attempt(0, Array.from({ length: 301 }, (_, i) => ({ path: `f${i}.js`, data: b64('x') }))), 413)
    assert.equal(await attempt(0, [...files(), { path: 'gros.js', data: Buffer.alloc(6 * 1024 * 1024 + 1).toString('base64') }]), 413)
    assert.equal(t.c.db.prepare('SELECT COUNT(*) AS n FROM previews').get()!.n, 0, 'rien n\'a ete enregistre')

    // un echec sans fichiers est enregistre (avec son erreur), pour que le chat l'affiche
    assert.equal((await t.upload(job, { ...meta(1, { ok: false, error: 'construction impossible' }), files: [] })).status, 200)
    const rows = previewsForJobs(t.c.db, [job]).get(job)!
    assert.deepEqual(rows.map((r) => [r.n, r.ok, r.error]), [[1, false, 'construction impossible']])
  } finally { await t.close() }
})

test('service : paquet servi avec une politique qui l\'isole, rien d\'autre n\'est accessible', async () => {
  const t = await setup()
  try {
    const job = t.runningJob()
    const { id } = (await (await t.upload(job, { ...meta(), files: files({ 'thumb.png': 'PNG' }) })).json()) as { id: string }
    const get = (path: string) => fetch(`${t.url}/preview/${id}/${path}`)

    const index = await get('index.html')
    assert.equal(index.status, 200)
    assert.equal(await index.text(), '<html>apercu</html>')
    assert.match(index.headers.get('content-type') ?? '', /text\/html/)
    const csp = index.headers.get('content-security-policy') ?? ''
    assert.match(csp, /sandbox allow-scripts/)
    assert.doesNotMatch(csp, /allow-same-origin/)
    assert.match(csp, /connect-src 'none'/)
    assert.match(csp, /frame-ancestors 'self'/)
    assert.equal(index.headers.get('access-control-allow-origin'), '*', 'necessaire au chargement des scripts depuis un cadre isole')
    assert.equal(index.headers.get('x-content-type-options'), 'nosniff')
    assert.equal(index.headers.get('referrer-policy'), 'no-referrer')
    assert.equal(index.headers.get('x-frame-options'), null, 'doit pouvoir etre affiche dans un cadre du site')
    assert.equal((await get('')).status, 200, 'la racine du paquet sert index.html')
    assert.equal(await (await get('assets/app.js')).text(), 'console.log(1)')
    assert.match((await get('assets/app.js')).headers.get('content-type') ?? '', /javascript/)
    assert.equal((await get('thumb.png')).status, 200)

    for (const bad of ['absent.js', '..%2f..%2fsecret.js', '%2e%2e/%2e%2e/x.js', 'assets/../../x.js', 'run.php', '.env', 'assets', 'x.svg']) {
      assert.equal((await get(bad)).status, 404, bad)
    }
    for (const badId of ['0'.repeat(32), 'A'.repeat(32), 'zz', '../..', id.slice(1)]) {
      assert.equal((await fetch(`${t.url}/preview/${badId}/index.html`)).status, 404, badId)
    }
    // l'apercu en echec n'a pas de paquet a servir
    const failed = (await (await t.upload(job, { ...meta(1, { ok: false, error: 'boom' }), files: [] })).json()) as { id: string }
    assert.equal((await fetch(`${t.url}/preview/${failed.id}/index.html`)).status, 404)

    // le reste du site garde ses en-tetes stricts, et autorise seulement ses propres cadres
    const page = await t.c.call('GET', '/projects')
    assert.match(page.res.headers.get('content-security-policy') ?? '', /frame-src 'self'/)
    assert.equal(page.res.headers.get('x-frame-options'), 'DENY')
    assert.match(page.res.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/)
  } finally { await t.close() }
})

test('un nouveau depot pour le meme bloc remplace l\'ancien (passe de correction)', async () => {
  const t = await setup()
  try {
    const job = t.runningJob()
    const first = (await (await t.upload(job, { ...meta(0, { ok: false, error: 'boom' }), files: [] })).json()) as { id: string }
    const second = (await (await t.upload(job, { ...meta(0), files: files() })).json()) as { id: string }
    assert.notEqual(first.id, second.id)
    const rows = previewsForJobs(t.c.db, [job]).get(job)!
    assert.deepEqual(rows.map((r) => [r.id, r.ok]), [[second.id, true]])
    const third = (await (await t.upload(job, { ...meta(0), files: files({ 'x.js': 'v3' }) })).json()) as { id: string }
    assert.equal(previewFile(t.c.db, second.id, 'index.html'), null, 'l\'ancien paquet est supprime')
    assert.ok(previewFile(t.c.db, third.id, 'x.js'))
  } finally { await t.close() }
})

test('quota par utilisateur', async () => {
  const t = await setup()
  try {
    const job = t.runningJob()
    t.c.db.prepare('INSERT INTO previews (id, user_id, job_id, n, title, file, viewport, ok, bytes, created_at) VALUES (?, ?, ?, 5, ?, ?, ?, 1, ?, ?)')
      .run('f'.repeat(32), t.userId, job, 't', 'f', 'UI Labs', 499 * 1024 * 1024 + 900_000, Date.now())
    const r = await t.upload(job, { ...meta(0), files: files({ 'gros.js': 'x'.repeat(200_000) }) })
    assert.equal(r.status, 413)
    assert.match(((await r.json()) as { error: string }).error, /plein/)
  } finally { await t.close() }
})

// --- dans le chat ---------------------------------------------------------------------------------------------------------------------------

function fenceBlock(o: unknown) { return '```rpm-ui\n' + JSON.stringify(o) + '\n```' }

// Faux executeur d'IA : repond avec des blocs rpm-ui et depose reellement les paquets (HTTP vers ce Host) via ctx.uploadPreview.
function aiWith(texts: () => string, bundles: { ok: boolean; error?: string }[], payloads: Record<string, unknown>[] = []): JobHandler {
  return async ({ payload, uploadPreview }) => {
    payloads.push(payload as Record<string, unknown>)
    const dir = mkdtempSync(join(tmpdir(), 'rpm-fake-bundle-'))
    mkdirSync(join(dir, 'assets'))
    writeFileSync(join(dir, 'index.html'), '<html>maquette</html>')
    writeFileSync(join(dir, 'assets', 'app.js'), 'console.log("ok")')
    const previews: unknown[] = []
    for (const [n, b] of bundles.entries()) {
      const m = { n, title: n === 0 ? 'Boutique <b>v2</b>' : `Apercu ${n}`, file: `src/s${n}.story.tsx`, viewport: n === 0 ? 'Telephone' : 'Desktop', root: n === 1 ? 'sandbox' as const : 'project' as const, ok: b.ok, error: b.error ?? null, checked: true, nodes: 9, errors: [], missing: [] }
      const previewId = await uploadPreview!(b.ok ? dir : null, m)
      previews.push({ ...m, previewId })
    }
    return { text: texts(), sessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', previews, commits: [], pushed: false }
  }
}

test('le chat affiche l\'apercu interactif dans un cadre isole, et la raison quand il manque', async () => {
  const t = await setup()
  try {
    const chat = createChat(t.c.db, t.project.id, 'Maquette boutique')
    const text = [
      'Voici la boutique :', fenceBlock({ file: 'src/s0.story.tsx', viewport: 'Telephone', title: 'Boutique <b>v2</b>' }),
      'Et un autre ecran :', fenceBlock({ file: 'src/s1.story.tsx' }),
      'Un exemple de format (pas un vrai apercu) :', '```markdown', '```rpm-ui', '{"file": "x.story.tsx"}', '```',
      fenceBlock({ file: 'src/s2.story.tsx' }),
    ].join('\n')
    const w = createWorker(t.c.db, t.userId, 'PC2', null)
    assert.ok(w.ok)
    t.running.push(startWorker({ hostUrl: t.url, token: w.token, handlers: { 'ai.chat': aiWith(() => text, [{ ok: true }, { ok: false, error: 'construction impossible : boom' }]) }, getCapabilities: () => ['git', 'claude'].map((id) => ({ id, label: id, version: null })) }))
    await waitFor(() => t.c.hub.status(w.id) !== 'offline', 'worker en ligne')

    await t.c.call('POST', `${t.base}/${chat.id}/messages`, { csrf: t.csrf, prompt: 'Montre-moi une boutique' })
    await waitFor(() => listMessages(t.c.db, chat.id)[1].job_status === 'succeeded', 'reponse')
    const html = (await t.c.call('GET', `${t.base}/${chat.id}`)).text

    // 1er bloc : cadre isole, adresse a 128 bits, jamais allow-same-origin
    const iframes = [...html.matchAll(/<iframe [^>]*>/g)].map((m) => m[0])
    assert.equal(iframes.length, 1)
    assert.match(iframes[0], /sandbox="allow-scripts"/)
    assert.doesNotMatch(iframes[0], /allow-same-origin/)
    assert.match(iframes[0], /src="\/preview\/[0-9a-f]{32}\/index\.html\?embed=1&amp;vp=Telephone"/)
    assert.match(iframes[0], /referrerpolicy="no-referrer"/)
    assert.match(html, /class="ui-preview-head"><strong>Boutique &lt;b&gt;v2&lt;\/b&gt;<\/strong>/, 'le titre est echappe')
    assert.ok(!html.includes('<b>v2</b>'))
    // 2e bloc : en echec -> raison affichee, pas de cadre
    assert.match(html, /ui-preview failed/)
    assert.match(html, /Apercu impossible : construction impossible : boom/)
    assert.match(html, /ui-preview failed[^]*class="chip accent"[^>]*>Atelier</, "un apercu venant de l'atelier est etiquete")
    // l'exemple imbrique n'est pas un apercu ; le 3e vrai bloc n'a pas d'apercu (le Worker n'en a depose que 2)
    assert.match(html, /ui-preview unavailable/)
    assert.match(html, /Apercu indisponible pour ce bloc/)
    assert.equal((html.match(/class="ui-preview(?: [a-z]+)?"/g) ?? []).length, 3, 'trois cartes : un apercu, un echec, un indisponible')

    // le paquet se charge reellement depuis cette adresse
    const src = /src="(\/preview\/[0-9a-f]{32}\/index\.html)/.exec(html)![1]
    assert.equal(await (await fetch(`${t.url}${src}`)).text(), '<html>maquette</html>')

    // une mise a jour en direct (live) renvoie les memes cartes
    const live = JSON.parse((await t.c.call('GET', `${t.base}/${chat.id}/live`)).text) as { thread: string }
    assert.match(live.thread, /<iframe [^>]*sandbox="allow-scripts"/)
  } finally { await t.close() }
})

test('supprimer un chat supprime ses apercus (lignes et fichiers)', async () => {
  const t = await setup()
  try {
    const chat = createChat(t.c.db, t.project.id, 'A supprimer')
    const w = createWorker(t.c.db, t.userId, 'PC2', null)
    assert.ok(w.ok)
    t.running.push(startWorker({ hostUrl: t.url, token: w.token, handlers: { 'ai.chat': aiWith(() => fenceBlock({ file: 'src/s0.story.tsx' }), [{ ok: true }]) }, getCapabilities: () => ['git', 'claude'].map((id) => ({ id, label: id, version: null })) }))
    await waitFor(() => t.c.hub.status(w.id) !== 'offline', 'worker en ligne')
    await t.c.call('POST', `${t.base}/${chat.id}/messages`, { csrf: t.csrf, prompt: 'Montre' })
    await waitFor(() => listMessages(t.c.db, chat.id)[1].job_status === 'succeeded', 'reponse')
    const row = t.c.db.prepare('SELECT id FROM previews').get() as { id: string }
    assert.ok(row)
    assert.ok(previewFile(t.c.db, row.id, 'index.html'))
    assert.equal((await t.c.call('POST', `${t.base}/${chat.id}/delete`, { csrf: t.csrf })).res.status, 303)
    assert.equal(t.c.db.prepare('SELECT COUNT(*) AS n FROM previews').get()!.n, 0)
    assert.equal(existsSync(join(config.dataDir, 'previews', row.id)), false, 'le dossier du paquet est supprime')
  } finally { await t.close() }
})

test('un depot direct ne peut pas ecrire hors de son dossier', () => {
  const c = client()
  const db = c.db
  const user = db.prepare("INSERT INTO users (email, password_hash, created_at) VALUES ('a@b.c', 'x', ?)").run(Date.now())
  const uid = Number(user.lastInsertRowid)
  const w = createWorker(db, uid, 'PC', null)
  assert.ok(w.ok)
  const job = insertJob(db, uid, 'ai.chat', {}, {})
  markJobRunning(db, job, w.id)
  assert.throws(() => savePreview(db, { id: w.id, user_id: uid }, { ...meta(), jobId: job, files: [{ path: '../../pwn.js', data: b64('x') }] } as never), (e: unknown) => e instanceof PreviewError)
  assert.equal(existsSync(join(config.dataDir, 'pwn.js')), false)
})
