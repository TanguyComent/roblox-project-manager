// Outils du Worker donnes a l'IA : un petit serveur MCP (protocole HTTP, reponses JSON) qui tourne DANS le processus du Worker, sur 127.0.0.1 seulement.
// Claude Code s'y connecte par `--mcp-config` ; il y trouve les outils (capture d'une UI, ouverture de la branche du projet...) et recoit leurs resultats,
// images comprises. Tout ce qui touche au depot ou a l'emulateur reste ainsi dans le Worker, avec ses controles.
//
// Securite : ecoute sur la boucle locale uniquement ; chaque tache obtient un jeton secret aleatoire (en-tete Authorization) valable le temps de la tache ;
// un nom d'hote inattendu est refuse (anti « DNS rebinding ») ; corps limite ; les outils valident leurs arguments.
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

export type ToolContent = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }
export interface ToolResult { content: ToolContent[]; isError?: boolean }
export interface ToolDef {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  run(args: Record<string, unknown>, signal: AbortSignal): Promise<ToolResult>
}

export const text = (t: string, isError = false): ToolResult => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError: true } : {}) })

const MAX_BODY = 256 * 1024
const TOOL_TIMEOUT_MS = 10 * 60_000
const PROTOCOL = '2025-06-18'

interface Session { tools: Map<string, ToolDef>; signal: AbortSignal }

export class ToolServer {
  private server: Server | null = null
  private port = 0
  private sessions = new Map<string, Session>()

  /** Demarre l'ecoute (une seule fois) ; l'adresse est choisie par le systeme. */
  async start(): Promise<void> {
    if (this.server) return
    const server = createServer((req, res) => { void this.handle(req, res).catch(() => { if (!res.headersSent) res.writeHead(500).end() }) })
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    server.unref()
    this.server = server
    this.port = (server.address() as AddressInfo).port
  }

  /** Ouvre une session pour UNE tache : renvoie l'adresse et le jeton a donner a Claude, et de quoi la refermer. */
  async register(tools: ToolDef[], signal: AbortSignal): Promise<{ url: string; token: string; dispose(): void }> {
    await this.start()
    const token = randomBytes(24).toString('base64url')
    this.sessions.set(token, { tools: new Map(tools.map((t) => [t.name, t])), signal })
    return { url: `http://127.0.0.1:${this.port}/mcp`, token, dispose: () => { this.sessions.delete(token) } }
  }

  close() {
    this.sessions.clear()
    this.server?.close()
    this.server = null
  }

  private sessionOf(header: string | undefined): Session | null {
    const given = /^Bearer\s+(\S+)$/.exec(header ?? '')?.[1]
    if (!given) return null
    for (const [token, s] of this.sessions) {
      const a = Buffer.from(token)
      const b = Buffer.from(given)
      if (a.length === b.length && timingSafeEqual(a, b)) return s
    }
    return null
  }

  private async handle(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) {
    const send = (status: number, body?: unknown) => {
      res.writeHead(status, body === undefined ? {} : { 'Content-Type': 'application/json' })
      res.end(body === undefined ? undefined : JSON.stringify(body))
    }
    // Anti « DNS rebinding » : seul l'hote exact de la boucle locale est accepte.
    const host = req.headers.host ?? ''
    if (host !== `127.0.0.1:${this.port}` && host !== `localhost:${this.port}`) return send(403)
    const session = this.sessionOf(req.headers.authorization)
    if (!session) return send(401)
    if (new URL(req.url ?? '/', 'http://x').pathname !== '/mcp') return send(404)
    if (req.method !== 'POST') return send(405) // pas de flux serveur -> client : tout passe par des reponses JSON

    let raw = ''
    let size = 0
    for await (const chunk of req) {
      size += (chunk as Buffer).length
      if (size > MAX_BODY) return send(413)
      raw += chunk
    }
    let msg: { jsonrpc?: string; id?: unknown; method?: string; params?: Record<string, unknown> }
    try { msg = JSON.parse(raw) } catch { return send(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'JSON invalide' } }) }
    if (!msg || typeof msg !== 'object' || Array.isArray(msg) || typeof msg.method !== 'string') return send(400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'requete invalide' } })
    if (msg.id === undefined) return send(202) // notification (ex. notifications/initialized) : pas de reponse

    const ok = (result: unknown) => send(200, { jsonrpc: '2.0', id: msg.id, result })
    const err = (code: number, message: string) => send(200, { jsonrpc: '2.0', id: msg.id, error: { code, message } })

    switch (msg.method) {
      case 'initialize': {
        const asked = msg.params?.protocolVersion
        return ok({ protocolVersion: typeof asked === 'string' ? asked : PROTOCOL, capabilities: { tools: {} }, serverInfo: { name: 'rpm', version: '0.1.0' } })
      }
      case 'ping': return ok({})
      case 'tools/list':
        return ok({ tools: [...session.tools.values()].map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) })
      case 'tools/call': {
        const name = msg.params?.name
        const tool = typeof name === 'string' ? session.tools.get(name) : undefined
        if (!tool) return err(-32602, `outil inconnu : ${String(name).slice(0, 60)}`)
        const args = msg.params?.arguments && typeof msg.params.arguments === 'object' && !Array.isArray(msg.params.arguments) ? (msg.params.arguments as Record<string, unknown>) : {}
        const timer = AbortSignal.timeout(TOOL_TIMEOUT_MS)
        try { return ok(await tool.run(args, AbortSignal.any([session.signal, timer]))) }
        catch (e) { return ok(text(`Erreur : ${e instanceof Error ? e.message : String(e)}`, true)) }
      }
      default: return err(-32601, `methode inconnue : ${msg.method.slice(0, 60)}`)
    }
  }
}
