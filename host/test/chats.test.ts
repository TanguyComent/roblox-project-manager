import assert from 'node:assert/strict'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { test } from 'node:test'
import { serve } from '@hono/node-server'
import { createUser } from '../src/auth.ts'
import { createChat, getChat, listMessages } from '../src/chats.ts'
import { createProject } from '../src/projects.ts'
import { createWorker, deleteWorker, getJob } from '../src/workers.ts'
import { startWorker, type RunningWorker } from '../../worker/src/worker.ts'
import { JobCancelled, type JobHandler } from '../../worker/src/jobs.ts'
import { client, csrfOf, registerAndEnable } from './helpers.ts'

async function waitFor(cond: () => boolean, what: string, ms = 4000) {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) assert.fail(`delai depasse : ${what}`)
    await new Promise((r) => setTimeout(r, 15))
  }
}

type Payload = { project: string; url: string; branch: string; prompt: string; sessionId: string | null; push: boolean }

async function setup(repo: string | null = 'acme/jeu') {
  const c = client()
  await registerAndEnable(c)
  const csrf = csrfOf((await c.call('GET', '/projects')).text)
  const userId = (c.db.prepare('SELECT id FROM users ORDER BY id LIMIT 1').get() as { id: number }).id
  const project = createProject(c.db, userId, { name: 'Mon Jeu', groupId: null, groupName: null, githubRepo: repo, robloxAccountId: null })
  const server = await new Promise<Server>((resolve) => { const s = serve({ fetch: c.app.fetch, port: 0, hostname: '127.0.0.1' }, () => resolve(s as Server)) })
  c.hub.attach(server)
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const running: RunningWorker[] = []
  const payloads: Payload[] = []
  let n = 0
  // Faux executeur d'IA : memorise ce que le Host demande et repond comme le vrai (voir worker/src/ai.ts).
  const ai: JobHandler = async ({ payload, event, signal }) => {
    const p = payload as Payload
    payloads.push(p)
    event('info', 'Claude demarre…')
    if (p.prompt.includes('BOOM')) throw new Error('Claude n\'est pas connecte.')
    if (p.prompt.includes('SLOW')) {
      await new Promise<void>((resolve, reject) => { const t = setTimeout(resolve, 30_000); signal.addEventListener('abort', () => { clearTimeout(t); reject(new JobCancelled()) }) })
    }
    n++
    return {
      text: `Reponse ${n} <b>gras</b>`, sessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', costUsd: 0.0123, durationMs: 4200, turns: 2,
      project: p.project, branch: p.branch, head: 'abc1234', commits: [`abc1234 Commit ${n}`], diffStat: ' a.txt | 1 +', diff: '+<script>alert(1)</script>', pushed: true, pushError: null, leftoverFiles: 0,
    }
  }
  const addWorker = (name: string, caps: string[] = ['git', 'claude'], uid = userId) => {
    const r = createWorker(c.db, uid, name, null)
    assert.ok(r.ok)
    const w = startWorker({
      hostUrl: url, token: r.token, handlers: { 'ai.chat': ai }, backoff: { minMs: 20, maxMs: 60 },
      getCapabilities: () => caps.map((id) => ({ id, label: id, version: '1.0' })),
    })
    running.push(w)
    return { id: r.id, run: w }
  }
  const online = (id: number) => waitFor(() => c.hub.status(id) !== 'offline', `Worker ${id} en ligne`)
  const base = `/projects/${project.id}/chats`
  const post = (path: string, body: Record<string, string> = {}) => c.call('POST', `${base}${path}`, { csrf, ...body })
  const send = (chatId: number, prompt: string) => post(`/${chatId}/messages`, { prompt })
  const page = async (chatId: number) => (await c.call('GET', `${base}/${chatId}`)).text
  // Attend la fin des taches du chat puis l'affiche (c'est l'affichage qui reporte les reponses dans le chat).
  const settle = async (chatId: number) => {
    await waitFor(() => listMessages(c.db, chatId).every((m) => m.job_status === null || !['queued', 'running'].includes(m.job_status)), 'taches du chat terminees')
    await page(chatId)
  }
  const close = async () => { await Promise.all(running.map((w) => w.stop())); c.hub.close(); server.closeAllConnections(); await new Promise((r) => server.close(r)) }
  return { c, csrf, userId, project, base, url, payloads, addWorker, online, post, send, page, settle, close }
}

