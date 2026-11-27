// Page « Bibliotheque » : images en attente, puis images triees regroupees par scope, par style ou par sujet (trois visions de la meme bibliotheque).
import { ratioKind, type LibraryImage } from './library.ts'
import { FORMATS, type TargetOption } from './library-publish.ts'
import { alert, appPage, csrfField, esc, type Viewer } from './views.ts'

export type Group = 'scope' | 'style' | 'subject'
export const GROUPS: { id: Group; label: string }[] = [{ id: 'scope', label: 'Par scope' }, { id: 'style', label: 'Par style' }, { id: 'subject', label: 'Par sujet' }]
/** Les deux vues de la page : images triees (regroupees par scope, style ou sujet) et images en attente. */
export type View = 'sorted' | 'pending'
export const viewOf = (v: unknown, counts: { sorted: number; pending: number; sorting: number }): View =>
  v === 'pending' || v === 'sorted' ? v : counts.sorted === 0 && counts.pending + counts.sorting > 0 ? 'pending' : 'sorted'
export const groupOf = (v: unknown): Group => (v === 'style' || v === 'subject' ? v : 'scope')

const fmtSize = (n: number) => (n < 1024 ? `${n} o` : n < 1048576 ? `${Math.round(n / 1024)} Ko` : `${(n / 1048576).toFixed(1)} Mo`)
const chips = (csv: string, cls = 'tag') => (csv ? csv.split(',').map((t) => `<span class="${cls}">${esc(t)}</span>`).join('') : '')

const viewField = (view: string) => `<input type="hidden" name="view" value="${view}">`

const robloxLine = (img: LibraryImage, csrf: string, targets: TargetOption[], view = 'sorted') => {
  if (img.status !== 'sorted') return ''
  if (img.roblox_status === 'published') return `<div class="rbx ok"><strong>Roblox</strong> <code>rbxassetid://${esc(img.roblox_asset_id ?? '')}</code>${img.published_by ? ` <span class="muted small">(${esc(img.published_by)})</span>` : ''}</div>`
  if (img.roblox_status === 'publishing') return '<div class="rbx wait">Publication en cours (moderation Roblox)…</div>'
  const form = !FORMATS[img.mime] ? '<span class="muted small">Format non publiable sur Roblox (PNG ou JPEG seulement).</span>'
    : !targets.length ? '<span class="muted small">Lie un compte Roblox a un projet pour publier.</span>'
    : `<form method="post" action="/library/${img.id}/publish" class="rbx-form">${csrfField(csrf)}${viewField(view)}<select name="target" aria-label="Publier sur">${targets.map((t) => `<option value="${esc(t.value)}">${esc(t.label)}</option>`).join('')}</select><button type="submit">Publier sur Roblox</button></form>`
  return `<div class="rbx">${img.roblox_status === 'failed' && img.roblox_error ? `<p class="alert error small">${esc(img.roblox_error)}</p>` : ''}${form}</div>`
}

