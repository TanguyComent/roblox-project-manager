// Apercus d'interface : paquets statiques de l'emulateur d'UI, deposes par un Worker (POST /api/worker/previews) et servis dans un cadre isole du chat.
// Ils contiennent du code produit par une IA : tout est verifie a l'entree (chemins, extensions, tailles) et ils ne sont jamais servis avec des droits du site.
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { config } from './config.ts'
import type { Db } from './db.ts'

export const VIEWPORTS = ['UI Labs', 'Desktop', 'Tablette', 'Telephone'] as const
export const ROOTS = ['project', 'sandbox'] as const // d'ou vient la story : le projet, ou l'atelier du chat
export const MAX_FILES = 300
export const MAX_FILE_BYTES = 6 * 1024 * 1024
export const MAX_TOTAL_BYTES = 12 * 1024 * 1024
export const MAX_USER_BYTES = 500 * 1024 * 1024
export const MAX_PREVIEWS_PER_JOB = 6

// Ce qu'un paquet de l'emulateur contient : pages, scripts, styles, images, polices. Rien d'autre (pas de .php, .exe, .svg actif...).
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.map': 'application/json; charset=utf-8',
}
const ID = /^[0-9a-f]{32}$/
const PATH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/

export interface PreviewRow {
  id: string; job_id: number; n: number; title: string; file: string; viewport: string; root: 'project' | 'sandbox'; ok: boolean; error: string | null
  checked: boolean; nodes: number; errors: string[]; missing: string[]; bytes: number
}

const dirOf = (id: string) => join(resolve(config.dataDir), 'previews', id)

export const isPreviewId = (id: string) => ID.test(id)

/** Chemin de fichier d'un paquet : relatif, sans « .. » ni segment cache, extension connue. null si refuse. */
export function safePath(p: unknown): string | null {
  if (typeof p !== 'string' || !PATH.test(p) || p.includes('..') || p.includes('//') || p.endsWith('/')) return null
  if (p.split('/').some((s) => s.startsWith('.'))) return null
  return Object.hasOwn(TYPES, extOf(p)) ? p : null
}
const extOf = (p: string) => { const i = p.lastIndexOf('.'); return i < 0 ? '' : p.slice(i).toLowerCase() }

export interface UploadBody {
  jobId: unknown; n: unknown; title: unknown; file: unknown; viewport: unknown; root?: unknown; ok: unknown; error: unknown
  checked: unknown; nodes: unknown; errors: unknown; missing: unknown; files: unknown
}

const strings = (v: unknown, max: number, len: number) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, max).map((x) => x.slice(0, len)) : [])

export class PreviewError extends Error {
  status: 400 | 403 | 413
  constructor(message: string, status: 400 | 403 | 413 = 400) { super(message); this.status = status }
}

/**
 * Enregistre l'apercu d'un bloc. Le Worker ne peut deposer que pour SA tache en cours (et pour son utilisateur) ; un depot pour le meme bloc remplace le precedent
 * (passe de correction automatique).
 */
