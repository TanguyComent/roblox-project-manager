import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { config, ensureDataDir } from './config.ts'

export type Db = DatabaseSync

export const MIGRATIONS = [
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
  // 5 : comptes Roblox (OAuth 2.0 / Open Cloud) d'un utilisateur, etats OAuth en cours, compte Roblox d'un projet
  `CREATE TABLE roblox_accounts (
     id INTEGER PRIMARY KEY,
     user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     roblox_user_id TEXT NOT NULL,
     username TEXT NOT NULL,
     display_name TEXT,
     refresh_token_enc TEXT NOT NULL,   -- chiffre ; a usage unique cote Roblox (rotation a chaque rafraichissement)
     access_token_enc TEXT,             -- chiffre ; valable 15 minutes
     access_expires_at INTEGER NOT NULL DEFAULT 0,
     scopes TEXT NOT NULL DEFAULT '',
     status TEXT NOT NULL DEFAULT 'ok' CHECK (status IN ('ok', 'needs_reauth')),
     created_at INTEGER NOT NULL,
     UNIQUE (user_id, roblox_user_id)
   );
   CREATE TABLE oauth_states (
     state_hash TEXT PRIMARY KEY,       -- sha256 de la valeur "state" envoyee a Roblox
     user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     session_id TEXT NOT NULL,          -- la connexion doit etre terminee dans la session qui l'a demandee
     code_verifier_enc TEXT NOT NULL,   -- PKCE
     expires_at INTEGER NOT NULL
   );
   ALTER TABLE projects ADD COLUMN roblox_account_id INTEGER REFERENCES roblox_accounts(id);`,
  // 6 : administrateur de l'instance (le premier compte) et reglages d'instance chiffres (identifiants de l'application OAuth Roblox...)
  `ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0;
   UPDATE users SET is_admin = 1 WHERE id = (SELECT MIN(id) FROM users);
   CREATE TABLE settings (
     key TEXT PRIMARY KEY,
     value_enc TEXT NOT NULL,           -- chiffre (AES-256-GCM)
     updated_at INTEGER NOT NULL
   );`,
  // 7 : on abandonne OAuth au profit de CLES D'API (une par compte Roblox). Les anciennes connexions OAuth n'ont pas de cle : elles sont retirees,
  //     ainsi que les reglages d'application OAuth, les etats OAuth et la notion d'administrateur qui ne servaient qu'a cela.
  `UPDATE projects SET roblox_account_id = NULL;
   DROP TABLE oauth_states;
   DROP TABLE settings;
   DROP TABLE roblox_accounts;
   ALTER TABLE users DROP COLUMN is_admin;
   CREATE TABLE roblox_accounts (
     id INTEGER PRIMARY KEY,
     user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     label TEXT NOT NULL,
     api_key_enc TEXT NOT NULL,         -- chiffre (AES-256-GCM), jamais renvoye au navigateur
     key_hash TEXT NOT NULL,            -- sha256 de la cle : eviter les doublons sans la dechiffrer
     key_name TEXT,
     roblox_user_id TEXT NOT NULL,      -- compte Roblox auquel appartient la cle
     username TEXT,
     scopes_json TEXT NOT NULL DEFAULT '[]',
     expires_at INTEGER,
     status TEXT NOT NULL DEFAULT 'ok' CHECK (status IN ('ok', 'invalid')),
     status_detail TEXT,
     checked_at INTEGER NOT NULL,
     created_at INTEGER NOT NULL,
     UNIQUE (user_id, key_hash)
   );`,
  // 8 : Workers (machines qui executent les taches), pools de Workers, taches et leurs evenements. Tout appartient a UN utilisateur.
  `CREATE TABLE worker_pools (
     id INTEGER PRIMARY KEY,
     user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     name TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     UNIQUE (user_id, name)
   );
   CREATE TABLE workers (
     id INTEGER PRIMARY KEY,
     user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     pool_id INTEGER REFERENCES worker_pools(id) ON DELETE SET NULL,
     name TEXT NOT NULL,
     token_hash TEXT NOT NULL UNIQUE,   -- sha256 du jeton ; le jeton lui-meme n'est montre qu'une fois
     last_seen_at INTEGER,
     info_json TEXT NOT NULL DEFAULT '{}',
     created_at INTEGER NOT NULL,
     UNIQUE (user_id, name)
   );
   CREATE TABLE jobs (
     id INTEGER PRIMARY KEY,
     user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     kind TEXT NOT NULL,
     payload_json TEXT NOT NULL DEFAULT '{}',
     target_worker_id INTEGER REFERENCES workers(id) ON DELETE SET NULL,  -- un Worker precis,
     target_pool_id INTEGER REFERENCES worker_pools(id) ON DELETE SET NULL, -- ou un pool, ou (les deux nuls) n'importe lequel des Workers de l'utilisateur
     worker_id INTEGER REFERENCES workers(id) ON DELETE SET NULL,         -- celui qui l'execute / l'a executee
     status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
     result_json TEXT,
     error TEXT,
     created_at INTEGER NOT NULL,
     started_at INTEGER,
     finished_at INTEGER
   );
   CREATE INDEX jobs_user ON jobs(user_id, id DESC);
   CREATE INDEX jobs_status ON jobs(status);
   CREATE TABLE job_events (
     id INTEGER PRIMARY KEY,
     job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
     at INTEGER NOT NULL,
     level TEXT NOT NULL,
     text TEXT NOT NULL
   );
   CREATE INDEX job_events_job ON job_events(job_id, id);`,
  // 9 : ciblage des taches par outils (requires) et chats IA des projets
  `ALTER TABLE jobs ADD COLUMN requires TEXT;
   CREATE TABLE chats (
     id INTEGER PRIMARY KEY,
     project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
     title TEXT NOT NULL,
     branch TEXT NOT NULL,             -- branche git dediee a ce chat
     session_id TEXT,                  -- conversation Claude Code a reprendre sur le Worker
     worker_id INTEGER REFERENCES workers(id) ON DELETE SET NULL,   -- Worker qui detient le dossier de travail et la session
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   );
   CREATE INDEX chats_project ON chats(project_id, updated_at DESC);
   CREATE TABLE chat_messages (
     id INTEGER PRIMARY KEY,
     chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
     role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
     content TEXT NOT NULL DEFAULT '',
     status TEXT NOT NULL DEFAULT 'done' CHECK (status IN ('done', 'pending', 'failed', 'cancelled')),
     job_id INTEGER,
     details_json TEXT,                -- commits, diff, cout... (reponses de l'IA)
     created_at INTEGER NOT NULL
   );
   CREATE INDEX chat_messages_chat ON chat_messages(chat_id, id);`,
  // 10 : activite typee des taches (pensee, outils), modele / effort et etat « lu » des chats
  `ALTER TABLE job_events ADD COLUMN kind TEXT;
   ALTER TABLE chats ADD COLUMN model TEXT;
   ALTER TABLE chats ADD COLUMN effort TEXT;
   ALTER TABLE chats ADD COLUMN seen_message_id INTEGER NOT NULL DEFAULT 0;`,
  // 11 : apercus d'interface (paquets de l'emulateur d'UI deposes par les Workers) et chats « maquette »
  `ALTER TABLE chats ADD COLUMN mode TEXT NOT NULL DEFAULT 'project' CHECK (mode IN ('project', 'concept'));
   CREATE TABLE previews (
     id TEXT PRIMARY KEY,              -- 128 bits aleatoires : l'adresse de l'apercu en est la seule cle d'acces (voir preview-routes.ts)
     user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
     n INTEGER NOT NULL,               -- rang du bloc rpm-ui dans la reponse
     title TEXT NOT NULL,
     file TEXT NOT NULL,
     viewport TEXT NOT NULL,
     ok INTEGER NOT NULL,
     error TEXT,
     checked INTEGER NOT NULL DEFAULT 0,
     nodes INTEGER NOT NULL DEFAULT 0,
     errors_json TEXT NOT NULL DEFAULT '[]',
     missing_json TEXT NOT NULL DEFAULT '[]',
     bytes INTEGER NOT NULL DEFAULT 0,
     created_at INTEGER NOT NULL,
     UNIQUE (job_id, n)
   );
   CREATE INDEX previews_user ON previews(user_id);`,
  // 12 : depot de maquette UI choisi parmi les depots du compte GitHub connecte (remplace le depot fixe)
  `ALTER TABLE github_connections ADD COLUMN ui_template_repo TEXT;
   ALTER TABLE github_connections ADD COLUMN ui_template_branch TEXT;`,
  // 13 : un chat ne cree plus de branche a sa creation. Il travaille dans un « atelier » (dossier libre sur le Worker) et la branche du projet n'est ouverte
  //      que quand l'IA doit modifier le projet (branch_open). Les chats deja utilises sur leur branche l'ont ouverte ; leur conversation Claude est
  //      repartie de zero (son dossier de travail change : l'atelier). Les apercus savent d'ou vient leur story (project / sandbox = atelier).
  `ALTER TABLE chats ADD COLUMN branch_open INTEGER NOT NULL DEFAULT 0;
   UPDATE chats SET branch_open = 1 WHERE mode = 'project' AND EXISTS (SELECT 1 FROM chat_messages m WHERE m.chat_id = chats.id);
   UPDATE chats SET session_id = NULL;
   ALTER TABLE previews ADD COLUMN root TEXT NOT NULL DEFAULT 'project';`,
  // 14 : fichiers joints aux messages d'un chat (images, PDF, autres). message_id NULL = televerse mais message pas encore envoye.
  `CREATE TABLE chat_attachments (
     id TEXT PRIMARY KEY,              -- 128 bits aleatoires : nom du fichier sur le disque (jamais le nom d'origine)
     user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
     message_id INTEGER REFERENCES chat_messages(id) ON DELETE SET NULL,
     name TEXT NOT NULL,               -- nom d'origine, nettoye
     kind TEXT NOT NULL CHECK (kind IN ('image', 'pdf', 'text', 'other')),
     mime TEXT NOT NULL,               -- deduit des octets
     size INTEGER NOT NULL,
     sha256 TEXT NOT NULL,
     created_at INTEGER NOT NULL
   );
   CREATE INDEX chat_attachments_chat ON chat_attachments(chat_id, id);
   CREATE INDEX chat_attachments_user ON chat_attachments(user_id);`,
  // 15 : bibliotheque d'images de l'utilisateur (le Host est la source de verite ; le vault Obsidian en est derive).
  `CREATE TABLE library_images (
     id TEXT PRIMARY KEY,               -- 128 bits aleatoires : nom du fichier sur le disque
     user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     file_name TEXT NOT NULL,           -- nom d'origine, nettoye
     title TEXT NOT NULL,               -- nom de la note dans le vault (unique par dossier une fois triee)
     folder TEXT NOT NULL DEFAULT '',   -- dossier du vault (« icons/shop »), vide tant que l'image n'est pas triee
     description TEXT NOT NULL DEFAULT '',
     tags TEXT NOT NULL DEFAULT '',     -- mots-cles separes par des virgules
     status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sorting', 'sorted')),
     mime TEXT NOT NULL,
     size INTEGER NOT NULL,
     sha256 TEXT NOT NULL,
     sort_job_id INTEGER,               -- tache de tri en cours
     source TEXT NOT NULL DEFAULT 'upload' CHECK (source IN ('upload', 'generated')),
     roblox_status TEXT NOT NULL DEFAULT 'unpublished' CHECK (roblox_status IN ('unpublished', 'publishing', 'published', 'failed')),
     roblox_asset_id TEXT,
     created_at INTEGER NOT NULL,
     sorted_at INTEGER
   );
   CREATE INDEX library_images_user ON library_images(user_id, status);`,
  // 16 : facettes de la bibliotheque (scope, style + traits, sujet, couleurs, dimensions, provenance) et styles definis une fois.
  `ALTER TABLE library_images ADD COLUMN scope TEXT NOT NULL DEFAULT '';
   ALTER TABLE library_images ADD COLUMN style TEXT NOT NULL DEFAULT '';
   ALTER TABLE library_images ADD COLUMN traits TEXT NOT NULL DEFAULT '';
   ALTER TABLE library_images ADD COLUMN subject TEXT NOT NULL DEFAULT '';
   ALTER TABLE library_images ADD COLUMN colors TEXT NOT NULL DEFAULT '';
   ALTER TABLE library_images ADD COLUMN width INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE library_images ADD COLUMN height INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE library_images ADD COLUMN origin TEXT NOT NULL DEFAULT '';
   UPDATE library_images SET scope = folder WHERE status = 'sorted';
   CREATE TABLE library_styles (
     user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     name TEXT NOT NULL,
     definition TEXT NOT NULL DEFAULT '',
     PRIMARY KEY (user_id, name)
   );`,
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