const card = (img: LibraryImage, csrf: string, targets: TargetOption[] = [], view = 'sorted') => {
  const status = img.status === 'sorting' ? '<span class="chip accent">Tri en cours…</span>' : img.status === 'pending' ? '<span class="chip">En attente</span>' : ''
  const locked = img.status === 'sorting'
  const sorted = img.status === 'sorted'
  const ratio = ratioKind(img.width, img.height)
  const facts = [
    sorted && img.scope ? `<span class="chip">${esc(img.scope)}</span>` : '',
    sorted && img.style ? `<span class="chip style">${esc(img.style)}</span>` : '',
    sorted && img.subject ? `<span class="chip subject">${esc(img.subject)}</span>` : '',
  ].join('')
  return `<article class="lib-card" id="i${img.id}">
  <a class="lib-thumb" href="/library/${img.id}/file" target="_blank" rel="noopener"><img src="/library/${img.id}/file" alt="${esc(img.description || img.file_name)}" loading="lazy" decoding="async"></a>
  <div class="lib-meta">
    <div class="lib-title"><strong>${esc(sorted ? img.title : img.file_name)}</strong>${status}</div>
    ${facts ? `<div class="facts">${facts}</div>` : ''}
    ${img.description ? `<p class="lib-desc">${esc(img.description)}</p>` : ''}
    ${img.colors ? `<div class="tags colors">${chips(img.colors, 'tag color')}</div>` : ''}
    ${img.traits ? `<div class="tags">${chips(img.traits)}</div>` : ''}
    <div class="muted small">${img.width ? `${img.width}×${img.height}${ratio ? ` (${ratio})` : ''} · ` : ''}${fmtSize(img.size)} · ${esc(img.mime.replace('image/', '').toUpperCase())}${img.source === 'generated' ? ' · generee' : ''}${img.origin ? ` · ${esc(img.origin)}` : ''}${img.hint ? ` · ${esc(img.hint)}/` : ''}${img.roblox_status === 'published' ? ` · Roblox ${esc(img.roblox_asset_id ?? '')}` : ''}</div>
    ${robloxLine(img, csrf, targets, view)}
    ${locked ? '' : `<details class="lib-edit"><summary>Modifier</summary>
      <form method="post" action="/library/${img.id}/edit">${csrfField(csrf)}${viewField(view)}
        <label>Nom <input type="text" name="title" maxlength="60" value="${esc(sorted ? img.title : '')}" placeholder="${esc(img.title)}"></label>
        <label>Scope <input type="text" name="scope" maxlength="32" value="${esc(img.scope)}" placeholder="icon, decoration, background..."></label>
        <label>Style <input type="text" name="style" maxlength="40" value="${esc(img.style)}" placeholder="cartoon-contour-epais"></label>
        <label>Traits du style <input type="text" name="traits" maxlength="200" value="${esc(img.traits.replace(/,/g, ', '))}" placeholder="cartoon, contours-epais, saturee"></label>
        <label>Sujet <input type="text" name="subject" maxlength="40" value="${esc(img.subject)}" placeholder="pendule"></label>
        <label>Couleurs <input type="text" name="colors" maxlength="100" value="${esc(img.colors.replace(/,/g, ', '))}" placeholder="rouge, or"></label>
        <label>Description <textarea name="description" rows="2" maxlength="160">${esc(img.description)}</textarea></label>
        <label>Mots-cles <input type="text" name="tags" maxlength="300" value="${esc(img.tags.replace(/,/g, ', '))}" placeholder="epee, sword, arme"></label>
        <label>Provenance (pack) <input type="text" name="origin" maxlength="60" value="${esc(img.origin)}" placeholder="pack Fantasy GUI"></label>
        <button type="submit">Enregistrer</button>
      </form>
      <form method="post" action="/library/${img.id}/delete">${csrfField(csrf)}${viewField(view)}<button class="danger" type="submit">Supprimer</button></form>
    </details>`}
  </div>
</article>`
}

export const PAGE_SIZE = 48

export interface GridOptions { view?: View; group?: Group; targets?: TargetOption[]; page?: number; q?: string }

const norm = (s: string) => s.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
/** Une image correspond si TOUS les mots de la recherche apparaissent dans son nom, sa description, ses mots-cles, son style, son sujet, son scope, ses couleurs ou sa provenance. */
export function matches(img: LibraryImage, q: string): boolean {
  const words = norm(q).split(/[^a-z0-9]+/).filter(Boolean)
  if (!words.length) return true
  const hay = norm([img.file_name, img.title, img.description, img.tags, img.style, img.traits, img.subject, img.scope, img.colors, img.origin, img.hint].join(' '))
  return words.every((w) => hay.includes(w))
}

const pageLink = (o: { view: View; group: Group; q: string }, p: number) => `/library?view=${o.view}&group=${o.group}${o.q ? `&q=${encodeURIComponent(o.q)}` : ''}${p > 1 ? `&p=${p}` : ''}`

