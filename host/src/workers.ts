// Workers (machines qui executent les taches), pools et taches. Tout est rattache a un utilisateur : jamais de partage entre comptes.
import { randomToken, sha256 } from './crypto.ts'
import type { Db } from './db.ts'
import type { Capability } from './worker-protocol.ts'

export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'

export interface Pool { id: number; user_id: number; name: string; created_at: number; worker_count: number }
export interface Worker {
  id: number; user_id: number; pool_id: number | null; pool_name: string | null; name: string
  last_seen_at: number | null; info: Record<string, unknown>; capabilities: Capability[]; created_at: number
}
export interface Job {
  id: number; user_id: number; kind: string; payload: unknown
  target_worker_id: number | null; target_pool_id: number | null; worker_id: number | null; worker_name: string | null
  /** Outils que le Worker doit avoir (identifiants de capacites, ex. git, claude). */
  requires: string[]
  status: JobStatus; result: unknown; error: string | null
  created_at: number; started_at: number | null; finished_at: number | null
}
export type EventKind = 'info' | 'thinking' | 'tool' | 'text'
export interface JobEvent { id: number; at: number; level: string; text: string; kind: EventKind }

const now = () => Date.now()
const NAME = /^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,39}$/u
export const nameProblem = (n: string) => (NAME.test(n) ? null : 'Nom invalide : 1 a 40 caracteres (lettres, chiffres, espace, point, tiret).')

// --- pools -------------------------------------------------------------------------------------------------------------------
export const listPools = (db: Db, userId: number) =>
  db.prepare(
    `SELECT p.*, (SELECT COUNT(*) FROM workers w WHERE w.pool_id = p.id) AS worker_count
     FROM worker_pools p WHERE p.user_id = ? ORDER BY p.name`,
  ).all(userId) as unknown as Pool[]

export const getPool = (db: Db, userId: number, id: number) =>
  db.prepare('SELECT * FROM worker_pools WHERE id = ? AND user_id = ?').get(id, userId) as unknown as Omit<Pool, 'worker_count'> | undefined

export function createPool(db: Db, userId: number, name: string): { ok: true; id: number } | { ok: false; error: string } {
  const problem = nameProblem(name)
  if (problem) return { ok: false, error: problem }
  if (db.prepare('SELECT 1 FROM worker_pools WHERE user_id = ? AND name = ?').get(userId, name)) return { ok: false, error: 'Un pool porte deja ce nom.' }
  const r = db.prepare('INSERT INTO worker_pools (user_id, name, created_at) VALUES (?, ?, ?)').run(userId, name, now())
  return { ok: true, id: Number(r.lastInsertRowid) }
}

export const deletePool = (db: Db, userId: number, id: number) =>
  Number(db.prepare('DELETE FROM worker_pools WHERE id = ? AND user_id = ?').run(id, userId).changes) > 0

// --- workers -----------------------------------------------------------------------------------------------------------------
type WorkerRow = Omit<Worker, 'info' | 'capabilities'> & { info_json: string }
const toWorker = (r: WorkerRow): Worker => {
  const { info_json, ...rest } = r
  let info: Record<string, unknown> = {}
  try { info = JSON.parse(info_json) as Record<string, unknown> } catch { /* illisible : aucune information */ }
  return { ...rest, info, capabilities: sanitizeCapabilities(info.capabilities) }
}
const WORKER_SELECT = `SELECT w.id, w.user_id, w.pool_id, p.name AS pool_name, w.name, w.last_seen_at, w.info_json, w.created_at
  FROM workers w LEFT JOIN worker_pools p ON p.id = w.pool_id`

export const listWorkers = (db: Db, userId: number) =>
  (db.prepare(`${WORKER_SELECT} WHERE w.user_id = ? ORDER BY w.name`).all(userId) as unknown as WorkerRow[]).map(toWorker)

export const getWorker = (db: Db, userId: number, id: number) => {
  const r = db.prepare(`${WORKER_SELECT} WHERE w.id = ? AND w.user_id = ?`).get(id, userId) as unknown as WorkerRow | undefined
  return r ? toWorker(r) : undefined
}

export const newWorkerToken = () => `rpmw_${randomToken(32)}`

