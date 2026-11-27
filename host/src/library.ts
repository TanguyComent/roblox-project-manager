// Bibliotheque d'images de l'utilisateur. Le HOST est la source de verite : fichiers dans DATA_DIR/library/<id>, metadonnees en base.
//
// Une image ajoutee est « en attente » (visible, pas triee). Quand l'utilisateur demande le tri, toutes les images en attente partent vers un agent (Claude sur un Worker)
// qui les decrit par FACETTES : scope (dans quelle situation on s'en sert : icon, decoration, background...), style (nom + traits : cartoon, contours-epais, saturee...),
// sujet (ce qu'elle represente, normalise : pendule, poubelle...), couleurs, mini-description et mots-cles. Le ratio vient des octets du fichier, pas de l'agent.
// Les facettes servent a retrouver des images par scope, par style (coherence visuelle d'un ecran) ou par sujet, independamment les unes des autres.
// Le « vault » Obsidian (une note par image, des notes pivots par style) est DERIVE de ces donnees : le Worker le reconstruit pour que l'agent voie l'existant.
//
// SECURITE : seules les images PNG / JPEG / WebP / GIF verifiees par leurs octets sont acceptees (pas de SVG) ; tout ce que renvoie l'agent est revalide ici
// (valeurs nettoyees, longueurs bornees) avant d'etre enregistre : l'agent lit des images qui peuvent contenir du texte hostile.
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
  scope: string; style: string; traits: string; subject: string; colors: string; width: number; height: number; origin: string
  status: LibraryStatus; mime: string; size: number; sha256: string; sort_job_id: number | null
  source: 'upload' | 'generated'; roblox_status: 'unpublished' | 'publishing' | 'published' | 'failed'; roblox_asset_id: string | null
  created_at: number; sorted_at: number | null
}

export const SORT_BATCH = 40
export const SORT_REQUIRES = ['claude']
/** Points de depart des vocabulaires : l'agent les reutilise et n'en ajoute un que s'il manque vraiment. */
export const SEED_SCOPES = ['icon', 'decoration', 'background', 'character', 'button', 'logo', 'effect', 'texture']
export const SEED_TRAITS = ['flat', 'cartoon', 'pixel-art', 'dessine-main', 'realiste', '3d', 'isometrique', 'contours-epais', 'contours-fins', 'sans-contour', 'saturee', 'pastel', 'sombre', 'monochrome', 'neon']
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
const list = (raw: unknown): unknown[] => (Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(/[,;\n]/) : [])
const slugList = (raw: unknown, max: number, each: number): string => {
  const out: string[] = []
  for (const t of list(raw)) {
    const s = typeof t === 'string' ? slug(t, each) : ''
    if (s && !out.includes(s)) out.push(s)
    if (out.length >= max) break
  }
  return out.join(',')
}

/** Dossier du vault : 1 a 3 niveaux, minuscules, chiffres et tirets. Vide : « divers ». */
export function cleanFolder(raw: unknown): string {
  const parts = (typeof raw === 'string' ? raw : '').split(/[\\/]+/).map((p) => slug(p, 32)).filter(Boolean).slice(0, 3)
  return parts.join('/') || 'divers'
}
/** Scope : la situation d'usage (un seul mot ou tiret : icon, decoration...). Il donne aussi le dossier du vault. */
export const cleanScope = (raw: unknown): string => slug(typeof raw === 'string' ? raw : '', 32) || 'divers'
/** Style : nom court reutilise d'une image a l'autre (« cartoon-contour-epais »). Vide : pas de style defini. */
export const cleanStyle = (raw: unknown): string => slug(typeof raw === 'string' ? raw : '', 40)
/** Traits du style (vocabulaire court), 6 au plus. */
export const cleanTraits = (raw: unknown): string => slugList(raw, 6, 24)
/** Sujet normalise (« pendule », « poubelle ») : ce que l'image represente, independamment de son style. */
export const cleanSubject = (raw: unknown): string => slug(typeof raw === 'string' ? raw : '', 40)
/** Couleurs dominantes : 4 au plus, noms normalises (« rouge », « bleu-nuit »). */
export const cleanColors = (raw: unknown): string => slugList(raw, 4, 20)
export const cleanOrigin = (raw: unknown): string => (typeof raw === 'string' ? raw : '').replace(/[\u0000-\u001f\u007f‪-‮⁦-⁩]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60)
/** Nom de la note (et de l'image) dans le vault. */
export function cleanTitle(raw: unknown, fallback = 'image'): string {
  const t = slug((typeof raw === 'string' ? raw : '').replace(/\.[a-z0-9]{2,5}$/i, ''), 60)
  return t || slug(fallback.replace(/\.[a-z0-9]{2,5}$/i, ''), 60) || 'image'
}
/** Mini-description : une phrase courte. */
export function cleanDescription(raw: unknown): string {
  return (typeof raw === 'string' ? raw : '').replace(/[\u0000-\u001f\u007f‪-‮⁦-⁩]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160)
}
/** Mots-cles (synonymes, autre langue) : 8 au plus, 30 caracteres, minuscules, sans doublon. Stockes separes par des virgules. */
export const cleanTags = (raw: unknown): string => slugList(raw, 8, 30)
export const cleanDefinition = (raw: unknown): string => cleanDescription(raw).slice(0, 160)

