// Protocole Host <-> Worker (messages JSON sur un WebSocket que le WORKER ouvre vers le Host : aucun port a ouvrir cote Worker).
// Le paquet worker/ en garde une copie des types : toute modification doit etre repercutee dans worker/src/protocol.ts.

export const WORKER_WS_PATH = '/ws/worker'
export const PROTOCOL_VERSION = 1

/** Types de taches que le Host sait envoyer. Les autres seront ajoutes avec les agents, Studio, Blender... */
export const JOB_KINDS = ['echo', 'sleep'] as const
export type JobKind = (typeof JOB_KINDS)[number]

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

/** Codes de fermeture applicatifs (4000-4999). */
export const CLOSE = { badToken: 4401, badHello: 4400, replaced: 4409, revoked: 4403 } as const

/**
 * Code de jumelage : une seule chaine a coller dans l'interface du Worker (adresse du Host + jeton).
 * Il contient le jeton : il est traite comme lui (affiche une seule fois). Le decodage est dans worker/src/protocol.ts.
 */
export const PAIRING_PREFIX = 'rpm1.'
export const encodePairingCode = (hostUrl: string, token: string) =>
  PAIRING_PREFIX + Buffer.from(JSON.stringify({ u: hostUrl, t: token }), 'utf8').toString('base64url')
