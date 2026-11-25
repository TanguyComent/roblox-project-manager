// Reglages d'instance (modifiables depuis la page Reglages par l'administrateur), chiffres en base.
// Le .env reste possible en solution de secours : la base prime sur lui.
import { config } from './config.ts'
import { decryptSecret, encryptSecret } from './crypto.ts'
import type { Db } from './db.ts'
import type { RobloxCredentials } from './roblox.ts'

export const KEYS = {
  robloxClientId: 'roblox.client_id',
  robloxClientSecret: 'roblox.client_secret',
  robloxScopes: 'roblox.scopes',
} as const

export function getSetting(db: Db, key: string): string | undefined {
  const row = db.prepare('SELECT value_enc FROM settings WHERE key = ?').get(key) as { value_enc: string } | undefined
  return row ? decryptSecret(row.value_enc) : undefined
}

export function setSetting(db: Db, key: string, value: string) {
  db.prepare(
    'INSERT INTO settings (key, value_enc, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value_enc = excluded.value_enc, updated_at = excluded.updated_at',
  ).run(key, encryptSecret(value), Date.now())
}

export function deleteSettings(db: Db, keys: string[]) {
  for (const k of keys) db.prepare('DELETE FROM settings WHERE key = ?').run(k)
}

// Identifiants de l'application OAuth Roblox : la base d'abord, puis le .env.
export function robloxCredentials(db: Db): RobloxCredentials {
  return {
    clientId: getSetting(db, KEYS.robloxClientId) ?? config.robloxClientId,
    clientSecret: getSetting(db, KEYS.robloxClientSecret) ?? config.robloxClientSecret,
    scopes: getSetting(db, KEYS.robloxScopes) ?? config.robloxScopes,
  }
}

export type SettingsSource = 'database' | 'env' | 'none'

// D'ou viennent les identifiants actuels (jamais leur valeur, surtout pas le secret).
export function robloxSource(db: Db): { source: SettingsSource; clientId: string; hasSecret: boolean; scopes: string } {
  const dbId = getSetting(db, KEYS.robloxClientId)
  const dbSecret = getSetting(db, KEYS.robloxClientSecret)
  const c = robloxCredentials(db)
  return {
    source: dbId && dbSecret ? 'database' : c.clientId && c.clientSecret ? 'env' : 'none',
    clientId: c.clientId ?? '',
    hasSecret: !!c.clientSecret,
    scopes: c.scopes ?? config.robloxScopes,
  }
}
