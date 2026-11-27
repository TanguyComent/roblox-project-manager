// Page « Bibliotheque » : images en attente, puis images triees regroupees par scope, par style ou par sujet (trois visions de la meme bibliotheque).
import { ratioKind, type LibraryImage } from './library.ts'
import { FORMATS, type TargetOption } from './library-publish.ts'
import { alert, appPage, csrfField, esc, type Viewer } from './views.ts'

export type Group = 'scope' | 'style' | 'subject'
export const GROUPS: { id: Group; label: string }[] = [{ id: 'scope', label: 'Par scope' }, { id: 'style', label: 'Par style' }, { id: 'subject', label: 'Par sujet' }]
export const groupOf = (v: unknown): Group => (v === 'style' || v === 'subject' ? v : 'scope')

const fmtSize = (n: number) => (n < 1024 ? `${n} o` : n < 1048576 ? `${Math.round(n / 1024)} Ko` : `${(n / 1048576).toFixed(1)} Mo`)
const chips = (csv: string, cls = 'tag') => (csv ? csv.split(',').map((t) => `<span class="${cls}">${esc(t)}</span>`).join('') : '')

const robloxLine = (img: LibraryImage, csrf: string, targets: TargetOption[]) => {
  if (img.status !== 'sorted') return ''
  if (img.roblox_status === 'published') return `<div class="rbx ok"><strong>Roblox</strong> <code>rbxassetid://${esc(img.roblox_asset_id ?? '')}</code>${img.published_by ? ` <span class="muted small">(${esc(img.published_by)})</span>` : ''}</div>`
  if (img.roblox_status === 'publishing') return '<div class="rbx wait">Publication en cours (moderation Roblox)…</div>'
  const form = !FORMATS[img.mime] ? '<span class="muted small">Format non publiable sur Roblox (PNG ou JPEG seulement).</span>'
    : !targets.length ? '<span class="muted small">Lie un compte Roblox a un projet pour publier.</span>'
    : `<form method="post" action="/library/${img.id}/publish" class="rbx-form">${csrfField(csrf)}<select name="target" aria-label="Publier sur">${targets.map((t) => `<option value="${esc(t.value)}">${esc(t.label)}</option>`).join('')}</select><button type="submit">Publier sur Roblox</button></form>`
  return `<div class="rbx">${img.roblox_status === 'failed' && img.roblox_error ? `<p class="alert error small">${esc(img.roblox_error)}</p>` : ''}${form}</div>`
}

