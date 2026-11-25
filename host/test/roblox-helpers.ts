import assert from 'node:assert/strict'
import type { client as makeClient } from './helpers.ts'

type Client = ReturnType<typeof makeClient>

// Deroule la connexion OAuth comme un navigateur : /connect -> redirection vers Roblox -> retour sur /callback.
export async function connectRoblox(c: Client, sub = '1001') {
  const start = await c.call('GET', '/account/roblox/connect')
  assert.equal(start.res.status, 302, 'redirection vers Roblox')
  const authorize = new URL(start.res.headers.get('location')!)
  assert.equal(authorize.origin + authorize.pathname, 'https://apis.roblox.com/oauth/v1/authorize')
  const state = authorize.searchParams.get('state')!
  const back = await c.call('GET', `/account/roblox/callback?code=code-${sub}&state=${encodeURIComponent(state)}`)
  const row = c.db.prepare('SELECT id FROM roblox_accounts WHERE roblox_user_id = ? ORDER BY id DESC LIMIT 1').get(sub) as { id: number } | undefined
  return { start, authorize, state, back, accountId: row?.id }
}
