// Pages et actions « Workers » : creer / regenerer / supprimer un Worker, pools, tester, annuler une tache.
import type { Context, Hono } from 'hono'
import type { Env } from './app.ts'
import { config } from './config.ts'
import type { Db } from './db.ts'
import type { WorkerHub } from './worker-hub.ts'
import { jobPage, workersPage, type RevealedToken, type WorkerView } from './worker-views.ts'
import {
  createPool, createWorker, deletePool, deleteWorker, getJob, getPool, getWorker, listJobEvents, listJobs, listPools, listWorkers, regenerateWorkerToken, setWorkerPool,
} from './workers.ts'
import { messagePage } from './views.ts'

type Auth = NonNullable<Context<Env>['var']['auth']>
type Status = 200 | 400 | 403 | 404

interface Ctx {
  db: Db
  hub: WorkerHub
  html: (c: Context, body: string, status?: Status) => Response
  form: (c: Context) => Promise<{ s: (k: string) => string }>
  csrfOk: (c: Context, given: string) => boolean
  requireFull: (c: Context) => Auth | Response
}

const NOTICES: Record<string, string> = {
  queued: 'Tache envoyee.', poolcreated: 'Pool cree.', pooldeleted: 'Pool supprime.', deleted: 'Worker supprime.', moved: 'Pool mis a jour.', cancelled: 'Annulation demandee.',
}
const idOf = (c: Context, name: string) => { const v = c.req.param(name); return v && /^\d{1,12}$/.test(v) ? Number(v) : null }

