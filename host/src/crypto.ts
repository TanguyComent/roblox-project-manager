// Primitives de securite : hachage des mots de passe (scrypt), jetons, chiffrement des secrets (AES-256-GCM), TOTP (RFC 6238).
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomInt, scrypt, timingSafeEqual } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { config, ensureDataDir } from './config.ts'

const scryptAsync = promisify(scrypt) as (pw: string, salt: Buffer, len: number, opts: object) => Promise<Buffer>
const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 128 * 1024 * 1024 }

// --- mots de passe ----------------------------------------------------------------------------------------------------------
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16)
  const key = await scryptAsync(password.normalize('NFKC'), salt, 64, SCRYPT)
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${key.toString('base64')}`
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [alg, n, r, p, saltB64, keyB64] = stored.split('$')
  if (alg !== 'scrypt') return false
  const expected = Buffer.from(keyB64, 'base64')
  const key = await scryptAsync(password.normalize('NFKC'), Buffer.from(saltB64, 'base64'), expected.length, { N: Number(n), r: Number(r), p: Number(p), maxmem: SCRYPT.maxmem })
  return timingSafeEqual(key, expected)
}

// Hash factice, verifie quand l'e-mail est inconnu : la reponse prend le meme temps qu'avec un vrai compte.
let dummy: string | undefined
export async function burnPasswordTime(password: string) {
  dummy ??= await hashPassword('dummy-password-for-timing')
  await verifyPassword(password, dummy)
}

// --- jetons -------------------------------------------------------------------------------------------------------------------
export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url')
export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')
export const safeEqual = (a: string, b: string) => {
  const ba = Buffer.from(a)
  const bb = Buffer.from(b)
  return ba.length === bb.length && timingSafeEqual(ba, bb)
}

// Codes de secours : 10 codes "xxxxx-xxxxx" (alphabet sans caracteres ambigus), stockes haches.
const RECOVERY_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'
export function generateRecoveryCodes(count = 10): string[] {
  const part = () => Array.from({ length: 5 }, () => RECOVERY_ALPHABET[randomInt(RECOVERY_ALPHABET.length)]).join('')
  return Array.from({ length: count }, () => `${part()}-${part()}`)
}
export const normalizeRecoveryCode = (c: string) => c.trim().toLowerCase().replace(/\s+/g, '')

// --- chiffrement des secrets --------------------------------------------------------------------------------------------------
let key: Buffer | undefined
function secretKey(): Buffer {
  if (key) return key
  if (config.secretKey) key = Buffer.from(config.secretKey, 'base64')
  else {
    ensureDataDir()
    const file = join(config.dataDir, 'secret.key')
    if (!existsSync(file)) writeFileSync(file, randomBytes(32).toString('base64'), { mode: 0o600 })
    key = Buffer.from(readFileSync(file, 'utf8').trim(), 'base64')
  }
  if (key.length !== 32) throw new Error('La cle de chiffrement doit faire 32 octets (base64).')
  return key
}

export function encryptSecret(plain: string): string {
  const iv = randomBytes(12)
  const c = createCipheriv('aes-256-gcm', secretKey(), iv)
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()])
  return `${iv.toString('base64')}.${enc.toString('base64')}.${c.getAuthTag().toString('base64')}`
}

export function decryptSecret(stored: string): string {
  const [iv, enc, tag] = stored.split('.').map((p) => Buffer.from(p, 'base64'))
  const d = createDecipheriv('aes-256-gcm', secretKey(), iv)
  d.setAuthTag(tag)
  return Buffer.concat([d.update(enc), d.final()]).toString('utf8')
}

// --- TOTP (RFC 6238 : SHA-1, 6 chiffres, pas de 30 s) -------------------------------------------------------------------------
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
export function base32Encode(buf: Buffer): string {
  let bits = 0, value = 0, out = ''
  for (const byte of buf) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5 }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31]
  return out
}
export function base32Decode(s: string): Buffer {
  let bits = 0, value = 0
  const out: number[] = []
  for (const ch of s.replace(/=+$/, '').toUpperCase()) {
    const idx = B32.indexOf(ch)
    if (idx < 0) throw new Error('base32 invalide')
    value = (value << 5) | idx
    bits += 5
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8 }
  }
  return Buffer.from(out)
}

export const TOTP_STEP = 30
export const generateTotpSecret = () => base32Encode(randomBytes(20))

export function totpAt(secret: string, counter: number): string {
  const msg = Buffer.alloc(8)
  msg.writeBigUInt64BE(BigInt(counter))
  const h = createHmac('sha1', base32Decode(secret)).update(msg).digest()
  const off = h[h.length - 1] & 15
  const code = ((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3]
  return String(code % 1_000_000).padStart(6, '0')
}

// Verifie un code avec une tolerance de +-1 pas (decalage d'horloge). Renvoie le pas accepte (pour interdire le rejeu) ou null.
export function verifyTotp(secret: string, input: string, now = Date.now()): number | null {
  const code = input.replace(/\s+/g, '')
  if (!/^\d{6}$/.test(code)) return null
  const counter = Math.floor(now / 1000 / TOTP_STEP)
  for (const delta of [0, -1, 1]) if (safeEqual(totpAt(secret, counter + delta), code)) return counter + delta
  return null
}

export function otpauthUrl(account: string, secret: string): string {
  const issuer = encodeURIComponent(config.appName)
  return `otpauth://totp/${issuer}:${encodeURIComponent(account)}?secret=${secret}&issuer=${issuer}&algorithm=SHA1&digits=6&period=${TOTP_STEP}`
}
