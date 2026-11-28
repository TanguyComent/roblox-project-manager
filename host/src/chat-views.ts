// Interface de chat IA, dans l'esprit de Claude Code : liste des chats a gauche (pastilles : en cours, en attente, reponse non lue), conversation a droite
// avec l'activite de l'IA (pensee, outils) et une zone de saisie avec choix du modele et de l'effort. Les fragments (liste, fil) sont aussi renvoyes par
// l'endpoint « live » : la page se met a jour sans rechargement.
import { isInline, type Attachment } from './attachments.ts'
import { DEFAULT_TITLE, EFFORTS, MAX_PROMPT, MAX_TITLE, MODELS, type Chat, type ChatMessage, type ChatState } from './chats.ts'
import { renderMarkdown } from './markdown.ts'
import type { PreviewRow } from './previews.ts'
import type { Project } from './projects.ts'
import { alert, appPage, csrfField, esc, type Viewer } from './views.ts'
import type { JobEvent } from './workers.ts'

const ago = (ms: number) => {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000))
  if (s < 45) return "a l'instant"
  if (s < 3600) return `il y a ${Math.max(1, Math.round(s / 60))} min`
  if (s < 86400) return `il y a ${Math.round(s / 3600)} h`
  return `il y a ${Math.round(s / 86400)} j`
}

const I = {
  think: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3a6 6 0 0 0-3.6 10.8c.4.4.6.9.6 1.4V16h6v-.8c0-.5.2-1 .6-1.4A6 6 0 0 0 12 3zM10 19.5h4M10.5 22h3"/></svg>',
  tool: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m14.7 6.3 3 3-8.4 8.4H6.3v-3zM13 8l3 3"/></svg>',
  text: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h10"/></svg>',
  info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 8h.01M11 12h1v5h1"/></svg>',
  send: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19V5M5 12l7-7 7 7"/></svg>',
  worker: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/></svg>',
  clip: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m20.5 11.5-8.6 8.6a5 5 0 0 1-7.1-7.1l9-9a3.3 3.3 0 0 1 4.7 4.7l-9 9a1.7 1.7 0 0 1-2.4-2.4l8.3-8.3"/></svg>',
  branch: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="8" r="2"/><path d="M6 7v10M18 10c0 4-6 3-12 7"/></svg>',
}

const STATE_LABEL: Record<ChatState, string> = {
  running: "L'IA travaille", queued: "En attente d'un Worker", unread: 'Nouvelle reponse', error: 'Echec', idle: '',
}
const dot = (s: ChatState) => `<span class="dot ${s}" ${s === 'idle' ? 'aria-hidden="true"' : `role="img" aria-label="${esc(STATE_LABEL[s])}" title="${esc(STATE_LABEL[s])}"`}></span>`

/** Colonne de gauche : projet, bouton « Nouveau chat » et liste des chats avec leur pastille d'etat. */
export function chatListHtml(o: { project: Project; chats: Chat[]; activeId: number | null; csrf: string }) {
  const p = o.project
  const items = o.chats.map((c) => `
    <li class="chat-item${c.id === o.activeId ? ' active' : ''}${c.state === 'unread' ? ' is-unread' : ''}">
      <a href="/projects/${p.id}/chats/${c.id}"${c.id === o.activeId ? ' aria-current="page"' : ''}>
        ${dot(c.id === o.activeId && c.state === 'unread' ? 'idle' : c.state)}
        <span class="txt"><span class="t">${esc(c.title)}</span><span class="s">${esc(STATE_LABEL[c.state] || ago(c.updated_at))}${c.state !== 'idle' && c.state !== 'running' && c.state !== 'queued' ? ` · ${esc(ago(c.updated_at))}` : ''}</span></span>
      </a>
    </li>`).join('')
  return `
  <div class="chat-list-head">
    <div class="proj"><a href="/projects/${p.id}" title="Retour au projet">${esc(p.name)}</a><small>${o.chats.length} chat${o.chats.length > 1 ? 's' : ''}</small></div>
    <form method="post" action="/projects/${p.id}/chats">${csrfField(o.csrf)}<button class="primary" type="submit">+ Nouveau chat</button></form>
  </div>
  ${o.chats.length ? `<ul class="chat-items">${items}</ul>` : '<p class="chat-empty">Aucun chat pour ce projet.</p>'}`
}

