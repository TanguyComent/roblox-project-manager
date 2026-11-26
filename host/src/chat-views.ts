// Pages des chats IA d'un projet : liste (creer / ouvrir / supprimer) et conversation.
import { MAX_PROMPT, MAX_TITLE, type Chat, type ChatMessage } from './chats.ts'
import type { Project } from './projects.ts'
import { alert, appPage, csrfField, esc, type Viewer } from './views.ts'
import type { JobEvent } from './workers.ts'

const ago = (ms: number) => {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000))
  if (s < 60) return `il y a ${s} s`
  if (s < 3600) return `il y a ${Math.round(s / 60)} min`
  if (s < 86400) return `il y a ${Math.round(s / 3600)} h`
  return `il y a ${Math.round(s / 86400)} j`
}

const crumbs = (p: Project, last: string) =>
  `<p class="crumbs"><a href="/projects">Projets</a> <span aria-hidden="true">/</span> <a href="/projects/${p.id}">${esc(p.name)}</a> <span aria-hidden="true">/</span> ${last}</p>`

export function chatsPage(o: Viewer & { project: Project; chats: Chat[]; error?: string; notice?: string; title?: string }) {
  const p = o.project
  const rows = o.chats.map((c) => `
    <li class="exp">
      <div class="row-main">
        <strong><a href="/projects/${p.id}/chats/${c.id}">${esc(c.title)}</a></strong>
        <span class="muted small">${c.message_count / 2 | 0} echange${(c.message_count / 2 | 0) > 1 ? 's' : ''} · ${esc(ago(c.updated_at))} · branche <code>${esc(c.branch)}</code>${c.worker_name ? ` · ${esc(c.worker_name)}` : ''}</span>
        <details class="change"><summary>Supprimer</summary>
          <p class="muted small">Le chat et ses messages sont supprimes de ce site. La branche <code>${esc(c.branch)}</code> reste sur GitHub.</p>
          <form method="post" action="/projects/${p.id}/chats/${c.id}/delete" class="inline">${csrfField(o.csrf)}<button class="ghost danger" type="submit">Supprimer ce chat</button></form>
        </details>
      </div>
      <a class="button" href="/projects/${p.id}/chats/${c.id}">Ouvrir</a>
    </li>`).join('')
  return appPage(`Chats IA · ${p.name}`, o, 'projects', `
${crumbs(p, 'Chats IA')}
<section class="card">
  <div class="card-head"><div><h1>Chats IA</h1><p class="muted">Chaque chat travaille sur sa propre branche git, sur l'un de tes Workers, avec Claude Code.</p></div></div>
  ${alert(o.notice, 'ok')}${alert(o.error)}
  ${o.chats.length ? `<ul class="exps">${rows}</ul>` : '<div class="empty"><p><strong>Aucun chat pour ce projet.</strong></p><p class="muted">Cree le premier ci-dessous.</p></div>'}
  <form method="post" action="/projects/${p.id}/chats" autocomplete="off" class="add-key">
    ${csrfField(o.csrf)}
    <h3>Nouveau chat</h3>
    <label>Titre <input type="text" name="title" maxlength="${MAX_TITLE}" required value="${esc(o.title ?? '')}" placeholder="Ex. Ajouter l'inventaire"></label>
    <div class="actions"><button class="primary" type="submit">Creer le chat</button></div>
  </form>
</section>`)
}

