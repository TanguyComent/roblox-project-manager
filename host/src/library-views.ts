// Page « Bibliotheque » : images en attente, puis images triees regroupees par dossier du vault.
import type { LibraryImage } from './library.ts'
import { alert, appPage, csrfField, esc, type Viewer } from './views.ts'

const fmtSize = (n: number) => (n < 1024 ? `${n} o` : n < 1048576 ? `${Math.round(n / 1024)} Ko` : `${(n / 1048576).toFixed(1)} Mo`)

const card = (img: LibraryImage, csrf: string) => {
  const tags = img.tags ? img.tags.split(',').map((t) => `<span class="tag">${esc(t)}</span>`).join('') : ''
  const status = img.status === 'sorting' ? '<span class="chip accent">Tri en cours…</span>' : img.status === 'pending' ? '<span class="chip">En attente</span>' : ''
  const locked = img.status === 'sorting'
  return `<article class="lib-card" id="i${img.id}">
  <a class="lib-thumb" href="/library/${img.id}/file" target="_blank" rel="noopener"><img src="/library/${img.id}/file" alt="${esc(img.description || img.file_name)}" loading="lazy"></a>
  <div class="lib-meta">
    <div class="lib-title"><strong>${esc(img.status === 'sorted' ? img.title : img.file_name)}</strong>${status}</div>
    ${img.description ? `<p class="lib-desc">${esc(img.description)}</p>` : ''}
    ${tags ? `<div class="tags">${tags}</div>` : ''}
    <div class="muted small">${fmtSize(img.size)} · ${esc(img.mime.replace('image/', '').toUpperCase())}${img.source === 'generated' ? ' · generee' : ''}${img.roblox_status === 'published' ? ` · Roblox ${esc(img.roblox_asset_id ?? '')}` : ''}</div>
    ${locked ? '' : `<details class="lib-edit"><summary>Modifier</summary>
      <form method="post" action="/library/${img.id}/edit">${csrfField(csrf)}
        <label>Nom <input type="text" name="title" maxlength="60" value="${esc(img.status === 'sorted' ? img.title : '')}" placeholder="${esc(img.title)}"></label>
        <label>Dossier <input type="text" name="folder" maxlength="100" value="${esc(img.folder)}" placeholder="icons/shop"></label>
        <label>Description <textarea name="description" rows="2" maxlength="300">${esc(img.description)}</textarea></label>
        <label>Mots-cles <input type="text" name="tags" maxlength="300" value="${esc(img.tags.replace(/,/g, ', '))}" placeholder="epee, arme, icone"></label>
        <button type="submit">Enregistrer</button>
      </form>
      <form method="post" action="/library/${img.id}/delete">${csrfField(csrf)}<button class="danger" type="submit">Supprimer</button></form>
    </details>`}
  </div>
</article>`
}

/** Contenu de la grille (renvoye tel quel par /library/live). */
export function libraryGridHtml(images: LibraryImage[], csrf: string): string {
  if (!images.length) return '<div class="hello"><h2>Ta bibliotheque est vide</h2><p>Ajoute des images (icones, fonds, personnages...) : une IA les decrira et les rangera pour que les agents qui construisent tes interfaces puissent les retrouver.</p></div>'
  const waiting = images.filter((i) => i.status !== 'sorted')
  const sorted = images.filter((i) => i.status === 'sorted')
  const parts: string[] = []
  if (waiting.length) parts.push(`<section><h2>En attente <span class="count">${waiting.length}</span></h2><div class="lib-grid">${waiting.map((i) => card(i, csrf)).join('')}</div></section>`)
  const folders = [...new Set(sorted.map((i) => i.folder))].sort()
  for (const f of folders) {
    const list = sorted.filter((i) => i.folder === f)
    parts.push(`<section><h2><span class="folder">${esc(f)}/</span> <span class="count">${list.length}</span></h2><div class="lib-grid">${list.map((i) => card(i, csrf)).join('')}</div></section>`)
  }
  return parts.join('\n')
}

export interface LibraryPageData { images: LibraryImage[]; counts: { pending: number; sorting: number; sorted: number }; error?: string; noWorker: boolean }

export function libraryPage(o: Viewer & LibraryPageData) {
  const busy = o.counts.sorting > 0
  return appPage('Bibliotheque', o, 'library', `
<div class="library" id="library" data-csrf="${esc(o.csrf)}" data-sorting="${busy}">
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
  <div id="lib-error">${alert(o.error)}</div>
  ${o.noWorker && (o.counts.pending || busy) ? alert("Aucun Worker connecte ne dispose de Claude Code : le tri attendra qu'il y en ait un.") : ''}
  <div class="lib-drop" id="lib-drop" hidden>Depose tes images pour les ajouter</div>
  <div id="lib-grid">${libraryGridHtml(o.images, o.csrf)}</div>
</div>`, { scripts: ['library.js'] })
}