const money = (n: number | null | undefined) => (typeof n === 'number' ? `${n.toFixed(n < 0.1 ? 3 : 2)} $` : '')
/** Cout estime cumule des reponses d'un chat (estimation du CLI : sur abonnement, ce sont les limites d'usage qui sont consommees, pas ces dollars). */
export const chatCostLabel = (messages: ChatMessage[]): string => {
  const costs = messages.flatMap((m) => (typeof m.details?.costUsd === 'number' ? [m.details.costUsd] : []))
  return costs.length ? `≈ ${money(costs.reduce((a, b) => a + b, 0))} · ${costs.length} reponse${costs.length > 1 ? 's' : ''}` : ''
}
const duration = (ms: number | null | undefined) => (typeof ms === 'number' ? (ms < 60_000 ? `${Math.max(1, Math.round(ms / 1000))} s` : `${Math.round(ms / 60_000)} min`) : '')

// Etapes visibles : pensee, outils, texte intermediaire, et les deux messages d'avancement du Worker (le reste est du bruit git).
const visible = (e: JobEvent) => e.kind !== 'info' || /^(Preparation|Claude)/.test(e.text)

function activityHtml(m: ChatMessage, events: JobEvent[]) {
  const pending = m.status === 'pending'
  let steps = events.filter(visible)
  // Le dernier texte intermediaire est la reponse finale elle-meme : on ne l'affiche pas deux fois.
  const last = steps[steps.length - 1]
  if (!pending && last?.kind === 'text' && m.content.startsWith(last.text.slice(0, 80))) steps = steps.slice(0, -1)
  if (!steps.length) return ''
  const list = steps.map((e) => `<li class="step ${e.kind}">${e.kind === 'thinking' ? I.think : e.kind === 'tool' ? I.tool : e.kind === 'text' ? I.text : I.info}<div class="st">${esc(e.text)}</div></li>`).join('')
  const thinking = steps.filter((e) => e.kind === 'thinking').length
  const label = pending
    ? `${dot(m.job_status === 'running' ? 'running' : 'queued')} <span>Activite · ${steps.length} etape${steps.length > 1 ? 's' : ''}</span>`
    : `<span>Activite · ${steps.length} etape${steps.length > 1 ? 's' : ''}${thinking ? ' · pensee' : ''}</span>`
  return `<details class="activity" data-k="a${m.id}"${pending ? ' open' : ''}><summary>${label}</summary><ul class="steps-list">${list}</ul></details>`
}

const VP_CLASS: Record<string, string> = { 'UI Labs': 'vp-uilabs', Desktop: 'vp-desktop', Tablette: 'vp-tablet', Telephone: 'vp-phone' }

/** Carte d'un bloc ```rpm-ui : l'apercu interactif (cadre ISOLE, voir preview-routes.ts), ou la raison pour laquelle il n'existe pas. */
export function uiBlockHtml(n: number, rows: PreviewRow[] | undefined): string {
  const row = rows?.find((r) => r.n === n)
  if (!row) return `<div class="ui-preview unavailable"><p class="muted small">Apercu indisponible pour ce bloc.</p></div>`
  const title = esc(row.title || row.file)
  if (!row.ok) {
    return `<div class="ui-preview failed"><div class="ui-preview-head"><strong>${title}</strong>${row.root === 'sandbox' ? '<span class="chip accent" title="Concept dans l\'atelier du chat">Atelier</span>' : ''}<span class="chip">${esc(row.file)}</span></div>${alert(`Apercu impossible : ${row.error ?? 'erreur inconnue'}`)}</div>`
  }
  const src = esc(`/preview/${row.id}/index.html?embed=1&vp=${encodeURIComponent(row.viewport)}`)
  const notes = [
    row.errors.length ? alert(`L'apercu s'affiche avec des erreurs : ${row.errors.slice(0, 2).join(' | ')}`) : '',
    row.missing.length ? `<details class="small muted"><summary>${row.missing.length} module${row.missing.length > 1 ? 's' : ''} du jeu remplace${row.missing.length > 1 ? 's' : ''} par l'emulateur</summary><p>${row.missing.map((x) => `<code>${esc(x)}</code>`).join(' ')}</p></details>` : '',
  ].join('')
  return `<div class="ui-preview" data-pid="${row.id}">
    <div class="ui-preview-head"><strong>${title}</strong>${row.root === 'sandbox' ? '<span class="chip accent" title="Concept dans l\'atelier du chat : de fausses donnees, rien d\'integre au projet">Atelier</span>' : ''}<span class="chip" title="Format d'ecran">${esc(row.viewport)}</span><span class="chip" title="Fichier de la story">${esc(row.file)}</span>
      <a class="small" href="${src}" target="_blank" rel="noopener noreferrer">Ouvrir ↗</a></div>
    <iframe class="${VP_CLASS[row.viewport] ?? 'vp-uilabs'}" src="${src}" sandbox="allow-scripts" loading="lazy" referrerpolicy="no-referrer" title="${title}"></iframe>
    ${notes}
  </div>`
}

