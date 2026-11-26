// Pages « Workers » : machines, pools et taches.
import { alert, appPage, csrfField, esc, type Viewer } from './views.ts'
import type { Job, JobEvent, Pool, Worker } from './workers.ts'
import type { WorkerStatus } from './worker-hub.ts'
import { encodePairingCode } from './worker-protocol.ts'

export type WorkerView = Worker & { status: WorkerStatus }

const ago = (ms: number | null) => {
  if (ms === null) return 'jamais'
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000))
  if (s < 60) return `il y a ${s} s`
  if (s < 3600) return `il y a ${Math.round(s / 60)} min`
  if (s < 86400) return `il y a ${Math.round(s / 3600)} h`
  return `il y a ${Math.round(s / 86400)} j`
}

const STATUS: Record<WorkerStatus, string> = {
  idle: '<span class="pill ok">En ligne · libre</span>',
  busy: '<span class="pill warn">En ligne · occupe</span>',
  offline: '<span class="pill">Hors ligne</span>',
}
const JOB_STATUS: Record<Job['status'], string> = {
  queued: '<span class="pill">En attente</span>',
  running: '<span class="pill warn">En cours</span>',
  succeeded: '<span class="pill ok">Reussie</span>',
  failed: '<span class="pill bad">Echec</span>',
  cancelled: '<span class="pill">Annulee</span>',
}

const infoLine = (w: Worker) => {
  const i = w.info as { hostname?: string; platform?: string; arch?: string; version?: string; node?: string }
  return [i.hostname, [i.platform, i.arch].filter(Boolean).join(' '), i.version ? `v${i.version}` : ''].filter(Boolean).map((x) => esc(x)).join(' · ')
}

export interface RevealedToken { name: string; token: string; hostUrl: string }

function reveal(r: RevealedToken) {
  const code = encodePairingCode(r.hostUrl, r.token)
  const env = `RPM_HOST_URL=${r.hostUrl}
RPM_WORKER_TOKEN=${r.token}`
  return `
<section class="card reveal">
  <h2>Worker « ${esc(r.name)} » : relie-le a ta machine</h2>
  <p class="alert ok">Ce code contient le jeton du Worker : il n'est affiche qu'<strong>une seule fois</strong>. S'il est perdu, regenere un jeton.</p>
  <ol class="steps">
    <li>Sur la machine du Worker, lance-le : double-clic sur <code>worker/start.vbs</code> (Windows) ou <code>worker/start.command</code> (macOS / Linux). Une page s'ouvre (<code>http://127.0.0.1:4180</code>).</li>
    <li>Colle ce <strong>code de jumelage</strong> dans cette page, puis clique <em>Jumeler</em> :</li>
  </ol>
  <pre class="code">${esc(code)}</pre>
  <p class="muted small">Le Worker se connecte <em>lui-meme</em> au Host : rien a ouvrir sur sa machine. Depuis cette page locale tu pourras aussi activer son demarrage automatique.</p>
  <details class="change"><summary>Configuration manuelle (fichier .env)</summary>
    <p class="muted small">Alternative au code : cree <code>worker/.env</code> avec ces deux lignes.</p>
    <pre class="code">${esc(env)}</pre>
  </details>
</section>`
}

