// Chats IA d'un projet : un chat = une branche git dediee + une conversation Claude Code sur un Worker. Les reponses viennent des taches `ai.chat` :
// le Host stocke ici le texte, les commits et le diff qu'elles renvoient. Tout est rattache a un projet (donc a son proprietaire).
import type { Db } from './db.ts'
import { slugify } from './projects.ts'
import { getJob, type JobStatus } from './workers.ts'

export interface Chat {
  id: number; project_id: number; title: string; branch: string; session_id: string | null
  worker_id: number | null; worker_name: string | null; created_at: number; updated_at: number; message_count: number
}
export interface ChatDetails {
  branch?: string; head?: string; commits?: string[]; diffStat?: string; diff?: string
  costUsd?: number | null; durationMs?: number | null; turns?: number | null
  pushed?: boolean; pushError?: string | null; leftoverFiles?: number
}
export interface ChatMessage {
  id: number; chat_id: number; role: 'user' | 'assistant'; content: string; status: 'done' | 'pending' | 'failed' | 'cancelled'
  job_id: number | null; job_status: JobStatus | null; details: ChatDetails | null; created_at: number
}

export const MAX_TITLE = 80
export const MAX_PROMPT = 20_000

const CHAT_SELECT = `SELECT c.id, c.project_id, c.title, c.branch, c.session_id, c.worker_id, w.name AS worker_name, c.created_at, c.updated_at,
  (SELECT COUNT(*) FROM chat_messages m WHERE m.chat_id = c.id) AS message_count
  FROM chats c LEFT JOIN workers w ON w.id = c.worker_id`

export const listChats = (db: Db, projectId: number) =>
  db.prepare(`${CHAT_SELECT} WHERE c.project_id = ? ORDER BY c.updated_at DESC, c.id DESC`).all(projectId) as unknown as Chat[]

export const getChat = (db: Db, projectId: number, id: number) =>
  db.prepare(`${CHAT_SELECT} WHERE c.id = ? AND c.project_id = ?`).get(id, projectId) as unknown as Chat | undefined

export function titleProblem(title: string): string | null {
  if (!title) return 'Donne un titre au chat.'
  if (title.length > MAX_TITLE) return `Titre trop long (${MAX_TITLE} caracteres maximum).`
  if (/[\r\n\u0000-\u001f]/.test(title)) return 'Titre invalide.'
  return null
}

// Chaque chat a sa branche : « ai/chat-<id>-<titre> » (le numero la rend unique et stable, meme si deux chats ont le meme titre).
export function createChat(db: Db, projectId: number, title: string): Chat {
  const now = Date.now()
  const r = db.prepare("INSERT INTO chats (project_id, title, branch, created_at, updated_at) VALUES (?, ?, '', ?, ?)").run(projectId, title, now, now)
  const id = Number(r.lastInsertRowid)
  const slug = slugify(title).slice(0, 30).replace(/-+$/, '') || 'chat'
  db.prepare('UPDATE chats SET branch = ? WHERE id = ?').run(`ai/chat-${id}-${slug}`, id)
  return getChat(db, projectId, id)!
}

export const deleteChat = (db: Db, projectId: number, id: number) =>
  Number(db.prepare('DELETE FROM chats WHERE id = ? AND project_id = ?').run(id, projectId).changes) > 0

export function listMessages(db: Db, chatId: number): ChatMessage[] {
  const rows = db.prepare(
    `SELECT m.id, m.chat_id, m.role, m.content, m.status, m.job_id, j.status AS job_status, m.details_json, m.created_at
     FROM chat_messages m LEFT JOIN jobs j ON j.id = m.job_id WHERE m.chat_id = ? ORDER BY m.id`,
  ).all(chatId) as unknown as (Omit<ChatMessage, 'details'> & { details_json: string | null })[]
  return rows.map(({ details_json, ...m }) => {
    let details: ChatDetails | null = null
    try { details = details_json ? (JSON.parse(details_json) as ChatDetails) : null } catch { /* illisible */ }
    return { ...m, details }
  })
}