// --- dimensions et ratio, lus dans les octets du fichier (aucun decodage d'image) ---------------------------------------------------------------

/** Largeur et hauteur d'une image PNG / JPEG / GIF / WebP, ou null. */
export function imageSize(d: Buffer): { width: number; height: number } | null {
  const ok = (w: number, h: number) => (w > 0 && h > 0 && w <= 65535 && h <= 65535 ? { width: w, height: h } : null)
  if (d.length >= 24 && d[0] === 0x89 && d[1] === 0x50) return ok(d.readUInt32BE(16), d.readUInt32BE(20))
  if (d.length >= 10 && d.toString('latin1', 0, 3) === 'GIF') return ok(d.readUInt16LE(6), d.readUInt16LE(8))
  if (d.length >= 30 && d.toString('latin1', 0, 4) === 'RIFF' && d.toString('latin1', 8, 12) === 'WEBP') {
    const kind = d.toString('latin1', 12, 16)
    if (kind === 'VP8X') return ok(1 + d.readUIntLE(24, 3), 1 + d.readUIntLE(27, 3))
    if (kind === 'VP8 ') return ok(d.readUInt16LE(26) & 0x3fff, d.readUInt16LE(28) & 0x3fff)
    if (kind === 'VP8L') { const b = d.readUInt32LE(21); return ok((b & 0x3fff) + 1, ((b >> 14) & 0x3fff) + 1) }
    return null
  }
  if (d.length > 4 && d[0] === 0xff && d[1] === 0xd8) {
    let i = 2
    while (i + 9 < d.length) {
      if (d[i] !== 0xff) { i++; continue }
      const m = d[i + 1]
      if (m === 0xff) { i++; continue }
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return ok(d.readUInt16BE(i + 7), d.readUInt16BE(i + 5))
      i += 2 + d.readUInt16BE(i + 2)
    }
  }
  return null
}

/** Famille de ratio : carre, large, haut, bandeau (tres allonge). Vide si les dimensions sont inconnues. */
export function ratioKind(w: number, h: number): string {
  if (!w || !h) return ''
  const r = w / h
  return r >= 2.6 || r <= 0.38 ? 'bandeau' : r > 1.12 ? 'large' : r < 0.89 ? 'haut' : 'carre'
}
export const RATIOS = ['carre', 'large', 'haut', 'bandeau']

/** Rend le titre unique dans son dossier (« icone », « icone-2 », ...). */
function uniqueTitle(db: Db, userId: number, folder: string, title: string, exceptId: string | null): string {
  const taken = new Set((db.prepare("SELECT title FROM library_images WHERE user_id = ? AND folder = ? AND status = 'sorted' AND id != ?").all(userId, folder, exceptId ?? '') as unknown as { title: string }[]).map((r) => r.title))
  if (!taken.has(title)) return title
  for (let n = 2; ; n++) { const t = `${title.slice(0, 56)}-${n}`; if (!taken.has(t)) return t }
}

// --- lecture ----------------------------------------------------------------------------------------------------------------------------

const COLS = 'id, user_id, file_name, title, folder, description, tags, scope, style, traits, subject, colors, width, height, origin, status, mime, size, sha256, sort_job_id, source, roblox_status, roblox_asset_id, created_at, sorted_at'

export const listImages = (db: Db, userId: number) =>
  db.prepare(`SELECT ${COLS} FROM library_images WHERE user_id = ? ORDER BY CASE status WHEN 'sorted' THEN 1 ELSE 0 END, scope, title, created_at DESC, id`).all(userId) as unknown as LibraryImage[]

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

// --- styles (definis une fois, reutilises) ------------------------------------------------------------------------------------------------

