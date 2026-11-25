// Logique metier des comptes : creation, sessions, A2F. Aucune dependance HTTP (testable seule).
import type { Db } from './db.ts'
import {
  burnPasswordTime, decryptSecret, encryptSecret, generateRecoveryCodes, generateTotpSecret, hashPassword, normalizeRecoveryCode,
  randomToken, sha256, verifyPassword, verifyTotp,
} from './crypto.ts'

export type Stage = 'mfa' | 'setup' | 'full'
export interface User { id: number; email: string; totp_enabled: number }
export interface Session { id: string; user_id: number; stage: Stage; csrf: string; attempts: number; expires_at: number }

export const FULL_SESSION_MS = 14 * 24 * 3600_000
export const PENDING_SESSION_MS = 10 * 60_000
export const MAX_MFA_ATTEMPTS = 5

const now = () => Date.now()

// --- validation -------------------------------------------------------------------------------------------------------------
export const normalizeEmail = (e: string) => e.trim().toLowerCase()
export const isEmail = (e: string) => e.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e)

export function passwordProblem(pw: string): string | null {
  if (pw.length < 10) return 'Le mot de passe doit faire au moins 10 caracteres.'
  if (pw.length > 200) return 'Le mot de passe est trop long.'
  if (/^(.)\1+$/.test(pw)) return 'Le mot de passe est trop simple.'
  return null
}

// --- comptes ----------------------------------------------------------------------------------------------------------------
export const countUsers = (db: Db) => (db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n

export function findUserByEmail(db: Db, email: string) {
  return db.prepare('SELECT * FROM users WHERE email = ?').get(normalizeEmail(email)) as
    | (User & { password_hash: string; totp_secret: string | null; totp_last_step: number }) | undefined
}

export async function createUser(db: Db, email: string, password: string): Promise<User> {
  const e = normalizeEmail(email)
  const hash = await hashPassword(password)
  const r = db.prepare('INSERT INTO users (email, password_hash, created_at) VALUES (?, ?, ?)').run(e, hash, now())
  return { id: Number(r.lastInsertRowid), email: e, totp_enabled: 0 }
}

// Verifie e-mail + mot de passe. Renvoie l'utilisateur, ou null (meme duree dans les deux cas).
export async function checkCredentials(db: Db, email: string, password: string) {
  const u = findUserByEmail(db, email)
  if (!u) { await burnPasswordTime(password); return null }
  return (await verifyPassword(password, u.password_hash)) ? u : null
}

// --- sessions ---------------------------------------------------------------------------------------------------------------
export function createSession(db: Db, userId: number, stage: Stage, userAgent = ''): { token: string; session: Session } {
  const token = randomToken()
  const session: Session = {
    id: sha256(token), user_id: userId, stage, csrf: randomToken(18), attempts: 0,
    expires_at: now() + (stage === 'full' ? FULL_SESSION_MS : PENDING_SESSION_MS),
  }
  db.prepare('INSERT INTO sessions (id, user_id, stage, csrf, attempts, created_at, expires_at, user_agent) VALUES (?, ?, ?, ?, 0, ?, ?, ?)')
    .run(session.id, userId, stage, session.csrf, now(), session.expires_at, userAgent.slice(0, 200))
  return { token, session }
}

export function getSession(db: Db, token: string | undefined): { session: Session; user: User } | null {
  if (!token) return null
  const id = sha256(token)
  const s = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as Session | undefined
  if (!s) return null
  if (s.expires_at <= now()) { deleteSession(db, token); return null }
  const user = db.prepare('SELECT id, email, totp_enabled FROM users WHERE id = ?').get(s.user_id) as User | undefined
  if (!user) return null
  return { session: s, user }
}

export const deleteSession = (db: Db, token: string) => { db.prepare('DELETE FROM sessions WHERE id = ?').run(sha256(token)) }
export const deleteUserSessions = (db: Db, userId: number, exceptId?: string) => {
  db.prepare('DELETE FROM sessions WHERE user_id = ? AND id != ?').run(userId, exceptId ?? '')
}
export const purgeExpiredSessions = (db: Db) => { db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now()) }

// Remplace une session par une nouvelle (changement de niveau) : l'ancien jeton cesse de fonctionner.
export function promoteSession(db: Db, oldToken: string, userId: number, stage: Stage, userAgent = '') {
  deleteSession(db, oldToken)
  return createSession(db, userId, stage, userAgent)
}