function assistantHtml(m: ChatMessage, events: JobEvent[], previews: PreviewRow[] | undefined) {
  const activity = activityHtml(m, events)
  let body = ''
  if (m.status === 'pending') {
    const running = m.job_status === 'running'
    body = `<div class="live-line">${dot(running ? 'running' : 'queued')}<span>${running ? "L'IA travaille…" : "En attente d'un Worker disponible…"}</span></div>`
  } else if (m.status === 'done') {
    const d = m.details
    const meta = d ? [
      d.commits?.length ? `${d.commits.length} commit${d.commits.length > 1 ? 's' : ''}` : 'aucune modification',
      d.commits?.length ? (d.pushed ? 'pousse sur GitHub' : '<span class="warn-text">non pousse</span>') : '',
      duration(d.durationMs), money(d.costUsd),
      d.limit ? `<span class="warn-text" title="La reponse a ete interrompue pour controler la consommation : ecris « continue » pour poursuivre.">${d.limit === 'turns' ? 'limite de tours atteinte' : 'plafond de cout atteint'}</span>` : '',
    ].filter(Boolean) : []
    body = `<div class="answer md">${renderMarkdown(m.content, { uiBlock: (n) => uiBlockHtml(n, previews) })}</div>
    ${d ? `<div class="reply-meta">${meta.map((x) => `<span>${x}</span>`).join('<span aria-hidden="true">·</span>')}<span class="stamp">${esc(ago(m.created_at))}</span></div>
    ${d.pushError ? alert(`Push impossible : ${d.pushError}`) : ''}
    ${d.commits?.length ? `<ul class="commits">${d.commits.map((c) => `<li><code>${esc(c)}</code></li>`).join('')}</ul>` : ''}
    ${d.diff ? `<details class="diff-box" data-k="d${m.id}"><summary>Voir les modifications</summary><pre class="code diff">${esc(d.diffStat ?? '')}\n\n${esc(d.diff)}</pre></details>` : ''}` : ''}`
  } else {
    body = alert(m.status === 'cancelled' ? 'Reponse annulee.' : m.content)
  }
  return `<div class="msg assistant" id="m${m.id}"><div class="avatar" aria-hidden="true">C</div><div class="content-col">${activity}${body}</div></div>`
}

const fmtSize = (n: number) => (n < 1024 ? `${n} o` : n < 1048576 ? `${Math.round(n / 1024)} Ko` : `${(n / 1048576).toFixed(1)} Mo`)

/** Fichiers joints d'un message : vignettes cliquables pour les images verifiees, pastilles de telechargement pour le reste. */
function filesHtml(files: Attachment[] | undefined, chatUrl: string) {
  if (!files?.length) return ''
  return `<div class="afiles">${files.map((a) => {
    const url = `${chatUrl}/attachments/${a.id}`
    return isInline(a)
      ? `<a class="athumb" href="${url}" target="_blank" rel="noopener" title="${esc(a.name)}"><img src="${url}" alt="${esc(a.name)}" loading="lazy"></a>`
      : `<a class="achip" href="${url}" download title="Telecharger"><span class="ak">${esc(a.kind === 'pdf' ? 'PDF' : a.kind === 'text' ? 'TXT' : (a.name.split('.').pop() ?? 'FICHIER').slice(0, 5).toUpperCase())}</span><span class="an">${esc(a.name)}</span><span class="as">${fmtSize(a.size)}</span></a>`
  }).join('')}</div>`
}

