// Bibliotheque d'images de l'utilisateur. Le HOST est la source de verite : fichiers dans DATA_DIR/library/<id>, metadonnees en base.
//
// Une image ajoutee est « en attente » (visible, pas triee). Quand l'utilisateur demande le tri, toutes les images en attente partent vers un agent (Claude sur un Worker)
// qui leur donne un nom, une courte description, des mots-cles et un dossier : les images passent a « triee ». Le « vault » Obsidian (dossiers + notes Markdown) est
// DERIVE de ces donnees : le Worker le reconstruit a la demande pour que l'agent voie l'organisation existante.
//
// SECURITE : seules les images PNG / JPEG / WebP / GIF verifiees par leurs octets sont acceptees (pas de SVG) ; tout ce que renvoie l'agent est revalide ici
// (dossiers, noms, descriptions, mots-cles) avant d'etre enregistre : l'agent lit des images qui peuvent contenir du texte hostile.
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { cleanName, isInline, sniff } from './attachments.ts'
import { config } from './config.ts'
import type { Db } from './db.ts'
import type { WorkerHub } from './worker-hub.ts'
import { getJob } from './workers.ts'

export type LibraryStatus = 'pending' | 'sorting' | 'sorted'

export interface LibraryImage {
  id: string; user_id: number; file_name: string; title: string; folder: string; description: string; tags: string
  status: LibraryStatus; mime: string; size: number; sha256: string; sort_job_id: number | null
  source: 'upload' | 'generated'; roblox_status: 'unpublished' | 'publishing' | 'published' | 'failed'; roblox_asset_id: string | null
  created_at: number; sorted_at: number | null
}

export const SORT_BATCH = 40
export const SORT_REQUIRES = ['claude']
const ID = /^[0-9a-f]{32}$/
export const isLibraryId = (v: unknown): v is string => typeof v === 'string' && ID.test(v)

const dir = () => join(resolve(config.dataDir), 'library')
const fileOf = (id: string) => join(dir(), id)

export class LibraryError extends Error {
  status: 400 | 404 | 409 | 413
  constructor(message: string, status: 400 | 404 | 409 | 413 = 400) { super(message); this.status = status }
}

// --- valeurs saisies par l'utilisateur ou proposees par l'agent : toujours nettoyees ----------------------------------------------------------

const slug = (s: string, max: number) =>
  s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, max).replace(/-+$/, '')

/** Dossier du vault : 1 a 3 niveaux, minuscules, chiffres et tirets (« icons/shop »). Vide : « divers ». */
export function cleanFolder(raw: unknown): string {
  const parts = (typeof raw === 'string' ? raw : '').split(/[\\/]+/).map((p) => slug(p, 32)).filter(Boolean).slice(0, 3)
  return parts.join('/') || 'divers'
}
/** Nom de la note (et de l'image) dans le vault. */
export function cleanTitle(raw: unknown, fallback = 'image'): string {
  const t = slug((typeof raw === 'string' ? raw : '').replace(/\.[a-z0-9]{2,5}$/i, ''), 60)
  return t || slug(fallback.replace(/\.[a-z0-9]{2,5}$/i, ''), 60) || 'image'
}
export function cleanDescription(raw: unknown): string {
  return (typeof raw === 'string' ? raw : '').replace(/[\u0000-\u001f\u007f‪-‮⁦-⁩]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300)
}
/** Mots-cles : 8 au plus, 30 caracteres, minuscules, sans doublon. Stockes separes par des virgules. */
export function cleanTags(raw: unknown): string {
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(/[,;\n]/) : []
  const out: string[] = []
  for (const t of list) {
    const s = typeof t === 'string' ? slug(t, 30) : ''
    if (s && !out.includes(s)) out.push(s)
    if (out.length >= 8) break
  }
  return out.join(',')
}

/** Rend le titre unique dans son dossier (« icone », « icone-2 », ...). */
function uniqueTitle(db: Db, userId: number, folder: string, title: string, exceptId: string | null): string {
  const taken = new Set((db.prepare("SELECT title FROM library_images WHERE user_id = ? AND folder = ? AND status = 'sorted' AND id != ?").all(userId, folder, exceptId ?? '') as unknown as { title: string }[]).map((r) => r.title))
  if (!taken.has(title)) return title
  for (let n = 2; ; n++) { const t = `${title.slice(0, 56)}-${n}`; if (!taken.has(t)) return t }
}