export interface StyleDef { name: string; definition: string }
export const listStyles = (db: Db, userId: number) =>
  db.prepare('SELECT name, definition FROM library_styles WHERE user_id = ? ORDER BY name').all(userId) as unknown as StyleDef[]
const ensureStyle = (db: Db, userId: number, name: string, definition: string) => {
  if (name) db.prepare('INSERT INTO library_styles (user_id, name, definition) VALUES (?, ?, ?) ON CONFLICT(user_id, name) DO NOTHING').run(userId, name, definition)
}

// --- ajout, modification, suppression ---------------------------------------------------------------------------------------------------

/** Ajoute une image (« en attente »). Toutes les limites sont verifiees ici. `source` : `generated` pour une image creee par une IA. */
export function addImage(db: Db, userId: number, rawName: unknown, data: Buffer, source: 'upload' | 'generated' = 'upload', origin = ''): LibraryImage {
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
  const dims = imageSize(data) ?? { width: 0, height: 0 }
  const sha256 = createHash('sha256').update(data).digest('hex')
  const created = Date.now()
  db.prepare(`INSERT INTO library_images (id, user_id, file_name, title, folder, description, tags, scope, style, traits, subject, colors, width, height, origin, status, mime, size, sha256, sort_job_id, source, roblox_status, roblox_asset_id, created_at, sorted_at)
    VALUES (?, ?, ?, ?, '', '', '', '', '', '', '', '', ?, ?, ?, 'pending', ?, ?, ?, NULL, ?, 'unpublished', NULL, ?, NULL)`)
    .run(id, userId, name, cleanTitle(name), dims.width, dims.height, cleanOrigin(origin), s.mime, data.length, sha256, source, created)
  return getImage(db, userId, id)!
}

export interface ImageEdit { title?: unknown; scope?: unknown; style?: unknown; traits?: unknown; subject?: unknown; colors?: unknown; description?: unknown; tags?: unknown; origin?: unknown }

/** Modification a la main. Une image en cours de tri ne peut pas etre modifiee ; une image en attente le reste. */
export function editImage(db: Db, userId: number, id: string, f: ImageEdit): LibraryImage {
  const img = getImage(db, userId, id)
  if (!img) throw new LibraryError('Image introuvable.', 404)
  if (img.status === 'sorting') throw new LibraryError('Cette image est en cours de tri.', 409)
  const sorted = img.status === 'sorted'
  const scope = f.scope !== undefined && String(f.scope).trim() !== '' ? cleanScope(f.scope) : img.scope || (sorted ? 'divers' : '')
  const folder = scope
  const title = sorted ? uniqueTitle(db, userId, folder, cleanTitle(f.title, img.file_name), id) : cleanTitle(f.title, img.file_name)
  const style = f.style !== undefined ? cleanStyle(f.style) : img.style
  const description = cleanDescription(f.description ?? img.description)
  db.prepare('UPDATE library_images SET title = ?, folder = ?, scope = ?, style = ?, traits = ?, subject = ?, colors = ?, description = ?, tags = ?, origin = ? WHERE id = ?')
    .run(title, folder, scope, style, f.traits !== undefined ? cleanTraits(f.traits) : img.traits, f.subject !== undefined ? cleanSubject(f.subject) : img.subject,
      f.colors !== undefined ? cleanColors(f.colors) : img.colors, description, f.tags !== undefined ? cleanTags(f.tags) : img.tags, f.origin !== undefined ? cleanOrigin(f.origin) : img.origin, id)
  ensureStyle(db, userId, style, '')
  return getImage(db, userId, id)!
}

