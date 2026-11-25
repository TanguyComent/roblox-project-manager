// Projets et experiences Roblox. Tout est rattache a un proprietaire : une requete ne voit jamais le projet d'un autre utilisateur.
import type { Db } from './db.ts'

export type ExperienceKind = 'release' | 'dev' | 'bench'
export const KIND_LABEL: Record<ExperienceKind, string> = { release: 'Release', dev: 'Dev', bench: 'Bench' }

export interface Project {
  id: number
  owner_id: number
  name: string
  slug: string
  roblox_group_id: number | null
  roblox_group_name: string | null
  github_repo: string | null
  created_at: number
}
export interface Experience {
  id: number
  project_id: number
  kind: ExperienceKind
  label: string
  universe_id: number
  place_id: number
  created_at: number
}

// --- validation -------------------------------------------------------------------------------------------------------------
const MAX_ID = Number.MAX_SAFE_INTEGER

export function parseRobloxId(raw: string): number | null {
  const t = raw.trim()
  if (!/^\d{1,16}$/.test(t)) return null
  const n = Number(t)
  return n > 0 && n <= MAX_ID ? n : null
}

export function slugify(name: string): string {
  const s = name.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50)
  return s || 'projet'
}

// "proprietaire/depot" (ou une URL GitHub) -> "proprietaire/depot"
export function parseRepo(raw: string): string | null {
  const m = /^(?:https?:\/\/github\.com\/)?([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100}?)(?:\.git)?\/?$/.exec(raw.trim())
  return m ? `${m[1]}/${m[2]}` : null
}

// --- projets ----------------------------------------------------------------------------------------------------------------
export function listProjects(db: Db, ownerId: number): (Project & { experience_count: number })[] {
  return db.prepare(
    `SELECT p.*, (SELECT COUNT(*) FROM experiences e WHERE e.project_id = p.id) AS experience_count
     FROM projects p WHERE p.owner_id = ? ORDER BY p.created_at DESC, p.id DESC`,
  ).all(ownerId) as unknown as (Project & { experience_count: number })[]
}

export function getProject(db: Db, ownerId: number, id: number): Project | undefined {
  return db.prepare('SELECT * FROM projects WHERE id = ? AND owner_id = ?').get(id, ownerId) as unknown as Project | undefined
}

export function uniqueSlug(db: Db, ownerId: number, name: string): string {
  const base = slugify(name)
  const taken = (s: string) => !!db.prepare('SELECT 1 FROM projects WHERE owner_id = ? AND slug = ?').get(ownerId, s)
  if (!taken(base)) return base
  for (let i = 2; ; i++) if (!taken(`${base}-${i}`)) return `${base}-${i}`
}

export function createProject(
  db: Db, ownerId: number,
  p: { name: string; groupId: number | null; groupName: string | null; githubRepo: string | null },
): Project {
  const slug = uniqueSlug(db, ownerId, p.name)
  const r = db.prepare(
    'INSERT INTO projects (owner_id, name, slug, roblox_group_id, roblox_group_name, github_repo, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(ownerId, p.name, slug, p.groupId, p.groupName, p.githubRepo, Date.now())
  return getProject(db, ownerId, Number(r.lastInsertRowid))!
}

export function updateProject(
  db: Db, ownerId: number, id: number,
  p: { name: string; groupId: number | null; groupName: string | null; githubRepo: string | null },
): boolean {
  const r = db.prepare('UPDATE projects SET name = ?, roblox_group_id = ?, roblox_group_name = ?, github_repo = ? WHERE id = ? AND owner_id = ?')
    .run(p.name, p.groupId, p.groupName, p.githubRepo, id, ownerId)
  return Number(r.changes) > 0
}

export function deleteProject(db: Db, ownerId: number, id: number): boolean {
  return Number(db.prepare('DELETE FROM projects WHERE id = ? AND owner_id = ?').run(id, ownerId).changes) > 0
}

// --- experiences ------------------------------------------------------------------------------------------------------------
const KIND_ORDER = `CASE kind WHEN 'release' THEN 0 WHEN 'dev' THEN 1 ELSE 2 END`

export function listExperiences(db: Db, projectId: number): Experience[] {
  return db.prepare(`SELECT * FROM experiences WHERE project_id = ? ORDER BY ${KIND_ORDER}, id`).all(projectId) as unknown as Experience[]
}

export type AddExperienceResult = { ok: true; experience: Experience } | { ok: false; error: string }

export function addExperience(
  db: Db, projectId: number,
  e: { kind: ExperienceKind; universeId: number; placeId: number; label?: string },
): AddExperienceResult {
  if (!(e.kind in KIND_LABEL)) return { ok: false, error: 'Type d\'experience inconnu.' }
  let label = (e.label ?? '').trim().slice(0, 60)
  if (e.kind !== 'bench') {
    if (db.prepare('SELECT 1 FROM experiences WHERE project_id = ? AND kind = ?').get(projectId, e.kind)) {
      return { ok: false, error: `Ce projet a deja une experience ${KIND_LABEL[e.kind]}.` }
    }
    label ||= KIND_LABEL[e.kind]
  } else {
    // Bancs d'essai numerotes : "Bench 1", "Bench 2"... (le plus petit numero libre)
    const used = new Set(
      (db.prepare(`SELECT label FROM experiences WHERE project_id = ? AND kind = 'bench'`).all(projectId) as unknown as { label: string }[]).map((r) => r.label),
    )
    if (!label) { let n = 1; while (used.has(`Bench ${n}`)) n++; label = `Bench ${n}` }
    else if (used.has(label)) return { ok: false, error: 'Un banc d\'essai porte deja ce nom.' }
  }
  const r = db.prepare('INSERT INTO experiences (project_id, kind, label, universe_id, place_id, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(projectId, e.kind, label, e.universeId, e.placeId, Date.now())
  return { ok: true, experience: db.prepare('SELECT * FROM experiences WHERE id = ?').get(Number(r.lastInsertRowid)) as unknown as Experience }
}

export function deleteExperience(db: Db, projectId: number, experienceId: number): boolean {
  return Number(db.prepare('DELETE FROM experiences WHERE id = ? AND project_id = ?').run(experienceId, projectId).changes) > 0
}
