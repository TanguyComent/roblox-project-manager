// Routes de la bibliotheque d'images : page, televersement, service des fichiers, modification, tri.
import { createWriteStream } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { join, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { Context, Hono } from 'hono'
import { config } from './config.ts'
import type { Env } from './app.ts'
import {
  LibraryError, addImage, addZip, findResult, startFind, cancelSortJobs, discard, renameFacet, deleteImage, editImage, getImage, imageCounts, listImages, readImage, resetSorting, startSort, syncLibrary, SORT_REQUIRES,
} from './library.ts'
import { findResultsHtml, groupOf, libraryGridHtml, libraryInfoHtml, libraryPage, viewOf, type View } from './library-views.ts'
import type { Db } from './db.ts'
import type { WorkerHub } from './worker-hub.ts'
import { autoPublishOf, publishImages, publishTargets, resolveTarget, setAutoPublish, syncPublishing } from './library-publish.ts'
import type { RobloxClient } from './roblox.ts'

type Auth = NonNullable<Context<Env>['var']['auth']>

interface Ctx {
  db: Db
  hub: WorkerHub
  roblox: RobloxClient
  html: (c: Context, body: string, status?: 200 | 400 | 403 | 404 | 409) => Response
  form: (c: Context) => Promise<{ s: (k: string) => string }>
  csrfOk: (c: Context, given: string) => boolean
  requireFull: (c: Context) => Auth | Response
}

const pageOf = (c: Context) => Math.max(1, Math.min(100000, Number.parseInt(c.req.query('p') ?? '1', 10) || 1))
const queryOf = (c: Context) => (c.req.query('q') ?? '').slice(0, 100)
const wantsJson = (c: Context) => (c.req.header('accept') ?? '').includes('application/json')
const asciiName = (n: string) => n.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_')

export function libraryRoutes(app: Hono<Env>, ctx: Ctx) {
  const { db, hub, roblox, html, form, csrfOk, requireFull } = ctx

  const state = (a: Auth) => {
    const sync = syncLibrary(db, a.user.id, hub)
    const counts = imageCounts(db, a.user.id)
    return { autoPublish: autoPublishOf(db, a.user.id), targets: publishTargets(db, a.user.id), images: listImages(db, a.user.id), counts, error: sync.error ?? undefined, noWorker: (counts.pending > 0 || counts.sorting > 0) && !hub.hasCapable(a.user.id, SORT_REQUIRES, null) }
  }
  const viewer = (a: Auth) => ({ email: a.user.email, csrf: a.session.csrf })
  // retour a la vue d'ou vient le formulaire (champ cache « view »), jamais une adresse libre
  const back = (c: Context, view = '') => c.redirect(`/library?view=${view === 'pending' ? 'pending' : 'sorted'}`, 303)

  app.get('/library', async (c) => {
    const a = requireFull(c)
    if (a instanceof Response) return a
    await syncPublishing(db, roblox, a.user.id).catch(() => 0)
    return html(c, libraryPage({ ...viewer(a), ...state(a), group: groupOf(c.req.query('group')), page: pageOf(c), q: queryOf(c), view: viewOf(c.req.query('view'), state(a).counts) }))
  })

  app.get('/library/live', async (c) => {
    const a = requireFull(c)
    if (a instanceof Response) return a
    await syncPublishing(db, roblox, a.user.id).catch(() => 0)
    const s = state(a)
    c.header('Cache-Control', 'no-store')
    return c.json({ html: libraryGridHtml(s.images, a.session.csrf, { view: viewOf(c.req.query('view'), s.counts), group: groupOf(c.req.query('group')), targets: s.targets, page: pageOf(c), q: queryOf(c) }), counts: s.counts, error: s.error ?? null })
  })

  // Televersement : corps brut, nom dans X-File-Name, jeton CSRF dans X-CSRF.
  app.post('/library/upload', async (c) => {
    const a = requireFull(c)
    if (a instanceof Response) return a
    if (!csrfOk(c, c.req.header('x-csrf') ?? '')) return c.json({ error: 'Session expiree : recharge la page.' }, 403)
    let name = ''
    try { name = decodeURIComponent(c.req.header('x-file-name') ?? '') } catch { return c.json({ error: 'Nom de fichier invalide.' }, 400) }
    try {
      const img = addImage(db, a.user.id, name, Buffer.from(await c.req.arrayBuffer()))
      return c.json({ id: img.id, name: img.file_name })
    } catch (e) {
      if (e instanceof LibraryError) return c.json({ error: e.message }, e.status)
      throw e
    }
  })

  // Import d'un pack : archive ZIP (corps brut, enregistre sur le disque puis lu entree par entree : jamais en memoire). Tout ce qui n'est pas une image est ignore.
  app.post('/library/upload-zip', async (c) => {
    const a = requireFull(c)
    if (a instanceof Response) return a
    if (!csrfOk(c, c.req.header('x-csrf') ?? '')) return c.json({ error: 'Session expiree : recharge la page.' }, 403)
    let name = ''
    try { name = decodeURIComponent(c.req.header('x-file-name') ?? '') } catch { return c.json({ error: 'Nom de fichier invalide.' }, 400) }
    const body = c.req.raw.body
    if (!body) return c.json({ error: 'Archive vide.' }, 400)
    const dir = join(resolve(config.dataDir), 'tmp')
    await mkdir(dir, { recursive: true })
    const tmp = join(dir, `${randomBytes(12).toString('hex')}.zip`)
    try {
      await pipeline(Readable.fromWeb(body as never), createWriteStream(tmp, { mode: 0o600 }))
      return c.json(await addZip(db, a.user.id, tmp, name))
    } catch (e) {
      if (e instanceof LibraryError) return c.json({ error: e.message }, e.status)
      if ((e as { code?: string })?.code === 'ERR_STREAM_PREMATURE_CLOSE') return c.json({ error: 'Envoi interrompu.' }, 400)
      throw e
    } finally { await discard(tmp) }
  })

  // Fenetre d'une image : toutes ses informations et, si elle n'est pas sur Roblox, le bouton pour l'y envoyer.
  app.get('/library/:id{[0-9a-f]{32}}/info', (c) => {
    const a = requireFull(c)
    if (a instanceof Response) return a
    const img = getImage(db, a.user.id, c.req.param('id'))
    if (!img) return c.json({ error: 'Image introuvable.' }, 404)
    c.header('Cache-Control', 'no-store')
    return c.json({ html: libraryInfoHtml(img, a.session.csrf, publishTargets(db, a.user.id)) })
  })

  // Le fichier : proprietaire seulement, image verifiee affichee en ligne, sans pouvoir executer quoi que ce soit.
  app.get('/library/:id{[0-9a-f]{32}}/file', (c) => {
    const a = requireFull(c)
    if (a instanceof Response) return a
    const img = getImage(db, a.user.id, c.req.param('id'))
    const data = img ? readImage(img.id) : null
    if (!img || !data) return c.text('Introuvable', 404)
    return c.body(new Uint8Array(data), 200, {
      'Content-Type': img.mime,
      'Content-Disposition': `inline; filename="${asciiName(img.file_name)}"`,
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'X-Content-Type-Options': 'nosniff',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Cache-Control': 'private, max-age=86400, immutable', // le contenu d'un identifiant ne change jamais
    })
  })

  const post = async (c: Context) => {
    const a = requireFull(c)
    if (a instanceof Response) return { res: a } as const
    const f = await form(c)
    if (!csrfOk(c, f.s('csrf'))) return { res: wantsJson(c) ? c.json({ error: 'Session expiree : recharge la page.' }, 403) : c.text('Jeton invalide', 403) } as const
    return { a, f } as const
  }
  const fail = (c: Context, a: Auth, e: unknown) => {
    if (!(e instanceof LibraryError)) throw e
    if (wantsJson(c)) return c.json({ error: e.message }, e.status)
    return html(c, libraryPage({ ...viewer(a), ...state(a), group: 'scope', view: 'sorted' as View, error: e.message }), e.status === 413 ? 400 : e.status)
  }

  app.post('/library/sort', async (c) => {
    const p = await post(c)
    if ('res' in p) return p.res
    // « count » : combien d'images trier dans cette serie ; vide = toutes celles en attente
    const raw = p.f.s('count').trim()
    let count: number | undefined
    if (raw !== '') {
      count = Number(raw)
      if (!Number.isInteger(count) || count < 1) return fail(c, p.a, new LibraryError('Indique un nombre d\'images a trier (1 au moins).'))
      count = Math.min(count, imageCounts(db, p.a.user.id).pending)
    }
    try { startSort(db, hub, p.a.user.id, true, count) } catch (e) { return fail(c, p.a, e) }
    return wantsJson(c) ? c.json({ ok: true }) : back(c, 'pending')
  })

  app.post('/library/sort/cancel', async (c) => {
    const p = await post(c)
    if ('res' in p) return p.res
    cancelSortJobs(db, hub, p.a.user.id)
    resetSorting(db, p.a.user.id)
    return wantsJson(c) ? c.json({ ok: true }) : back(c, 'pending')
  })

  app.post('/library/:id{[0-9a-f]{32}}/edit', async (c) => {
    const p = await post(c)
    if ('res' in p) return p.res
    try { editImage(db, p.a.user.id, c.req.param('id'), { title: p.f.s('title'), scope: p.f.s('scope'), style: p.f.s('style'), traits: p.f.s('traits'), subject: p.f.s('subject'), colors: p.f.s('colors'), description: p.f.s('description'), tags: p.f.s('tags'), origin: p.f.s('origin') }) } catch (e) { return fail(c, p.a, e) }
    return back(c, p.f.s('view'))
  })

  // Renomme (ou fusionne) une valeur de scope, de style ou de sujet sur toutes les images.
  app.post('/library/rename', async (c) => {
    const p = await post(c)
    if ('res' in p) return p.res
    const facet = p.f.s('facet')
    if (facet !== 'scope' && facet !== 'style' && facet !== 'subject') return fail(c, p.a, new LibraryError('Facette inconnue.'))
    try { renameFacet(db, p.a.user.id, facet, p.f.s('from'), p.f.s('to')) } catch (e) { return fail(c, p.a, e) }
    return c.redirect(`/library?group=${facet}`, 303)
  })

  // Publication manuelle d'une image sur Roblox (compte ou groupe au choix).
  app.post('/library/:id{[0-9a-f]{32}}/publish', async (c) => {
    const p = await post(c)
    if ('res' in p) return p.res
    const target = resolveTarget(db, p.a.user.id, p.f.s('target'))
    if ('error' in target) return fail(c, p.a, new LibraryError(target.error))
    const results = await publishImages(db, roblox, p.a.user.id, [c.req.param('id')], target, 'manuel').catch((e: unknown) => [{ id: c.req.param('id'), status: 'failed' as const, reference: null, error: e instanceof Error ? e.message : 'Envoi impossible.' }])
    if (wantsJson(c)) return c.json(results[0] ?? { status: 'failed', error: 'Envoi impossible.' })
    return back(c, p.f.s('view'))
  })

  app.post('/library/settings', async (c) => {
    const p = await post(c)
    if ('res' in p) return p.res
    setAutoPublish(db, p.a.user.id, p.f.s('auto_publish') === '1')
    return back(c)
  })

  // Recherche par description : un agent parcourt les images triees (tache library.find) ; la page interroge ensuite l'etat de la tache.
  app.post('/library/find', async (c) => {
    const p = await post(c)
    if ('res' in p) return p.res
    try { return c.json({ jobId: startFind(db, hub, p.a.user.id, p.f.s('query')) }) } catch (e) { return fail(c, p.a, e) }
  })

  app.get('/library/find/:job{[0-9]{1,12}}', (c) => {
    const a = requireFull(c)
    if (a instanceof Response) return a
    const r = findResult(db, a.user.id, Number(c.req.param('job')))
    c.header('Cache-Control', 'no-store')
    if (!r) return c.json({ error: 'Recherche introuvable.' }, 404)
    return c.json(r.state === 'done' ? { state: 'done', html: findResultsHtml(r.matches) } : r)
  })

  app.post('/library/:id{[0-9a-f]{32}}/delete', async (c) => {
    const p = await post(c)
    if ('res' in p) return p.res
    try { if (!deleteImage(db, p.a.user.id, c.req.param('id'))) return fail(c, p.a, new LibraryError('Image introuvable.', 404)) } catch (e) { return fail(c, p.a, e) }
    return back(c, p.f.s('view'))
  })
}