function pager(o: { view: View; group: Group; q: string }, page: number, pages: number, total: number): string {
  if (pages <= 1) return `<p class="muted small lib-count">${total} image(s)</p>`
  const nums = new Set([1, pages, page - 2, page - 1, page, page + 1, page + 2].filter((n) => n >= 1 && n <= pages))
  const items: string[] = []
  let last = 0
  for (const n of [...nums].sort((a, b) => a - b)) {
    if (n - last > 1) items.push('<span class="gap">…</span>')
    items.push(n === page ? `<span class="cur" aria-current="page">${n}</span>` : `<a href="${pageLink(o, n)}">${n}</a>`)
    last = n
  }
  return `<nav class="lib-pages" aria-label="Pages"><span class="muted small">${total} image(s) · ${PAGE_SIZE} par page</span>${page > 1 ? `<a href="${pageLink(o, page - 1)}">‹ Precedente</a>` : ''}${items.join('')}${page < pages ? `<a href="${pageLink(o, page + 1)}">Suivante ›</a>` : ''}</nav>`
}

/** Contenu de la grille (renvoye tel quel par /library/live). Une page (48 images) a la fois : le navigateur ne charge que celles-la, jamais toute la bibliotheque. */
export function libraryGridHtml(images: LibraryImage[], csrf: string, opts: GridOptions = {}): string {
  const view = opts.view ?? 'sorted'
  const group = opts.group ?? 'scope'
  const targets = opts.targets ?? []
  const q = (opts.q ?? '').trim().slice(0, 100)
  const inView = images.filter((i) => (view === 'sorted' ? i.status === 'sorted' : i.status !== 'sorted'))
  if (!inView.length) {
    return view === 'sorted'
      ? '<div class="hello"><h2>Aucune image triee</h2><p>Les images triees apparaissent ici, decrites par scope, style, sujet et couleurs, pretes a etre choisies par les agents qui construisent tes interfaces. Ajoute des images, puis lance le tri depuis l\'onglet « En attente ».</p></div>'
      : '<div class="hello"><h2>Aucune image en attente</h2><p>Ajoute des images ou un pack (.zip) : elles attendent ici d\'etre decrites et rangees par une IA.</p></div>'
  }
  const shown = q ? inView.filter((i) => matches(i, q)) : inView
  if (!shown.length) return `<div class="hello"><h2>Aucune image ne correspond</h2><p>Rien pour « ${esc(q)} ». <a href="/library?view=${view}&group=${group}">Voir toutes les images</a></p></div>`
  const key = (i: LibraryImage) => i[group] || '(non defini)'
  const ordered = view === 'sorted' ? [...shown].sort((a, b) => key(a).localeCompare(key(b)) || a.title.localeCompare(b.title)) : shown
  const pages = Math.max(1, Math.ceil(ordered.length / PAGE_SIZE))
  const page = Math.min(Math.max(1, Math.floor(opts.page ?? 1) || 1), pages)
  const slice = ordered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)
  const parts: string[] = []
  if (view === 'pending') {
    parts.push(`<div class="lib-grid">${slice.map((i) => card(i, csrf, targets, view)).join('')}</div>`)
  } else {
    const totals = new Map<string, number>()
    for (const i of ordered) totals.set(key(i), (totals.get(key(i)) ?? 0) + 1)
    const runs: { name: string; list: LibraryImage[] }[] = []
    for (const i of slice) {
      const last = runs.at(-1)
      if (last && last.name === key(i)) last.list.push(i); else runs.push({ name: key(i), list: [i] })
    }
    for (const { name: n, list } of runs) {
      const rename = n === '(non defini)' ? '' : `<details class="lib-rename"><summary>Renommer / fusionner</summary>
      <form method="post" action="/library/rename">${csrfField(csrf)}<input type="hidden" name="facet" value="${group}"><input type="hidden" name="from" value="${esc(n)}">
        <input type="text" name="to" maxlength="40" value="${esc(n)}" aria-label="Nouveau nom" required><button type="submit">Renommer</button></form>
      <p class="muted small">Un nom deja existant fusionne les deux groupes.</p></details>`
      parts.push(`<section><h2><span class="folder">${esc(n)}</span> <span class="count">${totals.get(n) ?? list.length}</span>${rename}</h2><div class="lib-grid">${list.map((i) => card(i, csrf, targets, view)).join('')}</div></section>`)
    }
  }
  return `${parts.join('\n')}\n${pager({ view, group, q }, page, pages, ordered.length)}`
}

