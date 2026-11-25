// Page « Choisir le template par defaut » : depot puis branche (deux etapes, sans JavaScript).
import type { RepoSummary } from './github.ts'
import { alert, appPage, csrfField, esc, type Viewer } from './views.ts'

export interface TemplatePickerData {
  repos: RepoSummary[]
  /** Depot dont on affiche les branches (choisi dans l'etape 1, ou le template actuel). */
  selected: string | null
  branches: string[]
  /** Branche a preselectionner. */
  branch: string | null
  current: { repo: string; branch: string } | null
  error?: string
}

export function templatePickerPage(o: Viewer & TemplatePickerData) {
  const option = (r: RepoSummary) =>
    `<option value="${esc(r.fullName)}"${r.fullName === o.selected ? ' selected' : ''}>${esc(r.fullName)}${r.isPrivate ? ' (prive)' : ''}</option>`
  const templates = o.repos.filter((r) => r.isTemplate)
  const others = o.repos.filter((r) => !r.isTemplate)
  const repoSelect = `
    <select name="repo" required>
      ${o.selected ? '' : '<option value="" selected disabled>Choisir un depot…</option>'}
      ${templates.length ? `<optgroup label="Depots marques « template »">${templates.map(option).join('')}</optgroup>` : ''}
      <optgroup label="${templates.length ? 'Autres depots' : 'Tes depots'}">${others.map(option).join('')}</optgroup>
    </select>`
  const branchOptions = o.branches.map((b) => `<option value="${esc(b)}"${b === o.branch ? ' selected' : ''}>${esc(b)}</option>`).join('')

  return appPage('Template par defaut', o, 'account', `
<p class="crumbs"><a href="/account">Compte</a> <span aria-hidden="true">/</span> Template par defaut</p>
<section class="card">
  <h1>Template par defaut</h1>
  <p class="muted">Le depot (et sa branche) copie pour chaque nouveau projet.</p>
  ${o.current ? `<p class="muted small">Actuel : <strong>${esc(o.current.repo)}</strong> · ${o.current.branch ? `branche <code>${esc(o.current.branch)}</code>` : 'branche par defaut'}</p>` : ''}
  ${alert(o.error)}
  ${o.repos.length === 0 && !o.error ? '<div class="empty"><p><strong>Aucun depot accessible avec ce jeton.</strong></p></div>' : ''}
  ${o.repos.length ? `
  <ol class="steps">
    <li>
      <strong>Depot</strong>
      <form method="get" action="/account/github/template" class="pick">
        ${repoSelect}
        <button type="submit">Voir les branches</button>
      </form>
    </li>
    <li>
      <strong>Branche</strong>
      ${o.selected ? `
      <p class="muted small">Branches de <code>${esc(o.selected)}</code>. La branche choisie deviendra la branche principale du nouveau depot ; les autres n'y seront pas conservees.</p>
      <form method="post" action="/account/github/template" class="pick">
        ${csrfField(o.csrf)}
        <input type="hidden" name="repo" value="${esc(o.selected)}">
        <select name="branch" required>${branchOptions}</select>
        <button class="primary" type="submit">Utiliser ce template</button>
      </form>` : '<p class="muted small">Choisis d\'abord un depot.</p>'}
    </li>
  </ol>` : ''}
  <div class="actions">
    ${o.current ? `<form method="post" action="/account/github/template/clear" class="inline">${csrfField(o.csrf)}<button class="ghost danger" type="submit">Retirer le template par defaut</button></form>` : ''}
    <a class="button" href="/account">Retour</a>
  </div>
</section>`)
}
