// Copie des types du protocole defini par le Host (host/src/worker-protocol.ts) : a garder identique.
export const WORKER_WS_PATH = '/ws/worker'
export const PROTOCOL_VERSION = 1

// Worker -> Host
export type WorkerMessage =
  | { type: 'hello'; token: string; protocol: number; version: string; info: Record<string, unknown> }
  | { type: 'heartbeat'; busyJobId: number | null }
  | { type: 'event'; jobId: number; level: 'info' | 'warn' | 'error'; text: string }
  | { type: 'result'; jobId: number; ok: boolean; cancelled?: boolean; output?: unknown; error?: string }

// Host -> Worker
export type HostMessage =
  | { type: 'welcome'; workerId: number; name: string; heartbeatMs: number }
  | { type: 'job'; jobId: number; kind: string; payload: unknown }
  | { type: 'cancel'; jobId: number }
  | { type: 'error'; message: string }

/** Codes de fermeture applicatifs : le Worker ne se reconnecte pas apres ceux-la (la situation ne se regle pas toute seule). */
export const CLOSE = { badToken: 4401, badHello: 4400, replaced: 4409, revoked: 4403 } as const

/** Code de jumelage affiche par le Host a la creation d'un Worker (voir host/src/worker-protocol.ts) : adresse du Host + jeton. */
export const PAIRING_PREFIX = 'rpm1.'
export function parsePairingCode(input: string): { hostUrl: string; token: string } | null {
  const code = input.trim()
  if (!code.startsWith(PAIRING_PREFIX) || code.length > 2000) return null
  try {
    const data = JSON.parse(Buffer.from(code.slice(PAIRING_PREFIX.length), 'base64url').toString('utf8')) as { u?: unknown; t?: unknown }
    if (typeof data.u !== 'string' || typeof data.t !== 'string') return null
    const url = new URL(data.u)
    if (!['http:', 'https:'].includes(url.protocol) || !/^rpmw_[A-Za-z0-9_-]{20,200}$/.test(data.t)) return null
    return { hostUrl: url.origin, token: data.t }
  } catch { return null }
}
