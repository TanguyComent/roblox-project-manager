// Fichiers joints aux messages d'un chat (images, PDF, texte, autres). Un fichier est televerse AVANT l'envoi du message (il reste « en attente » : message_id NULL),
// puis rattache au message. Le Worker le telecharge dans l'atelier du chat pour que l'IA le lise.
//
// SECURITE : le type d'un fichier est deduit de ses OCTETS (jamais de son nom ni du type annonce par le navigateur) ; les executables et scripts systeme sont refuses ;
// une image n'est servie « en ligne » que si c'est du PNG / JPEG / WebP / GIF verifie (un SVG peut contenir du code : telechargement seulement) ; tout le reste est servi
// en piece jointe, sans interpretation. Les fichiers sont ranges sous un identifiant aleatoire (jamais le nom d'origine, nettoye avant d'etre stocke ou affiche).
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { config } from './config.ts'
import type { Db } from './db.ts'

export type AttachmentKind = 'image' | 'pdf' | 'text' | 'other'

export interface Attachment {
  id: string; user_id: number; chat_id: number; message_id: number | null
  name: string; kind: AttachmentKind; mime: string; size: number; sha256: string; created_at: number
}

export const STAGED_TTL_MS = 24 * 3600_000
const ID = /^[0-9a-f]{32}$/
export const isAttachmentId = (id: unknown): id is string => typeof id === 'string' && ID.test(id)

const dir = () => join(resolve(config.dataDir), 'attachments')
const fileOf = (id: string) => join(dir(), id)

// --- type d'un fichier, deduit de ses octets ------------------------------------------------------------------------------------------

// Executables et scripts qui s'executent « en double-cliquant » : jamais acceptes, quel que soit leur contenu ou leur nom.
const DENIED_EXT = new Set(['exe', 'dll', 'sys', 'drv', 'bat', 'cmd', 'com', 'msi', 'msp', 'scr', 'ps1', 'psm1', 'psd1', 'vbs', 'vbe', 'wsf', 'wsh', 'jar', 'apk', 'app', 'dmg', 'pkg', 'sh', 'bash', 'zsh', 'csh', 'command', 'cpl', 'hta', 'reg', 'lnk', 'url', 'scf', 'inf', 'gadget', 'msc'])

const startsWith = (b: Buffer, sig: number[], at = 0) => b.length >= at + sig.length && sig.every((v, i) => b[at + i] === v)
const ascii = (b: Buffer, from: number, to: number) => b.subarray(from, to).toString('latin1')

export function extOf(name: string): string { const i = name.lastIndexOf('.'); return i < 0 ? '' : name.slice(i + 1).toLowerCase() }