export interface LibraryPageData { images: LibraryImage[]; counts: { pending: number; sorting: number; sorted: number }; error?: string; noWorker: boolean; group: Group; autoPublish: boolean; targets: TargetOption[]; page?: number; q?: string; view: View }

export function libraryPage(o: Viewer & LibraryPageData) {
  const busy = o.counts.sorting > 0
  const waiting = o.counts.pending + o.counts.sorting
  const sortedView = o.view === 'sorted'
  const tab = (v: View, label: string, n: number) => `<a href="/library?view=${v}${v === 'sorted' ? `&group=${o.group}` : ''}"${o.view === v ? ' class="active" aria-current="page"' : ''}>${label} <span class="count">${n}</span></a>`
  const stateQ = `${o.q ? `&q=${encodeURIComponent(o.q)}` : ''}`
  return appPage('Bibliotheque', o, 'library', `
<div class="library" id="library" data-csrf="${esc(o.csrf)}" data-sorting="${busy}" data-view="${o.view}">
  <header class="page-head">
    <div><h1>Bibliotheque d'images</h1>
      <p class="muted">Les agents qui construisent tes interfaces y choisissent leurs images.</p></div>
    <div class="actions">
      <input type="file" id="lib-input" accept="image/png,image/jpeg,image/webp,image/gif,.zip,application/zip" multiple hidden>
      <button type="button" id="lib-add" title="Images, ou un pack complet en archive ZIP (tout ce qui n'est pas une image est ignore)">Ajouter des images ou un pack (.zip)</button>
    </div>
  </header>
  <nav class="lib-tabs main" aria-label="Section">${tab('sorted', 'Triees', o.counts.sorted)}${tab('pending', 'En attente', waiting)}</nav>
  <div id="lib-error">${alert(o.error)}</div>
  ${o.noWorker && waiting ? alert("Aucun Worker connecte ne dispose de Claude Code : le tri attendra qu'il y en ait un.") : ''}
  ${sortedView ? `
  <section class="lib-find" id="lib-find" data-csrf="${esc(o.csrf)}">
    <h2>Retrouver une image par description</h2>
    <p class="muted small">Decris l'image que tu cherches : une IA parcourt tes images triees et te montre celles qui correspondent le mieux (quelques dizaines de secondes).</p>
    <form id="lib-find-form" class="lib-find-form">
      <textarea id="lib-find-q" name="query" rows="2" maxlength="300" placeholder="Ex. une petite icone d'epee rouge dans un style cartoon, fond transparent" aria-label="Description de l'image cherchee"${o.counts.sorted ? '' : ' disabled'}></textarea>
      <button class="primary" type="submit" id="lib-find-btn"${o.counts.sorted ? '' : ' disabled'}>Chercher avec l'IA</button>
    </form>
    <div id="lib-find-out" aria-live="polite"></div>
  </section>
  <form method="post" action="/library/settings" class="lib-settings">${csrfField(o.csrf)}
    <label><input type="checkbox" name="auto_publish" value="1"${o.autoPublish ? ' checked' : ''}> Publier automatiquement sur Roblox les images utilisees quand une IA integre un concept valide dans un projet</label>
    <button type="submit">Enregistrer</button>
  </form>` : `
  <div class="lib-sortbar">
    <p class="muted">${o.counts.pending} en attente${busy ? ` · ${o.counts.sorting} en cours de tri` : ''}. Une IA decrit chaque image (scope, style, sujet, couleurs) et la range.</p>
    <form method="post" action="/library/sort" id="lib-sort-form" class="lib-sort">${csrfField(o.csrf)}<label class="sr" for="lib-count">Nombre d'images a trier</label><input type="number" id="lib-count" name="count" min="1" max="${o.counts.pending}" value="${Math.min(o.counts.pending, 80) || ''}" inputmode="numeric"${o.counts.pending && !busy ? '' : ' disabled'} title="Nombre d'images a trier maintenant (laisse vide pour toutes)"><button class="primary" type="submit" id="lib-sort"${o.counts.pending && !busy ? '' : ' disabled'}>Trier${o.counts.pending ? ` sur ${o.counts.pending}` : ''}</button><span class="muted small" id="lib-estimate"></span></form>
    ${busy ? `<form method="post" action="/library/sort/cancel">${csrfField(o.csrf)}<button type="submit">Annuler le tri</button></form>` : ''}
  </div>`}
  <form method="get" action="/library" class="lib-search" role="search"><input type="hidden" name="view" value="${o.view}"><input type="hidden" name="group" value="${o.group}"><input type="search" name="q" value="${esc(o.q ?? '')}" maxlength="100" placeholder="Filtrer par mots (nom, sujet, style, couleur, mot-cle...)" aria-label="Filtrer par mots"><button type="submit">Filtrer</button>${o.q ? `<a href="/library?view=${o.view}&group=${o.group}">Effacer</a>` : ''}</form>
  ${sortedView ? `<nav class="lib-tabs" aria-label="Regroupement">${GROUPS.map((g) => `<a href="/library?view=sorted&group=${g.id}${stateQ}"${g.id === o.group ? ' class="active" aria-current="page"' : ''}>${g.label}</a>`).join('')}</nav>` : ''}
  <div class="lib-drop" id="lib-drop" hidden>Depose tes images ou ton pack (.zip) pour les ajouter</div>
  <div id="lib-grid">${libraryGridHtml(o.images, o.csrf, { view: o.view, group: o.group, targets: o.targets, page: o.page, q: o.q })}</div>
</div>`, { scripts: ['library.js'] })
}

