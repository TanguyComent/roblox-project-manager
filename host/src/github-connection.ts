// Connexion GitHub d'un utilisateur : le jeton est chiffre en base et ne sort jamais du serveur.
import { decryptSecret, encryptSecret } from './crypto.ts'
import type { Db } from './db.ts'

export interface GithubConnection { user_id: number; login: string; template_repo: string | null; default_owner: string | null; created_at: number }

// Le jeton n'est volontairement PAS dans cette requete (il ne doit jamais atteindre une vue).
export function getConnection(db: Db, userId: number): GithubConnection | undefined {
  return db.prepare('SELECT user_id, login, template_repo, default_owner, created_at FROM github_connections WHERE user_id = ?').get(userId) as unknown as GithubConnection | undefined
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

export function updateSettings(db: Db, userId: number, s: { templateRepo: string | null; defaultOwner: string | null }) {
  db.prepare('UPDATE github_connections SET template_repo = ?, default_owner = ? WHERE user_id = ?').run(s.templateRepo, s.defaultOwner, userId)
}

export function deleteConnection(db: Db, userId: number) {
  db.prepare('DELETE FROM github_connections WHERE user_id = ?').run(userId)
}
