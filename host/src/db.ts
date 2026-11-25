import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { config, ensureDataDir } from './config.ts'

export type Db = DatabaseSync

const MIGRATIONS = [
  `CREATE TABLE users (
     id INTEGER PRIMARY KEY,
     email TEXT NOT NULL UNIQUE,
     password_hash TEXT NOT NULL,
     totp_secret TEXT,                 -- chiffre ; en attente tant que totp_enabled = 0
     totp_enabled INTEGER NOT NULL DEFAULT 0,
     totp_last_step INTEGER NOT NULL DEFAULT 0,
     created_at INTEGER NOT NULL
   );
   CREATE TABLE recovery_codes (
     id INTEGER PRIMARY KEY,
     user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     code_hash TEXT NOT NULL,
     used_at INTEGER
   );
   CREATE INDEX recovery_user ON recovery_codes(user_id);
   CREATE TABLE sessions (
     id TEXT PRIMARY KEY,              -- sha256 du jeton du cookie
     user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     stage TEXT NOT NULL,              -- 'mfa' (mot de passe ok, code A2F attendu) | 'setup' (A2F a configurer) | 'full'
     csrf TEXT NOT NULL,
     attempts INTEGER NOT NULL DEFAULT 0,
     created_at INTEGER NOT NULL,
     expires_at INTEGER NOT NULL,
     user_agent TEXT
   );
   CREATE INDEX sessions_user ON sessions(user_id);`,
  // 2 : projets et experiences Roblox
  `CREATE TABLE projects (
     id INTEGER PRIMARY KEY,
     owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     name TEXT NOT NULL,
     slug TEXT NOT NULL,
     roblox_group_id INTEGER,
     roblox_group_name TEXT,
     github_repo TEXT,                 -- "proprietaire/depot"
     created_at INTEGER NOT NULL,
     UNIQUE (owner_id, slug)
   );
   CREATE TABLE experiences (
     id INTEGER PRIMARY KEY,
     project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
     kind TEXT NOT NULL CHECK (kind IN ('release', 'dev', 'bench')),
     label TEXT NOT NULL,
     universe_id INTEGER NOT NULL,
     place_id INTEGER NOT NULL,
     created_at INTEGER NOT NULL
   );
   CREATE INDEX experiences_project ON experiences(project_id);
   -- une seule release et un seul dev par projet ; autant de bancs d'essai que l'on veut
   CREATE UNIQUE INDEX experiences_single_kind ON experiences(project_id, kind) WHERE kind IN ('release', 'dev');`,
  // 3 : connexion GitHub par utilisateur (jeton chiffre) et son template par defaut
  `CREATE TABLE github_connections (
     user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
     login TEXT NOT NULL,
     token_enc TEXT NOT NULL,          -- chiffre (AES-256-GCM), jamais renvoye au navigateur
     template_repo TEXT,               -- "proprietaire/depot" utilise pour creer les projets
     default_owner TEXT,               -- compte ou organisation qui recevra les nouveaux depots (vide = login)
     created_at INTEGER NOT NULL
   );`,
  // 4 : branche du depot template a utiliser
  `ALTER TABLE github_connections ADD COLUMN template_branch TEXT;`,
]

export function openDb(file?: string): Db {
  let path = file
  if (!path) { ensureDataDir(); path = join(config.dataDir, 'host.db') }
  const db = new DatabaseSync(path)
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;')
  const version = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
  for (let i = version; i < MIGRATIONS.length; i++) {
    db.exec('BEGIN')
    try { db.exec(MIGRATIONS[i]); db.exec(`PRAGMA user_version = ${i + 1}`); db.exec('COMMIT') }
    catch (e) { db.exec('ROLLBACK'); throw e }
  }
  return db
}
