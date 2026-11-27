// Telechargement d'un fichier joint par un Worker.
//
// SECURITE : jeton de Worker (Authorization: Bearer), ET le fichier doit etre cite par une tache EN COURS de CE Worker, ET appartenir au meme utilisateur que le Worker.
// Un Worker ne peut donc lire que les fichiers des conversations qu'on lui a confiees, pour la duree de la tache.
import type { Hono } from 'hono'
import type { Env } from './app.ts'
import { isAttachmentId, readBytes } from './attachments.ts'
import { isLibraryId, readImage, searchImages } from './library.ts'
import { autoPublishOf, publishImages, targetForProject, type PublishResult } from './library-publish.ts'
import type { RobloxClient } from './roblox.ts'
import type { Db } from './db.ts'
import { findWorkerByToken } from './workers.ts'

export function attachmentRoutes(app: Hono<Env>, ctx: { db: Db; roblox: RobloxClient }) {
  const { db, roblox } = ctx
  app.get('/api/worker/attachments/:id{[0-9a-f]{32}}', (c) => {
    const token = /^Bearer\s+(\S+)$/.exec(c.req.header('authorization') ?? '')?.[1]
    const worker = token ? findWorkerByToken(db, token) : undefined
    if (!worker) return c.json({ error: 'Jeton invalide.' }, 403)
    const id = c.req.param('id')
    if (!isAttachmentId(id)) return c.json({ error: 'Introuvable.' }, 404)
    const row = db.prepare('SELECT user_id, sha256, size FROM chat_attachments WHERE id = ?').get(id) as { user_id: number; sha256: string; size: number } | undefined
    if (!row || row.user_id !== worker.user_id) return c.json({ error: 'Introuvable.' }, 404)
    const jobs = db.prepare("SELECT payload_json FROM jobs WHERE worker_id = ? AND status = 'running' AND kind = 'ai.chat'").all(worker.id) as unknown as { payload_json: string }[]
    const cited = jobs.some((j) => {
      try { return (JSON.parse(j.payload_json).attachments as { id?: string }[] | undefined)?.some((x) => x.id === id) === true } catch { return false }
    })
    if (!cited) return c.json({ error: 'Introuvable.' }, 404)
    const data = readBytes(id)
    if (!data) return c.json({ error: 'Introuvable.' }, 404)
    return c.body(new Uint8Array(data), 200, { 'Content-Type': 'application/octet-stream', 'X-Content-SHA256': row.sha256, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' })
  })

  // Image de la bibliotheque, pour une tache de tri EN COURS de ce Worker qui la cite (meme regles que ci-dessus).
  const isSorted = (id: string) => !!db.prepare("SELECT 1 FROM library_images WHERE id = ? AND status = 'sorted'").get(id)

  // Publication sur Roblox demandee par l'IA d'un chat (a l'integration d'un concept dans le projet). Le Host publie : la cle Roblox ne va jamais au Worker.
  // Garde-fous ici : un chat de CE Worker est en cours, il appartient a un projet de l'utilisateur (qui fixe le compte et le proprietaire), les images sont les siennes et triees,
  // et le reglage « publication automatique » est actif (sinon, ou pour une image generee par IA, l'utilisateur confirme depuis la bibliotheque). Le Worker, lui, verifie que la
  // branche du projet est ouverte et que l'image est bien referencee dans le code.
  app.post('/api/worker/library-publish', async (c) => {
    const token = /^Bearer\s+(\S+)$/.exec(c.req.header('authorization') ?? '')?.[1]
    const worker = token ? findWorkerByToken(db, token) : undefined
    if (!worker) return c.json({ error: 'Jeton invalide.' }, 403)
    let body: { ids?: unknown }
    try { body = (await c.req.json()) as { ids?: unknown } } catch { return c.json({ error: 'Corps JSON invalide.' }, 400) }
    const ids = Array.isArray(body.ids) ? body.ids.filter(isLibraryId) : []
    if (!ids.length || ids.length > 100) return c.json({ error: 'Indique 1 a 100 images.' }, 400)
    const jobs = db.prepare("SELECT payload_json FROM jobs WHERE worker_id = ? AND status = 'running' AND kind = 'ai.chat'").all(worker.id) as unknown as { payload_json: string }[]
    let chat: { id: number; project_id: number } | undefined
    for (const j of jobs) {
      try {
        const chatId = (JSON.parse(j.payload_json) as { chatId?: unknown }).chatId
        const row = typeof chatId === 'number' ? db.prepare('SELECT c.id, c.project_id FROM chats c JOIN projects p ON p.id = c.project_id WHERE c.id = ? AND p.owner_id = ?').get(chatId, worker.user_id) as { id: number; project_id: number } | undefined : undefined
        if (row) { chat = row; break }
      } catch { /* charge illisible */ }
    }
    if (!chat) return c.json({ error: 'Aucune conversation en cours sur ce Worker.' }, 403)
    const target = targetForProject(db, worker.user_id, chat.project_id)
    if ('error' in target) return c.json({ error: target.error }, 409)
    const auto = autoPublishOf(db, worker.user_id)
    const results: (PublishResult | { id: string; status: 'needs-confirmation'; reference: null; error: null })[] = []
    const go: string[] = []
    for (const id of ids) {
      const row = db.prepare("SELECT source FROM library_images WHERE id = ? AND user_id = ?").get(id, worker.user_id) as { source: string } | undefined
      if (!row) results.push({ id, status: 'failed', reference: null, error: 'Image introuvable.' })
      else if (!auto || row.source === 'generated') results.push({ id, status: 'needs-confirmation', reference: null, error: null })
      else go.push(id)
    }
    if (go.length) results.push(...await publishImages(db, roblox, worker.user_id, go, target, `chat ${chat.id}`))
    return c.json({ results })
  })

  // Recherche dans le catalogue trie de l'utilisateur du Worker, pour un Worker qui execute un chat.
  app.get('/api/worker/library-search', (c) => {
    const token = /^Bearer\s+(\S+)$/.exec(c.req.header('authorization') ?? '')?.[1]
    const worker = token ? findWorkerByToken(db, token) : undefined
    if (!worker) return c.json({ error: 'Jeton invalide.' }, 403)
    if (!db.prepare("SELECT 1 FROM jobs WHERE worker_id = ? AND status = 'running' AND kind = 'ai.chat'").get(worker.id)) return c.json({ error: 'Aucune conversation en cours sur ce Worker.' }, 403)
    const id = c.req.query('id')
    const q = (k: string) => c.req.query(k)?.slice(0, 100) || undefined
    const similar = q('similar')
    const hits = searchImages(db, worker.user_id, { query: c.req.query('q')?.slice(0, 200), scope: q('scope'), style: q('style'), subject: q('subject'), color: q('color'), ratio: q('ratio'), id: id && isLibraryId(id) ? id : undefined, similar: similar && isLibraryId(similar) ? similar : undefined, limit: Number(c.req.query('limit')) || 20 })
    return c.json({ images: hits })
  })

  app.get('/api/worker/library/:id{[0-9a-f]{32}}', (c) => {
    const token = /^Bearer\s+(\S+)$/.exec(c.req.header('authorization') ?? '')?.[1]
    const worker = token ? findWorkerByToken(db, token) : undefined
    if (!worker) return c.json({ error: 'Jeton invalide.' }, 403)
    const id = c.req.param('id')
    const row = db.prepare('SELECT user_id, sha256 FROM library_images WHERE id = ?').get(id) as { user_id: number; sha256: string } | undefined
    if (!row || row.user_id !== worker.user_id) return c.json({ error: 'Introuvable.' }, 404)
    const jobs = db.prepare("SELECT kind, payload_json FROM jobs WHERE worker_id = ? AND status = 'running' AND kind IN ('library.sort', 'ai.chat')").all(worker.id) as unknown as { kind: string; payload_json: string }[]
    // tri : seulement les images citees par la tache ; chat : tout le catalogue TRIE de l'utilisateur (l'agent d'UI choisit lui-meme ses images)
    const cited = jobs.some((j) => {
      if (j.kind === 'ai.chat') return isSorted(id)
      try { return (JSON.parse(j.payload_json).images as { id?: string }[] | undefined)?.some((x) => x.id === id) === true } catch { return false }
    })
    const data = cited ? readImage(id) : null
    if (!data) return c.json({ error: 'Introuvable.' }, 404)
    return c.body(new Uint8Array(data), 200, { 'Content-Type': 'application/octet-stream', 'X-Content-SHA256': row.sha256, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' })
  })
}
