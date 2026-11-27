// Page « Choisir un template » : depot puis branche (deux etapes, sans JavaScript). Deux reglages utilisent la meme page :
//  - « project » : le template copie pour chaque NOUVEAU PROJET ;
//  - « ui »      : le depot minimal dont partent les chats « Maquette UI ».
import type { RepoSummary } from './github.ts'
import { alert, appPage, csrfField, esc, type Viewer } from './views.ts'

export type TemplateKind = 'project' | 'ui'

export interface TemplatePickerData {
  kind: TemplateKind
  repos: RepoSummary[]
  /** Depot dont on affiche les branches (choisi dans l'etape 1, ou le template actuel). */
  selected: string | null
  branches: string[]
  /** Branche a preselectionner. */
  branch: string | null
  current: { repo: string; branch: string } | null
  error?: string
}

const TEXT: Record<TemplateKind, { title: string; intro: string; path: string; branchNote: string; use: string; remove: string }> = {
  project: {
    title: 'Template par defaut', path: '/account/github/template', use: 'Utiliser ce template', remove: 'Retirer le template par defaut',
    intro: 'Le depot (et sa branche) copie pour chaque nouveau projet.',
    branchNote: "La branche choisie deviendra la branche principale du nouveau depot ; les autres n'y seront pas conservees.",
  },
  ui: {
    title: 'Depot de maquette UI', path: '/account/github/ui-template', use: 'Utiliser ce depot', remove: 'Retirer le depot de maquette',
    intro: "Le depot minimal dont partent les chats « Maquette UI » : ton kit de composants, sans le reste d'un jeu. Le Worker le clone pour chaque maquette ; il n'est jamais modifie ni pousse.",
    branchNote: "Chaque maquette part de cette branche, sur sa propre branche locale. Le Worker doit pouvoir cloner ce depot avec ses identifiants git.",
  },
}

export function templatePickerPage(o: Viewer & TemplatePickerData) {
  const t = TEXT[o.kind]
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

  return appPage(t.title, o, 'account', `
<p class="crumbs"><a href="/account">Compte</a> <span aria-hidden="true">/</span> ${esc(t.title)}</p>
<section class="card">
  <h1>${esc(t.title)}</h1>
  <p class="muted">${esc(t.intro)}</p>
  ${o.current ? `<p class="muted small">Actuel : <strong>${esc(o.current.repo)}</strong> · ${o.current.branch ? `branche <code>${esc(o.current.branch)}</code>` : 'branche par defaut'}</p>` : ''}
  ${alert(o.error)}
  ${o.repos.length === 0 && !o.error ? '<div class="empty"><p><strong>Aucun depot accessible avec ce jeton.</strong></p></div>' : ''}
  ${o.repos.length ? `
  <ol class="steps">
    <li>
      <strong>Depot</strong>
      <form method="get" action="${t.path}" class="pick">
        ${repoSelect}
        <button type="submit">Voir les branches</button>
      </form>
    </li>
    <li>
      <strong>Branche</strong>
      ${o.selected ? `
      <p class="muted small">Branches de <code>${esc(o.selected)}</code>. ${esc(t.branchNote)}</p>
      <form method="post" action="${t.path}" class="pick">
        ${csrfField(o.csrf)}
        <input type="hidden" name="repo" value="${esc(o.selected)}">
        <select name="branch" required>${branchOptions}</select>
        <button class="primary" type="submit">${esc(t.use)}</button>
      </form>` : '<p class="muted small">Choisis d\'abord un depot.</p>'}
    </li>
  </ol>` : ''}
  <div class="actions">
    ${o.current ? `<form method="post" action="${t.path}/clear" class="inline">${csrfField(o.csrf)}<button class="ghost danger" type="submit">${esc(t.remove)}</button></form>` : ''}
    <a class="button" href="/account">Retour</a>
  </div>
</section>`)
}
