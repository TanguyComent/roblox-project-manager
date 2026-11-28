import assert from 'node:assert/strict'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { test } from 'node:test'
import { serve } from '@hono/node-server'
import { createUser } from '../src/auth.ts'
import { saveConnection, updateUiTemplate } from '../src/github-connection.ts'
import { config } from '../src/config.ts'
import { createChat, deleteChat, getChat, listChats, listMessages, renameChat } from '../src/chats.ts'
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

type Payload = {
  chatId: number; prompt: string; sessionId: string | null; push: boolean; model: string | null; effort: string | null
  project: { slug: string; url: string; branch: string; base: string | null; open: boolean } | null
  atelier: { url: string; base: string | null } | null
  contextHash?: string | null; contextAge?: number
}

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
    event('info', 'Je dois <b>reflechir</b> au probleme', 'thinking')
    event('info', 'Lecture de a.txt', 'tool')
    event('info', 'Je commence par regarder.', 'text')
    if (p.prompt.includes('BOOM')) throw new Error('Claude n\'est pas connecte.')
    if (p.prompt.includes('SLOW')) {
      await new Promise<void>((resolve, reject) => { const t = setTimeout(resolve, 30_000); signal.addEventListener('abort', () => { clearTimeout(t); reject(new JobCancelled()) }) })
    }
    n++
    return {
      text: `Reponse ${n} <b>gras</b>`, sessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', costUsd: 0.0123, durationMs: 4200, turns: 2,
      project: p.project?.slug ?? null, branch: p.project && (p.project.open || p.prompt.includes('OUVRE')) ? p.project.branch : null, branchOpened: !!p.project && !p.project.open && p.prompt.includes('OUVRE'),
      // comme le vrai Worker : le contexte n'est renvoye qu'au demarrage, s'il change, ou tous les 10 messages
      contextHash: 'abcdef0123456789', contextSent: p.sessionId === null || p.contextHash !== 'abcdef0123456789' || (p.contextAge ?? 99) >= 10, limit: p.prompt.includes('LIMITE') ? 'turns' : null,
      head: 'abc1234', commits: [`abc1234 Commit ${n}`], diffStat: ' a.txt | 1 +', diff: '+<script>alert(1)</script>', pushed: true, pushError: null, leftoverFiles: 0,
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

test('creer, lister, ouvrir et supprimer un chat ; deux chats de meme titre ont des branches distinctes (reservees)', async () => {
  const t = await setup()
  try {
    assert.match((await t.c.call('GET', t.base)).text, /Creer le premier chat/)
    assert.equal((await t.post('', { title: 'x'.repeat(81) })).res.status, 400)
    // titre vide : un chat « Nouveau chat » (le titre sera deduit du premier message)
    const blank = await t.post('', { title: '   ' })
    assert.equal(blank.res.status, 303)
    const blankChat = getChat(t.c.db, t.project.id, Number(/chats\/(\d+)/.exec(blank.res.headers.get('location')!)![1]))!
    assert.equal(blankChat.title, 'Nouveau chat')
    assert.equal(deleteChat(t.c.db, t.project.id, blankChat.id), true)

    const a = await t.post('', { title: 'Ajouter l\'inventaire !' })
    assert.equal(a.res.status, 303)
    const b = await t.post('', { title: 'Ajouter l\'inventaire !' })
    const [ida, idb] = [a, b].map((r) => Number(/chats\/(\d+)/.exec(r.res.headers.get('location')!)![1]))
    const chatA = getChat(t.c.db, t.project.id, ida)!
    const chatB = getChat(t.c.db, t.project.id, idb)!
    assert.match(chatA.branch, /^ai\/chat-\d+-ajouter-l-inventaire$/)
    assert.notEqual(chatA.branch, chatB.branch, 'deux chats de meme titre : deux branches')

    const list = (await t.c.call('GET', `${t.base}/${ida}`)).text // la liste des chats est a gauche de chaque chat
    assert.match(list, /Ajouter l&#39;inventaire|Ajouter l'inventaire/)
    assert.ok(!list.includes(chatA.branch), "la branche n'est pas affichee : elle n'existe pas tant que l'IA ne l'ouvre pas")
    const open = await t.c.call('GET', `${t.base}/${ida}`)
    assert.equal(open.res.status, 200)
    assert.match(open.text, /Que veux-tu faire/)

    assert.equal((await t.post(`/${ida}/delete`)).res.status, 303)
    assert.equal(getChat(t.c.db, t.project.id, ida), undefined)
    assert.ok(getChat(t.c.db, t.project.id, idb), "l'autre chat reste")
    assert.equal((await t.c.call('GET', `${t.base}/${ida}`)).res.status, 404)
    assert.equal((await t.c.call('GET', t.base)).res.headers.get('location'), `${t.base}/${idb}`, 'sans chat choisi : le plus recent est ouvert')
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
    assert.deepEqual([first.chatId, first.project, first.prompt, first.sessionId, first.push, first.atelier],
      [chat.id, { slug: 'mon-jeu', url: 'https://github.com/acme/jeu.git', branch: chat.branch, base: null, open: false }, 'Ajoute un inventaire', null, true, null])
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
    assert.equal(t.payloads[1].project!.branch, chat.branch)
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
    assert.match(waiting, /data-pending="true"/)
    assert.match(waiting, /data-live="[^"]*\/live"/)
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

test('validations : message vide, trop long, valeurs inconnues', async () => {
  const t = await setup()
  try {
    const w = t.addWorker('PC')
    await t.online(w.id)
    const chat = createChat(t.c.db, t.project.id, 'Validations')
    assert.equal((await t.send(chat.id, '   ')).res.status, 400)
    const long = await t.send(chat.id, 'x'.repeat(20_001))
    assert.equal(long.res.status, 400)
    assert.equal(t.c.db.prepare('SELECT COUNT(*) AS n FROM jobs').get()!.n, 0, 'aucune tache creee')
  } finally { await t.close() }
})

test('un projet sans depot GitHub marche quand meme : l\'IA n\'a que son atelier', async () => {
  const t = await setup(null)
  try {
    const w = t.addWorker('PC')
    await t.online(w.id)
    const chat = createChat(t.c.db, t.project.id, 'Sans depot')
    const r = await t.send(chat.id, 'Imagine une jauge de vie')
    assert.equal(r.res.status, 303)
    await t.settle(chat.id)
    assert.equal(t.payloads[0].project, null, 'pas de depot : aucun projet transmis au Worker')
    assert.equal(getChat(t.c.db, t.project.id, chat.id)!.branch_open, false)
    const page = await t.page(chat.id)
    assert.doesNotMatch(page, /<textarea[^>]*name="prompt"[^>]*disabled/)
    assert.match(page, /class="chip accent"[^>]*>Atelier</)
    assert.ok(!/pas de depot GitHub/.test(page), 'plus de refus : rien a configurer pour discuter')
  } finally { await t.close() }
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
    assert.equal(t.payloads[1].project!.branch, chat.branch, 'meme branche : le travail pousse est retrouve')
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

test('pastilles : en attente, en cours, reponse non lue, echec, puis lu en ouvrant le chat', async () => {
  const t = await setup()
  try {
    const state = (id: number) => listChats(t.c.db, t.project.id).find((c) => c.id === id)!.state
    const chat = createChat(t.c.db, t.project.id, 'Etats')
    assert.equal(state(chat.id), 'idle')

    await t.send(chat.id, 'Bonjour') // aucun Worker : en attente
    assert.equal(state(chat.id), 'queued')
    const w = t.addWorker('PC')
    await t.online(w.id)
    await waitFor(() => state(chat.id) === 'unread', 'reponse non lue') // terminee, personne n'a regarde
    await t.page(chat.id)
    assert.equal(state(chat.id), 'idle', 'ouvrir le chat marque la reponse comme lue')

    await t.send(chat.id, 'SLOW 1')
    await waitFor(() => state(chat.id) === 'running', 'en cours')
    await t.post(`/${chat.id}/cancel`)
    await waitFor(() => listMessages(t.c.db, chat.id)[3].job_status === 'cancelled', 'annulee')
    await t.page(chat.id)
    assert.equal(state(chat.id), 'idle', 'une annulation ne declenche pas de pastille')

    await t.send(chat.id, 'BOOM')
    await waitFor(() => state(chat.id) === 'error', 'echec non lu')
    await t.page(chat.id)
    assert.equal(state(chat.id), 'idle')

    // depuis un AUTRE chat, la pastille du premier est visible dans la liste de gauche
    const other = createChat(t.c.db, t.project.id, 'Autre')
    await t.send(chat.id, 'Encore')
    await waitFor(() => state(chat.id) === 'unread', 'non lu')
    const html = await t.page(other.id)
    assert.match(html, /chat-item is-unread/)
    assert.match(html, /dot unread/)
  } finally { await t.close() }
})

test('endpoint live : fragments HTML, compteur de non lus, jamais mis en cache', async () => {
  const t = await setup()
  try {
    const w = t.addWorker('PC')
    await t.online(w.id)
    const chat = createChat(t.c.db, t.project.id, 'Direct')
    const live = `${t.base}/${chat.id}/live`
    const idle = await t.c.call('GET', live, undefined, { accept: 'application/json' })
    assert.equal(idle.res.status, 200)
    assert.match(idle.res.headers.get('cache-control') ?? '', /no-store/)
    const j0 = JSON.parse(idle.text) as { list: string; thread: string; pending: boolean; unread: number; title: string }
    assert.equal(j0.pending, false)
    assert.equal(j0.title, 'Direct')
    assert.match(j0.thread, /Que veux-tu faire/)
    assert.match(j0.list, /Direct/)

    await t.send(chat.id, 'Bonjour')
    await waitFor(() => listMessages(t.c.db, chat.id)[1].job_status === 'succeeded', 'reponse')
    const done = JSON.parse((await t.c.call('GET', live)).text) as typeof j0
    assert.equal(done.pending, false)
    assert.match(done.thread, /Reponse 1/)
    assert.equal(done.unread, 0, 'le chat ouvert est lu')

    const other = createChat(t.c.db, t.project.id, 'Autre')
    await t.send(chat.id, 'Encore')
    await waitFor(() => listMessages(t.c.db, chat.id)[3].job_status === 'succeeded', '2e reponse')
    const fromOther = JSON.parse((await t.c.call('GET', `${t.base}/${other.id}/live`)).text) as typeof j0
    assert.equal(fromOther.unread, 1, "la reponse du premier chat est signalee depuis l'autre")
    assert.match(fromOther.list, /dot unread/)

    // pas de fuite : le live d'un chat qui n'est pas a moi
    const intruder = await createUser(t.c.db, 'autre@example.com', 'correct horse battery')
    const theirs = createChat(t.c.db, createProject(t.c.db, intruder.id, { name: 'X', groupId: null, groupName: null, githubRepo: 'x/y', robloxAccountId: null }).id, 'Prive')
    assert.equal((await t.c.call('GET', `${t.base}/${theirs.id}/live`)).res.status, 404)
  } finally { await t.close() }
})

test('modele et effort : memorises par chat, transmis au Worker, valeurs inconnues refusees', async () => {
  const t = await setup()
  try {
    const w = t.addWorker('PC')
    await t.online(w.id)
    const chat = createChat(t.c.db, t.project.id, 'Reglages')
    const first = await t.send(chat.id, 'Un')
    assert.equal(first.res.status, 303)
    await t.settle(chat.id)
    assert.deepEqual([t.payloads[0].model, t.payloads[0].effort], [null, null], 'sans choix : valeurs par defaut du CLI')

    await t.post(`/${chat.id}/messages`, { prompt: 'Deux', model: 'opus', effort: 'high' })
    await t.settle(chat.id)
    assert.deepEqual([t.payloads[1].model, t.payloads[1].effort], ['opus', 'high'])
    const html = await t.page(chat.id)
    assert.match(html, /<option value="opus" selected>/)
    assert.match(html, /<option value="high" selected>/)
    assert.equal(getChat(t.c.db, t.project.id, chat.id)!.model, 'opus')

    const badValues: Record<string, string>[] = [{ model: '--dangerously-skip-permissions' }, { model: 'gpt-9' }, { effort: 'extreme' }, { effort: '--x' }]
    for (const bad of badValues) {
      const r = await t.post(`/${chat.id}/messages`, { prompt: 'Mauvais', ...bad })
      assert.equal(r.res.status, 400, JSON.stringify(bad))
    }
    assert.equal(t.payloads.length, 2, 'aucune tache pour des valeurs refusees')
  } finally { await t.close() }
})

test('envoi sans rechargement : reponses JSON (succes, erreurs, une reponse a la fois)', async () => {
  const t = await setup()
  try {
    const w = t.addWorker('PC')
    await t.online(w.id)
    const chat = createChat(t.c.db, t.project.id, 'Ajax')
    const json = { accept: 'application/json' }
    const post = (path: string, body: Record<string, string>) => t.c.call('POST', `${t.base}/${chat.id}${path}`, { csrf: t.csrf, ...body }, json)

    const empty = await post('/messages', { prompt: '  ' })
    assert.equal(empty.res.status, 400)
    assert.match((JSON.parse(empty.text) as { error: string }).error, /Ecris un message/)
    const ok = await post('/messages', { prompt: 'SLOW 1' })
    assert.equal(ok.res.status, 200)
    assert.deepEqual(JSON.parse(ok.text), { ok: true })
    const busy = await post('/messages', { prompt: 'Deux' })
    assert.equal(busy.res.status, 409)
    assert.match((JSON.parse(busy.text) as { error: string }).error, /deja en cours/)
    assert.deepEqual(JSON.parse((await post('/cancel', {})).text), { ok: true })
    const noCsrf = await t.c.call('POST', `${t.base}/${chat.id}/messages`, { prompt: 'x' }, json)
    assert.equal(noCsrf.res.status, 403)
    assert.ok(typeof (JSON.parse(noCsrf.text) as { error: string }).error === 'string')
  } finally { await t.close() }
})

test('titre et branche deduits du premier message ; renommer ne change pas la branche', async () => {
  const t = await setup()
  try {
    const w = t.addWorker('PC')
    await t.online(w.id)
    const chat = createChat(t.c.db, t.project.id)
    assert.equal(chat.title, 'Nouveau chat')
    assert.match(chat.branch, /^ai\/chat-\d+-nouveau-chat$/)

    await t.send(chat.id, "Corrige le bug de l'inventaire\nPlus de details ici")
    await t.settle(chat.id)
    const after = getChat(t.c.db, t.project.id, chat.id)!
    assert.equal(after.title, "Corrige le bug de l'inventaire")
    assert.equal(after.branch, `ai/chat-${chat.id}-corrige-le-bug-de-l-inventaire`)
    assert.equal(t.payloads[0].project!.branch, after.branch, 'la branche envoyee au Worker est celle deduite du titre')

    await t.send(chat.id, 'Autre sujet completement')
    await t.settle(chat.id)
    assert.equal(getChat(t.c.db, t.project.id, chat.id)!.branch, after.branch, 'la branche est figee apres le premier message')

    assert.equal((await t.post(`/${chat.id}/rename`, { title: 'Inventaire v2' })).res.status, 303)
    const renamed = getChat(t.c.db, t.project.id, chat.id)!
    assert.equal(renamed.title, 'Inventaire v2')
    assert.equal(renamed.branch, after.branch)
    assert.equal((await t.post(`/${chat.id}/rename`, { title: 'x'.repeat(81) })).res.status, 400)
    assert.equal(renameChat(t.c.db, t.project.id, chat.id, 'Inventaire v2'), true)
  } finally { await t.close() }
})

test("activite de l'IA affichee (pensee, outils, texte), echappee, et conservee apres la reponse", async () => {
  const t = await setup()
  try {
    const w = t.addWorker('PC')
    await t.online(w.id)
    const chat = createChat(t.c.db, t.project.id, 'Activite')
    await t.send(chat.id, 'Bonjour')
    await t.settle(chat.id)
    const html = await t.page(chat.id)
    assert.match(html, /class="activity"/)
    assert.match(html, /Activite · 4 etapes · pensee/)
    assert.match(html, /step thinking/)
    assert.match(html, /Je dois &lt;b&gt;reflechir&lt;\/b&gt; au probleme/)
    assert.ok(!html.includes('<b>reflechir</b>'), "la pensee n'est jamais interpretee comme du HTML")
    assert.match(html, /step tool[^]*Lecture de a\.txt/)
    assert.match(html, /step text[^]*Je commence par regarder\./)
    assert.match(html, /Claude demarre/)
  } finally { await t.close() }
})

test('reponses en Markdown, scripts et CSP corrects', async () => {
  const t = await setup()
  try {
    const w = t.addWorker('PC')
    await t.online(w.id)
    const chat = createChat(t.c.db, t.project.id, 'Markdown')
    await t.send(chat.id, 'Bonjour')
    await t.settle(chat.id)
    const page = await t.c.call('GET', `${t.base}/${chat.id}`)
    assert.match(page.text, /<div class="answer md">/)
    assert.match(page.res.headers.get('content-security-policy') ?? '', /connect-src 'self'/)
    assert.doesNotMatch(page.res.headers.get('content-security-policy') ?? '', /unsafe-inline/)
    const js = await t.c.call('GET', '/static/chat.js')
    assert.equal(js.res.status, 200)
    assert.match(js.res.headers.get('content-type') ?? '', /javascript/)
    assert.match(page.text, /<script src="\/static\/chat\.js\?v=\d+" defer>/)
    assert.ok(!/<script>[^<]/.test(page.text), 'aucun script en ligne')
  } finally { await t.close() }
})

test('un chat se cree sans branche ni depot : seule la ligne en base existe', async () => {
  const t = await setup()
  try {
    const r = await t.post('', {})
    assert.equal(r.res.status, 303)
    const chat = getChat(t.c.db, t.project.id, Number(/chats\/(\d+)/.exec(r.res.headers.get('location')!)![1]))!
    assert.equal(chat.title, 'Nouveau chat')
    assert.equal(chat.branch_open, false)
    assert.equal(t.c.db.prepare("SELECT COUNT(*) AS n FROM jobs").get()!.n, 0, 'aucune tache : rien n\'est prepare sur un Worker')
    const page = (await t.c.call('GET', `${t.base}/${chat.id}`)).text
    assert.match(page, /class="chip accent"[^>]*>Atelier</, 'l\'en-tete montre l\'atelier')
    assert.ok(!page.includes(`>${chat.branch}<`), 'aucune branche n\'est affichee tant qu\'elle n\'est pas ouverte')
    assert.doesNotMatch(page, /Maquette UI/, 'plus de bouton « Maquette UI » : un seul type de chat')
    assert.match(page, /Que veux-tu faire/)
    assert.match(page, /idee d'interface/)
  } finally { await t.close() }
})

test('la branche s\'ouvre quand l\'IA modifie le projet : le chat s\'en souvient et la transmet aux tours suivants', async () => {
  const t = await setup()
  try {
    const w = t.addWorker('PC')
    await t.online(w.id)
    const chat = createChat(t.c.db, t.project.id, 'Branche')
    await t.send(chat.id, 'Une idee de HUD ?')
    await t.settle(chat.id)
    assert.equal(getChat(t.c.db, t.project.id, chat.id)!.branch_open, false, 'discussion : aucune branche')
    assert.equal(t.payloads[0].project!.open, false)
    assert.ok(!(await t.page(chat.id)).includes(`>${getChat(t.c.db, t.project.id, chat.id)!.branch}<`))

    await t.send(chat.id, 'Ok, OUVRE la branche et code-le')
    await t.settle(chat.id)
    const opened = getChat(t.c.db, t.project.id, chat.id)!
    assert.equal(opened.branch_open, true, 'l\'IA a ouvert la branche pendant ce tour')
    assert.equal(t.payloads[1].project!.open, false, 'au moment de la demande, elle n\'etait pas ouverte')
    const html = await t.page(chat.id)
    assert.ok(html.includes(`${opened.branch}</span>`), 'la branche apparait dans l\'en-tete')
    assert.doesNotMatch(html, /class="chip accent"[^>]*>Atelier</)

    await t.send(chat.id, 'Continue')
    await t.settle(chat.id)
    assert.equal(t.payloads[2].project!.open, true, 'les tours suivants savent que la branche est ouverte')
    assert.equal(t.payloads[2].project!.branch, opened.branch)
  } finally { await t.close() }
})

test('l\'atelier part du depot de maquette choisi dans le compte GitHub (et sa branche) ; le jeton GitHub n\'est jamais transmis', async () => {
  const t = await setup()
  const savedFallback = config.uiTemplateRepo
  config.uiTemplateRepo = null
  try {
    const w = t.addWorker('PC')
    await t.online(w.id)
    const chat = createChat(t.c.db, t.project.id, 'Atelier')
    // 1. rien choisi, pas de depot par defaut : atelier vide
    await t.send(chat.id, 'Un')
    await t.settle(chat.id)
    assert.equal(t.payloads[0].atelier, null)
    // 2. depot choisi dans Compte > GitHub
    saveConnection(t.c.db, t.userId, 'acme', 'ghp_secret_token')
    updateUiTemplate(t.c.db, t.userId, 'acme/mon-kit-ui', 'ui-v2')
    await t.send(chat.id, 'Deux')
    await t.settle(chat.id)
    assert.deepEqual(t.payloads[1].atelier, { url: 'https://github.com/acme/mon-kit-ui.git', base: 'ui-v2' })
    assert.ok(!JSON.stringify(t.payloads).includes('ghp_secret_token'))
    // 3. sans branche choisie
    updateUiTemplate(t.c.db, t.userId, 'acme/mon-kit-ui', null)
    await t.send(chat.id, 'Trois')
    await t.settle(chat.id)
    assert.deepEqual(t.payloads[2].atelier, { url: 'https://github.com/acme/mon-kit-ui.git', base: null })
    // 4. depot par defaut de l'instance pour qui n'a rien choisi
    updateUiTemplate(t.c.db, t.userId, null, null)
    config.uiTemplateRepo = 'org/defaut'
    await t.send(chat.id, 'Quatre')
    await t.settle(chat.id)
    assert.deepEqual(t.payloads[3].atelier, { url: 'https://github.com/org/defaut.git', base: null })
  } finally { config.uiTemplateRepo = savedFallback; await t.close() }
})

test('consommation : le Host retient le contexte deja envoye et le Worker ne le renvoie que s il change', async () => {
  const t = await setup()
  try {
    const w = t.addWorker('PC')
    await t.online(w.id)
    const chat = createChat(t.c.db, t.project.id, 'Cout')
    const ctx = () => ({ ...(t.c.db.prepare('SELECT context_hash AS h, context_age AS a FROM chats WHERE id = ?').get(chat.id) as { h: string | null; a: number }) })
    assert.deepEqual(ctx(), { h: null, a: 0 })
    await t.send(chat.id, 'Premier message')
    await t.settle(chat.id)
    assert.deepEqual([t.payloads[0].contextHash, t.payloads[0].contextAge], [null, 0], 'rien envoye encore')
    assert.deepEqual(ctx(), { h: 'abcdef0123456789', a: 0 }, 'contexte envoye : age remis a zero')
    await t.send(chat.id, 'Deuxieme')
    await t.settle(chat.id)
    assert.deepEqual([t.payloads[1].contextHash, t.payloads[1].contextAge], ['abcdef0123456789', 0])
    assert.deepEqual(ctx(), { h: 'abcdef0123456789', a: 1 }, 'contexte NON renvoye : un message de plus')
    await t.send(chat.id, 'Troisieme')
    await t.settle(chat.id)
    assert.equal(t.payloads[2].contextAge, 1)
    assert.equal(ctx().a, 2)
    // rappel periodique apres 10 messages
    t.c.db.prepare('UPDATE chats SET context_age = 10 WHERE id = ?').run(chat.id)
    await t.send(chat.id, 'Quatrieme')
    await t.settle(chat.id)
    assert.equal(ctx().a, 0, 'contexte renvoye : age remis a zero')
  } finally { await t.close() }
})

test('consommation : cout cumule du chat dans l en-tete (et en direct), plafond atteint signale', async () => {
  const t = await setup()
  try {
    const w = t.addWorker('PC')
    await t.online(w.id)
    const chat = createChat(t.c.db, t.project.id, 'Cout')
    assert.match(await t.page(chat.id), /id="chat-cost"[^>]* hidden>/, 'pas de cout avant la premiere reponse')
    await t.send(chat.id, 'Un')
    await t.settle(chat.id)
    await t.send(chat.id, 'Deux')
    await t.settle(chat.id)
    const html = await t.page(chat.id)
    assert.match(html, /id="chat-cost"[^>]*>≈ 0\.025 \$ · 2 reponses<\/span>/, '2 x 0,0123 $')
    const live = JSON.parse((await t.c.call('GET', `${t.base}/${chat.id}/live`, undefined, { accept: 'application/json' })).text) as { cost: string }
    assert.equal(live.cost, '≈ 0.025 $ · 2 reponses')
    assert.doesNotMatch(html, /limite de tours atteinte/)
    await t.send(chat.id, 'Un gros travail LIMITE')
    await t.settle(chat.id)
    assert.match(await t.page(chat.id), /limite de tours atteinte/)
  } finally { await t.close() }
})
