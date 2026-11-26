import assert from 'node:assert/strict'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { test } from 'node:test'
import { serve } from '@hono/node-server'
import { createUser } from '../src/auth.ts'
import { createPool, createWorker, getJob } from '../src/workers.ts'
import { startWorker, type RunningWorker, type WorkerState } from '../../worker/src/worker.ts'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAgent } from '../../worker/src/agent.ts'
import { client, csrfOf, registerAndEnable } from './helpers.ts'

type Client = ReturnType<typeof client>

async function waitFor(cond: () => boolean, what: string, ms = 4000) {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) assert.fail(`delai depasse : ${what}`)
    await new Promise((r) => setTimeout(r, 15))
  }
}

// Un Host reel (serveur HTTP sur un port libre) + des vrais Workers qui s'y connectent.
async function setup() {
  const c = client()
  await registerAndEnable(c)
  const csrf = csrfOf((await c.call('GET', '/workers')).text)
  const server = await new Promise<Server>((resolve) => {
    const s = serve({ fetch: c.app.fetch, port: 0, hostname: '127.0.0.1' }, () => resolve(s as Server))
  })
  c.hub.attach(server)
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const running: RunningWorker[] = []
  const userId = (c.db.prepare('SELECT id FROM users ORDER BY id LIMIT 1').get() as { id: number }).id

  const connect = (token: string, states: WorkerState[] = []) => {
    const w = startWorker({ hostUrl: url, token, backoff: { minMs: 20, maxMs: 60 }, onState: (s) => states.push(s) })
    running.push(w)
    return w
  }
  const addWorker = (name: string, poolId: number | null = null, uid = userId) => {
    const r = createWorker(c.db, uid, name, poolId)
    assert.ok(r.ok)
    return { id: r.id, token: r.token }
  }
  const online = async (id: number) => waitFor(() => c.hub.status(id) !== 'offline', `Worker ${id} en ligne`)
  const status = (id: number) => (c.db.prepare('SELECT status FROM jobs WHERE id = ?').get(id) as { status: string }).status
  const close = async () => {
    await Promise.all(running.map((w) => w.stop()))
    c.hub.close()
    server.closeAllConnections()
    await new Promise((r) => server.close(r))
  }
  return { c, csrf, url, userId, connect, addWorker, online, status, close }
}

test('les pages Workers exigent une session complete et un jeton CSRF', async () => {
  const anon = client()
  for (const path of ['/workers', '/jobs/1']) {
    const r = await anon.call('GET', path)
    assert.equal(r.res.status, 302, path)
    assert.equal(r.res.headers.get('location'), '/login', path)
  }
  const t = await setup()
  try {
    const noCsrf = await t.c.call('POST', '/workers', { name: 'PC' })
    assert.equal(noCsrf.res.status, 403)
    assert.equal(t.c.db.prepare('SELECT COUNT(*) AS n FROM workers').get()!.n, 0)
    const foreign = await t.c.call('POST', '/workers', { csrf: t.csrf, name: 'PC' }, { origin: 'http://evil.example' })
    assert.equal(foreign.res.status, 403)
  } finally { await t.close() }
})

test('le jeton n\'est affiche qu\'a la creation et n\'est stocke que haché', async () => {
  const t = await setup()
  try {
    const created = await t.c.call('POST', '/workers', { csrf: t.csrf, name: 'Mon PC' })
    assert.equal(created.res.status, 200)
    const token = /rpmw_[A-Za-z0-9_-]{20,}/.exec(created.text)?.[0]
    assert.ok(token, 'jeton affiche')
    assert.match(created.text, /une seule fois/)
    const later = await t.c.call('GET', '/workers')
    assert.ok(!later.text.includes(token!), 'jamais reaffiche')
    assert.match(later.text, /Mon PC/)
    const row = t.c.db.prepare('SELECT token_hash FROM workers').get() as { token_hash: string }
    assert.ok(!row.token_hash.includes(token!))
    assert.equal(row.token_hash.length, 64)
    // nom en double / invalide
    assert.equal((await t.c.call('POST', '/workers', { csrf: t.csrf, name: 'Mon PC' })).res.status, 400)
    assert.equal((await t.c.call('POST', '/workers', { csrf: t.csrf, name: '  ' })).res.status, 400)
    assert.equal((await t.c.call('POST', '/workers', { csrf: t.csrf, name: 'Autre', poolId: '999' })).res.status, 400)
  } finally { await t.close() }
})