/** Fichiers televerses mais pas encore envoyes (affiches dans le composeur ; retrait par la croix). */
function stagedHtml(files: Attachment[], chatUrl: string) {
  return files.map((a) => `<span class="achip staged" data-id="${a.id}">${isInline(a) ? `<img src="${chatUrl}/attachments/${a.id}" alt="">` : `<span class="ak">${esc(a.kind === 'pdf' ? 'PDF' : a.kind === 'text' ? 'TXT' : 'FICHIER')}</span>`}<span class="an">${esc(a.name)}</span><span class="as">${fmtSize(a.size)}</span><button type="button" class="x" data-remove aria-label="Retirer ${esc(a.name)}">×</button></span>`).join('')
}

/** Fil de la conversation (renvoye tel quel par l'endpoint live). */
export function threadHtml(o: { files: Map<number, Attachment[]>; chatUrl: string; messages: ChatMessage[]; events: Map<number, JobEvent[]>; previews: Map<number, PreviewRow[]>; noWorker: boolean; workerName: string | null }) {
  const parts: string[] = []
  if (o.noWorker) parts.push(alert(`Aucun Worker connecte${o.workerName ? ` (« ${o.workerName} »)` : ''} ne dispose de Git et de Claude Code : la demande attend. Lance un Worker, ou verifie ses outils sur la page Workers.`))
  if (!o.messages.length) {
    parts.push(`<div class="hello"><h2>Que veux-tu faire ?</h2>
      <p>Discute, demande une <strong>idee d'interface</strong> (l'IA te propose un visuel dans son atelier, tu valides avant qu'elle l'integre) ou une <strong>modification du projet</strong> (elle ouvre sa branche et te montre le resultat).</p></div>`)
  }
  for (const m of o.messages) {
    parts.push(m.role === 'user'
      ? `<div class="msg user" id="m${m.id}"><div class="bubble">${filesHtml(o.files.get(m.id), o.chatUrl)}${esc(m.content)}</div></div>`
      : assistantHtml(m, m.job_id ? (o.events.get(m.job_id) ?? []) : [], m.job_id ? o.previews.get(m.job_id) : undefined))
  }
  return `<div class="thread">${parts.join('\n')}</div>`
}

export interface ChatPageData {
  project: Project; chats: Chat[]; chat: Chat | null; files: Map<number, Attachment[]>; staged: Attachment[]; messages: ChatMessage[]; events: Map<number, JobEvent[]>; previews: Map<number, PreviewRow[]>
  hasProjectRepo: boolean; noWorker: boolean; pending: boolean; error?: string
}