const card = (img: LibraryImage, csrf: string, targets: TargetOption[] = []) => {
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
    ${robloxLine(img, csrf, targets)}
    ${locked ? '' : `<details class="lib-edit"><summary>Modifier</summary>
      <form method="post" action="/library/${img.id}/edit">${csrfField(csrf)}
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
      <form method="post" action="/library/${img.id}/delete">${csrfField(csrf)}<button class="danger" type="submit">Supprimer</button></form>
    </details>`}
  </div>
</article>`
}

export const PAGE_SIZE = 48

export interface GridOptions { group?: Group; targets?: TargetOption[]; page?: number; q?: string }

const norm = (s: string) => s.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
/** Une image correspond si TOUS les mots de la recherche apparaissent dans son nom, sa description, ses mots-cles, son style, son sujet, son scope, ses couleurs ou sa provenance. */
export function matches(img: LibraryImage, q: string): boolean {
  const words = norm(q).split(/[^a-z0-9]+/).filter(Boolean)
  if (!words.length) return true
  const hay = norm([img.file_name, img.title, img.description, img.tags, img.style, img.traits, img.subject, img.scope, img.colors, img.origin, img.hint].join(' '))
  return words.every((w) => hay.includes(w))
}

const pageLink = (o: { group: Group; q: string }, p: number) => `/library?group=${o.group}${o.q ? `&q=${encodeURIComponent(o.q)}` : ''}${p > 1 ? `&p=${p}` : ''}`

function pager(o: { group: Group; q: string }, page: number, pages: number, total: number): string {
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
  const group = opts.group ?? 'scope'
  const targets = opts.targets ?? []
  const q = (opts.q ?? '').trim().slice(0, 100)
  if (!images.length) return '<div class="hello"><h2>Ta bibliotheque est vide</h2><p>Ajoute des images (icones, fonds, personnages...) : une IA les decrira (scope, style, sujet, couleurs) pour que les agents qui construisent tes interfaces puissent les retrouver.</p></div>'
  const shown = q ? images.filter((i) => matches(i, q)) : images
  if (!shown.length) return `<div class="hello"><h2>Aucune image ne correspond</h2><p>Rien pour « ${esc(q)} ». <a href="/library?group=${group}">Voir toute la bibliotheque</a></p></div>`
  const key = (i: LibraryImage) => i[group] || '(non defini)'
  const waiting = shown.filter((i) => i.status !== 'sorted')
  const sorted = shown.filter((i) => i.status === 'sorted').sort((a, b) => key(a).localeCompare(key(b)) || a.title.localeCompare(b.title))
  const ordered = [...waiting, ...sorted]
  const pages = Math.max(1, Math.ceil(ordered.length / PAGE_SIZE))
  const page = Math.min(Math.max(1, Math.floor(opts.page ?? 1) || 1), pages)
  const slice = ordered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)
  const totals = new Map<string, number>()
  for (const i of sorted) totals.set(key(i), (totals.get(key(i)) ?? 0) + 1)

  const parts: string[] = []
  const wslice = slice.filter((i) => i.status !== 'sorted')
  if (wslice.length) parts.push(`<section><h2>En attente <span class="count">${waiting.length}</span></h2><div class="lib-grid">${wslice.map((i) => card(i, csrf, targets)).join('')}</div></section>`)
  const runs: { name: string; list: LibraryImage[] }[] = []
  for (const i of slice.filter((x) => x.status === 'sorted')) {
    const last = runs.at(-1)
    if (last && last.name === key(i)) last.list.push(i); else runs.push({ name: key(i), list: [i] })
  }
  for (const { name: n, list } of runs) {
    const rename = n === '(non defini)' ? '' : `<details class="lib-rename"><summary>Renommer / fusionner</summary>
      <form method="post" action="/library/rename">${csrfField(csrf)}<input type="hidden" name="facet" value="${group}"><input type="hidden" name="from" value="${esc(n)}">
        <input type="text" name="to" maxlength="40" value="${esc(n)}" aria-label="Nouveau nom" required><button type="submit">Renommer</button></form>
      <p class="muted small">Un nom deja existant fusionne les deux groupes.</p></details>`
    parts.push(`<section><h2><span class="folder">${esc(n)}</span> <span class="count">${totals.get(n) ?? list.length}</span>${rename}</h2><div class="lib-grid">${list.map((i) => card(i, csrf, targets)).join('')}</div></section>`)
  }
  const nav = pager({ group, q }, page, pages, ordered.length)
  return `${parts.join('\n')}\n${nav}`
}

export interface LibraryPageData { images: LibraryImage[]; counts: { pending: number; sorting: number; sorted: number }; error?: string; noWorker: boolean; group: Group; autoPublish: boolean; targets: TargetOption[]; page?: number; q?: string }

export function libraryPage(o: Viewer & LibraryPageData) {
  const busy = o.counts.sorting > 0
  return appPage('Bibliotheque', o, 'library', `
<div class="library" id="library" data-csrf="${esc(o.csrf)}" data-sorting="${busy}" data-group="${o.group}">
  <header class="page-head">
    <div><h1>Bibliotheque d'images</h1>
      <p class="muted">${o.counts.sorted} triee(s) · ${o.counts.pending} en attente${busy ? ` · ${o.counts.sorting} en cours de tri` : ''}. Les agents qui construisent tes interfaces y choisissent leurs images.</p></div>
    <div class="actions">
      <input type="file" id="lib-input" accept="image/png,image/jpeg,image/webp,image/gif,.zip,application/zip" multiple hidden>
      <button type="button" id="lib-add" title="Images, ou un pack complet en archive ZIP (tout ce qui n'est pas une image est ignore)">Ajouter des images ou un pack (.zip)</button>
      <form method="post" action="/library/sort" id="lib-sort-form">${csrfField(o.csrf)}<button class="primary" type="submit" id="lib-sort"${o.counts.pending && !busy ? '' : ' disabled'}>Trier${o.counts.pending ? ` ${o.counts.pending} image(s)` : ''}</button></form>
      ${busy ? `<form method="post" action="/library/sort/cancel">${csrfField(o.csrf)}<button type="submit">Annuler le tri</button></form>` : ''}
    </div>
  </header>
  <form method="post" action="/library/settings" class="lib-settings">${csrfField(o.csrf)}
    <label><input type="checkbox" name="auto_publish" value="1"${o.autoPublish ? ' checked' : ''}> Publier automatiquement sur Roblox les images utilisees quand une IA integre un concept valide dans un projet</label>
    <button type="submit">Enregistrer</button>
  </form>
  <form method="get" action="/library" class="lib-search" role="search"><input type="hidden" name="group" value="${o.group}"><input type="search" name="q" value="${esc(o.q ?? '')}" maxlength="100" placeholder="Rechercher (nom, sujet, style, couleur, mot-cle...)" aria-label="Rechercher dans la bibliotheque"><button type="submit">Rechercher</button>${o.q ? `<a href="/library?group=${o.group}">Effacer</a>` : ''}</form>
  <nav class="lib-tabs" aria-label="Vue">${GROUPS.map((g) => `<a href="/library?group=${g.id}${o.q ? `&q=${encodeURIComponent(o.q)}` : ''}"${g.id === o.group ? ' class="active" aria-current="page"' : ''}>${g.label}</a>`).join('')}</nav>
  <div id="lib-error">${alert(o.error)}</div>
  ${o.noWorker && (o.counts.pending || busy) ? alert("Aucun Worker connecte ne dispose de Claude Code : le tri attendra qu'il y en ait un.") : ''}
  <div class="lib-drop" id="lib-drop" hidden>Depose tes images pour les ajouter</div>
  <div id="lib-grid">${libraryGridHtml(o.images, o.csrf, { group: o.group, targets: o.targets, page: o.page, q: o.q })}</div>
</div>`, { scripts: ['library.js'] })
}