// --- lecture ----------------------------------------------------------------------------------------------------------------------------

const COLS = 'id, user_id, file_name, title, folder, description, tags, status, mime, size, sha256, sort_job_id, source, roblox_status, roblox_asset_id, created_at, sorted_at'

export const listImages = (db: Db, userId: number) =>
  db.prepare(`SELECT ${COLS} FROM library_images WHERE user_id = ? ORDER BY CASE status WHEN 'sorted' THEN 1 ELSE 0 END, folder, title, created_at DESC, id`).all(userId) as unknown as LibraryImage[]

export const getImage = (db: Db, userId: number, id: string) =>
  isLibraryId(id) ? (db.prepare(`SELECT ${COLS} FROM library_images WHERE id = ? AND user_id = ?`).get(id, userId) as unknown as LibraryImage | undefined) : undefined

export const imageCounts = (db: Db, userId: number) => {
  const rows = db.prepare('SELECT status, COUNT(*) AS n FROM library_images WHERE user_id = ? GROUP BY status').all(userId) as unknown as { status: LibraryStatus; n: number }[]
  const c = { pending: 0, sorting: 0, sorted: 0 }
  for (const r of rows) c[r.status] = r.n
  return c
}

export function readImage(id: string): Buffer | null {
  if (!isLibraryId(id)) return null
  return existsSync(fileOf(id)) ? readFileSync(fileOf(id)) : null
}

// --- ajout, modification, suppression ---------------------------------------------------------------------------------------------------

/** Ajoute une image (« en attente »). Toutes les limites sont verifiees ici. `source` : `generated` pour une image creee par une IA. */
export function addImage(db: Db, userId: number, rawName: unknown, data: Buffer, source: 'upload' | 'generated' = 'upload'): LibraryImage {
  const l = config.library
  if (data.length > l.maxFile) throw new LibraryError(`Image trop grosse (${Math.round(l.maxFile / 1048576)} Mo maximum).`, 413)
  const name = cleanName(rawName)
  const s = sniff(data, name)
  if (!s.ok) throw new LibraryError(s.error)
  if (s.kind !== 'image' || !isInline({ kind: s.kind, mime: s.mime })) throw new LibraryError('Seules les images PNG, JPEG, WebP et GIF sont acceptees.')
  const t = db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS b FROM library_images WHERE user_id = ?').get(userId) as { n: number; b: number }
  if (t.n >= l.maxImages) throw new LibraryError(`Bibliotheque pleine (${l.maxImages} images maximum).`, 413)
  if (t.b + data.length > l.userQuota) throw new LibraryError('Espace de la bibliotheque plein : supprime des images.', 413)
  const id = randomBytes(16).toString('hex')
  mkdirSync(dir(), { recursive: true })
  writeFileSync(fileOf(id), data)
  const row: LibraryImage = {
    id, user_id: userId, file_name: name, title: cleanTitle(name), folder: '', description: '', tags: '', status: 'pending', mime: s.mime, size: data.length,
    sha256: createHash('sha256').update(data).digest('hex'), sort_job_id: null, source, roblox_status: 'unpublished', roblox_asset_id: null, created_at: Date.now(), sorted_at: null,
  }
  db.prepare(`INSERT INTO library_images (${COLS}) VALUES (?, ?, ?, ?, '', '', '', 'pending', ?, ?, ?, NULL, ?, 'unpublished', NULL, ?, NULL)`)
    .run(id, userId, row.file_name, row.title, row.mime, row.size, row.sha256, source, row.created_at)
  return row
}

/** Modification a la main (nom, dossier, description, mots-cles). Une image en cours de tri ne peut pas etre modifiee. */
export function editImage(db: Db, userId: number, id: string, f: { title?: unknown; folder?: unknown; description?: unknown; tags?: unknown }): LibraryImage {
  const img = getImage(db, userId, id)
  if (!img) throw new LibraryError('Image introuvable.', 404)
  if (img.status === 'sorting') throw new LibraryError('Cette image est en cours de tri.', 409)
  const folder = img.status === 'sorted' || f.folder ? cleanFolder(f.folder ?? img.folder) : ''
  const title = img.status === 'sorted' ? uniqueTitle(db, userId, folder, cleanTitle(f.title, img.file_name), id) : cleanTitle(f.title, img.file_name)
  db.prepare('UPDATE library_images SET title = ?, folder = ?, description = ?, tags = ? WHERE id = ?').run(title, folder, cleanDescription(f.description ?? img.description), cleanTags(f.tags ?? img.tags), id)
  return getImage(db, userId, id)!
}