export function savePreview(db: Db, worker: { id: number; user_id: number }, body: UploadBody): string {
  const jobId = Number(body.jobId)
  const job = Number.isInteger(jobId) ? (db.prepare("SELECT id, user_id, worker_id, status FROM jobs WHERE id = ?").get(jobId) as { id: number; user_id: number; worker_id: number | null; status: string } | undefined) : undefined
  if (!job || job.user_id !== worker.user_id || job.worker_id !== worker.id || job.status !== 'running') throw new PreviewError("Ce Worker n'execute pas cette tache.", 403)
  const n = Number(body.n)
  if (!Number.isInteger(n) || n < 0 || n >= MAX_PREVIEWS_PER_JOB + 4) throw new PreviewError('Rang de bloc invalide.')
  const viewport = typeof body.viewport === 'string' && (VIEWPORTS as readonly string[]).includes(body.viewport) ? body.viewport : 'UI Labs'
  const root = body.root === 'sandbox' ? 'sandbox' : 'project'
  const title = typeof body.title === 'string' ? body.title.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 80) : ''
  const file = typeof body.file === 'string' ? body.file.replace(/[\u0000-\u001f]/g, ' ').slice(0, 300) : ''
  const ok = body.ok === true
  const error = typeof body.error === 'string' ? body.error.slice(0, 1000) : null

  // fichiers : tous valides, taille bornee, index.html present pour un apercu reussi
  const rawFiles = Array.isArray(body.files) ? body.files : []
  if (rawFiles.length > MAX_FILES) throw new PreviewError('Trop de fichiers dans le paquet.', 413)
  const files: { path: string; data: Buffer }[] = []
  let total = 0
  for (const f of rawFiles) {
    const rec = (f ?? {}) as { path?: unknown; data?: unknown }
    const p = safePath(rec.path)
    if (!p || typeof rec.data !== 'string') throw new PreviewError(`Fichier refuse : ${String(rec.path).slice(0, 80)}`)
    const data = Buffer.from(rec.data, 'base64')
    if (data.length > MAX_FILE_BYTES) throw new PreviewError(`Fichier trop gros : ${p}`, 413)
    total += data.length
    if (total > MAX_TOTAL_BYTES) throw new PreviewError('Apercu trop gros.', 413)
    files.push({ path: p, data })
  }
  if (new Set(files.map((f) => f.path)).size !== files.length) throw new PreviewError('Fichiers en double.')
  if (ok && !files.some((f) => f.path === 'index.html')) throw new PreviewError('index.html manquant.')
  if (!ok && files.length) throw new PreviewError("Un apercu en echec ne contient pas de fichiers.")
  const used = (db.prepare('SELECT COALESCE(SUM(bytes), 0) AS b FROM previews WHERE user_id = ?').get(worker.user_id) as { b: number }).b
  if (used + total > MAX_USER_BYTES) throw new PreviewError("Espace d'apercus plein : supprime d'anciens chats.", 413)

  const old = db.prepare('SELECT id FROM previews WHERE job_id = ? AND n = ?').get(jobId, n) as { id: string } | undefined
  if (old) { rmSync(dirOf(old.id), { recursive: true, force: true }); db.prepare('DELETE FROM previews WHERE id = ?').run(old.id) }

  const id = randomBytes(16).toString('hex')
  if (files.length) {
    const root = dirOf(id)
    for (const f of files) {
      const target = resolve(root, f.path)
      if (!target.startsWith(root + sep)) throw new PreviewError('Chemin refuse.') // (deja exclu par safePath : double garde)
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, f.data)
    }
  }
  db.prepare(
    `INSERT INTO previews (id, user_id, job_id, n, title, file, viewport, root, ok, error, checked, nodes, errors_json, missing_json, bytes, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, worker.user_id, jobId, n, title, file, viewport, root, ok ? 1 : 0, error, body.checked === true ? 1 : 0, Math.max(0, Math.min(1e6, Number(body.nodes) || 0)),
    JSON.stringify(strings(body.errors, 5, 300)), JSON.stringify(strings(body.missing, 20, 120)), total, Date.now())
  return id
}

type Row = Omit<PreviewRow, 'ok' | 'checked' | 'errors' | 'missing'> & { ok: number; checked: number; errors_json: string; missing_json: string }
const toRow = (r: Row): PreviewRow => {
  const parse = (t: string) => { try { return JSON.parse(t) as string[] } catch { return [] } }
  const { errors_json, missing_json, ...rest } = r
  return { ...rest, ok: !!r.ok, checked: !!r.checked, errors: parse(errors_json), missing: parse(missing_json) }
}

/** Apercus des taches donnees (un chat affiche ceux de ses reponses), regroupes par tache. */
export function previewsForJobs(db: Db, jobIds: number[]): Map<number, PreviewRow[]> {
  const out = new Map<number, PreviewRow[]>()
  if (!jobIds.length) return out
  const rows = db.prepare(`SELECT id, job_id, n, title, file, viewport, root, ok, error, checked, nodes, errors_json, missing_json, bytes FROM previews WHERE job_id IN (${jobIds.map(() => '?').join(',')}) ORDER BY n`).all(...jobIds) as unknown as Row[]
  for (const r of rows) {
    if (!out.has(r.job_id)) out.set(r.job_id, [])
    out.get(r.job_id)!.push(toRow(r))
  }
  return out
}

/** Fichier d'un apercu a servir (null : inconnu). L'identifiant doit exister en base ET le chemin etre sur. */
export function previewFile(db: Db, id: string, path: string): { data: Buffer; type: string } | null {
  if (!ID.test(id)) return null
  const p = safePath(path)
  if (!p) return null
  if (!db.prepare('SELECT 1 FROM previews WHERE id = ? AND ok = 1').get(id)) return null
  const root = dirOf(id)
  const target = resolve(root, p)
  if (!target.startsWith(root + sep) || !existsSync(target) || !statSync(target).isFile()) return null
  return { data: readFileSync(target), type: TYPES[extOf(p)] }
}

/** Supprime les apercus (lignes et fichiers) des taches donnees : suppression d'un chat. */
export function deletePreviewsOfJobs(db: Db, jobIds: number[]) {
  if (!jobIds.length) return
  const rows = db.prepare(`SELECT id FROM previews WHERE job_id IN (${jobIds.map(() => '?').join(',')})`).all(...jobIds) as unknown as { id: string }[]
  for (const r of rows) rmSync(dirOf(r.id), { recursive: true, force: true })
  db.prepare(`DELETE FROM previews WHERE job_id IN (${jobIds.map(() => '?').join(',')})`).run(...jobIds)
}