const money = (n: number | null | undefined) => (typeof n === 'number' ? `${n.toFixed(n < 0.1 ? 3 : 2)} $` : '')
const duration = (ms: number | null | undefined) => (typeof ms === 'number' ? (ms < 60_000 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms / 60_000)} min`) : '')

function bubble(m: ChatMessage, events: JobEvent[]) {
  if (m.role === 'user') return `<div class="msg user"><div class="who">Toi · <span class="muted">${esc(ago(m.created_at))}</span></div><div class="body">${esc(m.content)}</div></div>`
  if (m.status === 'pending') {
    const state = m.job_status === 'running' ? "L'IA travaille…" : "En attente d'un Worker…"
    const log = events.slice(-4).map((e) => `<li>${esc(e.text)}</li>`).join('')
    return `<div class="msg assistant pending"><div class="who">IA</div><div class="body"><span class="pill warn">${state}</span>${log ? `<ul class="events">${log}</ul>` : ''}</div></div>`
  }
  if (m.status !== 'done') {
    return `<div class="msg assistant"><div class="who">IA</div><div class="body">${alert(m.status === 'cancelled' ? 'Reponse annulee.' : m.content)}</div></div>`
  }
  const d = m.details
  const meta = d ? [
    d.commits?.length ? `${d.commits.length} commit${d.commits.length > 1 ? 's' : ''}` : 'aucune modification',
    d.pushed ? 'pousse sur GitHub' : d.commits?.length ? '<span class="warn-text">non pousse</span>' : '',
    duration(d.durationMs), money(d.costUsd),
  ].filter(Boolean).join(' · ') : ''
  return `<div class="msg assistant"><div class="who">IA · <span class="muted">${esc(ago(m.created_at))}</span></div>
  <div class="body">${esc(m.content)}</div>
  ${d ? `<div class="meta small muted">${meta}</div>
  ${d.pushError ? alert(`Push impossible : ${d.pushError}`) : ''}
  ${d.commits?.length ? `<ul class="commits">${d.commits.map((c) => `<li><code>${esc(c)}</code></li>`).join('')}</ul>` : ''}
  ${d.diff ? `<details class="change"><summary>Voir les modifications</summary><pre class="code diff">${esc(d.diffStat ?? '')}\n\n${esc(d.diff)}</pre></details>` : ''}` : ''}
</div>`
}

export function chatPage(o: Viewer & {
  project: Project; chat: Chat; messages: ChatMessage[]; pendingEvents: JobEvent[]; error?: string; notice?: string
  noWorker: boolean; hasRepo: boolean; draft?: string
}) {
  const p = o.project
  const c = o.chat
  const pending = o.messages.some((m) => m.status === 'pending')
  const base = `/projects/${p.id}/chats/${c.id}`
  return appPage(`${c.title} · ${p.name}`, o, 'projects', `
${crumbs(p, `<a href="/projects/${p.id}/chats">Chats IA</a> <span aria-hidden="true">/</span> ${esc(c.title)}`)}
<section class="card chat">
  <div class="card-head">
    <div><h1>${esc(c.title)}</h1><p class="muted small">Branche <code>${esc(c.branch)}</code>${c.worker_name ? ` · Worker « ${esc(c.worker_name)} »` : ''}</p></div>
    ${pending ? `<form method="post" action="${base}/cancel" class="inline">${csrfField(o.csrf)}<button class="ghost danger" type="submit">Annuler la reponse</button></form>` : ''}
  </div>
  ${alert(o.notice, 'ok')}${alert(o.error)}
  ${!o.hasRepo ? alert("Ce projet n'a pas de depot GitHub : renseigne-le dans le projet pour pouvoir discuter avec l'IA.") : ''}
  ${pending && o.noWorker ? alert(`Aucun Worker connecte${c.worker_name ? ` (« ${c.worker_name} »)` : ''} ne dispose de Git et de Claude Code : la demande attend. Lance un Worker, ou verifie ses outils sur la page Workers.`) : ''}
  <div class="messages">
    ${o.messages.length ? o.messages.map((m) => bubble(m, m.status === 'pending' ? o.pendingEvents : [])).join('') : '<p class="muted">Pose ta premiere question : l\'IA travaille sur la branche de ce chat et commite ses changements.</p>'}
  </div>
  <form method="post" action="${base}/messages" autocomplete="off" class="composer" id="bas">
    ${csrfField(o.csrf)}
    <label class="sr">Message</label>
    <textarea name="prompt" rows="4" maxlength="${MAX_PROMPT}" required placeholder="Decris ce que l'IA doit faire…"${pending || !o.hasRepo ? ' disabled' : ''}>${esc(o.draft ?? '')}</textarea>
    <div class="actions"><button class="primary" type="submit"${pending || !o.hasRepo ? ' disabled' : ''}>Envoyer</button></div>
  </form>
</section>
<section class="card">
  <details class="change"><summary>Supprimer ce chat</summary>
    <p class="muted small">Le chat et ses messages sont supprimes de ce site ; la branche <code>${esc(c.branch)}</code> reste sur GitHub.</p>
    <form method="post" action="${base}/delete" class="inline">${csrfField(o.csrf)}<button class="ghost danger" type="submit">Supprimer ce chat</button></form>
  </details>
</section>`, pending ? { refreshSeconds: 3, refreshUrl: `${base}#bas` } : {})
}
