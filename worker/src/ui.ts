// Interface locale du Worker : une petite page sur 127.0.0.1 (jamais exposee au reseau) pour voir l'etat, jumeler, demarrer / arreter,
// activer le demarrage automatique. Aucune dependance : node:http.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import type { Agent, AgentState } from './agent.ts'
import type { Autostart } from './autostart.ts'

const esc = (s: unknown) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

const CSS = `
:root { color-scheme: dark; --bg:#0b0e18; --card:#121728; --line:#232a42; --text:#e6e9f5; --muted:#8d95b3; --accent:#6c8cff; --ok:#4fd1a0; --warn:#f2b84b; --err:#ff6b7d; }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 720px; margin: 0 auto; padding: 32px 20px 60px; display: grid; gap: 16px; }
h1 { margin: 0; font-size: 22px; } h2 { margin: 0 0 8px; font-size: 16px; }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 14px; padding: 18px 20px; }
.muted { color: var(--muted); } .small { font-size: 13px; }
.pill { display: inline-block; padding: 3px 11px; border-radius: 999px; font-weight: 650; font-size: 13px; background: rgba(255,255,255,.07); color: var(--muted); }
.pill.ok { color: var(--ok); background: rgba(79,209,160,.13); } .pill.warn { color: var(--warn); background: rgba(242,184,75,.13); } .pill.bad { color: var(--err); background: rgba(255,107,125,.13); }
.row { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
form { margin: 0; } form.inline { display: inline; }
textarea { width: 100%; padding: 10px 12px; background: #0b0e18; color: var(--text); border: 1px solid var(--line); border-radius: 10px; font: 13px ui-monospace, Menlo, Consolas, monospace; }
button { padding: 8px 16px; border-radius: 10px; border: 1px solid var(--line); background: #1a2138; color: var(--text); font: inherit; cursor: pointer; }
button.primary { background: var(--accent); border-color: var(--accent); color: #0b0e18; font-weight: 650; }
button.danger { color: var(--err); background: transparent; }
.actions { display: flex; gap: 8px; margin-top: 12px; flex-wrap: wrap; }
.alert { margin: 0; padding: 10px 12px; border-radius: 10px; background: rgba(255,107,125,.1); color: var(--err); }
.alert.ok { background: rgba(79,209,160,.1); color: var(--ok); }
pre.log { margin: 0; max-height: 280px; overflow: auto; padding: 12px; background: #0b0e18; border: 1px solid var(--line); border-radius: 10px; font: 12.5px/1.55 ui-monospace, Menlo, Consolas, monospace; white-space: pre-wrap; word-break: break-word; }
ol { margin: 8px 0 0; padding-left: 20px; } code { font: 13px ui-monospace, Menlo, Consolas, monospace; background: rgba(255,255,255,.07); padding: 1px 6px; border-radius: 6px; }
details summary { cursor: pointer; color: var(--accent); }
`

const STATE: Record<AgentState, { pill: string; label: string; help: string }> = {
  unconfigured: { pill: '', label: 'Pas encore jumele', help: 'Colle le code de jumelage ci-dessous pour relier ce Worker a ton Host.' },
  stopped: { pill: '', label: 'Arrete', help: 'Le Worker est jumele mais ne tourne pas.' },
  connecting: { pill: 'warn', label: 'Connexion…', help: '' },
  connected: { pill: 'ok', label: 'Connecte', help: 'Pret : le Host peut envoyer des taches a cette machine.' },
  waiting: { pill: 'warn', label: 'Host injoignable', help: 'Nouvelle tentative automatique en cours.' },
  rejected: { pill: 'bad', label: 'Refuse par le Host', help: "Le jeton n'est plus valide (Worker supprime, jeton regenere ou autre machine connectee). Jumelle-le de nouveau avec un nouveau code." },
}

export interface UiOptions { agent: Agent; autostart: Autostart; port: number; quit: () => void }

