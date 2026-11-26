// L'« agent » : ce que l'interface locale pilote (configuration, connexion au Host, journal). Aucune dependance reseau ici hormis le Worker.
import { DEFAULT_ENV_PATH, readConfig, writeConfig } from './config.ts'
import { detectCapabilities } from './capabilities.ts'
import { readPairingInput, type Capability } from './protocol.ts'
import { startWorker, type RunningWorker, type WorkerOptions, type WorkerState } from './worker.ts'

export type AgentState = 'unconfigured' | 'stopped' | WorkerState

export interface AgentSnapshot {
  state: AgentState
  hostUrl: string | null
  workerName: string | null
  detail: string
  logs: string[]
  startedAt: number
  capabilities: Capability[]
  scanning: boolean
}

export interface Agent {
  snapshot(): AgentSnapshot
  start(): void
  stop(): Promise<void>
  pair(code: string): Promise<{ ok: true } | { ok: false; error: string }>
  forget(): Promise<void>
  log(message: string): void
  /** Relance la detection des outils et previent le Host. */
  rescan(): Promise<void>
}

const MAX_LOGS = 200

export function createAgent(o: { envPath?: string; version: string; info: Record<string, unknown>; launch?: (opts: WorkerOptions) => RunningWorker; backoff?: WorkerOptions['backoff']; echo?: (line: string) => void; detect?: () => Promise<Capability[]> }): Agent {
  const envPath = o.envPath ?? DEFAULT_ENV_PATH
  const launch = o.launch ?? startWorker
  const logs: string[] = []
  const startedAt = Date.now()
  let state: AgentState = readConfig(envPath) ? 'stopped' : 'unconfigured'
  let detail = ''
  let workerName: string | null = null
  let hostUrl: string | null = null
  let current: RunningWorker | null = null
  let caps: Capability[] = []
  let scanning = false
  const detect = o.detect ?? detectCapabilities
  let generation = 0 // change a chaque (re)demarrage et a chaque arret : les evenements d'une connexion perimee sont ignores

  const log = (message: string) => {
    const line = `${new Date().toLocaleTimeString('fr-FR')}  ${message}`
    logs.push(line)
    if (logs.length > MAX_LOGS) logs.shift()
    o.echo?.(line)
  }

  function start() {
    if (current) return
    const cfg = readConfig(envPath)
    if (!cfg) { state = 'unconfigured'; detail = ''; hostUrl = null; return }
    hostUrl = cfg.hostUrl
    workerName = null
    const gen = ++generation
    current = launch({
      hostUrl: cfg.hostUrl, token: cfg.token, version: o.version, info: o.info, backoff: o.backoff, log, getCapabilities: () => caps,
      onState: (s, d) => {
        if (gen !== generation) return // evenement d'une ancienne connexion
        state = s
        detail = d ?? ''
        if (s === 'connected') workerName = d ?? null
        if (s === 'rejected') current = null
      },
    })
    if (gen === generation && state !== 'rejected') { state = 'connecting'; detail = '' }
  }

  async function stop() {
    const w = current
    current = null
    generation++
    if (w) await w.stop()
    state = readConfig(envPath) ? 'stopped' : 'unconfigured'
    detail = ''
    workerName = null
  }

  return {
    // Un .env cree ou modifie a la main apres le lancement est pris en compte des que la page est rechargee.
    snapshot: () => {
      if (state === 'unconfigured' && !current && readConfig(envPath)) start()
      return { state, hostUrl, workerName, detail, logs: [...logs], startedAt, capabilities: caps, scanning }
    },
    start, stop, log,
    async rescan() {
      if (scanning) return
      scanning = true
      try {
        const next = await detect()
        const changed = JSON.stringify(next) !== JSON.stringify(caps)
        caps = next
        if (changed) log(`outils detectes : ${next.length ? next.map((c) => c.label + (c.version ? ` ${c.version}` : '')).join(', ') : 'aucun'}`)
        current?.setCapabilities(caps) // le Host est tenu a jour sans reconnexion
      } catch (e) { log(`detection des outils impossible : ${e instanceof Error ? e.message : String(e)}`) }
      finally { scanning = false }
    },
    async pair(code) {
      const parsed = readPairingInput(code)
      if (!parsed.ok) return { ok: false, error: parsed.reason }
      writeConfig({ hostUrl: parsed.hostUrl, token: parsed.token }, envPath)
      log(`jumele avec ${parsed.hostUrl}`)
      await stop()
      start()
      return { ok: true }
    },
    async forget() {
      await stop()
      writeConfig(null, envPath)
      hostUrl = null
      state = 'unconfigured'
      log('jumelage supprime')
    },
  }
}
