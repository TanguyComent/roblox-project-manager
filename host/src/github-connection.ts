// Connexion GitHub d'un utilisateur : le jeton est chiffre en base et ne sort jamais du serveur.
import { decryptSecret, encryptSecret } from './crypto.ts'
import type { Db } from './db.ts'

export interface GithubConnection {
  user_id: number
  login: string
  template_repo: string | null
  template_branch: string | null
  /** Depot dont partent les chats « Maquette UI » (et sa branche). */
  ui_template_repo: string | null
  ui_template_branch: string | null
  default_owner: string | null
  created_at: number
}

// Le jeton n'est volontairement PAS dans cette requete (il ne doit jamais atteindre une vue).
export function getConnection(db: Db, userId: number): GithubConnection | undefined {
  return db.prepare(
    'SELECT user_id, login, template_repo, template_branch, ui_template_repo, ui_template_branch, default_owner, created_at FROM github_connections WHERE user_id = ?',
  ).get(userId) as unknown as GithubConnection | undefined
}

export function getToken(db: Db, userId: number): string | null {
  const row = db.prepare('SELECT token_enc FROM github_connections WHERE user_id = ?').get(userId) as { token_enc: string } | undefined
  return row ? decryptSecret(row.token_enc) : null
}

// Connecte (ou reconnecte avec un nouveau jeton) ; les reglages existants sont conserves.
export function saveConnection(db: Db, userId: number, login: string, token: string) {
  db.prepare(
    `INSERT INTO github_connections (user_id, login, token_enc, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET login = excluded.login, token_enc = excluded.token_enc`,
  ).run(userId, login, encryptSecret(token), Date.now())
}

export function updateOwner(db: Db, userId: number, defaultOwner: string | null) {
  db.prepare('UPDATE github_connections SET default_owner = ? WHERE user_id = ?').run(defaultOwner, userId)
}

export function updateTemplate(db: Db, userId: number, repo: string | null, branch: string | null) {
  db.prepare('UPDATE github_connections SET template_repo = ?, template_branch = ? WHERE user_id = ?').run(repo, branch, userId)
}

export function updateUiTemplate(db: Db, userId: number, repo: string | null, branch: string | null) {
  db.prepare('UPDATE github_connections SET ui_template_repo = ?, ui_template_branch = ? WHERE user_id = ?').run(repo, branch, userId)
}

/** Depot de maquette d'un utilisateur : son reglage, sinon le depot par defaut de l'instance (UI_TEMPLATE_REPO), sinon rien. */
export function uiTemplateOf(db: Db, userId: number, fallback: string | null): { repo: string; branch: string | null } | null {
  const c = getConnection(db, userId)
  if (c?.ui_template_repo) return { repo: c.ui_template_repo, branch: c.ui_template_branch }
  return fallback ? { repo: fallback, branch: null } : null
}

export function deleteConnection(db: Db, userId: number) {
  db.prepare('DELETE FROM github_connections WHERE user_id = ?').run(userId)
}
