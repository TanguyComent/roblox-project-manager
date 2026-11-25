// Pages des projets et de leurs experiences Roblox.
import { alert, appPage, csrfField, esc, type Viewer } from './views.ts'
import { KIND_LABEL, type Experience, type ExperienceKind, type Project } from './projects.ts'

const groupText = (p: Pick<Project, 'roblox_group_id' | 'roblox_group_name'>) =>
  p.roblox_group_id ? `${p.roblox_group_name ? `${esc(p.roblox_group_name)} · ` : ''}groupe ${p.roblox_group_id}` : 'Aucun groupe'
const repoLink = (repo: string | null) =>
  repo ? `<a href="https://github.com/${esc(repo)}" target="_blank" rel="noopener noreferrer">${esc(repo)}</a>` : '<span class="muted">Aucun depot</span>'

export function projectsPage(o: Viewer & { projects: (Project & { experience_count: number })[]; notice?: string }) {
  const rows = o.projects.map((p) => `
  <a class="row" href="/projects/${p.id}">
    <div class="row-main">
      <strong>${esc(p.name)}</strong>
      <span class="muted">${groupText(p)}</span>
    </div>
    <div class="row-side">
      <span class="muted">${p.github_repo ? esc(p.github_repo) : 'sans depot'}</span>
      <span class="pill">${p.experience_count} experience${p.experience_count > 1 ? 's' : ''}</span>
    </div>
  </a>`).join('')
  return appPage('Projets', o, 'projects', `
<section class="card">
  <div class="card-head">
    <div><h1>Projets</h1><p class="muted">Un projet = un groupe Roblox, un depot GitHub et ses experiences.</p></div>
    <a class="button primary" href="/projects/new">Nouveau projet</a>
  </div>
  ${alert(o.notice, 'ok')}
  ${o.projects.length ? `<div class="list">${rows}</div>` : '<div class="empty"><p><strong>Aucun projet pour l\'instant.</strong></p><p class="muted">Cree ton premier projet pour y rattacher un depot et des experiences.</p></div>'}
</section>`)
}

export interface NewProjectForm {
  name?: string; groupId?: string; groupName?: string
  repoMode?: 'template' | 'existing' | 'none'
  template?: string; owner?: string; isPrivate?: boolean; existing?: string
}

export function newProjectPage(o: Viewer & { error?: string; form: NewProjectForm; githubEnabled: boolean; defaults: { template: string; owner: string } }) {
  const f = o.form
  const mode = f.repoMode ?? (o.githubEnabled ? 'template' : 'none')
  const radio = (value: string, label: string, hint: string, disabled = false) => `
      <label class="choice${disabled ? ' disabled' : ''}">
        <input type="radio" name="repoMode" value="${value}"${mode === value ? ' checked' : ''}${disabled ? ' disabled' : ''}>
        <span><strong>${label}</strong><small>${hint}</small></span>
      </label>`
  return appPage('Nouveau projet', o, 'projects', `
<section class="card">
  <h1>Nouveau projet</h1>
  ${alert(o.error)}
  <form method="post" action="/projects" autocomplete="off">
    ${csrfField(o.csrf)}
    <label>Nom du projet
      <input type="text" name="name" value="${esc(f.name ?? '')}" maxlength="60" required autofocus placeholder="Steal Treasure">
    </label>
    <fieldset>
      <legend>Groupe Roblox <span class="hint">facultatif</span></legend>
      <div class="two">
        <label>Identifiant du groupe
          <input type="text" name="groupId" value="${esc(f.groupId ?? '')}" inputmode="numeric" pattern="[0-9]*" placeholder="12345678">
        </label>
        <label>Nom du groupe
          <input type="text" name="groupName" value="${esc(f.groupName ?? '')}" maxlength="80" placeholder="Boilr Studio">
        </label>
      </div>
    </fieldset>
    <fieldset>
      <legend>Depot GitHub</legend>
      ${radio('template', 'Creer depuis un template', o.githubEnabled ? 'Cree un nouveau depot a partir du template.' : 'Indisponible : aucun GITHUB_TOKEN configure sur le Host.', !o.githubEnabled)}
      <div class="sub">
        <div class="two">
          <label>Depot template
            <input type="text" name="template" value="${esc(f.template ?? o.defaults.template)}" placeholder="mon-compte/roblox-ts-template">
          </label>
          <label>Proprietaire du nouveau depot
            <input type="text" name="owner" value="${esc(f.owner ?? o.defaults.owner)}" placeholder="mon-compte">
          </label>
        </div>
        <label class="check"><input type="checkbox" name="isPrivate" value="1"${f.isPrivate === false ? '' : ' checked'}> Depot prive</label>
      </div>
      ${radio('existing', 'Lier un depot existant', 'Rien n\'est cree, on garde seulement le lien.')}
      <div class="sub">
        <label>Depot
          <input type="text" name="existing" value="${esc(f.existing ?? '')}" placeholder="proprietaire/depot ou URL GitHub">
        </label>
      </div>
      ${radio('none', 'Aucun pour l\'instant', 'Tu pourras en ajouter un plus tard.')}
    </fieldset>
    <div class="actions">
      <button class="primary" type="submit">Creer le projet</button>
      <a class="button" href="/projects">Annuler</a>
    </div>
  </form>
</section>`)
}

