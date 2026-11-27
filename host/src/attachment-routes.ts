// Telechargement d'un fichier joint par un Worker.
//
// SECURITE : jeton de Worker (Authorization: Bearer), ET le fichier doit etre cite par une tache EN COURS de CE Worker, ET appartenir au meme utilisateur que le Worker.
// Un Worker ne peut donc lire que les fichiers des conversations qu'on lui a confiees, pour la duree de la tache.
import type { Hono } from 'hono'
import type { Env } from './app.ts'
import { isAttachmentId, readBytes } from './attachments.ts'
import { readImage } from './library.ts'
import type { Db } from './db.ts'
import { findWorkerByToken } from './workers.ts'

export function attachmentRoutes(app: Hono<Env>, ctx: { db: Db }) {
  const { db } = ctx
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
  app.get('/api/worker/library/:id{[0-9a-f]{32}}', (c) => {
    const token = /^Bearer\s+(\S+)$/.exec(c.req.header('authorization') ?? '')?.[1]
    const worker = token ? findWorkerByToken(db, token) : undefined
    if (!worker) return c.json({ error: 'Jeton invalide.' }, 403)
    const id = c.req.param('id')
    const row = db.prepare('SELECT user_id, sha256 FROM library_images WHERE id = ?').get(id) as { user_id: number; sha256: string } | undefined
    if (!row || row.user_id !== worker.user_id) return c.json({ error: 'Introuvable.' }, 404)
    const jobs = db.prepare("SELECT payload_json FROM jobs WHERE worker_id = ? AND status = 'running' AND kind = 'library.sort'").all(worker.id) as unknown as { payload_json: string }[]
    const cited = jobs.some((j) => {
      try { return (JSON.parse(j.payload_json).images as { id?: string }[] | undefined)?.some((x) => x.id === id) === true } catch { return false }
    })
    const data = cited ? readImage(id) : null
    if (!data) return c.json({ error: 'Introuvable.' }, 404)
    return c.body(new Uint8Array(data), 200, { 'Content-Type': 'application/octet-stream', 'X-Content-SHA256': row.sha256, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' })
  })
}
