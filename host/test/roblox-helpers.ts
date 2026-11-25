import { csrfOf, type client as makeClient } from './helpers.ts'
import { KEYS } from './fake-roblox.ts'

type Client = ReturnType<typeof makeClient>

// Connecte un compte Roblox en collant sa cle dans le formulaire de la page Compte (comme un utilisateur).
export async function connectRoblox(c: Client, key: string = KEYS.tanguy, label = '') {
  const csrf = csrfOf((await c.call('GET', '/account')).text)
  const r = await c.call('POST', '/account/roblox', { csrf, label, apiKey: key })
  const row = c.db.prepare('SELECT id FROM roblox_accounts ORDER BY id DESC LIMIT 1').get() as { id: number } | undefined
  return { ...r, csrf, accountId: r.res.status === 303 ? row?.id : undefined }
}