export function deleteImage(db: Db, userId: number, id: string): boolean {
  const img = getImage(db, userId, id)
  if (!img) return false
  if (img.status === 'sorting') throw new LibraryError('Cette image est en cours de tri.', 409)
  rmSync(fileOf(id), { force: true })
  db.prepare('DELETE FROM library_images WHERE id = ?').run(id)
  return true
}

// --- tri par un agent --------------------------------------------------------------------------------------------------------------------

/** Ce que l'agent voit de l'organisation existante : dossiers et un resume des images deja triees (borne : la tache a une taille maximale). */
function vaultSummary(db: Db, userId: number) {
  const sorted = db.prepare("SELECT folder, title, description, tags FROM library_images WHERE user_id = ? AND status = 'sorted' ORDER BY folder, title").all(userId) as unknown as { folder: string; title: string; description: string; tags: string }[]
  const folders = [...new Set(sorted.map((r) => r.folder))]
  const items: { folder: string; title: string; description: string }[] = []
  let budget = 12_000
  for (const r of sorted) {
    const it = { folder: r.folder, title: r.title, description: r.description.slice(0, 70) }
    const size = JSON.stringify(it).length
    if (size > budget) break
    budget -= size
    items.push(it)
  }
  return { folders, items, total: sorted.length }
}

/** Envoie les images en attente (40 au plus par tache) a un agent. */
export function startSort(db: Db, hub: WorkerHub, userId: number): { jobId: number; count: number } {
  if (db.prepare("SELECT 1 FROM library_images WHERE user_id = ? AND status = 'sorting'").get(userId)) throw new LibraryError('Un tri est deja en cours.', 409)
  const pending = db.prepare("SELECT id, file_name, mime, size, sha256 FROM library_images WHERE user_id = ? AND status = 'pending' ORDER BY created_at, id LIMIT ?").all(userId, SORT_BATCH) as unknown as { id: string; file_name: string; mime: string; size: number; sha256: string }[]
  if (!pending.length) throw new LibraryError('Aucune image en attente.', 409)
  const jobId = hub.enqueue(userId, 'library.sort', {
    images: pending.map((p) => ({ id: p.id, name: p.file_name, mime: p.mime, size: p.size, sha256: p.sha256 })),
    vault: vaultSummary(db, userId),
  }, { requires: SORT_REQUIRES })
  db.prepare(`UPDATE library_images SET status = 'sorting', sort_job_id = ? WHERE id IN (${pending.map(() => '?').join(',')})`).run(jobId, ...pending.map((p) => p.id))
  return { jobId, count: pending.length }
}

export const sortingJobIds = (db: Db, userId: number) =>
  (db.prepare("SELECT DISTINCT sort_job_id AS j FROM library_images WHERE user_id = ? AND status = 'sorting' AND sort_job_id IS NOT NULL").all(userId) as unknown as { j: number }[]).map((r) => r.j)

/** Arrete les taches de tri en cours de l'utilisateur. */
export function cancelSortJobs(db: Db, hub: WorkerHub, userId: number) {
  for (const j of sortingJobIds(db, userId)) hub.cancel(userId, j)
}

/** Annule un tri en cours : les images reviennent « en attente ». */
export function resetSorting(db: Db, userId: number, jobId?: number) {
  db.prepare("UPDATE library_images SET status = 'pending', sort_job_id = NULL WHERE user_id = ? AND status = 'sorting' AND (? IS NULL OR sort_job_id = ?)").run(userId, jobId ?? null, jobId ?? null)
}

/** Reporte le resultat des taches de tri terminees (appelee a l'ouverture de la page et pendant son suivi en direct). */
export function syncLibrary(db: Db, userId: number): { error: string | null } {
  let error: string | null = null
  for (const jobId of sortingJobIds(db, userId)) {
    const job = getJob(db, userId, jobId)
    if (!job) { resetSorting(db, userId, jobId); continue }
    if (job.status === 'queued' || job.status === 'running') continue
    if (job.status === 'succeeded') applySort(db, userId, jobId, job.result)
    else { resetSorting(db, userId, jobId); error = job.status === 'cancelled' ? 'Tri annule.' : `Le tri a echoue : ${String(job.error ?? 'erreur inconnue').slice(0, 300)}` }
  }
  return { error }
}

