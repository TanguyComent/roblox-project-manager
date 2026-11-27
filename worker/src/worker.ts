// Coeur du Worker : une connexion SORTANTE vers le Host (rien a ouvrir sur cette machine), reconnectee automatiquement.
import { defaultHandlers, JobCancelled, type JobHandler } from './jobs.ts'
import { downloadAttachment } from './attachments.ts'
import { downloadLibraryImage } from './library.ts'
import { uploadPreview } from './upload.ts'
import { CLOSE, PROTOCOL_VERSION, WORKER_WS_PATH, type Capability, type HostMessage, type WorkerMessage } from './protocol.ts'

export type WorkerState = 'connecting' | 'connected' | 'waiting' | 'stopped' | 'rejected'

export interface WorkerOptions {
  /** Adresse du Host : http(s)://... ou ws(s)://... */
  hostUrl: string
  token: string
  version?: string
  /** Informations affichees sur le site (nom de la machine, systeme, capacites...). */
  info?: Record<string, unknown>
  handlers?: Record<string, JobHandler>
  /** Outils detectes sur la machine, envoyes au Host a chaque connexion (la valeur la plus recente est lue au moment du hello). */
  getCapabilities?: () => Capability[]
  log?: (message: string) => void
  onState?: (state: WorkerState, detail?: string) => void
  /** Delais de reconnexion (ms) : exponentiels entre `minMs` et `maxMs`. */
  backoff?: { minMs: number; maxMs: number }
}

export interface RunningWorker {
  /** Prevenir le Host d'un changement des outils detectes (sans reconnexion). */
  setCapabilities(caps: Capability[]): void
  stop(): Promise<void>
  readonly state: WorkerState
}

export function toWebSocketUrl(hostUrl: string): string {
  const u = new URL(hostUrl)
  u.protocol = u.protocol === 'https:' || u.protocol === 'wss:' ? 'wss:' : 'ws:'
  u.pathname = WORKER_WS_PATH
  u.search = ''
  u.hash = ''
  return u.toString()
}

export function startWorker(opts: WorkerOptions): RunningWorker {
  const url = toWebSocketUrl(opts.hostUrl)
  const handlers = { ...defaultHandlers, ...opts.handlers }
  const log = opts.log ?? (() => {})
  const backoff = opts.backoff ?? { minMs: 1000, maxMs: 30_000 }
  let state: WorkerState = 'connecting'
  let stopped = false
  let ws: WebSocket | undefined
  let retry = 0
  let retryTimer: NodeJS.Timeout | undefined
  let heartbeat: NodeJS.Timeout | undefined
  let current: { jobId: number; abort: AbortController } | null = null
  let finish: () => void = () => {}
  const done = new Promise<void>((resolve) => { finish = resolve })

  const setState = (s: WorkerState, detail?: string) => { state = s; opts.onState?.(s, detail) }
  const send = (msg: WorkerMessage) => { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg)) }

  async function runJob(jobId: number, kind: string, payload: unknown) {
    const abort = new AbortController()
    current = { jobId, abort }
    const handler = handlers[kind]
    try {
      if (!handler) throw new Error(`Type de tache non pris en charge par ce Worker : ${kind}`)
      log(`tache ${jobId} (${kind}) : debut`)
      const output = await handler({
        jobId, payload, signal: abort.signal,
        event: (level, text, kind) => send({ type: 'event', jobId, level, text, ...(kind ? { kind } : {}) }),
        uploadPreview: (dir, meta) => uploadPreview(opts.hostUrl, opts.token, jobId, dir, meta),
        downloadAttachment: (id) => downloadAttachment(opts.hostUrl, opts.token, id),
        downloadLibraryImage: (id) => downloadLibraryImage(opts.hostUrl, opts.token, id),
      })
      send({ type: 'result', jobId, ok: true, output })
      log(`tache ${jobId} : terminee`)
    } catch (e) {
      if (e instanceof JobCancelled || abort.signal.aborted) {
        send({ type: 'result', jobId, ok: false, cancelled: true, error: 'Tache annulee.' })
        log(`tache ${jobId} : annulee`)
      } else {
        const message = e instanceof Error ? e.message : String(e)
        send({ type: 'result', jobId, ok: false, error: message })
        log(`tache ${jobId} : echec (${message})`)
      }
    } finally {
      if (current?.jobId === jobId) current = null
    }
  }

  function connect() {
    if (stopped) return
    setState('connecting')
    const socket = new WebSocket(url)
    ws = socket

    socket.addEventListener('open', () => {
      send({ type: 'hello', token: opts.token, protocol: PROTOCOL_VERSION, version: opts.version ?? '0.1.0', info: opts.info ?? {}, capabilities: opts.getCapabilities?.() ?? [] })
    })

    socket.addEventListener('message', (ev) => {
      let msg: HostMessage
      try { msg = JSON.parse(String(ev.data)) as HostMessage } catch { return }
      if (msg.type === 'welcome') {
        retry = 0
        setState('connected', msg.name)
        log(`connecte au Host en tant que « ${msg.name} »`)
        heartbeat = setInterval(() => send({ type: 'heartbeat', busyJobId: current?.jobId ?? null }), msg.heartbeatMs)
        heartbeat.unref?.()
      } else if (msg.type === 'job') {
        void runJob(msg.jobId, msg.kind, msg.payload)
      } else if (msg.type === 'cancel') {
        if (current?.jobId === msg.jobId) current.abort.abort()
      } else if (msg.type === 'error') {
        log(`Host : ${msg.message}`)
      }
    })

    socket.addEventListener('close', (ev) => {
      if (heartbeat) clearInterval(heartbeat)
      heartbeat = undefined
      current?.abort.abort() // le Host a deja considere la tache comme perdue : inutile de la poursuivre
      if (stopped) { setState('stopped'); finish(); return }
      if (ev.code === CLOSE.badToken || ev.code === CLOSE.revoked || ev.code === CLOSE.replaced || ev.code === CLOSE.badHello) {
        const why = ev.code === CLOSE.replaced ? 'un autre Worker utilise le meme jeton' : ev.code === CLOSE.revoked ? 'jeton revoque ou Worker supprime' : ev.code === CLOSE.badToken ? 'jeton invalide' : 'message refuse par le Host'
        log(`connexion refusee (${why}) : arret, pas de nouvelle tentative`)
        stopped = true
        setState('rejected', why)
        finish()
        return
      }
      const delay = Math.min(backoff.minMs * 2 ** retry, backoff.maxMs) * (0.75 + Math.random() * 0.5)
      retry++
      setState('waiting', `${Math.round(delay)} ms`)
      log(`connexion perdue (code ${ev.code}) : nouvelle tentative dans ${Math.round(delay / 100) / 10} s`)
      retryTimer = setTimeout(connect, delay)
    })

    socket.addEventListener('error', () => { /* « close » suit toujours */ })
  }

  connect()

  return {
    get state() { return state },
    setCapabilities(caps) { send({ type: 'capabilities', capabilities: caps }) },
    async stop() {
      if (stopped && state !== 'connected') { return }
      stopped = true
      if (retryTimer) clearTimeout(retryTimer)
      current?.abort.abort()
      if (ws && ws.readyState <= WebSocket.OPEN) { ws.close(1000, 'arret du Worker'); await done } else { setState('stopped'); finish() }
    },
  }
}