export function workersPage(o: Viewer & {
  workers: WorkerView[]; pools: Pool[]; jobs: Job[]; reveal?: RevealedToken; error?: string; notice?: string
}) {
  const busy = o.jobs.some((j) => j.status === 'queued' || j.status === 'running')
  const poolOptions = (selected: number | null) =>
    `<option value=""${selected === null ? ' selected' : ''}>Aucun pool</option>${o.pools.map((p) => `<option value="${p.id}"${selected === p.id ? ' selected' : ''}>${esc(p.name)}</option>`).join('')}`

  const workerRows = o.workers.map((w) => `
    <li class="exp worker">
      <div class="row-main">
        <strong>${esc(w.name)}</strong>
        <span class="muted">${STATUS[w.status]} ${w.status === 'offline' ? `· vu ${esc(ago(w.last_seen_at))}` : ''}${w.pool_name ? ` · pool « ${esc(w.pool_name)} »` : ''}</span>
        ${infoLine(w) ? `<span class="muted small">${infoLine(w)}</span>` : ''}
        <details class="change"><summary>Reglages</summary>
          <form method="post" action="/workers/${w.id}/pool" class="pool-form">${csrfField(o.csrf)}
            <label>Pool <select name="poolId">${poolOptions(w.pool_id)}</select></label>
            <div class="actions"><button class="primary" type="submit">Enregistrer</button></div>
          </form>
          <form method="post" action="/workers/${w.id}/token" class="inline">${csrfField(o.csrf)}<button type="submit">Regenerer le jeton</button></form>
          <form method="post" action="/workers/${w.id}/delete" class="inline">${csrfField(o.csrf)}<button class="ghost danger" type="submit">Supprimer</button></form>
        </details>
      </div>
      <div class="acct-actions">
        <form method="post" action="/workers/${w.id}/test" class="inline">${csrfField(o.csrf)}<button type="submit"${w.status === 'offline' ? ' disabled title="Worker hors ligne"' : ''}>Tester</button></form>
      </div>
    </li>`).join('')

  const poolRows = o.pools.map((p) => `
    <li class="exp">
      <div class="row-main"><strong>${esc(p.name)}</strong><span class="muted">${p.worker_count} Worker${p.worker_count > 1 ? 's' : ''}</span></div>
      <div class="acct-actions">
        <form method="post" action="/pools/${p.id}/test" class="inline">${csrfField(o.csrf)}<button type="submit">Tester</button></form>
        <form method="post" action="/pools/${p.id}/delete" class="inline">${csrfField(o.csrf)}<button class="ghost danger" type="submit">Supprimer</button></form>
      </div>
    </li>`).join('')

  const jobRows = o.jobs.map((j) => `
    <li class="exp">
      <div class="row-main">
        <strong><a href="/jobs/${j.id}">#${j.id} · ${esc(j.kind)}</a></strong>
        <span class="muted small">${JOB_STATUS[j.status]} ${j.worker_name ? `· ${esc(j.worker_name)} ` : ''}· ${esc(ago(j.created_at))}${j.error ? ` · ${esc(j.error)}` : ''}</span>
      </div>
      ${j.status === 'queued' || j.status === 'running' ? `<form method="post" action="/jobs/${j.id}/cancel" class="inline">${csrfField(o.csrf)}<button class="ghost danger" type="submit">Annuler</button></form>` : ''}
    </li>`).join('')

  return appPage('Workers', o, 'workers', `
${o.reveal ? reveal(o.reveal) : ''}
<section class="card">
  <div class="card-head"><div><h1>Workers</h1><p class="muted">Les machines qui executent tes taches (agents, Studio, Blender…). Chacune se connecte au Host et n'execute que <strong>tes</strong> taches.</p></div></div>
  ${alert(o.notice, 'ok')}${alert(o.error)}
  ${o.workers.length ? `<ul class="exps">${workerRows}</ul>` : '<div class="empty"><p><strong>Aucun Worker pour l\'instant.</strong></p><p class="muted">Ajoute-en un ci-dessous, puis lance-le sur la machine voulue.</p></div>'}
  <form method="post" action="/workers" autocomplete="off" class="add-key">
    ${csrfField(o.csrf)}
    <h3>Ajouter un Worker</h3>
    <div class="two">
      <label>Nom <input type="text" name="name" maxlength="40" required placeholder="Mon PC, Mac mini…"></label>
      <label>Pool <select name="poolId">${poolOptions(null)}</select></label>
    </div>
    <div class="actions"><button class="primary" type="submit">Creer le Worker</button></div>
  </form>
</section>

<section class="card">
  <h2>Pools</h2>
  <p class="muted">Un pool regroupe plusieurs Workers : une tache envoyee au pool est prise par le premier Worker libre.</p>
  ${o.pools.length ? `<ul class="exps">${poolRows}</ul>` : ''}
  <form method="post" action="/pools" autocomplete="off" class="add-key">
    ${csrfField(o.csrf)}
    <div class="two"><label>Nouveau pool <input type="text" name="name" maxlength="40" required placeholder="Mes machines"></label></div>
    <div class="actions"><button type="submit">Creer le pool</button></div>
  </form>
</section>

<section class="card">
  <h2>Dernieres taches</h2>
  ${o.jobs.length ? `<ul class="exps">${jobRows}</ul>` : '<p class="muted">Aucune tache. Utilise « Tester » sur un Worker pour envoyer une tache d\'essai.</p>'}
</section>`, { refreshSeconds: busy && !o.reveal ? 3 : undefined }) // jamais de rechargement tant que le code de jumelage est affiche
}

export function jobPage(o: Viewer & { job: Job; events: JobEvent[] }) {
  const j = o.job
  const active = j.status === 'queued' || j.status === 'running'
  return appPage(`Tache #${j.id}`, o, 'workers', `
<p class="crumbs"><a href="/workers">Workers</a> <span aria-hidden="true">/</span> Tache #${j.id}</p>
<section class="card">
  <div class="card-head"><div><h1>Tache #${j.id} · ${esc(j.kind)}</h1><p class="muted">${JOB_STATUS[j.status]} ${j.worker_name ? `· ${esc(j.worker_name)}` : ''} · creee ${esc(ago(j.created_at))}</p></div>
    ${active ? `<form method="post" action="/jobs/${j.id}/cancel" class="inline">${csrfField(o.csrf)}<button class="ghost danger" type="submit">Annuler</button></form>` : ''}</div>
  ${j.error ? alert(j.error) : ''}
  <h3>Contenu</h3>
  <pre class="code">${esc(JSON.stringify(j.payload, null, 2))}</pre>
  ${j.result !== null ? `<h3>Resultat</h3><pre class="code">${esc(JSON.stringify(j.result, null, 2))}</pre>` : ''}
  <h3>Evenements</h3>
  ${o.events.length ? `<ul class="events">${o.events.map((e) => `<li class="${esc(e.level)}"><span class="muted small">${esc(new Date(e.at).toLocaleTimeString('fr-FR'))}</span> ${esc(e.text)}</li>`).join('')}</ul>` : '<p class="muted small">Aucun evenement.</p>'}
</section>`, { refreshSeconds: active ? 3 : undefined })
}