test('un Worker se connecte, passe en ligne et execute une tache echo', async () => {
  const t = await setup()
  try {
    const w = t.addWorker('PC')
    assert.equal(t.c.hub.status(w.id), 'offline')
    t.connect(w.token)
    await t.online(w.id)
    assert.equal(t.c.hub.status(w.id), 'idle')
    assert.match((await t.c.call('GET', '/workers')).text, /En ligne/)

    const r = await t.c.call('POST', `/workers/${w.id}/test`, { csrf: t.csrf })
    assert.equal(r.res.status, 303)
    const jobId = Number(/\/jobs\/(\d+)/.exec(r.res.headers.get('location')!)![1])
    await waitFor(() => t.status(jobId) === 'succeeded', 'tache reussie')
    const job = getJob(t.c.db, t.userId, jobId)!
    assert.equal(job.worker_id, w.id)
    assert.equal((job.result as { echo: { message: string } }).echo.message, 'ping')
    const page = await t.c.call('GET', `/jobs/${jobId}`)
    assert.equal(page.res.status, 200)
    assert.match(page.text, /Reussie/)
    assert.match(page.text, /Evenements/)
    // l'info envoyee par le Worker est enregistree
    const info = JSON.parse((t.c.db.prepare('SELECT info_json FROM workers WHERE id = ?').get(w.id) as { info_json: string }).info_json)
    assert.equal(info.version, '0.1.0')
  } finally { await t.close() }
})

test('jeton invalide : refuse, et le Worker ne reessaie pas', async () => {
  const t = await setup()
  try {
    const states: WorkerState[] = []
    const w = t.connect('rpmw_' + 'x'.repeat(43), states)
    await waitFor(() => w.state === 'rejected', 'Worker rejete')
    await new Promise((r) => setTimeout(r, 200))
    assert.deepEqual(states.filter((s) => s === 'connecting').length, 1, 'aucune nouvelle tentative')
  } finally { await t.close() }
})

test('regenerer le jeton coupe l\'ancien Worker ; le nouveau jeton fonctionne', async () => {
  const t = await setup()
  try {
    const w = t.addWorker('PC')
    const old = t.connect(w.token)
    await t.online(w.id)
    const r = await t.c.call('POST', `/workers/${w.id}/token`, { csrf: t.csrf })
    assert.equal(r.res.status, 200)
    const fresh = /rpmw_[A-Za-z0-9_-]{20,}/.exec(r.text)![0]
    assert.notEqual(fresh, w.token)
    await waitFor(() => old.state === 'rejected', 'ancien Worker coupe')
    assert.equal(t.c.hub.status(w.id), 'offline')
    const again = t.connect(w.token)
    await waitFor(() => again.state === 'rejected', 'ancien jeton refuse')
    t.connect(fresh)
    await t.online(w.id)
  } finally { await t.close() }
})

test('deux connexions avec le meme jeton : la plus recente remplace l\'autre', async () => {
  const t = await setup()
  try {
    const w = t.addWorker('PC')
    const first = t.connect(w.token)
    await t.online(w.id)
    const second = t.connect(w.token)
    await waitFor(() => first.state === 'rejected', 'premiere connexion remplacee')
    await waitFor(() => second.state === 'connected', 'seconde connectee')
    assert.equal(t.c.hub.status(w.id), 'idle')
  } finally { await t.close() }
})

test('les taches passent une par une, dans l\'ordre', async () => {
  const t = await setup()
  try {
    const w = t.addWorker('PC')
    t.connect(w.token)
    await t.online(w.id)
    const a = t.c.hub.enqueue(t.userId, 'sleep', { ms: 150 }, { workerId: w.id })
    const b = t.c.hub.enqueue(t.userId, 'sleep', { ms: 10 }, { workerId: w.id })
    const c2 = t.c.hub.enqueue(t.userId, 'echo', { n: 3 }, { workerId: w.id })
    assert.equal(t.status(a), 'running')
    assert.equal(t.status(b), 'queued')
    assert.equal(t.c.hub.status(w.id), 'busy')
    await waitFor(() => t.status(c2) === 'succeeded', 'file videe')
    const at = (id: number) => getJob(t.c.db, t.userId, id)!
    assert.ok(at(a).finished_at! <= at(b).started_at!, 'b commence apres a')
    assert.ok(at(b).finished_at! <= at(c2).started_at!, 'c commence apres b')
    assert.throws(() => t.c.hub.enqueue(t.userId, 'rm-rf', {}), /inconnu/)
  } finally { await t.close() }
})

