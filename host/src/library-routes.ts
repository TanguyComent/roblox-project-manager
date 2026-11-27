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
  LibraryError, addImage, addZip, cancelSortJobs, discard, renameFacet, deleteImage, editImage, getImage, imageCounts, listImages, readImage, resetSorting, startSort, syncLibrary, SORT_REQUIRES,
} from './library.ts'
import { groupOf, libraryGridHtml, libraryPage } from './library-views.ts'
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
  const back = (c: Context) => c.redirect('/library', 303)

  app.get('/library', async (c) => {
    const a = requireFull(c)
    if (a instanceof Response) return a
    await syncPublishing(db, roblox, a.user.id).catch(() => 0)
    return html(c, libraryPage({ ...viewer(a), ...state(a), group: groupOf(c.req.query('group')) }))
  })

  app.get('/library/live', async (c) => {
    const a = requireFull(c)
    if (a instanceof Response) return a
    await syncPublishing(db, roblox, a.user.id).catch(() => 0)
    const s = state(a)
    c.header('Cache-Control', 'no-store')
    return c.json({ html: libraryGridHtml(s.images, a.session.csrf, groupOf(c.req.query('group')), s.targets), counts: s.counts, error: s.error ?? null })
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
      'Cache-Control': 'private, max-age=3600',
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
    return html(c, libraryPage({ ...viewer(a), ...state(a), group: 'scope', error: e.message }), e.status === 413 ? 400 : e.status)
  }

  app.post('/library/sort', async (c) => {
    const p = await post(c)
    if ('res' in p) return p.res
    try { startSort(db, hub, p.a.user.id, true) } catch (e) { return fail(c, p.a, e) }
    return wantsJson(c) ? c.json({ ok: true }) : back(c)
  })

  app.post('/library/sort/cancel', async (c) => {
    const p = await post(c)
    if ('res' in p) return p.res
    cancelSortJobs(db, hub, p.a.user.id)
    resetSorting(db, p.a.user.id)
    return wantsJson(c) ? c.json({ ok: true }) : back(c)
  })

  app.post('/library/:id{[0-9a-f]{32}}/edit', async (c) => {
    const p = await post(c)
    if ('res' in p) return p.res
    try { editImage(db, p.a.user.id, c.req.param('id'), { title: p.f.s('title'), scope: p.f.s('scope'), style: p.f.s('style'), traits: p.f.s('traits'), subject: p.f.s('subject'), colors: p.f.s('colors'), description: p.f.s('description'), tags: p.f.s('tags'), origin: p.f.s('origin') }) } catch (e) { return fail(c, p.a, e) }
    return back(c)
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
    await publishImages(db, roblox, p.a.user.id, [c.req.param('id')], target, 'manuel').catch(() => [])
    return back(c)
  })

  app.post('/library/settings', async (c) => {
    const p = await post(c)
    if ('res' in p) return p.res
    setAutoPublish(db, p.a.user.id, p.f.s('auto_publish') === '1')
    return back(c)
  })

  app.post('/library/:id{[0-9a-f]{32}}/delete', async (c) => {
    const p = await post(c)
    if ('res' in p) return p.res
    try { if (!deleteImage(db, p.a.user.id, c.req.param('id'))) return fail(c, p.a, new LibraryError('Image introuvable.', 404)) } catch (e) { return fail(c, p.a, e) }
    return back(c)
  })
}