export function createUi(o: UiOptions): Server {
  const csrf = randomBytes(24).toString('base64url')
  const allowedHosts = new Set([`127.0.0.1:${o.port}`, `localhost:${o.port}`])
  const sameToken = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b))
  const hidden = `<input type="hidden" name="csrf" value="${csrf}">`
  const button = (action: string, label: string, cls = '') => `<form class="inline" method="post" action="${action}">${hidden}<button class="${cls}" type="submit">${label}</button></form>`

  const pairForm = () => `
      <form method="post" action="/pair">${hidden}
        <label class="muted small" for="code">Code de jumelage</label>
        <textarea id="code" name="code" rows="3" required autocomplete="off" spellcheck="false" placeholder="rpm1.…"></textarea>
        <div class="actions"><button class="primary" type="submit">Jumeler</button></div>
      </form>`

  const page = (notice: { text: string; ok?: boolean } | null) => {
    const s = o.agent.snapshot()
    const st = STATE[s.state]
    const configured = s.state !== 'unconfigured'
    const live = s.state === 'connecting' || s.state === 'waiting' || s.state === 'connected'
    const autostartOn = o.autostart.supported && o.autostart.enabled()
    return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>RPM Worker</title>${live ? '<meta http-equiv="refresh" content="3">' : ''}<style>${CSS}</style></head><body><main>
<div class="row"><h1>RPM Worker</h1><span class="pill ${st.pill}">${esc(st.label)}</span></div>
${notice ? `<p class="alert ${notice.ok ? 'ok' : ''}" role="alert">${esc(notice.text)}</p>` : ''}
<section class="card">
  <h2>Etat</h2>
  <p class="muted">${esc(st.help)}${s.state === 'connected' && s.workerName ? ` Nom : <strong>${esc(s.workerName)}</strong>.` : ''}</p>
  ${s.hostUrl ? `<p class="small muted">Host : <code>${esc(s.hostUrl)}</code></p>` : ''}
  <div class="actions">
    ${s.state === 'stopped' ? button('/start', 'Demarrer', 'primary') : ''}
    ${s.state === 'rejected' ? button('/start', 'Reessayer', 'primary') : ''}
    ${live ? button('/stop', 'Arreter') : ''}
    ${button('/quit', 'Quitter le Worker', 'danger')}
  </div>
</section>
${!configured ? `<section class="card"><h2>Jumeler ce Worker</h2>
  <ol><li>Sur le site, page <strong>Workers</strong> → <em>Creer le Worker</em>.</li><li>Copie le <strong>code de jumelage</strong> affiche et colle-le ici.</li></ol>${pairForm()}</section>` : ''}
<section class="card">
  <h2>Demarrage automatique</h2>
  ${o.autostart.supported
    ? `<div class="row"><p class="muted" style="margin:0">${autostartOn ? "Le Worker se lance tout seul, en arriere-plan, a l'ouverture de ta session." : 'Le Worker ne se lance pas tout seul : il faut le demarrer a la main.'}</p>
       <form method="post" action="/autostart">${hidden}<input type="hidden" name="enabled" value="${autostartOn ? '0' : '1'}"><button class="${autostartOn ? '' : 'primary'}" type="submit">${autostartOn ? 'Desactiver' : 'Activer'}</button></form></div>`
    : '<p class="muted">Non disponible sur ce systeme.</p>'}
</section>
<section class="card">
  <h2>Journal</h2>
  <pre class="log">${s.logs.length ? esc(s.logs.slice(-60).join('\n')) : "Rien pour l'instant."}</pre>
</section>
${configured ? `<section class="card"><details><summary>Changer de Host / rejumeler</summary>
  <p class="muted small">Colle un nouveau code pour remplacer le jumelage actuel, ou supprime-le.</p>${pairForm()}
  <form method="post" action="/forget">${hidden}<div class="actions"><button class="danger" type="submit">Supprimer le jumelage</button></div></form>
</details></section>` : ''}
<p class="small muted">Cette page n'est accessible que depuis cet ordinateur.</p>
</main></body></html>`
  }

  const send = (res: ServerResponse, status: number, body: string, type = 'text/html; charset=utf-8', extra: Record<string, string> = {}) => {
    res.writeHead(status, {
      'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'", ...extra,
    })
    res.end(body)
  }
  const redirect = (res: ServerResponse, msg?: string, ok = true) =>
    send(res, 303, '', 'text/plain', { Location: msg ? `/?${ok ? 'ok' : 'err'}=${encodeURIComponent(msg)}` : '/' })

  const readForm = (req: IncomingMessage) => new Promise<URLSearchParams | null>((resolve) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => { size += c.length; if (size > 8192) { resolve(null); req.destroy() } else chunks.push(c) })
    req.on('end', () => resolve(new URLSearchParams(Buffer.concat(chunks).toString('utf8'))))
    req.on('error', () => resolve(null))
  })

  return createServer(async (req, res) => {
    try {
      // Anti « DNS rebinding » : seule l'adresse locale exacte est acceptee.
      if (!allowedHosts.has(req.headers.host ?? '')) return send(res, 403, 'Hote refuse', 'text/plain')
      const url = new URL(req.url ?? '/', `http://${req.headers.host}`)

      if (req.method === 'GET' || req.method === 'HEAD') {
        if (url.pathname !== '/') return send(res, 404, 'Introuvable', 'text/plain')
        const ok = url.searchParams.get('ok')
        const err = url.searchParams.get('err')
        return send(res, 200, page(ok ? { text: ok.slice(0, 200), ok: true } : err ? { text: err.slice(0, 200) } : null))
      }
      if (req.method !== 'POST') return send(res, 405, 'Methode refusee', 'text/plain')

      // Une page d'un autre site ne doit pas pouvoir piloter le Worker : origine + jeton CSRF.
      const origin = req.headers.origin
      if (origin && !allowedHosts.has(new URL(origin).host)) return send(res, 403, 'Origine refusee', 'text/plain')
      const form = await readForm(req)
      if (!form || !sameToken(form.get('csrf') ?? '', csrf)) return send(res, 403, 'Jeton invalide', 'text/plain')

      switch (url.pathname) {
        case '/pair': {
          const r = await o.agent.pair(form.get('code') ?? '')
          return r.ok ? redirect(res, 'Jumele : connexion en cours.') : redirect(res, r.error, false)
        }
        case '/start': o.agent.start(); return redirect(res)
        case '/stop': await o.agent.stop(); return redirect(res, 'Worker arrete.')
        case '/forget': await o.agent.forget(); return redirect(res, 'Jumelage supprime.')
        case '/autostart': {
          try {
            const on = form.get('enabled') === '1'
            o.autostart.set(on)
            o.agent.log(on ? 'demarrage automatique active' : 'demarrage automatique desactive')
            return redirect(res, on ? 'Demarrage automatique active.' : 'Demarrage automatique desactive.')
          } catch (e) { return redirect(res, e instanceof Error ? e.message : String(e), false) }
        }
        case '/quit':
          send(res, 200, '<!doctype html><meta charset="utf-8"><title>RPM Worker</title><body style="font:16px system-ui;background:#0b0e18;color:#e6e9f5;padding:40px">Worker arrete. Tu peux fermer cet onglet.</body>')
          setTimeout(o.quit, 100)
          return
        default: return send(res, 404, 'Introuvable', 'text/plain')
      }
    } catch (e) {
      if (!res.headersSent) send(res, 400, 'Requete invalide', 'text/plain')
      o.agent.log(`erreur interface : ${e instanceof Error ? e.message : String(e)}`)
    }
  })
}