test('annulation : tache en attente, puis tache en cours', async () => {
  const t = await setup()
  try {
    const w = t.addWorker('PC')
    t.connect(w.token)
    await t.online(w.id)
    const running = t.c.hub.enqueue(t.userId, 'sleep', { ms: 30_000 }, { workerId: w.id })
    const queued = t.c.hub.enqueue(t.userId, 'echo', {}, { workerId: w.id })
    assert.equal(t.status(queued), 'queued')
    assert.equal((await t.c.call('POST', `/jobs/${queued}/cancel`, { csrf: t.csrf })).res.status, 303)
    assert.equal(t.status(queued), 'cancelled')
    assert.equal((await t.c.call('POST', `/jobs/${running}/cancel`, { csrf: t.csrf })).res.status, 303)
    await waitFor(() => t.status(running) === 'cancelled', 'tache en cours annulee')
    await waitFor(() => t.c.hub.status(w.id) === 'idle', 'Worker libere')
    // le Worker est de nouveau utilisable
    const next = t.c.hub.enqueue(t.userId, 'echo', {}, { workerId: w.id })
    await waitFor(() => t.status(next) === 'succeeded', 'tache suivante')
  } finally { await t.close() }
})

test('une tache est « echec » si le Worker se deconnecte, et il se reconnecte seul', async () => {
  const t = await setup()
  try {
    const w = t.addWorker('PC')
    const states: WorkerState[] = []
    const worker = t.connect(w.token, states)
    await t.online(w.id)
    const job = t.c.hub.enqueue(t.userId, 'sleep', { ms: 30_000 }, { workerId: w.id })
    assert.equal(t.status(job), 'running')
    // coupure brutale cote reseau
    ;(t.c.hub as unknown as { conns: Map<number, { ws: { terminate(): void } }> }).conns.get(w.id)!.ws.terminate()
    await waitFor(() => t.status(job) === 'failed', 'tache en echec')
    assert.match(getJob(t.c.db, t.userId, job)!.error!, /deconnecte/)
    await waitFor(() => states.includes('waiting'), 'attente de reconnexion')
    await waitFor(() => worker.state === 'connected' && t.c.hub.status(w.id) === 'idle', 'reconnecte')
  } finally { await t.close() }
})

test('une tache en attente part des qu\'un Worker se connecte', async () => {
  const t = await setup()
  try {
    const w = t.addWorker('PC')
    const job = t.c.hub.enqueue(t.userId, 'echo', {}, { workerId: w.id })
    assert.equal(t.status(job), 'queued')
    t.connect(w.token)
    await waitFor(() => t.status(job) === 'succeeded', 'tache distribuee a la connexion')
  } finally { await t.close() }
})

test('ciblage : un Worker precis, ou le premier libre d\'un pool', async () => {
  const t = await setup()
  try {
    const pool = createPool(t.c.db, t.userId, 'Maison')
    assert.ok(pool.ok)
    const a = t.addWorker('A', pool.id)
    const b = t.addWorker('B', pool.id)
    const lone = t.addWorker('Seul')
    for (const w of [a, b, lone]) t.connect(w.token)
    await Promise.all([a, b, lone].map((w) => t.online(w.id)))

    const j1 = t.c.hub.enqueue(t.userId, 'sleep', { ms: 100 }, { poolId: pool.id })
    const j2 = t.c.hub.enqueue(t.userId, 'sleep', { ms: 100 }, { poolId: pool.id })
    const j3 = t.c.hub.enqueue(t.userId, 'echo', {}, { workerId: lone.id })
    await waitFor(() => [j1, j2, j3].every((j) => t.status(j) === 'succeeded'), 'toutes terminees')
    const who = (j: number) => getJob(t.c.db, t.userId, j)!.worker_id
    assert.notEqual(who(j1), who(j2), 'le pool repartit sur ses deux Workers')
    assert.ok([a.id, b.id].includes(who(j1)!) && [a.id, b.id].includes(who(j2)!))
    assert.equal(who(j3), lone.id)

    // via les pages : tester un pool
    const r = await t.c.call('POST', `/pools/${pool.id}/test`, { csrf: t.csrf })
    assert.equal(r.res.status, 303)
    const jobId = Number(/\/jobs\/(\d+)/.exec(r.res.headers.get('location')!)![1])
    await waitFor(() => t.status(jobId) === 'succeeded', 'test de pool')
    assert.ok([a.id, b.id].includes(getJob(t.c.db, t.userId, jobId)!.worker_id!))
  } finally { await t.close() }
})

