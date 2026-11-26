// Hub des Workers : accepte leurs connexions WebSocket, suit leur presence et leur distribue les taches (file d'attente comprise).
// Regle : un Worker n'execute que les taches de SON proprietaire, une a la fois.
import type { Server } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocketServer, type WebSocket } from 'ws'
import type { Db } from './db.ts'
import { CLOSE, JOB_KINDS, PROTOCOL_VERSION, WORKER_WS_PATH, type HostMessage, type WorkerMessage } from './worker-protocol.ts'
import {
  addJobEvent, failOrphanedJobs, finishJob, findWorkerByToken, getJob, getWorker, insertJob, markJobRunning, queuedJobs, runningJobOf, sanitizeCapabilities, setWorkerCapabilities, touchWorker,
  type Job,
} from './workers.ts'

const HEARTBEAT_MS = 15_000
const PING_MS = 20_000
const HELLO_TIMEOUT_MS = 10_000
const MAX_PAYLOAD = 1024 * 1024

interface Conn { ws: WebSocket; workerId: number; userId: number; poolId: number | null; name: string; busyJobId: number | null; alive: boolean }

export type WorkerStatus = 'offline' | 'idle' | 'busy'
export interface Target { workerId?: number | null; poolId?: number | null }

export class WorkerHub {
  private db: Db
  private wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD })
  private conns = new Map<number, Conn>()
  private timer?: NodeJS.Timeout

  constructor(db: Db) {
    this.db = db
    failOrphanedJobs(db)
  }

  // --- connexion --------------------------------------------------------------------------------------------------------------
  /** Branche le hub sur le serveur HTTP : seules les demandes d'upgrade vers /ws/worker sont prises. */
  attach(server: Server) {
    server.on('upgrade', (req, socket: Duplex, head) => {
      const path = new URL(req.url ?? '/', 'http://x').pathname
      if (path !== WORKER_WS_PATH) { socket.destroy(); return }
      this.wss.handleUpgrade(req, socket, head, (ws) => this.accept(ws))
    })
    this.timer = setInterval(() => this.sweep(), PING_MS)
    this.timer.unref()
  }

  private send(ws: WebSocket, msg: HostMessage) { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg)) }

  private accept(ws: WebSocket) {
    let conn: Conn | undefined
    const helloTimer = setTimeout(() => ws.close(CLOSE.badHello, 'hello attendu'), HELLO_TIMEOUT_MS)
    helloTimer.unref()

    ws.on('message', (data) => {
      let msg: WorkerMessage
      try { msg = JSON.parse(String(data)) as WorkerMessage } catch { ws.close(CLOSE.badHello, 'message illisible'); return }
      if (!conn) {
        if (msg.type !== 'hello') { ws.close(CLOSE.badHello, 'hello attendu'); return }
        clearTimeout(helloTimer)
        conn = this.hello(ws, msg)
        return
      }
      this.handle(conn, msg)
    })
    ws.on('pong', () => { if (conn) conn.alive = true })
    ws.on('close', () => { clearTimeout(helloTimer); if (conn && this.conns.get(conn.workerId) === conn) this.drop(conn) })
    ws.on('error', () => { /* la fermeture suit */ })
  }

  private hello(ws: WebSocket, msg: Extract<WorkerMessage, { type: 'hello' }>): Conn | undefined {
    const w = findWorkerByToken(this.db, msg.token)
    if (!w) { this.send(ws, { type: 'error', message: 'Jeton invalide ou revoque.' }); ws.close(CLOSE.badToken, 'jeton invalide'); return undefined }
    if (msg.protocol !== PROTOCOL_VERSION) {
      this.send(ws, { type: 'error', message: `Version de protocole non prise en charge (${msg.protocol}, attendu ${PROTOCOL_VERSION}).` })
      ws.close(CLOSE.badHello, 'protocole'); return undefined
    }
    const previous = this.conns.get(w.id)
    if (previous) { this.conns.delete(w.id); previous.ws.close(CLOSE.replaced, 'remplace par une nouvelle connexion'); this.interrupt(previous, 'Connexion remplacee') }
    const conn: Conn = { ws, workerId: w.id, userId: w.user_id, poolId: w.pool_id, name: w.name, busyJobId: null, alive: true }
    this.conns.set(w.id, conn)
    const info = { ...(typeof msg.info === 'object' && msg.info ? msg.info : {}), version: String(msg.version ?? '').slice(0, 40), connectedAt: Date.now(), capabilities: sanitizeCapabilities(msg.capabilities) }
    touchWorker(this.db, w.id, info)
    this.send(ws, { type: 'welcome', workerId: w.id, name: w.name, heartbeatMs: HEARTBEAT_MS })
    this.dispatch(w.user_id)
    return conn
  }

  // --- messages d'un Worker connecte ------------------------------------------------------------------------------------------
  private handle(conn: Conn, msg: WorkerMessage) {
    touchWorker(this.db, conn.workerId)
    if (msg.type === 'heartbeat') { conn.alive = true; return }
    if (msg.type === 'capabilities') { setWorkerCapabilities(this.db, conn.workerId, msg.capabilities); return }
    if (msg.type === 'event') {
      if (this.owns(conn, msg.jobId)) addJobEvent(this.db, msg.jobId, msg.level, msg.text)
      return
    }
    if (msg.type === 'result') {
      if (!this.owns(conn, msg.jobId)) return
      if (msg.cancelled) finishJob(this.db, msg.jobId, 'cancelled', msg.output, msg.error)
      else if (msg.ok) finishJob(this.db, msg.jobId, 'succeeded', msg.output)
      else finishJob(this.db, msg.jobId, 'failed', msg.output, msg.error ?? 'La tache a echoue.')
      conn.busyJobId = null
      this.dispatch(conn.userId)
    }
  }

  // Seul le Worker auquel la tache a ete confiee peut en parler.
  private owns(conn: Conn, jobId: number) { return typeof jobId === 'number' && conn.busyJobId === jobId }

  private interrupt(conn: Conn, reason: string) {
    if (conn.busyJobId === null) return
    finishJob(this.db, conn.busyJobId, 'failed', undefined, `${reason} pendant l'execution de la tache.`)
    conn.busyJobId = null
  }

  private drop(conn: Conn) {
    this.conns.delete(conn.workerId)
    this.interrupt(conn, `Le Worker « ${conn.name} » s'est deconnecte`)
    touchWorker(this.db, conn.workerId)
    this.dispatch(conn.userId)
  }

  // Ping regulier : un Worker qui ne repond plus (reseau coupe, machine endormie) est deconnecte.
  private sweep() {
    for (const conn of this.conns.values()) {
      if (!conn.alive) { conn.ws.terminate(); continue }
      conn.alive = false
      try { conn.ws.ping() } catch { /* ferme */ }
    }
  }

  // --- etat ----------------------------------------------------------------------------------------------------------------------
  status(workerId: number): WorkerStatus {
    const c = this.conns.get(workerId)
    return !c ? 'offline' : c.busyJobId === null ? 'idle' : 'busy'
  }

  /** Coupe la connexion d'un Worker (jeton regenere ou Worker supprime). */
  disconnect(workerId: number, reason = 'revoque') {
    const c = this.conns.get(workerId)
    if (!c) return
    this.conns.delete(workerId)
    c.ws.close(CLOSE.revoked, reason)
    this.interrupt(c, 'Le Worker a ete deconnecte par le Host')
  }

  // --- taches --------------------------------------------------------------------------------------------------------------------
  /** Cree une tache et tente de la distribuer tout de suite ; sinon elle attend en file (par utilisateur, dans l'ordre). */
  enqueue(userId: number, kind: string, payload: unknown, target: Target = {}): number {
    if (!(JOB_KINDS as readonly string[]).includes(kind)) throw new Error(`Type de tache inconnu : ${kind}`)
    const id = insertJob(this.db, userId, kind, payload, target)
    this.dispatch(userId)
    return id
  }

  /** Annule une tache : en attente -> annulee tout de suite ; en cours -> le Worker est prie de s'arreter. */
  cancel(userId: number, jobId: number): boolean {
    const job = getJob(this.db, userId, jobId)
    if (!job) return false
    if (job.status === 'queued') { finishJob(this.db, jobId, 'cancelled', undefined, 'Annulee avant son execution.'); return true }
    if (job.status === 'running' && job.worker_id !== null) {
      const c = this.conns.get(job.worker_id)
      if (c && c.busyJobId === jobId) { this.send(c.ws, { type: 'cancel', jobId }); return true }
      finishJob(this.db, jobId, 'cancelled', undefined, 'Annulee (Worker injoignable).')
      return true
    }
    return false
  }

  private accepts(c: Conn, job: Job) {
    if (c.userId !== job.user_id || c.busyJobId !== null) return false
    if (job.target_worker_id !== null) return c.workerId === job.target_worker_id
    if (job.target_pool_id !== null) return c.poolId === job.target_pool_id
    return true
  }

  /** Donne a chaque Worker libre la plus ancienne tache en attente qu'il peut prendre. */
  dispatch(userId: number) {
    for (const job of queuedJobs(this.db, userId)) {
      const target = [...this.conns.values()].find((c) => this.accepts(c, job))
      if (!target) continue
      // le pool d'un Worker a pu changer depuis sa connexion : on relit la base
      const fresh = getWorker(this.db, userId, target.workerId)
      if (!fresh) continue
      target.poolId = fresh.pool_id
      if (!this.accepts(target, job)) continue
      markJobRunning(this.db, job.id, target.workerId)
      target.busyJobId = job.id
      this.send(target.ws, { type: 'job', jobId: job.id, kind: job.kind, payload: job.payload })
    }
  }

  close() {
    if (this.timer) clearInterval(this.timer)
    for (const c of this.conns.values()) c.ws.close(1001, 'arret du Host')
    this.conns.clear()
    this.wss.close()
  }
}