/** Renomme une valeur de facette (scope, style ou sujet) sur toutes les images de l'utilisateur : fusionne aussi deux valeurs en une. */
export function renameFacet(db: Db, userId: number, facet: 'scope' | 'style' | 'subject', from: unknown, to: unknown): number {
  const clean = facet === 'scope' ? cleanScope : facet === 'style' ? cleanStyle : cleanSubject
  const a = clean(from)
  const b = clean(to)
  if (!a || !b) throw new LibraryError('Nom invalide.')
  if (a === b) return 0
  const rows = db.prepare(`SELECT id FROM library_images WHERE user_id = ? AND ${facet} = ? AND status != 'sorting'`).all(userId, a) as unknown as { id: string }[]
  for (const r of rows) {
    if (facet === 'scope') {
      const img = getImage(db, userId, r.id)!
      db.prepare('UPDATE library_images SET scope = ?, folder = ?, title = ? WHERE id = ?').run(b, b, uniqueTitle(db, userId, b, img.title, img.id), img.id)
    } else db.prepare(`UPDATE library_images SET ${facet} = ? WHERE id = ?`).run(b, r.id)
  }
  if (facet === 'style') {
    const def = db.prepare('SELECT definition FROM library_styles WHERE user_id = ? AND name = ?').get(userId, a) as { definition: string } | undefined
    ensureStyle(db, userId, b, def?.definition ?? '')
    db.prepare('DELETE FROM library_styles WHERE user_id = ? AND name = ?').run(userId, a)
  }
  return rows.length
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

/** Ce que l'agent voit de l'organisation existante : vocabulaires et un resume des images deja triees (borne : la tache a une taille maximale). */
function vaultSummary(db: Db, userId: number) {
  const sorted = db.prepare("SELECT scope, style, subject, title, description FROM library_images WHERE user_id = ? AND status = 'sorted' ORDER BY scope, title").all(userId) as unknown as { scope: string; style: string; subject: string; title: string; description: string }[]
  const used = db.prepare("SELECT traits FROM library_images WHERE user_id = ? AND status = 'sorted' AND traits != ''").all(userId) as unknown as { traits: string }[]
  const uniq = (xs: string[]) => [...new Set(xs.filter(Boolean))]
  const scopes = uniq([...SEED_SCOPES, ...sorted.map((r) => r.scope)]).slice(0, 60)
  const traits = uniq([...SEED_TRAITS, ...used.flatMap((r) => r.traits.split(','))]).slice(0, 80)
  const subjects = uniq(sorted.map((r) => r.subject)).slice(0, 200)
  const styles = listStyles(db, userId).slice(0, 80).map((s) => ({ name: s.name, definition: s.definition.slice(0, 120) }))
  const items: { scope: string; title: string; style: string; subject: string; description: string }[] = []
  let budget = 8_000
  for (const r of sorted) {
    const it = { scope: r.scope, title: r.title, style: r.style, subject: r.subject, description: r.description.slice(0, 60) }
    const size = JSON.stringify(it).length
    if (size > budget) break
    budget -= size
    items.push(it)
  }
  return { scopes, traits, subjects, styles, items, total: sorted.length }
}

/** Envoie les images en attente (40 au plus par tache) a un agent. */
export function startSort(db: Db, hub: WorkerHub, userId: number): { jobId: number; count: number } {
  if (db.prepare("SELECT 1 FROM library_images WHERE user_id = ? AND status = 'sorting'").get(userId)) throw new LibraryError('Un tri est deja en cours.', 409)
  const pending = db.prepare("SELECT id, file_name, mime, size, sha256, width, height, origin FROM library_images WHERE user_id = ? AND status = 'pending' ORDER BY created_at, id LIMIT ?").all(userId, SORT_BATCH) as unknown as { id: string; file_name: string; mime: string; size: number; sha256: string; width: number; height: number; origin: string }[]
  if (!pending.length) throw new LibraryError('Aucune image en attente.', 409)
  const jobId = hub.enqueue(userId, 'library.sort', {
    images: pending.map((p) => ({ id: p.id, name: p.file_name, mime: p.mime, size: p.size, sha256: p.sha256, width: p.width, height: p.height, origin: p.origin })),
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
  const sortedList = (result && typeof result === 'object' ? (result as { sorted?: unknown }).sorted : undefined)
  const decided = new Set<string>()
  if (Array.isArray(sortedList)) {
    for (const e of sortedList.slice(0, SORT_BATCH * 2)) {
      if (!e || typeof e !== 'object') continue
      const o = e as Record<string, unknown>
      if (!isLibraryId(o.id) || decided.has(o.id)) continue
      const img = getImage(db, userId, o.id)
      if (!img || img.status !== 'sorting' || img.sort_job_id !== jobId) continue
      const description = cleanDescription(o.description)
      if (!description) continue // sans description l'image ne serait pas retrouvable : elle reste en attente
      const scope = cleanScope(o.scope ?? o.folder)
      const title = uniqueTitle(db, userId, scope, cleanTitle(o.title, img.file_name), img.id)
      const style = cleanStyle(o.style)
      ensureStyle(db, userId, style, cleanDefinition(o.style_definition))
      db.prepare("UPDATE library_images SET status = 'sorted', sort_job_id = NULL, folder = ?, scope = ?, title = ?, description = ?, tags = ?, style = ?, traits = ?, subject = ?, colors = ?, sorted_at = ? WHERE id = ?")
        .run(scope, scope, title, description, cleanTags(o.tags), style, cleanTraits(o.traits), cleanSubject(o.subject) || cleanSubject(title), cleanColors(o.colors), Date.now(), img.id)
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
  id: string; scope: string; folder: string; title: string; description: string; tags: string[]; style: string; traits: string[]; subject: string; colors: string[]
  width: number; height: number; ratio: string; origin: string; mime: string; size: number; sha256: string
  roblox_status: LibraryImage['roblox_status']; roblox_asset_id: string | null
}
export interface SearchOptions { query?: string; scope?: string; style?: string; subject?: string; color?: string; ratio?: string; id?: string; similar?: string; limit?: number }

const toHit = (r: LibraryImage): SearchHit => ({
  id: r.id, scope: r.scope, folder: r.folder, title: r.title, description: r.description, tags: r.tags ? r.tags.split(',') : [], style: r.style, traits: r.traits ? r.traits.split(',') : [],
  subject: r.subject, colors: r.colors ? r.colors.split(',') : [], width: r.width, height: r.height, ratio: ratioKind(r.width, r.height), origin: r.origin, mime: r.mime, size: r.size, sha256: r.sha256,
  roblox_status: r.roblox_status, roblox_asset_id: r.roblox_asset_id,
})

/**
 * Images TRIEES de l'utilisateur. Filtres exacts (scope, style, sujet, couleur, ratio) ; `query` : mots compares au nom, au sujet, aux mots-cles, au style, au scope et a la description
 * (les meilleures d'abord) ; `similar` : images de STYLE PROCHE d'une image donnee (traits communs, meme style d'abord), pour garder un ensemble coherent.
 */
export function searchImages(db: Db, userId: number, o: SearchOptions): SearchHit[] {
  const limit = Math.max(1, Math.min(o.limit ?? 20, 50))
  let rows = db.prepare(`SELECT ${COLS} FROM library_images WHERE user_id = ? AND status = 'sorted' ORDER BY scope, title`).all(userId) as unknown as LibraryImage[]
  if (o.id) rows = rows.filter((r) => r.id === o.id)
  if (o.scope) { const s = cleanScope(o.scope); rows = rows.filter((r) => r.scope === s) }
  if (o.style) { const s = cleanStyle(o.style); rows = rows.filter((r) => r.style === s) }
  if (o.subject) { const s = cleanSubject(o.subject); rows = rows.filter((r) => r.subject === s || r.tags.split(',').includes(s)) }
  if (o.color) { const c = slug(o.color, 20); rows = rows.filter((r) => r.colors.split(',').includes(c)) }
  if (o.ratio) rows = rows.filter((r) => ratioKind(r.width, r.height) === o.ratio)
  if (o.similar) {
    const ref = db.prepare(`SELECT ${COLS} FROM library_images WHERE id = ? AND user_id = ? AND status = 'sorted'`).get(o.similar, userId) as unknown as LibraryImage | undefined
    if (!ref) return []
    const traits = new Set(ref.traits.split(',').filter(Boolean))
    const scored = rows.filter((r) => r.id !== ref.id).map((r) => {
      const common = r.traits.split(',').filter((t) => traits.has(t)).length
      return { r, score: (ref.style && r.style === ref.style ? 10 : 0) + common * 2 }
    }).filter((x) => x.score > 0).sort((a, b) => b.score - a.score)
    return scored.slice(0, limit).map((x) => toHit(x.r))
  }
  const q = words(o.query ?? '')
  let scored = rows.map((r) => ({ r, score: 0 }))
  if (q.length) {
    scored = scored.map(({ r }) => {
      const title = words(r.title), tags = r.tags.split(',').filter(Boolean), subject = words(r.subject), desc = words(r.description)
      const meta = words(`${r.scope} ${r.style} ${r.traits.replace(/,/g, ' ')} ${r.colors.replace(/,/g, ' ')}`)
      let score = 0
      for (const w of q) {
        if (tags.includes(w) || title.includes(w) || subject.includes(w)) score += 4
        else if (title.some((t) => t.includes(w)) || tags.some((t) => t.includes(w)) || subject.some((t) => t.includes(w))) score += 2
        if (meta.some((t) => t === w || t.startsWith(w))) score += 2
        if (desc.some((t) => t === w || t.startsWith(w))) score += 1
      }
      return { r, score }
    }).filter((x) => x.score > 0).sort((a, b) => b.score - a.score)
  }
  return scored.slice(0, limit).map(({ r }) => toHit(r))
}