test('pools : creation, rattachement, suppression (les Workers restent)', async () => {
  const t = await setup()
  try {
    assert.equal((await t.c.call('POST', '/pools', { csrf: t.csrf, name: 'Maison' })).res.status, 303)
    assert.equal((await t.c.call('POST', '/pools', { csrf: t.csrf, name: 'Maison' })).res.status, 400)
    const pool = t.c.db.prepare('SELECT id FROM worker_pools').get() as { id: number }
    const w = t.addWorker('PC')
    assert.equal((await t.c.call('POST', `/workers/${w.id}/pool`, { csrf: t.csrf, poolId: String(pool.id) })).res.status, 303)
    assert.match((await t.c.call('GET', '/workers')).text, /pool « Maison »/)
    assert.equal((await t.c.call('POST', `/workers/${w.id}/pool`, { csrf: t.csrf, poolId: '999' })).res.status, 400)
    assert.equal((await t.c.call('POST', `/pools/${pool.id}/delete`, { csrf: t.csrf })).res.status, 303)
    const row = t.c.db.prepare('SELECT pool_id FROM workers WHERE id = ?').get(w.id) as { pool_id: number | null }
    assert.equal(row.pool_id, null)
  } finally { await t.close() }
})

test('supprimer un Worker le deconnecte', async () => {
  const t = await setup()
  try {
    const w = t.addWorker('PC')
    const run = t.connect(w.token)
    await t.online(w.id)
    assert.equal((await t.c.call('POST', `/workers/${w.id}/delete`, { csrf: t.csrf })).res.status, 303)
    await waitFor(() => run.state === 'rejected', 'Worker deconnecte')
    assert.equal(t.c.db.prepare('SELECT COUNT(*) AS n FROM workers').get()!.n, 0)
  } finally { await t.close() }
})

test('isolation entre utilisateurs', async () => {
  const t = await setup()
  try {
    // second utilisateur, avec une session complete
    const other = await createUser(t.c.db, 'autre@example.com', 'correct horse battery')
    const mine = t.addWorker('Mon PC')
    const theirs = t.addWorker('Leur PC', null, other.id)
    t.connect(mine.token)
    t.connect(theirs.token)
    await Promise.all([t.online(mine.id), t.online(theirs.id)])

    // une tache de l'autre n'est jamais confiee a mon Worker, meme sans cible
    const job = t.c.hub.enqueue(other.id, 'echo', { secret: 1 })
    await waitFor(() => t.status(job) === 'succeeded', 'tache de l\'autre')
    assert.equal(getJob(t.c.db, other.id, job)!.worker_id, theirs.id)
    // et inversement
    const mineJob = t.c.hub.enqueue(t.userId, 'echo', {})
    await waitFor(() => t.status(mineJob) === 'succeeded', 'ma tache')
    assert.equal(getJob(t.c.db, t.userId, mineJob)!.worker_id, mine.id)

    // je ne vois ni n'actionne ce qui appartient a l'autre
    const foreign = { worker: theirs.id, job }
    for (const [method, path] of [
      ['GET', `/jobs/${foreign.job}`], ['POST', `/jobs/${foreign.job}/cancel`], ['POST', `/workers/${foreign.worker}/test`],
      ['POST', `/workers/${foreign.worker}/token`], ['POST', `/workers/${foreign.worker}/delete`], ['POST', `/workers/${foreign.worker}/pool`],
    ] as const) {
      const r = await t.c.call(method, path, method === 'POST' ? { csrf: t.csrf } : undefined)
      assert.equal(r.res.status, 404, `${method} ${path}`)
    }
    assert.equal(t.c.hub.status(theirs.id), 'idle', 'toujours connecte')
    const page = await t.c.call('GET', '/workers')
    assert.ok(!page.text.includes('Leur PC'))

    // un Worker ne peut pas cibler un pool qui n'est pas a son proprietaire
    const theirPool = createPool(t.c.db, other.id, 'Leur pool')
    assert.ok(theirPool.ok)
    assert.equal((await t.c.call('POST', `/workers/${mine.id}/pool`, { csrf: t.csrf, poolId: String(theirPool.id) })).res.status, 400)
    assert.equal((await t.c.call('POST', `/pools/${theirPool.id}/test`, { csrf: t.csrf })).res.status, 404)
  } finally { await t.close() }
})