/** Resultats de la recherche par description : les images les plus proches d'abord, avec la raison donnee par l'agent. */
export function findResultsHtml(matches: { image: LibraryImage; why: string }[]): string {
  if (!matches.length) return '<p class="muted">Aucune image triee ne correspond vraiment a cette description. Essaie avec d\'autres mots, ou ajoute des images.</p>'
  return `<p class="muted small">${matches.length} image(s), les plus proches d'abord.</p><div class="lib-grid">${matches.map(({ image: i, why }, n) => `<article class="lib-card find">
  <a class="lib-thumb" href="/library/${i.id}/file" target="_blank" rel="noopener"><img src="/library/${i.id}/file" alt="${esc(i.description || i.title)}" loading="lazy" decoding="async"></a>
  <div class="lib-meta">
    <div class="lib-title"><strong>${n + 1}. ${esc(i.title)}</strong></div>
    <div class="facts">${[i.scope, i.style, i.subject].filter(Boolean).map((x, k) => `<span class="chip${k === 1 ? ' style' : k === 2 ? ' subject' : ''}">${esc(x)}</span>`).join('')}</div>
    ${why ? `<p class="lib-why">${esc(why)}</p>` : ''}
    <p class="lib-desc">${esc(i.description)}</p>
    ${i.roblox_status === 'published' ? `<div class="rbx ok"><code>rbxassetid://${esc(i.roblox_asset_id ?? '')}</code></div>` : ''}
    <a class="small" href="/library?view=sorted&group=scope&q=${encodeURIComponent(i.title)}">Voir dans la bibliotheque</a>
  </div>
</article>`).join('')}</div>`
}