export const hasPendingReply = (db: Db, chatId: number) =>
  !!db.prepare("SELECT 1 FROM chat_messages WHERE chat_id = ? AND status = 'pending'").get(chatId)

/** Enregistre le message de l'utilisateur et la reponse « en attente » liee a la tache. */
export function addExchange(db: Db, chatId: number, prompt: string, jobId: number) {
  const now = Date.now()
  db.prepare("INSERT INTO chat_messages (chat_id, role, content, status, created_at) VALUES (?, 'user', ?, 'done', ?)").run(chatId, prompt, now)
  db.prepare("INSERT INTO chat_messages (chat_id, role, content, status, job_id, created_at) VALUES (?, 'assistant', '', 'pending', ?, ?)").run(chatId, jobId, now + 1)
  db.prepare('UPDATE chats SET updated_at = ? WHERE id = ?').run(now, chatId)
}

const pick = (r: Record<string, unknown>): ChatDetails => ({
  branch: typeof r.branch === 'string' ? r.branch : undefined,
  head: typeof r.head === 'string' ? r.head : undefined,
  commits: Array.isArray(r.commits) ? r.commits.filter((c): c is string => typeof c === 'string').slice(0, 30) : [],
  diffStat: typeof r.diffStat === 'string' ? r.diffStat : '',
  diff: typeof r.diff === 'string' ? r.diff : '',
  costUsd: typeof r.costUsd === 'number' ? r.costUsd : null,
  durationMs: typeof r.durationMs === 'number' ? r.durationMs : null,
  turns: typeof r.turns === 'number' ? r.turns : null,
  pushed: r.pushed === true,
  pushError: typeof r.pushError === 'string' ? r.pushError : null,
  leftoverFiles: typeof r.leftoverFiles === 'number' ? r.leftoverFiles : 0,
})

/**
 * Reporte dans le chat l'issue des taches terminees (reponse, echec ou annulation). Appelee a chaque affichage : fonctionne aussi pour une tache
 * terminee pendant que personne ne regardait, ou apres un redemarrage du Host.
 */
export function syncChat(db: Db, userId: number, chatId: number) {
  const pending = db.prepare("SELECT id, job_id FROM chat_messages WHERE chat_id = ? AND status = 'pending'").all(chatId) as unknown as { id: number; job_id: number | null }[]
  for (const m of pending) {
    const job = m.job_id === null ? undefined : getJob(db, userId, m.job_id)
    if (!job) { db.prepare("UPDATE chat_messages SET status = 'failed', content = ? WHERE id = ?").run('La tache de cette reponse a disparu.', m.id); continue }
    if (job.status === 'queued' || job.status === 'running') continue
    if (job.status === 'succeeded') {
      const r = (job.result && typeof job.result === 'object' ? job.result : {}) as Record<string, unknown>
      const text = typeof r.text === 'string' ? r.text : ''
      db.prepare("UPDATE chat_messages SET status = 'done', content = ?, details_json = ? WHERE id = ?").run(text || '(reponse vide)', JSON.stringify(pick(r)).slice(0, 60_000), m.id)
      // La conversation Claude et le dossier de travail vivent sur CE Worker : les messages suivants y retournent.
      db.prepare('UPDATE chats SET session_id = COALESCE(?, session_id), worker_id = COALESCE(?, worker_id), updated_at = ? WHERE id = ?')
        .run(typeof r.sessionId === 'string' ? r.sessionId : null, job.worker_id, Date.now(), chatId)
    } else {
      db.prepare('UPDATE chat_messages SET status = ?, content = ? WHERE id = ?')
        .run(job.status === 'cancelled' ? 'cancelled' : 'failed', job.error ?? (job.status === 'cancelled' ? 'Annulee.' : 'La tache a echoue.'), m.id)
      db.prepare('UPDATE chats SET updated_at = ? WHERE id = ?').run(Date.now(), chatId)
    }
  }
}

export const pendingJobIds = (db: Db, chatId: number) =>
  (db.prepare("SELECT job_id FROM chat_messages WHERE chat_id = ? AND status = 'pending' AND job_id IS NOT NULL").all(chatId) as unknown as { job_id: number }[]).map((r) => r.job_id)
