// Page « Bibliotheque » : images en attente, puis images triees regroupees par scope, par style ou par sujet (trois visions de la meme bibliotheque).
import { ratioKind, type LibraryImage } from './library.ts'
import { alert, appPage, csrfField, esc, type Viewer } from './views.ts'

export type Group = 'scope' | 'style' | 'subject'
export const GROUPS: { id: Group; label: string }[] = [{ id: 'scope', label: 'Par scope' }, { id: 'style', label: 'Par style' }, { id: 'subject', label: 'Par sujet' }]
export const groupOf = (v: unknown): Group => (v === 'style' || v === 'subject' ? v : 'scope')

const fmtSize = (n: number) => (n < 1024 ? `${n} o` : n < 1048576 ? `${Math.round(n / 1024)} Ko` : `${(n / 1048576).toFixed(1)} Mo`)
const chips = (csv: string, cls = 'tag') => (csv ? csv.split(',').map((t) => `<span class="${cls}">${esc(t)}</span>`).join('') : '')

const card = (img: LibraryImage, csrf: string) => {
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
  <a class="lib-thumb" href="/library/${img.id}/file" target="_blank" rel="noopener"><img src="/library/${img.id}/file" alt="${esc(img.description || img.file_name)}" loading="lazy"></a>
  <div class="lib-meta">
    <div class="lib-title"><strong>${esc(sorted ? img.title : img.file_name)}</strong>${status}</div>
    ${facts ? `<div class="facts">${facts}</div>` : ''}
    ${img.description ? `<p class="lib-desc">${esc(img.description)}</p>` : ''}
    ${img.colors ? `<div class="tags colors">${chips(img.colors, 'tag color')}</div>` : ''}
    ${img.traits ? `<div class="tags">${chips(img.traits)}</div>` : ''}
    <div class="muted small">${img.width ? `${img.width}×${img.height}${ratio ? ` (${ratio})` : ''} · ` : ''}${fmtSize(img.size)} · ${esc(img.mime.replace('image/', '').toUpperCase())}${img.source === 'generated' ? ' · generee' : ''}${img.origin ? ` · ${esc(img.origin)}` : ''}${img.roblox_status === 'published' ? ` · Roblox ${esc(img.roblox_asset_id ?? '')}` : ''}</div>
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
        <label>Provenance <input type="text" name="origin" maxlength="60" value="${esc(img.origin)}" placeholder="pack Fantasy GUI"></label>
        <button type="submit">Enregistrer</button>
      </form>
      <form method="post" action="/library/${img.id}/delete">${csrfField(csrf)}<button class="danger" type="submit">Supprimer</button></form>
    </details>`}
  </div>
</article>`
}

/** Contenu de la grille (renvoye tel quel par /library/live). `group` : la facette qui regroupe les images triees. */
export function libraryGridHtml(images: LibraryImage[], csrf: string, group: Group = 'scope'): string {
  if (!images.length) return '<div class="hello"><h2>Ta bibliotheque est vide</h2><p>Ajoute des images (icones, fonds, personnages...) : une IA les decrira (scope, style, sujet, couleurs) pour que les agents qui construisent tes interfaces puissent les retrouver.</p></div>'
  const waiting = images.filter((i) => i.status !== 'sorted')
  const sorted = images.filter((i) => i.status === 'sorted')
  const parts: string[] = []
  if (waiting.length) parts.push(`<section><h2>En attente <span class="count">${waiting.length}</span></h2><div class="lib-grid">${waiting.map((i) => card(i, csrf)).join('')}</div></section>`)
  const key = (i: LibraryImage) => i[group] || '(non defini)'
  const names = [...new Set(sorted.map(key))].sort()
  for (const n of names) {
    const list = sorted.filter((i) => key(i) === n)
    const rename = n === '(non defini)' ? '' : `<details class="lib-rename"><summary>Renommer / fusionner</summary>
      <form method="post" action="/library/rename">${csrfField(csrf)}<input type="hidden" name="facet" value="${group}"><input type="hidden" name="from" value="${esc(n)}">
        <input type="text" name="to" maxlength="40" value="${esc(n)}" aria-label="Nouveau nom" required><button type="submit">Renommer</button></form>
      <p class="muted small">Un nom deja existant fusionne les deux groupes.</p></details>`
    parts.push(`<section><h2><span class="folder">${esc(n)}</span> <span class="count">${list.length}</span>${rename}</h2><div class="lib-grid">${list.map((i) => card(i, csrf)).join('')}</div></section>`)
  }
  return parts.join('\n')
}

export interface LibraryPageData { images: LibraryImage[]; counts: { pending: number; sorting: number; sorted: number }; error?: string; noWorker: boolean; group: Group }

export function libraryPage(o: Viewer & LibraryPageData) {
  const busy = o.counts.sorting > 0
  return appPage('Bibliotheque', o, 'library', `
<div class="library" id="library" data-csrf="${esc(o.csrf)}" data-sorting="${busy}" data-group="${o.group}">
  <header class="page-head">
    <div><h1>Bibliotheque d'images</h1>
      <p class="muted">${o.counts.sorted} triee(s) · ${o.counts.pending} en attente${busy ? ` · ${o.counts.sorting} en cours de tri` : ''}. Les agents qui construisent tes interfaces y choisissent leurs images.</p></div>
    <div class="actions">
      <input type="file" id="lib-input" accept="image/png,image/jpeg,image/webp,image/gif" multiple hidden>
      <button type="button" id="lib-add">Ajouter des images</button>
      <form method="post" action="/library/sort" id="lib-sort-form">${csrfField(o.csrf)}<button class="primary" type="submit" id="lib-sort"${o.counts.pending && !busy ? '' : ' disabled'}>Trier${o.counts.pending ? ` ${o.counts.pending} image(s)` : ''}</button></form>
      ${busy ? `<form method="post" action="/library/sort/cancel">${csrfField(o.csrf)}<button type="submit">Annuler le tri</button></form>` : ''}
    </div>
  </header>
  <nav class="lib-tabs" aria-label="Vue">${GROUPS.map((g) => `<a href="/library?group=${g.id}"${g.id === o.group ? ' class="active" aria-current="page"' : ''}>${g.label}</a>`).join('')}</nav>
  <div id="lib-error">${alert(o.error)}</div>
  ${o.noWorker && (o.counts.pending || busy) ? alert("Aucun Worker connecte ne dispose de Claude Code : le tri attendra qu'il y en ait un.") : ''}
  <div class="lib-drop" id="lib-drop" hidden>Depose tes images pour les ajouter</div>
  <div id="lib-grid">${libraryGridHtml(o.images, o.csrf, o.group)}</div>
</div>`, { scripts: ['library.js'] })
}
