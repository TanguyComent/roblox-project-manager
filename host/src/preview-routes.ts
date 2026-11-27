// Depot des apercus par les Workers et service des paquets.
//
// SECURITE : un apercu est du JavaScript ecrit par une IA, execute dans le navigateur de l'utilisateur. Il est donc :
//  - affiche dans un <iframe sandbox="allow-scripts"> SANS allow-same-origin (origine « opaque » : ni cookies, ni session, ni acces au site, ni a ses API) ;
//  - servi avec sa propre politique CSP (`sandbox allow-scripts` aussi, au cas ou l'adresse serait ouverte directement ; connect-src 'none' : il ne peut rien envoyer) ;
//  - accessible uniquement par une adresse a 128 bits aleatoires (les requetes d'un cadre isole ne portent pas de cookie : l'adresse EST la cle).
import type { Hono } from 'hono'
import type { Env } from './app.ts'
import type { Db } from './db.ts'
import { PreviewError, previewFile, savePreview, type UploadBody } from './previews.ts'
import { findWorkerByToken } from './workers.ts'

const PREVIEW_CSP = [
  "default-src 'none'", "script-src 'self'", "style-src 'self' 'unsafe-inline'", "img-src 'self' data: blob:", "font-src 'self' data:", "connect-src 'none'",
  "frame-src 'none'", "form-action 'none'", "base-uri 'none'", "frame-ancestors 'self'", 'sandbox allow-scripts',
].join('; ')

export function previewRoutes(app: Hono<Env>, ctx: { db: Db }) {
  const { db } = ctx

  // --- depot par un Worker (jeton `rpmw_…` en Authorization : Bearer, pas de cookie) ---------------------------------------------------------
  app.post('/api/worker/previews', async (c) => {
    const token = /^Bearer\s+(\S+)$/.exec(c.req.header('authorization') ?? '')?.[1]
    const worker = token ? findWorkerByToken(db, token) : undefined
    if (!worker) return c.json({ error: 'Jeton invalide.' }, 403)
    let body: UploadBody
    try { body = (await c.req.json()) as UploadBody } catch { return c.json({ error: 'Corps JSON invalide.' }, 400) }
    if (!body || typeof body !== 'object') return c.json({ error: 'Corps JSON invalide.' }, 400)
    try { return c.json({ id: savePreview(db, worker, body) }) } catch (e) {
      if (e instanceof PreviewError) return c.json({ error: e.message }, e.status)
      throw e
    }
  })

  // --- service d'un paquet -------------------------------------------------------------------------------------------------------------------
  app.get('/preview/:id{[0-9a-f]{32}}/*', (c) => {
    const id = c.req.param('id')
    const rest = c.req.path.slice(`/preview/${id}/`.length)
    let path = 'index.html'
    if (rest) { try { path = decodeURIComponent(rest) } catch { return c.text('Introuvable', 404) } }
    const f = previewFile(db, id, path)
    if (!f) return c.text('Introuvable', 404)
    return c.body(new Uint8Array(f.data), 200, {
      'Content-Type': f.type,
      'Content-Security-Policy': PREVIEW_CSP,
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'X-Robots-Tag': 'noindex',
      // un cadre isole (origine opaque) charge ses scripts en mode CORS : ces fichiers sont publics pour qui connait l'adresse
      'Access-Control-Allow-Origin': '*',
      'Cross-Origin-Resource-Policy': 'cross-origin',
      'Cache-Control': 'private, max-age=3600',
    })
  })
}
