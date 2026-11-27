// Chats IA d'un projet : un chat = une branche git dediee + une conversation Claude Code sur un Worker. Les reponses viennent des taches `ai.chat` :
// le Host stocke ici le texte, les commits et le diff qu'elles renvoient. Tout est rattache a un projet (donc a son proprietaire).
import type { Db } from './db.ts'
import { slugify } from './projects.ts'
import { getJob, type EventKind, type JobEvent, type JobStatus } from './workers.ts'

/** Etat d'un chat dans la liste : reponse en cours, en attente d'un Worker, reponse non lue, echec non lu, ou rien a signaler. */
export type ChatState = 'running' | 'queued' | 'unread' | 'error' | 'idle'

export interface Chat {
  id: number; project_id: number; title: string; branch: string; session_id: string | null
  worker_id: number | null; worker_name: string | null; created_at: number; updated_at: number; message_count: number
  model: string | null; effort: string | null; seen_message_id: number
  /** La branche de travail du projet a-t-elle ete ouverte ? Tant que non, le chat n'a que son atelier (aucune branche, aucun depot). */
  branch_open: boolean
  state: ChatState
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
export const DEFAULT_TITLE = 'Nouveau chat'

/** Choix proposes a l'utilisateur (la valeur vide = reglage par defaut du CLI). */
export const MODELS: { value: string; label: string }[] = [
  { value: '', label: 'Modele par defaut' }, { value: 'fable', label: 'Fable' }, { value: 'opus', label: 'Opus' },
  { value: 'sonnet', label: 'Sonnet' }, { value: 'haiku', label: 'Haiku' },
]
export const EFFORTS: { value: string; label: string }[] = [
  { value: '', label: 'Effort par defaut' }, { value: 'low', label: 'Faible' }, { value: 'medium', label: 'Moyen' },
  { value: 'high', label: 'Eleve' }, { value: 'xhigh', label: 'Tres eleve' }, { value: 'max', label: 'Maximum' },
]
export const modelOk = (v: string) => MODELS.some((m) => m.value === v)
export const effortOk = (v: string) => EFFORTS.some((m) => m.value === v)

const CHAT_SELECT = `SELECT c.id, c.project_id, c.title, c.branch, c.session_id, c.worker_id, w.name AS worker_name, c.created_at, c.updated_at,
  c.model, c.effort, c.seen_message_id, c.branch_open,
  (SELECT COUNT(*) FROM chat_messages m WHERE m.chat_id = c.id) AS message_count,
  (SELECT m.id FROM chat_messages m WHERE m.chat_id = c.id AND m.role = 'assistant' AND m.status != 'pending' ORDER BY m.id DESC LIMIT 1) AS last_done_id,
  (SELECT m.status FROM chat_messages m WHERE m.chat_id = c.id AND m.role = 'assistant' AND m.status != 'pending' ORDER BY m.id DESC LIMIT 1) AS last_done_status,
  (SELECT CASE WHEN j.id IS NULL THEN 'queued' ELSE j.status END FROM chat_messages m LEFT JOIN jobs j ON j.id = m.job_id
     WHERE m.chat_id = c.id AND m.status = 'pending' ORDER BY m.id DESC LIMIT 1) AS pending_job_status
  FROM chats c LEFT JOIN workers w ON w.id = c.worker_id`

type ChatRow = Omit<Chat, 'state' | 'branch_open'> & { branch_open: number; last_done_id: number | null; last_done_status: string | null; pending_job_status: string | null }

function toChat(r: ChatRow): Chat {
  const { last_done_id, last_done_status, pending_job_status, branch_open, ...rest } = r
  const chat = { ...rest, branch_open: !!branch_open }
  let state: ChatState = 'idle'
  if (pending_job_status === 'running') state = 'running'
  else if (pending_job_status === 'queued') state = 'queued'
  else if (pending_job_status === 'succeeded') state = 'unread' // terminee, reponse pas encore reportee dans le chat
  else if (pending_job_status === 'failed') state = 'error'
  else if (last_done_id !== null && last_done_id > chat.seen_message_id) state = last_done_status === 'done' ? 'unread' : last_done_status === 'failed' ? 'error' : 'idle'
  return { ...chat, state }
}

export const listChats = (db: Db, projectId: number) =>
  (db.prepare(`${CHAT_SELECT} WHERE c.project_id = ? ORDER BY c.updated_at DESC, c.id DESC`).all(projectId) as unknown as ChatRow[]).map(toChat)

export const getChat = (db: Db, projectId: number, id: number) => {
  const r = db.prepare(`${CHAT_SELECT} WHERE c.id = ? AND c.project_id = ?`).get(id, projectId) as unknown as ChatRow | undefined
  return r ? toChat(r) : undefined
}

export function titleProblem(title: string): string | null {
  if (!title) return 'Donne un titre au chat.'
  if (title.length > MAX_TITLE) return `Titre trop long (${MAX_TITLE} caracteres maximum).`
  if (/[\r\n\u0000-\u001f]/.test(title)) return 'Titre invalide.'
  return null
}

const branchFor = (id: number, title: string) => `ai/chat-${id}-${slugify(title).slice(0, 30).replace(/-+$/, '') || 'chat'}`

// Chaque chat a sa branche : « ai/chat-<id>-<titre> » (le numero la rend unique et stable, meme si deux chats ont le meme titre).
export function createChat(db: Db, projectId: number, title: string = DEFAULT_TITLE): Chat {
  const now = Date.now()
  const r = db.prepare("INSERT INTO chats (project_id, title, branch, created_at, updated_at) VALUES (?, ?, '', ?, ?)").run(projectId, title, now, now)
  const id = Number(r.lastInsertRowid)
  db.prepare('UPDATE chats SET branch = ? WHERE id = ?').run(branchFor(id, title), id)
  return getChat(db, projectId, id)!
}

export const renameChat = (db: Db, projectId: number, id: number, title: string) =>
  Number(db.prepare('UPDATE chats SET title = ? WHERE id = ? AND project_id = ?').run(title, id, projectId).changes) > 0

/** Premier message d'un chat encore intitule « Nouveau chat » : le titre (et la branche, pas encore utilisee) en sont deduits. */
export function titleFromFirstMessage(db: Db, chat: Chat, prompt: string) {
  if (chat.title !== DEFAULT_TITLE || chat.message_count > 0) return
  const first = prompt.split('\n').find((l) => l.trim())?.trim().replace(/\s+/g, ' ') ?? ''
  const title = first.length > 60 ? `${first.slice(0, 59).trimEnd()}…` : first
  if (!title || titleProblem(title)) return
  db.prepare('UPDATE chats SET title = ?, branch = ? WHERE id = ?').run(title, branchFor(chat.id, title), chat.id)
}

export function setChatPrefs(db: Db, chatId: number, model: string, effort: string) {
  db.prepare('UPDATE chats SET model = ?, effort = ? WHERE id = ?').run(model || null, effort || null, chatId)
}

/** L'utilisateur a vu tout ce qui est termine dans ce chat : plus de point « non lu ». */
export function markSeen(db: Db, chatId: number) {
  db.prepare("UPDATE chats SET seen_message_id = (SELECT COALESCE(MAX(id), 0) FROM chat_messages WHERE chat_id = ? AND status != 'pending') WHERE id = ?").run(chatId, chatId)
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

/** Activite (pensee, outils, texte) des taches d'un chat, regroupee par tache. */
export function activityByJob(db: Db, jobIds: number[]): Map<number, JobEvent[]> {
  const out = new Map<number, JobEvent[]>()
  if (!jobIds.length) return out
  const rows = db.prepare(`SELECT job_id, id, at, level, text, kind FROM job_events WHERE job_id IN (${jobIds.map(() => '?').join(',')}) ORDER BY id`).all(...jobIds) as unknown as
    (JobEvent & { job_id: number; kind: EventKind | null })[]
  for (const { job_id, kind, ...e } of rows) {
    if (!out.has(job_id)) out.set(job_id, [])
    out.get(job_id)!.push({ ...e, kind: kind ?? 'info' })
  }
  return out
}

export const hasPendingReply = (db: Db, chatId: number) =>
  !!db.prepare("SELECT 1 FROM chat_messages WHERE chat_id = ? AND status = 'pending'").get(chatId)

/** Enregistre le message de l'utilisateur et la reponse « en attente » liee a la tache. */
export function addExchange(db: Db, chatId: number, prompt: string, jobId: number): number {
  const now = Date.now()
  const user = db.prepare("INSERT INTO chat_messages (chat_id, role, content, status, created_at) VALUES (?, 'user', ?, 'done', ?)").run(chatId, prompt, now)
  db.prepare("INSERT INTO chat_messages (chat_id, role, content, status, job_id, created_at) VALUES (?, 'assistant', '', 'pending', ?, ?)").run(chatId, jobId, now + 1)
  db.prepare('UPDATE chats SET updated_at = ? WHERE id = ?').run(now, chatId)
  return Number(user.lastInsertRowid) // message de l'utilisateur (les fichiers joints y sont rattaches)
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
      db.prepare('UPDATE chats SET session_id = COALESCE(?, session_id), worker_id = COALESCE(?, worker_id), updated_at = ?, branch_open = CASE WHEN ? THEN 1 ELSE branch_open END WHERE id = ?')
        .run(typeof r.sessionId === 'string' ? r.sessionId : null, job.worker_id, Date.now(), typeof r.branch === 'string' && r.branch ? 1 : 0, chatId)
    } else {
      db.prepare('UPDATE chat_messages SET status = ?, content = ? WHERE id = ?')
        .run(job.status === 'cancelled' ? 'cancelled' : 'failed', job.error ?? (job.status === 'cancelled' ? 'Annulee.' : 'La tache a echoue.'), m.id)
      db.prepare('UPDATE chats SET updated_at = ? WHERE id = ?').run(Date.now(), chatId)
    }
  }
}

/** Toutes les taches des reponses d'un chat (en cours ou terminees). */
export const allJobIds = (db: Db, chatId: number) =>
  (db.prepare('SELECT job_id FROM chat_messages WHERE chat_id = ? AND job_id IS NOT NULL').all(chatId) as unknown as { job_id: number }[]).map((r) => r.job_id)

export const pendingJobIds = (db: Db, chatId: number) =>
  (db.prepare("SELECT job_id FROM chat_messages WHERE chat_id = ? AND status = 'pending' AND job_id IS NOT NULL").all(chatId) as unknown as { job_id: number }[]).map((r) => r.job_id)