test('code de jumelage : affiche a la creation, accepte tel quel par le Worker', async () => {
  const t = await setup()
  try {
    const created = await t.c.call('POST', '/workers', { csrf: t.csrf, name: 'Mon PC' })
    const code = /rpm1\.[A-Za-z0-9_-]+/.exec(created.text)?.[0]
    assert.ok(code, 'code affiche')
    assert.match(created.text, /start\.vbs/)
    assert.ok(!(await t.c.call('GET', '/workers')).text.includes('rpm1.'), 'jamais reaffiche')

    // le Worker n'a que ce code a coller : il ecrit son .env et se connecte
    const envPath = join(mkdtempSync(join(tmpdir(), 'rpm-pair-')), '.env')
    const agent = createAgent({ envPath, version: 't', info: {}, backoff: { minMs: 20, maxMs: 60 } })
    // le code contient l'adresse publique configuree (localhost:3000) : on la remplace par celle du serveur de test
    const parsed = JSON.parse(Buffer.from(code!.slice(5), 'base64url').toString())
    const local = 'rpm1.' + Buffer.from(JSON.stringify({ u: t.url, t: parsed.t })).toString('base64url')
    assert.equal((await agent.pair(local)).ok, true)
    const id = (t.c.db.prepare('SELECT id FROM workers').get() as { id: number }).id
    await waitFor(() => agent.snapshot().state === 'connected' && t.c.hub.status(id) === 'idle', 'Worker jumele connecte')
    assert.equal(agent.snapshot().workerName, 'Mon PC')
    await agent.stop()
  } finally { await t.close() }
})

test('la page du code de jumelage ne se recharge jamais toute seule', async () => {
  const t = await setup()
  try {
    t.c.hub.enqueue(t.userId, 'sleep', { ms: 10 }) // une tache en attente declenche normalement le rafraichissement
    const created = await t.c.call('POST', '/workers', { csrf: t.csrf, name: 'Mon PC' })
    assert.match(created.text, /rpm1\./)
    assert.ok(!created.text.includes('http-equiv="refresh"'))
    assert.match((await t.c.call('GET', '/workers')).text, /http-equiv="refresh"/, 'la page normale se rafraichit toujours pendant une tache')
  } finally { await t.close() }
})

test('outils detectes : envoyes au hello, mis a jour en direct, affiches, et nettoyes', async () => {
  const t = await setup()
  try {
    const w = t.addWorker('PC')
    const caps = [{ id: 'git', label: 'Git', version: '2.43.0' }, { id: 'claude', label: 'Claude Code', version: '2.0.5' }]
    const run = startWorker({ hostUrl: t.url, token: w.token, getCapabilities: () => caps, backoff: { minMs: 20, maxMs: 60 } })
    await t.online(w.id)
    const stored = () => (JSON.parse((t.c.db.prepare('SELECT info_json FROM workers WHERE id = ?').get(w.id) as { info_json: string }).info_json) as { capabilities: { id: string; label: string; version: string | null }[] }).capabilities
    assert.deepEqual(stored().map((c) => c.id), ['git', 'claude'])
    const page = (await t.c.call('GET', '/workers')).text
    assert.match(page, /Git 2\.43\.0/)
    assert.match(page, /Claude Code 2\.0\.5/)

    // mise a jour sans reconnexion
    run.setCapabilities([...caps, { id: 'blender', label: 'Blender', version: '4.2.0' }])
    await waitFor(() => stored().length === 3, 'mise a jour des outils')
    assert.match((await t.c.call('GET', '/workers')).text, /Blender 4\.2\.0/)

    // un Worker ne peut pas injecter n'importe quoi : forme, doublons, longueurs et balises sont filtres
    run.setCapabilities([
      { id: 'git', label: 'Git', version: '2.0' }, { id: 'git', label: 'Doublon', version: null },
      { id: '../x', label: 'mauvais id', version: null }, { id: 'xss', label: '<script>alert(1)</script>', version: '<b>' },
      { id: 'long', label: 'L'.repeat(500), version: 'v'.repeat(500) },
    ] as never)
    await waitFor(() => stored().length === 3 && stored()[1]?.id === 'xss', 'filtrage')
    const clean = (await t.c.call('GET', '/workers')).text
    assert.ok(!clean.includes('<script>alert'), 'balises echappees')
    assert.deepEqual(stored().map((c) => c.id), ['git', 'xss', 'long'])
    const long = stored()[2]
    assert.equal(long.label.length, 40)
    assert.equal(long.version, null)
    await run.stop()
  } finally { await t.close() }
})