/** Applique ce que l'agent a decide. Tout est revalide ; une image sans proposition valable reste « en attente ». */
export function applySort(db: Db, userId: number, jobId: number, result: unknown) {
  const list = (result && typeof result === 'object' ? (result as { sorted?: unknown }).sorted : undefined)
  const decided = new Set<string>()
  if (Array.isArray(list)) {
    for (const e of list.slice(0, SORT_BATCH * 2)) {
      if (!e || typeof e !== 'object') continue
      const o = e as Record<string, unknown>
      if (!isLibraryId(o.id) || decided.has(o.id)) continue
      const img = getImage(db, userId, o.id)
      if (!img || img.status !== 'sorting' || img.sort_job_id !== jobId) continue
      const description = cleanDescription(o.description)
      if (!description) continue // sans description l'image ne serait pas retrouvable : elle reste en attente
      const folder = cleanFolder(o.folder)
      const title = uniqueTitle(db, userId, folder, cleanTitle(o.title, img.file_name), img.id)
      db.prepare("UPDATE library_images SET status = 'sorted', sort_job_id = NULL, folder = ?, title = ?, description = ?, tags = ?, sorted_at = ? WHERE id = ?")
        .run(folder, title, description, cleanTags(o.tags), Date.now(), img.id)
      decided.add(img.id)
    }
  }
  resetSorting(db, userId, jobId) // les images restantes retournent en attente
}

/** Fichiers supprimes avec le compte (appele avant la suppression de l'utilisateur). */
export function deleteUserLibrary(db: Db, userId: number) {
  for (const r of db.prepare('SELECT id FROM library_images WHERE user_id = ?').all(userId) as unknown as { id: string }[]) rmSync(fileOf(r.id), { force: true })
  db.prepare('DELETE FROM library_images WHERE user_id = ?').run(userId)
}

// --- recherche (outils des agents d'UI) -------------------------------------------------------------------------------------------------

const norm = (s: string) => s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
const words = (s: string) => norm(s).split(/[^a-z0-9]+/).filter(Boolean)

export interface SearchHit {
  id: string; folder: string; title: string; description: string; tags: string[]; mime: string; size: number; sha256: string
  roblox_status: LibraryImage['roblox_status']; roblox_asset_id: string | null
}

/** Images TRIEES de l'utilisateur correspondant a la recherche (mots de la requete compares au nom, aux mots-cles, au dossier et a la description), les meilleures d'abord. */
export function searchImages(db: Db, userId: number, o: { query?: string; folder?: string; id?: string; limit?: number }): SearchHit[] {
  const limit = Math.max(1, Math.min(o.limit ?? 20, 50))
  let rows = db.prepare(`SELECT ${COLS} FROM library_images WHERE user_id = ? AND status = 'sorted' ORDER BY folder, title`).all(userId) as unknown as LibraryImage[]
  if (o.id) rows = rows.filter((r) => r.id === o.id)
  if (o.folder) { const f = cleanFolder(o.folder); rows = rows.filter((r) => r.folder === f || r.folder.startsWith(`${f}/`)) }
  const q = words(o.query ?? '')
  let scored = rows.map((r) => ({ r, score: 0 }))
  if (q.length) {
    scored = scored.map(({ r }) => {
      const title = words(r.title), tags = r.tags.split(',').filter(Boolean), folder = words(r.folder), desc = words(r.description)
      let score = 0
      for (const w of q) {
        if (tags.includes(w) || title.includes(w)) score += 4
        else if (title.some((t) => t.includes(w)) || tags.some((t) => t.includes(w))) score += 2
        if (folder.some((t) => t === w || t.startsWith(w))) score += 2
        if (desc.some((t) => t === w || t.startsWith(w))) score += 1
      }
      return { r, score }
    }).filter((x) => x.score > 0).sort((a, b) => b.score - a.score)
  }
  return scored.slice(0, limit).map(({ r }) => ({
    id: r.id, folder: r.folder, title: r.title, description: r.description, tags: r.tags ? r.tags.split(',') : [], mime: r.mime, size: r.size, sha256: r.sha256,
    roblox_status: r.roblox_status, roblox_asset_id: r.roblox_asset_id,
  }))
}
