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
