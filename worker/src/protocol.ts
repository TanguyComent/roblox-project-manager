// Copie des types du protocole defini par le Host (host/src/worker-protocol.ts) : a garder identique.
export const WORKER_WS_PATH = '/ws/worker'
export const PROTOCOL_VERSION = 1

// Worker -> Host
export type WorkerMessage =
  | { type: 'hello'; token: string; protocol: number; version: string; info: Record<string, unknown>; capabilities?: Capability[] }
  | { type: 'capabilities'; capabilities: Capability[] }
  | { type: 'heartbeat'; busyJobId: number | null }
  | { type: 'event'; jobId: number; level: 'info' | 'warn' | 'error'; text: string; kind?: 'info' | 'thinking' | 'tool' | 'text' }
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
export type PairingResult = { ok: true; hostUrl: string; token: string } | { ok: false; reason: string }

/** Lit ce que l'utilisateur a colle : le code `rpm1.…` (meme entoure de texte ou coupe par des retours a la ligne) ou les deux lignes du .env. */
export function readPairingInput(input: string): PairingResult {
  const text = String(input).slice(0, 5000)
  const fromEnv = (() => {
    const u = /RPM_HOST_URL\s*=\s*(\S+)/.exec(text)?.[1]
    const t = /RPM_WORKER_TOKEN\s*=\s*(\S+)/.exec(text)?.[1]
    return u && t ? { u: u.replace(/^["']|["']$/g, ''), t: t.replace(/^["']|["']$/g, '') } : null
  })()
  let data: { u?: unknown; t?: unknown } | null = fromEnv
  if (!data) {
    const code = /rpm1\.[A-Za-z0-9_-]+/.exec(text.replace(/\s+/g, ''))?.[0]
    if (!code) {
      if (/rpmw_/.test(text)) return { ok: false, reason: "Tu as colle le jeton seul : il faut le code de jumelage complet (il commence par rpm1.), ou bien les deux lignes du .env." }
      return { ok: false, reason: "Ce n'est pas un code de jumelage : il commence par rpm1. et s'affiche sur la page Workers du site, a la creation du Worker (ou apres « Regenerer le jeton »)." }
    }
    try { data = JSON.parse(Buffer.from(code.slice(PAIRING_PREFIX.length), 'base64url').toString('utf8')) as { u?: unknown; t?: unknown } }
    catch { return { ok: false, reason: 'Code incomplet ou abime : recopie-le en entier (il est long, une seule ligne).' } }
  }
  if (typeof data?.u !== 'string' || typeof data.t !== 'string') return { ok: false, reason: 'Code incomplet ou abime : recopie-le en entier.' }
  let url: URL
  try { url = new URL(data.u) } catch { return { ok: false, reason: `Adresse du Host illisible dans le code (« ${data.u.slice(0, 60)} »). Verifie PUBLIC_URL cote Host.` } }
  if (!['http:', 'https:'].includes(url.protocol)) return { ok: false, reason: `Adresse du Host invalide dans le code (« ${data.u.slice(0, 60)} ») : elle doit commencer par http:// ou https://. Verifie PUBLIC_URL cote Host.` }
  if (!/^rpmw_[A-Za-z0-9_-]{20,200}$/.test(data.t)) return { ok: false, reason: 'Le jeton contenu dans le code est invalide : regenere-le sur le site.' }
  return { ok: true, hostUrl: url.origin, token: data.t }
}

export function parsePairingCode(input: string): { hostUrl: string; token: string } | null {
  const r = readPairingInput(input)
  return r.ok ? { hostUrl: r.hostUrl, token: r.token } : null
}

/** Ce a quoi un Worker a acces (voir host/src/worker-protocol.ts). */
export interface Capability { id: string; label: string; version: string | null }