export function chatPage(o: Viewer & ChatPageData) {
  const p = o.project
  const c = o.chat
  const list = chatListHtml({ project: p, chats: o.chats, activeId: c?.id ?? null, csrf: o.csrf })
  const select = (name: string, label: string, options: { value: string; label: string }[], current: string | null) =>
    `<select name="${name}" aria-label="${label}">${options.map((x) => `<option value="${esc(x.value)}"${(current ?? '') === x.value ? ' selected' : ''}>${esc(x.label)}</option>`).join('')}</select>`

  let main: string
  if (!c) {
    main = `<section class="chat-main">
      <header class="chat-head"><div class="ttl"><h1>Chats IA</h1></div><div class="tools"><button class="ghost toggle-list" type="button" data-toggle-list>Chats</button></div></header>
      <div class="messages"><div class="thread"><div class="hello"><h2>Discute avec l'IA sur « ${esc(p.name)} »</h2>
        <p>Chaque chat a sa propre branche git et tourne sur l'un de tes Workers avec Claude Code.</p>
        <form method="post" action="/projects/${p.id}/chats">${csrfField(o.csrf)}<button class="primary" type="submit">+ Creer le premier chat</button></form></div></div></div>
    </section>`
  } else {
    const base = `/projects/${p.id}/chats/${c.id}`
    main = `<section class="chat-main">
      <header class="chat-head">
        <div class="ttl">
          <h1>${esc(c.title)}</h1>
          <div class="meta"><span class="chip" id="chat-cost" title="Cout estime cumule des reponses de ce chat (estimation du CLI Claude Code ; sur abonnement, ce sont tes limites d'usage qui sont consommees)"${chatCostLabel(o.messages) ? '' : ' hidden'}>${esc(chatCostLabel(o.messages))}</span>${c.branch_open
            ? `<span class="chip" title="Branche de travail du projet, ouverte par l'IA">${I.branch}${esc(c.branch)}</span>`
            : '<span class="chip accent" title="Dossier libre de ce chat : l\'IA y discute et y imagine des interfaces. Aucune branche, rien n\'est pousse sur GitHub tant que le projet n\'est pas modifie.">Atelier</span>'}${c.worker_name ? `<span class="chip" title="Worker qui detient ce chat">${I.worker}${esc(c.worker_name)}</span>` : ''}</div>
        </div>
        <div class="tools">
          <button class="ghost toggle-list" type="button" data-toggle-list>Chats</button>
          <details><summary aria-label="Options du chat">⋯</summary>
            <div class="menu">
              <form method="post" action="${base}/rename">${csrfField(o.csrf)}
                <label>Renommer <input type="text" name="title" maxlength="${MAX_TITLE}" value="${esc(c.title === DEFAULT_TITLE ? '' : c.title)}" placeholder="${esc(c.title)}" required></label>
                <button type="submit">Enregistrer</button>
              </form>
              <hr>
              <p class="muted small">Supprime le chat de ce site.${c.branch_open ? ` La branche <code>${esc(c.branch)}</code> reste sur GitHub.` : " Son atelier est supprime du Worker au prochain nettoyage."}</p>
              <form method="post" action="${base}/delete">${csrfField(o.csrf)}<button class="danger" type="submit">Supprimer ce chat</button></form>
            </div>
          </details>
        </div>
      </header>
      <div class="messages" id="messages">${threadHtml({ files: o.files, chatUrl: base, messages: o.messages, events: o.events, previews: o.previews, noWorker: o.noWorker, workerName: c.worker_name })}</div>
      <div class="composer-wrap">
        <div class="composer-error" id="composer-error">${alert(o.error)}</div>
        <form class="composer" id="composer" method="post" action="${base}/messages" autocomplete="off" data-attach="${base}/attachments" data-csrf="${esc(o.csrf)}">
          ${csrfField(o.csrf)}
          <input type="hidden" name="attachments" id="attachments" value="${o.staged.map((a) => a.id).join(',')}">
          <div class="attach-staged" id="attach-staged">${stagedHtml(o.staged, base)}</div>
          <label class="sr" for="prompt">Message</label>
          <textarea id="prompt" name="prompt" rows="1" maxlength="${MAX_PROMPT}" placeholder="Pose une question, decris une interface a imaginer, ou demande une modification du projet…"${o.pending ? ' disabled' : ''}></textarea>
          <div class="composer-bar">
            <input type="file" id="file-input" multiple hidden>
            <button class="attach ghost" type="button" id="attach-btn" aria-label="Joindre des fichiers" title="Joindre des fichiers (ou glisser-deposer, ou coller une image)">${I.clip}</button>
            ${select('model', 'Modele', MODELS, c.model)}
            ${select('effort', 'Effort de reflexion', EFFORTS, c.effort)}
            <span class="spacer"></span>
            <span class="hintline">Entree pour envoyer · Maj+Entree : nouvelle ligne</span>
            <button class="send primary" type="submit" aria-label="Envoyer"${o.pending ? ' disabled' : ''}>${I.send}</button>
            <button class="stop danger" type="submit" formaction="${base}/cancel" formnovalidate>Arreter</button>
          </div>
        </form>
      </div>
    </section>`
  }

  return appPage(c ? `${c.title} · ${p.name}` : `Chats IA · ${p.name}`, o, 'projects', `
<div class="chat-app" id="chat-app" data-live="${c ? `/projects/${p.id}/chats/${c.id}/live` : ''}" data-pending="${o.pending}">
  <aside class="chat-list" id="chat-list" aria-label="Chats du projet">${list}</aside>
  ${main}
</div>`, { full: true, scripts: ['chat.js'] })
}