// Le jeton n'est renvoye QU'ICI (a la creation) : en base il n'y a que son hash.
export function createWorker(db: Db, userId: number, name: string, poolId: number | null): { ok: true; id: number; token: string } | { ok: false; error: string } {
  const problem = nameProblem(name)
  if (problem) return { ok: false, error: problem }
  if (db.prepare('SELECT 1 FROM workers WHERE user_id = ? AND name = ?').get(userId, name)) return { ok: false, error: 'Un Worker porte deja ce nom.' }
  if (poolId !== null && !getPool(db, userId, poolId)) return { ok: false, error: 'Pool introuvable.' }
  const token = newWorkerToken()
  const r = db.prepare('INSERT INTO workers (user_id, pool_id, name, token_hash, created_at) VALUES (?, ?, ?, ?, ?)').run(userId, poolId, name, sha256(token), now())
  return { ok: true, id: Number(r.lastInsertRowid), token }
}

export function regenerateWorkerToken(db: Db, userId: number, id: number): string | null {
  if (!getWorker(db, userId, id)) return null
  const token = newWorkerToken()
  db.prepare('UPDATE workers SET token_hash = ? WHERE id = ? AND user_id = ?').run(sha256(token), id, userId)
  return token
}

export function setWorkerPool(db: Db, userId: number, id: number, poolId: number | null): boolean {
  if (poolId !== null && !getPool(db, userId, poolId)) return false
  return Number(db.prepare('UPDATE workers SET pool_id = ? WHERE id = ? AND user_id = ?').run(poolId, id, userId).changes) > 0
}

export const deleteWorker = (db: Db, userId: number, id: number) =>
  Number(db.prepare('DELETE FROM workers WHERE id = ? AND user_id = ?').run(id, userId).changes) > 0

// Authentification d'un Worker qui se connecte : par le hash de son jeton.
export function findWorkerByToken(db: Db, token: string): { id: number; user_id: number; name: string; pool_id: number | null } | undefined {
  if (typeof token !== 'string' || token.length < 20 || token.length > 200) return undefined
  return db.prepare('SELECT id, user_id, name, pool_id FROM workers WHERE token_hash = ?').get(sha256(token)) as unknown as
    { id: number; user_id: number; name: string; pool_id: number | null } | undefined
}

// Ce qu'un Worker declare n'est jamais pris tel quel : forme, longueurs et nombre sont verifies avant stockage / affichage.
export function sanitizeCapabilities(input: unknown): Capability[] {
  if (!Array.isArray(input)) return []
  const out: Capability[] = []
  for (const c of input.slice(0, 30)) {
    if (!c || typeof c !== 'object') continue
    const { id, label, version } = c as Record<string, unknown>
    if (typeof id !== 'string' || !/^[a-z0-9_-]{1,32}$/.test(id) || out.some((o) => o.id === id)) continue
    out.push({
      id,
      label: typeof label === 'string' && label.trim() ? label.trim().slice(0, 40) : id,
      version: typeof version === 'string' && /^[\w.+-]{1,40}$/.test(version) ? version : null,
    })
  }
  return out
}

export function setWorkerCapabilities(db: Db, id: number, caps: unknown) {
  const row = db.prepare('SELECT info_json FROM workers WHERE id = ?').get(id) as { info_json: string } | undefined
  if (!row) return
  let info: Record<string, unknown> = {}
  try { info = JSON.parse(row.info_json) as Record<string, unknown> } catch { /* illisible */ }
  info.capabilities = sanitizeCapabilities(caps)
  db.prepare('UPDATE workers SET info_json = ? WHERE id = ?').run(JSON.stringify(info).slice(0, 8000), id)
}

export function touchWorker(db: Db, id: number, info?: Record<string, unknown>) {
  if (info) db.prepare('UPDATE workers SET last_seen_at = ?, info_json = ? WHERE id = ?').run(now(), JSON.stringify(info).slice(0, 8000), id)
  else db.prepare('UPDATE workers SET last_seen_at = ? WHERE id = ?').run(now(), id)
}

// --- taches ------------------------------------------------------------------------------------------------------------------
type JobRow = Omit<Job, 'payload' | 'result' | 'requires'> & { payload_json: string; result_json: string | null; requires: string | null }
const toJob = (r: JobRow): Job => {
  const { payload_json, result_json, ...rest } = r
  const parse = (t: string | null) => { if (t === null) return null; try { return JSON.parse(t) as unknown } catch { return null } }
  return { ...rest, requires: (r.requires ?? '').split(',').filter(Boolean), payload: parse(payload_json), result: parse(result_json) }
}
const JOB_SELECT = `SELECT j.id, j.user_id, j.kind, j.payload_json, j.target_worker_id, j.target_pool_id, j.worker_id, w.name AS worker_name,
  j.requires, j.status, j.result_json, j.error, j.created_at, j.started_at, j.finished_at FROM jobs j LEFT JOIN workers w ON w.id = j.worker_id`