/** Nom d'affichage sur : sans chemin, sans caracteres de controle ni de redirection, 120 caracteres au plus. */
export function cleanName(raw: unknown): string {
  let n = typeof raw === 'string' ? raw : ''
  n = n.replace(/[\u0000-\u001f\u007f‪-‮⁦-⁩]/g, '') // controle + inversion du sens d'ecriture (« fichier‮fdp.exe »)
  n = n.split(/[\\/]/).pop() ?? ''
  n = n.replace(/[<>:"|?*]/g, '_').replace(/^\.+/, '').replace(/[ .]+$/, '').trim()
  if (n.length > 120) { const e = extOf(n); n = n.slice(0, 120 - (e ? e.length + 1 : 0)) + (e ? `.${e}` : '') }
  return n || 'fichier'
}

export type Sniff = { ok: true; kind: AttachmentKind; mime: string } | { ok: false; error: string }

export function sniff(data: Buffer, name: string): Sniff {
  const ext = extOf(name)
  if (DENIED_EXT.has(ext)) return { ok: false, error: `Les fichiers « .${ext} » (executables, scripts systeme) ne sont pas acceptes.` }
  // executables reconnus a leur contenu, meme renommes
  if (startsWith(data, [0x4d, 0x5a]) || startsWith(data, [0x7f, 0x45, 0x4c, 0x46]) || startsWith(data, [0xfe, 0xed, 0xfa, 0xce]) || startsWith(data, [0xfe, 0xed, 0xfa, 0xcf])
    || startsWith(data, [0xce, 0xfa, 0xed, 0xfe]) || startsWith(data, [0xcf, 0xfa, 0xed, 0xfe]) || startsWith(data, [0xca, 0xfe, 0xba, 0xbe]) || startsWith(data, [0x23, 0x21])) {
    return { ok: false, error: 'Ce fichier est un programme ou un script executable : refuse.' }
  }
  if (!data.length) return { ok: false, error: 'Fichier vide.' }
  if (startsWith(data, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { ok: true, kind: 'image', mime: 'image/png' }
  if (startsWith(data, [0xff, 0xd8, 0xff])) return { ok: true, kind: 'image', mime: 'image/jpeg' }
  if (ascii(data, 0, 6) === 'GIF87a' || ascii(data, 0, 6) === 'GIF89a') return { ok: true, kind: 'image', mime: 'image/gif' }
  if (ascii(data, 0, 4) === 'RIFF' && ascii(data, 8, 12) === 'WEBP') return { ok: true, kind: 'image', mime: 'image/webp' }
  if (ascii(data, 0, 5) === '%PDF-') return { ok: true, kind: 'pdf', mime: 'application/pdf' }
  if (startsWith(data, [0x50, 0x4b, 0x03, 0x04])) return { ok: true, kind: 'other', mime: 'application/zip' }
  // texte : aucun octet NUL dans les premiers Ko (SVG, JSON, CSV, Lua, TypeScript...). Servi en telechargement, jamais interprete.
  const head = data.subarray(0, 8192)
  if (!head.includes(0)) return { ok: true, kind: 'text', mime: 'text/plain' }
  return { ok: true, kind: 'other', mime: 'application/octet-stream' }
}

/** Seules ces images sont affichees dans la page (vignettes) ; tout le reste est un telechargement. */
export const isInline = (a: Pick<Attachment, 'kind' | 'mime'>) => a.kind === 'image' && ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(a.mime)

// --- stockage ---------------------------------------------------------------------------------------------------------------------------

export class AttachmentError extends Error {
  status: 400 | 404 | 409 | 413
  constructor(message: string, status: 400 | 404 | 409 | 413 = 400) { super(message); this.status = status }
}

const used = (db: Db, userId: number) => (db.prepare('SELECT COALESCE(SUM(size), 0) AS b FROM chat_attachments WHERE user_id = ?').get(userId) as { b: number }).b

/** Enregistre un fichier « en attente » dans un chat. Toutes les limites sont verifiees ici. */
export function saveStaged(db: Db, userId: number, chatId: number, rawName: unknown, data: Buffer): Attachment {
  const a = config.attach
  purgeStaged(db)
  if (data.length > a.maxFile) throw new AttachmentError(`Fichier trop gros (${Math.round(a.maxFile / 1048576)} Mo maximum).`, 413)
  const name = cleanName(rawName)
  const s = sniff(data, name)
  if (!s.ok) throw new AttachmentError(s.error)
  const staged = db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS b FROM chat_attachments WHERE chat_id = ? AND message_id IS NULL').get(chatId) as { n: number; b: number }
  if (staged.n >= a.maxPerMessage) throw new AttachmentError(`Trop de fichiers pour un message (${a.maxPerMessage} maximum).`, 409)
  if (staged.b + data.length > a.maxMessage) throw new AttachmentError(`Les fichiers d'un message ne peuvent pas depasser ${Math.round(a.maxMessage / 1048576)} Mo.`, 413)
  if (used(db, userId) + data.length > a.userQuota) throw new AttachmentError("Espace de fichiers joints plein : supprime d'anciens chats.", 413)
  const id = randomBytes(16).toString('hex')
  mkdirSync(dir(), { recursive: true })
  writeFileSync(fileOf(id), data)
  const row: Attachment = { id, user_id: userId, chat_id: chatId, message_id: null, name, kind: s.kind, mime: s.mime, size: data.length, sha256: createHash('sha256').update(data).digest('hex'), created_at: Date.now() }
  db.prepare('INSERT INTO chat_attachments (id, user_id, chat_id, message_id, name, kind, mime, size, sha256, created_at) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)')
    .run(id, userId, chatId, name, row.kind, row.mime, row.size, row.sha256, row.created_at)
  return row
}

const COLS = 'id, user_id, chat_id, message_id, name, kind, mime, size, sha256, created_at'
const inList = (n: number) => Array(n).fill('?').join(',')

export const listStaged = (db: Db, chatId: number) =>
  db.prepare(`SELECT ${COLS} FROM chat_attachments WHERE chat_id = ? AND message_id IS NULL ORDER BY created_at, id`).all(chatId) as unknown as Attachment[]

export const getAttachment = (db: Db, chatId: number, id: string) =>
  isAttachmentId(id) ? (db.prepare(`SELECT ${COLS} FROM chat_attachments WHERE id = ? AND chat_id = ?`).get(id, chatId) as unknown as Attachment | undefined) : undefined

/** Fichiers des messages donnes, regroupes par message. */
export function attachmentsForMessages(db: Db, messageIds: number[]): Map<number, Attachment[]> {
  const out = new Map<number, Attachment[]>()
  if (!messageIds.length) return out
  for (const r of db.prepare(`SELECT ${COLS} FROM chat_attachments WHERE message_id IN (${inList(messageIds.length)}) ORDER BY id`).all(...messageIds) as unknown as Attachment[]) {
    if (!out.has(r.message_id!)) out.set(r.message_id!, [])
    out.get(r.message_id!)!.push(r)
  }
  return out
}

/** Les fichiers deja rattaches a des messages de ce chat (les plus recents d'abord limites) : transmis au Worker a chaque tour. */
export const chatAttachments = (db: Db, chatId: number, limit = 50) =>
  (db.prepare(`SELECT ${COLS} FROM chat_attachments WHERE chat_id = ? AND message_id IS NOT NULL ORDER BY id DESC LIMIT ?`).all(chatId, limit) as unknown as Attachment[]).reverse()

/** Valide les identifiants donnes par le navigateur : ce chat, en attente, sans doublon. */
export function stagedByIds(db: Db, chatId: number, ids: unknown[]): Attachment[] {
  if (ids.length > config.attach.maxPerMessage) throw new AttachmentError(`Trop de fichiers pour un message (${config.attach.maxPerMessage} maximum).`, 409)
  const seen = new Set<string>()
  const rows: Attachment[] = []
  for (const id of ids) {
    if (!isAttachmentId(id) || seen.has(id)) throw new AttachmentError('Fichier joint invalide.')
    seen.add(id)
    const r = getAttachment(db, chatId, id)
    if (!r || r.message_id !== null) throw new AttachmentError('Fichier joint introuvable ou deja envoye.', 404)
    rows.push(r)
  }
  return rows
}

export function attachToMessage(db: Db, messageId: number, ids: string[]) {
  for (const id of ids) db.prepare('UPDATE chat_attachments SET message_id = ? WHERE id = ? AND message_id IS NULL').run(messageId, id)
}

export function deleteStaged(db: Db, chatId: number, id: string): boolean {
  const r = getAttachment(db, chatId, id)
  if (!r || r.message_id !== null) return false
  rmSync(fileOf(id), { force: true })
  db.prepare('DELETE FROM chat_attachments WHERE id = ?').run(id)
  return true
}

/** Fichiers en attente depuis plus de 24 h (message jamais envoye) : supprimes. */
export function purgeStaged(db: Db, now = Date.now()) {
  const old = db.prepare('SELECT id FROM chat_attachments WHERE message_id IS NULL AND created_at < ?').all(now - STAGED_TTL_MS) as unknown as { id: string }[]
  for (const r of old) rmSync(fileOf(r.id), { force: true })
  if (old.length) db.prepare(`DELETE FROM chat_attachments WHERE id IN (${inList(old.length)})`).run(...old.map((r) => r.id))
  return old.length
}

/** Suppression d'un chat : tous ses fichiers (lignes et octets). */
export function deleteChatAttachments(db: Db, chatId: number) {
  for (const r of db.prepare('SELECT id FROM chat_attachments WHERE chat_id = ?').all(chatId) as unknown as { id: string }[]) rmSync(fileOf(r.id), { force: true })
  db.prepare('DELETE FROM chat_attachments WHERE chat_id = ?').run(chatId)
}

/** Octets d'un fichier (null : introuvable sur le disque). */
export function readBytes(id: string): Buffer | null {
  if (!isAttachmentId(id)) return null
  const f = fileOf(id)
  return existsSync(f) ? readFileSync(f) : null
}