test('les pages de chats exigent une session complete et un jeton CSRF', async () => {
  const anon = client()
  for (const path of ['/projects/1/chats', '/projects/1/chats/1']) {
    const r = await anon.call('GET', path)
    assert.equal(r.res.status, 302, path)
    assert.equal(r.res.headers.get('location'), '/login', path)
  }
  const t = await setup()
  try {
    const r = await t.c.call('POST', t.base, { title: 'Sans jeton' })
    assert.equal(r.res.status, 403)
    assert.equal(t.c.db.prepare('SELECT COUNT(*) AS n FROM chats').get()!.n, 0)
  } finally { await t.close() }
})

test('creer, lister, ouvrir et supprimer un chat ; chaque chat a sa branche', async () => {
  const t = await setup()
  try {
    assert.match((await t.c.call('GET', t.base)).text, /Aucun chat/)
    assert.equal((await t.post('', { title: '   ' })).res.status, 400)
    assert.equal((await t.post('', { title: 'x'.repeat(81) })).res.status, 400)

    const a = await t.post('', { title: 'Ajouter l\'inventaire !' })
    assert.equal(a.res.status, 303)
    const b = await t.post('', { title: 'Ajouter l\'inventaire !' })
    const [ida, idb] = [a, b].map((r) => Number(/chats\/(\d+)/.exec(r.res.headers.get('location')!)![1]))
    const chatA = getChat(t.c.db, t.project.id, ida)!
    const chatB = getChat(t.c.db, t.project.id, idb)!
    assert.match(chatA.branch, /^ai\/chat-\d+-ajouter-l-inventaire$/)
    assert.notEqual(chatA.branch, chatB.branch, 'deux chats de meme titre : deux branches')

    const list = (await t.c.call('GET', t.base)).text
    assert.match(list, /Ajouter l&#39;inventaire|Ajouter l'inventaire/)
    assert.ok(list.includes(chatA.branch))
    const open = await t.c.call('GET', `${t.base}/${ida}`)
    assert.equal(open.res.status, 200)
    assert.match(open.text, /Pose ta premiere question/)

    assert.equal((await t.post(`/${ida}/delete`)).res.status, 303)
    assert.equal(getChat(t.c.db, t.project.id, ida), undefined)
    assert.ok(getChat(t.c.db, t.project.id, idb), "l'autre chat reste")
    assert.equal((await t.c.call('GET', `${t.base}/${ida}`)).res.status, 404)
    assert.match((await t.c.call('GET', `${t.base}?n=deleted`)).text, /Chat supprime/)
  } finally { await t.close() }
})

test('un message part sur un Worker equipe, la reponse est stockee, la conversation est reprise ensuite', async () => {
  const t = await setup()
  try {
    const w = t.addWorker('PC')
    await t.online(w.id)
    const chat = createChat(t.c.db, t.project.id, 'Inventaire')

    const r = await t.send(chat.id, 'Ajoute un inventaire')
    assert.equal(r.res.status, 303)
    await t.settle(chat.id)

    const first = t.payloads[0]
    assert.deepEqual([first.project, first.url, first.branch, first.prompt, first.sessionId, first.push],
      ['mon-jeu', 'https://github.com/acme/jeu.git', chat.branch, 'Ajoute un inventaire', null, true])
    const job = getJob(t.c.db, t.userId, listMessages(t.c.db, chat.id)[1].job_id!)!
    assert.deepEqual(job.requires, ['git', 'claude'])
    assert.equal(job.worker_id, w.id)

    const html = await t.page(chat.id)
    assert.match(html, /Ajoute un inventaire/)
    assert.match(html, /Reponse 1 &lt;b&gt;gras&lt;\/b&gt;/, 'le texte de l\'IA est echappe')
    assert.ok(!html.includes('<b>gras</b>') && !html.includes('<script>alert'), 'aucun HTML venant de l\'IA n\'est interprete')
    assert.match(html, /1 commit/)
    assert.match(html, /pousse sur GitHub/)
    assert.match(html, /abc1234 Commit 1/)
    assert.match(html, /Voir les modifications/)
    assert.match(html, /0\.012 \$/)
    const stored = getChat(t.c.db, t.project.id, chat.id)!
    assert.equal(stored.session_id, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee')
    assert.equal(stored.worker_id, w.id)
    assert.equal(stored.worker_name, 'PC')

    // 2e message : meme Worker, meme conversation, meme branche
    await t.send(chat.id, 'Ajoute aussi les quetes')
    await t.settle(chat.id)
    assert.equal(t.payloads[1].sessionId, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee')
    assert.equal(t.payloads[1].branch, chat.branch)
    assert.match(await t.page(chat.id), /Reponse 2/)
    assert.equal(listMessages(t.c.db, chat.id).length, 4)
  } finally { await t.close() }
})

test('sans Worker equipe (Git + Claude Code) le message attend, puis part des qu\'un Worker adapte apparait', async () => {
  const t = await setup()
  try {
    const sansClaude = t.addWorker('Sans Claude', ['git'])
    await t.online(sansClaude.id)
    const chat = createChat(t.c.db, t.project.id, 'Attente')
    await t.send(chat.id, 'Bonjour')
    const msgs = () => listMessages(t.c.db, chat.id)
    assert.equal(msgs()[1].job_status, 'queued', "un Worker qui n'a pas Claude Code ne prend pas la tache")
    const waiting = await t.page(chat.id)
    assert.match(waiting, /En attente d&#39;un Worker|En attente d'un Worker/)
    assert.match(waiting, /Aucun Worker connecte/)
    assert.match(waiting, /http-equiv="refresh"/)
    assert.equal(t.payloads.length, 0)

    // une seule reponse a la fois
    const again = await t.send(chat.id, 'Deuxieme')
    assert.equal(again.res.status, 409)
    assert.match(again.text, /deja en cours/)
    assert.equal(msgs().length, 2)

    const outille = t.addWorker('Equipe')
    await waitFor(() => msgs()[1].job_status === 'succeeded', 'tache partie sur le Worker equipe')
    await t.page(chat.id)
    assert.equal(msgs()[1].status, 'done')
    assert.equal(getChat(t.c.db, t.project.id, chat.id)!.worker_id, outille.id)
  } finally { await t.close() }
})

test('un outil qui apparait en cours de route debloque la tache en attente', async () => {
  const t = await setup()
  try {
    const caps = ['git']
    const r = createWorker(t.c.db, t.userId, 'PC', null)
    assert.ok(r.ok)
    const w = startWorker({ hostUrl: t.url, token: r.token, handlers: {}, getCapabilities: () => caps.map((id) => ({ id, label: id, version: null })) })
    await t.online(r.id)
    const chat = createChat(t.c.db, t.project.id, 'Outil')
    await t.send(chat.id, 'Bonjour')
    assert.equal(listMessages(t.c.db, chat.id)[1].job_status, 'queued')
    // Claude Code est installe, le Worker le signale sans se reconnecter
    ;(w as RunningWorker).setCapabilities([{ id: 'git', label: 'Git', version: null }, { id: 'claude', label: 'Claude Code', version: '2.1' }])
    await waitFor(() => ['running', 'failed', 'succeeded'].includes(listMessages(t.c.db, chat.id)[1].job_status!), 'tache demarree')
    await w.stop()
  } finally { await t.close() }
})

test('echec de l\'IA, annulation et suppression d\'un chat en cours', async () => {
  const t = await setup()
  try {
    const w = t.addWorker('PC')
    await t.online(w.id)
    const chat = createChat(t.c.db, t.project.id, 'Echecs')

    await t.send(chat.id, 'BOOM')
    await waitFor(() => listMessages(t.c.db, chat.id)[1].job_status === 'failed', 'echec')
    const failed = await t.page(chat.id)
    assert.match(failed, /pas connecte/)
    assert.equal(listMessages(t.c.db, chat.id)[1].status, 'failed')
    assert.ok(!/disabled/.test(failed.split('class="composer"')[1] ?? ''), 'on peut reessayer apres un echec')

    await t.send(chat.id, 'SLOW 1')
    await waitFor(() => listMessages(t.c.db, chat.id)[3].job_status === 'running', 'en cours')
    assert.match(await t.page(chat.id), /L&#39;IA travaille|L'IA travaille/)
    assert.equal((await t.post(`/${chat.id}/cancel`)).res.status, 303)
    await waitFor(() => listMessages(t.c.db, chat.id)[3].job_status === 'cancelled', 'annulee')
    await t.page(chat.id)
    assert.equal(listMessages(t.c.db, chat.id)[3].status, 'cancelled')
    await waitFor(() => t.c.hub.status(w.id) === 'idle', 'Worker libere')

    // supprimer un chat dont la reponse est en cours arrete la tache
    const other = createChat(t.c.db, t.project.id, 'A supprimer')
    await t.send(other.id, 'SLOW 2')
    await waitFor(() => listMessages(t.c.db, other.id)[1].job_status === 'running', 'en cours')
    const jobId = listMessages(t.c.db, other.id)[1].job_id!
    assert.equal((await t.post(`/${other.id}/delete`)).res.status, 303)
    await waitFor(() => getJob(t.c.db, t.userId, jobId)!.status === 'cancelled', 'tache arretee')
    assert.equal(t.c.db.prepare('SELECT COUNT(*) AS n FROM chat_messages WHERE chat_id = ?').get(other.id)!.n, 0, 'messages supprimes avec le chat')
  } finally { await t.close() }
})

test('validations : message vide ou trop long, projet sans depot GitHub', async () => {
  const t = await setup()
  const bare = await setup(null)
  try {
    const w = t.addWorker('PC')
    await t.online(w.id)
    const chat = createChat(t.c.db, t.project.id, 'Validations')
    assert.equal((await t.send(chat.id, '   ')).res.status, 400)
    const long = await t.send(chat.id, 'x'.repeat(20_001))
    assert.equal(long.res.status, 400)
    assert.equal(t.c.db.prepare('SELECT COUNT(*) AS n FROM jobs').get()!.n, 0, 'aucune tache creee')

    const c2 = createChat(bare.c.db, bare.project.id, 'Sans depot')
    const r = await bare.send(c2.id, 'Bonjour')
    assert.equal(r.res.status, 400)
    assert.match(r.text, /pas de depot GitHub/)
    assert.equal(bare.c.db.prepare('SELECT COUNT(*) AS n FROM jobs').get()!.n, 0)
  } finally { await t.close(); await bare.close() }
})

test('si le Worker du chat est supprime, un autre prend le relais avec une nouvelle conversation', async () => {
  const t = await setup()
  try {
    const a = t.addWorker('Ancien')
    await t.online(a.id)
    const chat = createChat(t.c.db, t.project.id, 'Relais')
    await t.send(chat.id, 'Un')
    await t.settle(chat.id)
    assert.equal(getChat(t.c.db, t.project.id, chat.id)!.worker_id, a.id)

    await a.run.stop()
    await waitFor(() => t.c.hub.status(a.id) === 'offline', 'ancien Worker hors ligne') // (SQLite reutilise l'identifiant du Worker supprime)
    deleteWorker(t.c.db, t.userId, a.id)
    assert.equal(getChat(t.c.db, t.project.id, chat.id)!.worker_id, null)
    const b = t.addWorker('Nouveau')
    await t.online(b.id)
    await t.send(chat.id, 'Deux')
    await t.settle(chat.id)
    assert.equal(t.payloads[1].sessionId, null, 'la session Claude etait sur l\'ancienne machine')
    assert.equal(t.payloads[1].branch, chat.branch, 'meme branche : le travail pousse est retrouve')
  } finally { await t.close() }
})

test('isolation : les chats et les Workers d\'un autre utilisateur sont invisibles', async () => {
  const t = await setup()
  try {
    const other = await createUser(t.c.db, 'autre@example.com', 'correct horse battery')
    const theirProject = createProject(t.c.db, other.id, { name: 'Autre', groupId: null, groupName: null, githubRepo: 'x/y', robloxAccountId: null })
    const theirChat = createChat(t.c.db, theirProject.id, 'Secret')

    for (const [method, path] of [
      ['GET', `/projects/${theirProject.id}/chats`], ['GET', `/projects/${theirProject.id}/chats/${theirChat.id}`],
      ['POST', `/projects/${theirProject.id}/chats`], ['POST', `/projects/${theirProject.id}/chats/${theirChat.id}/messages`],
      ['POST', `/projects/${theirProject.id}/chats/${theirChat.id}/delete`], ['POST', `/projects/${theirProject.id}/chats/${theirChat.id}/cancel`],
    ] as const) {
      const r = await t.c.call(method, path, method === 'POST' ? { csrf: t.csrf, title: 'x', prompt: 'x' } : undefined)
      assert.equal(r.res.status, 404, `${method} ${path}`)
    }
    // mon projet, mais le chat d'un autre projet
    const mine = createChat(t.c.db, t.project.id, 'Mien')
    assert.equal((await t.c.call('GET', `${t.base}/${theirChat.id}`)).res.status, 404)
    assert.equal((await t.c.call('GET', `${t.base}/${mine.id}`)).res.status, 200)
    assert.ok(getChat(t.c.db, theirProject.id, theirChat.id), 'rien n\'a ete supprime')

    // la tache d'un autre utilisateur ne tombe jamais sur mon Worker, meme equipe
    const mineWorker = t.addWorker('Mon PC')
    await t.online(mineWorker.id)
    const jobId = t.c.hub.enqueue(other.id, 'ai.chat', { project: 'autre', url: 'https://github.com/x/y.git', branch: 'ai/x', prompt: 'secret', sessionId: null, push: false }, { requires: ['git', 'claude'] })
    await new Promise((r) => setTimeout(r, 300))
    assert.equal(getJob(t.c.db, other.id, jobId)!.status, 'queued')
    assert.equal(t.payloads.length, 0)
  } finally { await t.close() }
})

test('le projet propose le lien vers ses chats', async () => {
  const t = await setup()
  try {
    assert.ok((await t.c.call('GET', `/projects/${t.project.id}`)).text.includes(`/projects/${t.project.id}/chats`))
  } finally { await t.close() }
})