export function workerRoutes(app: Hono<Env>, ctx: Ctx) {
  const { db, hub, html, form, csrfOk, requireFull } = ctx

  const guard = async (c: Context, post = false) => {
    const a = requireFull(c)
    if (a instanceof Response) return { res: a } as const
    const f = post ? await form(c) : { s: (_: string) => '' }
    if (post && !csrfOk(c, f.s('csrf'))) return { res: c.text('Jeton invalide', 403) } as const
    return { a, f } as const
  }
  const notFound = (c: Context) => html(c, messagePage('Introuvable', "Cet element n'existe pas ou ne t'appartient pas.", 404).html, 404)

  const render = (c: Context, a: Auth, extra: { reveal?: RevealedToken; error?: string; notice?: string } = {}, status: Status = 200) => {
    const workers: WorkerView[] = listWorkers(db, a.user.id).map((w) => ({ ...w, status: hub.status(w.id) }))
    return html(c, workersPage({
      email: a.user.email, csrf: a.session.csrf, workers, pools: listPools(db, a.user.id), jobs: listJobs(db, a.user.id, 10), ...extra,
    }), status)
  }
  const revealFor = (name: string, token: string): RevealedToken => ({ name, token, hostUrl: config.publicUrl })

  app.get('/workers', async (c) => {
    const g = await guard(c)
    if ('res' in g) return g.res
    return render(c, g.a, { notice: NOTICES[c.req.query('n') ?? ''] })
  })

  // --- Workers ---------------------------------------------------------------------------------------------------------------------
  app.post('/workers', async (c) => {
    const g = await guard(c, true)
    if ('res' in g) return g.res
    const { a, f } = g
    const poolRaw = f.s('poolId')
    const poolId = poolRaw ? (/^\d{1,12}$/.test(poolRaw) ? Number(poolRaw) : -1) : null
    const r = createWorker(db, a.user.id, f.s('name').trim(), poolId === -1 ? 0 : poolId)
    if (!r.ok) return render(c, a, { error: r.error }, 400)
    return render(c, a, { reveal: revealFor(f.s('name').trim(), r.token) }) // le jeton n'est montre que dans CETTE reponse
  })

  app.post('/workers/:id{[0-9]+}/token', async (c) => {
    const g = await guard(c, true)
    if ('res' in g) return g.res
    const id = idOf(c, 'id')!
    const w = getWorker(db, g.a.user.id, id)
    if (!w) return notFound(c)
    const token = regenerateWorkerToken(db, g.a.user.id, id)!
    hub.disconnect(id, 'jeton regenere') // l'ancien jeton cesse de fonctionner tout de suite
    return render(c, g.a, { reveal: revealFor(w.name, token) })
  })

  app.post('/workers/:id{[0-9]+}/pool', async (c) => {
    const g = await guard(c, true)
    if ('res' in g) return g.res
    const id = idOf(c, 'id')!
    if (!getWorker(db, g.a.user.id, id)) return notFound(c)
    const raw = g.f.s('poolId')
    const poolId = raw ? (/^\d{1,12}$/.test(raw) ? Number(raw) : 0) : null
    if (!setWorkerPool(db, g.a.user.id, id, poolId)) return render(c, g.a, { error: 'Pool introuvable.' }, 400)
    return c.redirect('/workers?n=moved', 303)
  })

  app.post('/workers/:id{[0-9]+}/delete', async (c) => {
    const g = await guard(c, true)
    if ('res' in g) return g.res
    const id = idOf(c, 'id')!
    if (!getWorker(db, g.a.user.id, id)) return notFound(c)
    hub.disconnect(id, 'Worker supprime')
    deleteWorker(db, g.a.user.id, id)
    return c.redirect('/workers?n=deleted', 303)
  })

  app.post('/workers/:id{[0-9]+}/test', async (c) => {
    const g = await guard(c, true)
    if ('res' in g) return g.res
    const id = idOf(c, 'id')!
    if (!getWorker(db, g.a.user.id, id)) return notFound(c)
    const jobId = hub.enqueue(g.a.user.id, 'echo', { message: 'ping', at: new Date().toISOString() }, { workerId: id })
    return c.redirect(`/jobs/${jobId}`, 303)
  })

  // --- pools -----------------------------------------------------------------------------------------------------------------------
  app.post('/pools', async (c) => {
    const g = await guard(c, true)
    if ('res' in g) return g.res
    const r = createPool(db, g.a.user.id, g.f.s('name').trim())
    if (!r.ok) return render(c, g.a, { error: r.error }, 400)
    return c.redirect('/workers?n=poolcreated', 303)
  })

  app.post('/pools/:id{[0-9]+}/delete', async (c) => {
    const g = await guard(c, true)
    if ('res' in g) return g.res
    const id = idOf(c, 'id')!
    if (!getPool(db, g.a.user.id, id)) return notFound(c)
    deletePool(db, g.a.user.id, id)
    return c.redirect('/workers?n=pooldeleted', 303)
  })

  app.post('/pools/:id{[0-9]+}/test', async (c) => {
    const g = await guard(c, true)
    if ('res' in g) return g.res
    const id = idOf(c, 'id')!
    if (!getPool(db, g.a.user.id, id)) return notFound(c)
    const jobId = hub.enqueue(g.a.user.id, 'echo', { message: 'ping (pool)', at: new Date().toISOString() }, { poolId: id })
    return c.redirect(`/jobs/${jobId}`, 303)
  })

  // --- taches -----------------------------------------------------------------------------------------------------------------------
  app.get('/jobs/:id{[0-9]+}', async (c) => {
    const g = await guard(c)
    if ('res' in g) return g.res
    const job = getJob(db, g.a.user.id, idOf(c, 'id')!)
    if (!job) return notFound(c)
    return html(c, jobPage({ email: g.a.user.email, csrf: g.a.session.csrf, job, events: listJobEvents(db, job.id) }))
  })

  app.post('/jobs/:id{[0-9]+}/cancel', async (c) => {
    const g = await guard(c, true)
    if ('res' in g) return g.res
    const id = idOf(c, 'id')!
    if (!getJob(db, g.a.user.id, id)) return notFound(c)
    hub.cancel(g.a.user.id, id)
    return c.redirect(`/jobs/${id}`, 303)
  })
}