// Compte une tentative de code A2F. Au-dela de la limite la session est detruite (il faut ressaisir le mot de passe).
export function noteMfaAttempt(db: Db, session: Session): boolean {
  db.prepare('UPDATE sessions SET attempts = attempts + 1 WHERE id = ?').run(session.id)
  if (session.attempts + 1 >= MAX_MFA_ATTEMPTS) { db.prepare('DELETE FROM sessions WHERE id = ?').run(session.id); return false }
  return true
}

// --- A2F --------------------------------------------------------------------------------------------------------------------
// Etape 1 : genere (ou reprend) un secret en attente pour l'utilisateur. Il n'est actif qu'apres confirmation.
export function beginTotpSetup(db: Db, userId: number): string {
  const row = db.prepare('SELECT totp_secret, totp_enabled FROM users WHERE id = ?').get(userId) as { totp_secret: string | null; totp_enabled: number }
  if (row.totp_enabled) throw new Error('A2F deja active')
  if (row.totp_secret) return decryptSecret(row.totp_secret)
  const secret = generateTotpSecret()
  db.prepare('UPDATE users SET totp_secret = ? WHERE id = ?').run(encryptSecret(secret), userId)
  return secret
}

// Etape 2 : confirme avec un code valide, active l'A2F et renvoie les codes de secours (affiches une seule fois).
export function confirmTotpSetup(db: Db, userId: number, code: string): string[] | null {
  const row = db.prepare('SELECT totp_secret, totp_enabled FROM users WHERE id = ?').get(userId) as { totp_secret: string | null; totp_enabled: number }
  if (row.totp_enabled || !row.totp_secret) return null
  const step = verifyTotp(decryptSecret(row.totp_secret), code)
  if (step === null) return null
  const codes = generateRecoveryCodes()
  db.exec('BEGIN')
  try {
    db.prepare('UPDATE users SET totp_enabled = 1, totp_last_step = ? WHERE id = ?').run(step, userId)
    db.prepare('DELETE FROM recovery_codes WHERE user_id = ?').run(userId)
    const ins = db.prepare('INSERT INTO recovery_codes (user_id, code_hash) VALUES (?, ?)')
    for (const c of codes) ins.run(userId, sha256(normalizeRecoveryCode(c)))
    db.exec('COMMIT')
  } catch (e) { db.exec('ROLLBACK'); throw e }
  return codes
}

// Verifie le 2e facteur : code TOTP (une seule fois par pas de 30 s) ou code de secours (a usage unique).
export function verifySecondFactor(db: Db, userId: number, input: string): 'totp' | 'recovery' | null {
  const u = db.prepare('SELECT totp_secret, totp_enabled, totp_last_step FROM users WHERE id = ?').get(userId) as
    { totp_secret: string | null; totp_enabled: number; totp_last_step: number } | undefined
  if (!u || !u.totp_enabled || !u.totp_secret) return null
  const step = verifyTotp(decryptSecret(u.totp_secret), input)
  if (step !== null) {
    if (step <= u.totp_last_step) return null // code deja utilise : on refuse le rejeu
    db.prepare('UPDATE users SET totp_last_step = ? WHERE id = ?').run(step, userId)
    return 'totp'
  }
  const hash = sha256(normalizeRecoveryCode(input))
  const r = db.prepare('UPDATE recovery_codes SET used_at = ? WHERE user_id = ? AND code_hash = ? AND used_at IS NULL').run(now(), userId, hash)
  return Number(r.changes) > 0 ? 'recovery' : null
}

export const remainingRecoveryCodes = (db: Db, userId: number) =>
  (db.prepare('SELECT COUNT(*) AS n FROM recovery_codes WHERE user_id = ? AND used_at IS NULL').get(userId) as { n: number }).n

// --- limitation de debit (en memoire) ---------------------------------------------------------------------------------------
export class RateLimiter {
  private hits = new Map<string, { count: number; resetAt: number }>()
  private max: number
  private windowMs: number
  constructor(max: number, windowMs: number) { this.max = max; this.windowMs = windowMs }
  // Enregistre une tentative ; renvoie false si la limite est depassee.
  hit(key: string): boolean {
    const t = now()
    const e = this.hits.get(key)
    if (!e || e.resetAt <= t) { this.hits.set(key, { count: 1, resetAt: t + this.windowMs }); return true }
    e.count++
    return e.count <= this.max
  }
  blocked(key: string): boolean {
    const e = this.hits.get(key)
    return !!e && e.resetAt > now() && e.count >= this.max
  }
  reset(key: string) { this.hits.delete(key) }
  retryAfterSeconds(key: string) { const e = this.hits.get(key); return e ? Math.max(1, Math.ceil((e.resetAt - now()) / 1000)) : 0 }
}