const placeLink = (e: Experience) =>
  `<a href="https://www.roblox.com/games/${e.place_id}" target="_blank" rel="noopener noreferrer">place ${e.place_id}</a>`

function experienceSection(kind: ExperienceKind, items: Experience[], v: Viewer, projectId: number) {
  const title = kind === 'release' ? 'Release' : kind === 'dev' ? 'Dev' : 'Bancs d\'essai'
  const hint = kind === 'release' ? 'L\'experience publiee aux joueurs.' : kind === 'dev' ? 'L\'experience de developpement partagee.' : 'Places jetables pour tester une fonctionnalite sans toucher au reste.'
  const rows = items.map((e) => `
    <li class="exp">
      <div class="row-main"><strong>${esc(e.label)}</strong><span class="muted">${placeLink(e)} · univers ${e.universe_id}</span></div>
      <form method="post" action="/projects/${projectId}/experiences/${e.id}/delete" class="inline">${csrfField(v.csrf)}<button class="ghost danger" type="submit">Retirer</button></form>
    </li>`).join('')
  return `
  <div class="exp-group">
    <h3>${title} <span class="pill">${items.length}</span></h3>
    <p class="muted small">${hint}</p>
    ${items.length ? `<ul class="exps">${rows}</ul>` : `<p class="muted small empty-line">${kind === 'bench' ? 'Aucun banc d\'essai.' : 'Non renseignee.'}</p>`}
  </div>`
}

export function projectPage(o: Viewer & { project: Project; experiences: Experience[]; error?: string; notice?: string; experienceError?: string; githubEnabled: boolean }) {
  const p = o.project
  const by = (k: ExperienceKind) => o.experiences.filter((e) => e.kind === k)
  const has = (k: ExperienceKind) => by(k).length > 0
  const options = (['release', 'dev', 'bench'] as ExperienceKind[])
    .map((k) => `<option value="${k}"${(k === 'release' || k === 'dev') && has(k) ? ' disabled' : ''}>${KIND_LABEL[k]}${(k === 'release' || k === 'dev') && has(k) ? ' (deja ajoutee)' : ''}</option>`).join('')
  return appPage(p.name, o, 'projects', `
<p class="crumbs"><a href="/projects">Projets</a> <span aria-hidden="true">/</span> ${esc(p.name)}</p>
<section class="card">
  <div class="card-head">
    <div><h1>${esc(p.name)}</h1><p class="muted">${groupText(p)}</p></div>
  </div>
  ${alert(o.notice, 'ok')}${alert(o.error)}
  <dl class="facts">
    <dt>Depot GitHub</dt><dd>${repoLink(p.github_repo)}</dd>
    <dt>Identifiant</dt><dd><code>${esc(p.slug)}</code></dd>
  </dl>
  <details class="edit">
    <summary>Modifier le projet</summary>
    <form method="post" action="/projects/${p.id}" autocomplete="off">
      ${csrfField(o.csrf)}
      <label>Nom <input type="text" name="name" value="${esc(p.name)}" maxlength="60" required></label>
      <div class="two">
        <label>Identifiant du groupe <input type="text" name="groupId" value="${p.roblox_group_id ?? ''}" inputmode="numeric" pattern="[0-9]*"></label>
        <label>Nom du groupe <input type="text" name="groupName" value="${esc(p.roblox_group_name ?? '')}" maxlength="80"></label>
      </div>
      <label>Depot GitHub <input type="text" name="repo" value="${esc(p.github_repo ?? '')}" placeholder="proprietaire/depot"></label>
      <div class="actions"><button class="primary" type="submit">Enregistrer</button></div>
    </form>
  </details>
</section>

<section class="card">
  <h2>Experiences</h2>
  ${alert(o.experienceError)}
  ${experienceSection('release', by('release'), o, p.id)}
  ${experienceSection('dev', by('dev'), o, p.id)}
  ${experienceSection('bench', by('bench'), o, p.id)}
  <form method="post" action="/projects/${p.id}/experiences" class="add-exp" autocomplete="off">
    ${csrfField(o.csrf)}
    <h3>Ajouter une experience</h3>
    <div class="grid3">
      <label>Type <select name="kind">${options}</select></label>
      <label>Identifiant d'univers <input type="text" name="universeId" inputmode="numeric" pattern="[0-9]*" required placeholder="123456789"></label>
      <label>Identifiant de place <input type="text" name="placeId" inputmode="numeric" pattern="[0-9]*" required placeholder="987654321"></label>
    </div>
    <label>Nom <span class="hint">facultatif, « Bench 1 », « Bench 2 »… par defaut</span>
      <input type="text" name="label" maxlength="60">
    </label>
    <div class="actions"><button class="primary" type="submit">Ajouter</button></div>
  </form>
</section>

<section class="card danger-zone">
  <h2>Supprimer le projet</h2>
  <p class="muted">Retire le projet et ses experiences d'ici. Le depot GitHub et les experiences Roblox ne sont pas touches.</p>
  <form method="post" action="/projects/${p.id}/delete" autocomplete="off">
    ${csrfField(o.csrf)}
    <label>Tape <strong>${esc(p.name)}</strong> pour confirmer
      <input type="text" name="confirm" required>
    </label>
    <div class="actions"><button class="ghost danger" type="submit">Supprimer definitivement</button></div>
  </form>
</section>`)
}
