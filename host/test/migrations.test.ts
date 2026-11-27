import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { MIGRATIONS } from '../src/db.ts'

// Migration 13 : les chats ne creent plus de branche a leur creation. On part d'une base de la version 12 (avec des donnees) et on la met a niveau.
test('migration 13 : les chats deja utilises gardent leur branche, les conversations Claude sont reinitialisees', () => {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  assert.ok(MIGRATIONS.length >= 13, 'la migration existe')
  for (let i = 0; i < 12; i++) db.exec(MIGRATIONS[i])

  const now = Date.now()
  db.prepare("INSERT INTO users (id, email, password_hash, created_at) VALUES (1, 'a@b.c', 'x', ?)").run(now)
  db.prepare("INSERT INTO projects (id, owner_id, name, slug, created_at) VALUES (1, 1, 'P', 'p', ?)").run(now)
  const chat = (id: number, mode: string, session: string | null) =>
    db.prepare("INSERT INTO chats (id, project_id, title, branch, session_id, mode, created_at, updated_at) VALUES (?, 1, 't', 'ai/chat-x', ?, ?, ?, ?)").run(id, session, mode, now, now)
  const message = (chatId: number) => db.prepare("INSERT INTO chat_messages (chat_id, role, content, status, created_at) VALUES (?, 'user', 'x', 'done', ?)").run(chatId, now)
  chat(1, 'project', 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'); message(1) // projet, deja utilise : branche ouverte
  chat(2, 'project', null)                                              // projet, jamais utilise : rien d'ouvert
  chat(3, 'concept', 'bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee'); message(3) // ancienne maquette : atelier, pas de branche
  db.prepare("INSERT INTO workers (id, user_id, name, token_hash, created_at) VALUES (1, 1, 'w', 'h', ?)").run(now)
  db.prepare("INSERT INTO jobs (id, user_id, kind, payload_json, status, created_at) VALUES (1, 1, 'ai.chat', '{}', 'succeeded', ?)").run(now)
  db.prepare("INSERT INTO previews (id, user_id, job_id, n, title, file, viewport, ok, created_at) VALUES (?, 1, 1, 0, 't', 'f.story.tsx', 'UI Labs', 1, ?)").run('a'.repeat(32), now)

  db.exec(MIGRATIONS[12])

  const rows = db.prepare('SELECT id, branch_open, session_id FROM chats ORDER BY id').all() as { id: number; branch_open: number; session_id: string | null }[]
  assert.deepEqual(rows.map((r) => [r.id, r.branch_open]), [[1, 1], [2, 0], [3, 0]])
  assert.deepEqual(rows.map((r) => r.session_id), [null, null, null], 'le dossier de travail de Claude change : les anciennes conversations ne sont plus reprenables')
  assert.equal((db.prepare('SELECT root FROM previews').get() as { root: string }).root, 'project', 'les apercus existants viennent du projet')
})