export const getJob = (db: Db, userId: number, id: number) => {
  const r = db.prepare(`${JOB_SELECT} WHERE j.id = ? AND j.user_id = ?`).get(id, userId) as unknown as JobRow | undefined
  return r ? toJob(r) : undefined
}
export const listJobs = (db: Db, userId: number, limit = 20) =>
  (db.prepare(`${JOB_SELECT} WHERE j.user_id = ? ORDER BY j.id DESC LIMIT ?`).all(userId, limit) as unknown as JobRow[]).map(toJob)
export const queuedJobs = (db: Db, userId?: number) =>
  (db.prepare(`${JOB_SELECT} WHERE j.status = 'queued' ${userId === undefined ? '' : 'AND j.user_id = ?'} ORDER BY j.id`).all(...(userId === undefined ? [] : [userId])) as unknown as JobRow[]).map(toJob)

export function insertJob(db: Db, userId: number, kind: string, payload: unknown, target: { workerId?: number | null; poolId?: number | null; requires?: string[] } = {}): number {
  const requires = (target.requires ?? []).filter((x) => /^[a-z0-9_-]{1,32}$/.test(x))
  const r = db.prepare(
    `INSERT INTO jobs (user_id, kind, payload_json, target_worker_id, target_pool_id, requires, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'queued', ?)`,
  ).run(userId, kind, JSON.stringify(payload ?? {}).slice(0, 32_000), target.workerId ?? null, target.poolId ?? null, requires.length ? requires.join(',') : null, now())
  return Number(r.lastInsertRowid)
}

export const markJobRunning = (db: Db, jobId: number, workerId: number) => {
  db.prepare(`UPDATE jobs SET status = 'running', worker_id = ?, started_at = ? WHERE id = ? AND status = 'queued'`).run(workerId, now(), jobId)
}

const MAX_RESULT = 64_000
export function finishJob(db: Db, jobId: number, status: Exclude<JobStatus, 'queued' | 'running'>, result?: unknown, error?: string) {
  let json = result === undefined ? null : JSON.stringify(result)
  if (json && json.length > MAX_RESULT) json = JSON.stringify({ truncated: true, preview: json.slice(0, MAX_RESULT - 100) })
  db.prepare(`UPDATE jobs SET status = ?, result_json = ?, error = ?, finished_at = ? WHERE id = ? AND status IN ('queued', 'running')`)
    .run(status, json, error ? error.slice(0, 2000) : null, now(), jobId)
}

export const runningJobOf = (db: Db, workerId: number) =>
  db.prepare(`SELECT id, user_id FROM jobs WHERE worker_id = ? AND status = 'running'`).get(workerId) as unknown as { id: number; user_id: number } | undefined

const MAX_EVENTS_PER_JOB = 500
const MAX_TEXT: Record<EventKind, number> = { info: 2000, tool: 400, text: 6000, thinking: 8000 }
export function addJobEvent(db: Db, jobId: number, level: string, text: string, kind?: string) {
  const n = (db.prepare('SELECT COUNT(*) AS n FROM job_events WHERE job_id = ?').get(jobId) as { n: number }).n
  if (n >= MAX_EVENTS_PER_JOB) return
  const k: EventKind = kind === 'thinking' || kind === 'tool' || kind === 'text' ? kind : 'info'
  db.prepare('INSERT INTO job_events (job_id, at, level, text, kind) VALUES (?, ?, ?, ?, ?)')
    .run(jobId, now(), ['info', 'warn', 'error'].includes(level) ? level : 'info', String(text).slice(0, MAX_TEXT[k]), k)
}
export const listJobEvents = (db: Db, jobId: number, limit = 500) =>
  (db.prepare('SELECT id, at, level, text, kind FROM job_events WHERE job_id = ? ORDER BY id LIMIT ?').all(jobId, limit) as unknown as (Omit<JobEvent, 'kind'> & { kind: EventKind | null })[])
    .map((e) => ({ ...e, kind: e.kind ?? 'info' }))

// Au redemarrage du Host plus aucun Worker n'est connecte : les taches « en cours » ne peuvent plus aboutir.
export function failOrphanedJobs(db: Db): number {
  const r = db.prepare(`UPDATE jobs SET status = 'failed', error = 'Le Host a redemarre pendant la tache.', finished_at = ? WHERE status = 'running'`).run(now())
  return Number(r.changes)
}
