// Pages des projets et de leurs experiences Roblox.
import { alert, appPage, csrfField, esc, type Viewer } from './views.ts'
import { KIND_LABEL, type Experience, type ExperienceKind, type Project } from './projects.ts'
import type { KnownPlace } from './roblox-accounts.ts'

const groupText = (p: Pick<Project, 'roblox_group_id' | 'roblox_group_name'>) =>
  p.roblox_group_id ? `${p.roblox_group_name ? `${esc(p.roblox_group_name)} · ` : ''}groupe ${p.roblox_group_id}` : 'Aucun groupe'
const repoLink = (repo: string | null) =>
  repo ? `<a href="https://github.com/${esc(repo)}" target="_blank" rel="noopener noreferrer">${esc(repo)}</a>` : '<span class="muted">Aucun depot</span>'

export function projectsPage(o: Viewer & { projects: (Project & { experience_count: number; roblox_label: string | null })[]; notice?: string }) {
  const rows = o.projects.map((p) => `
  <a class="row" href="/projects/${p.id}">
    <div class="row-main">
      <strong>${esc(p.name)}</strong>
      <span class="muted">${groupText(p)}</span>
    </div>
    <div class="row-side">
      <span class="muted">${p.roblox_label ? `${esc(p.roblox_label)} · ` : ''}${p.github_repo ? esc(p.github_repo) : 'sans depot'}</span>
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


export interface AccountChoice { id: number; label: string; invalid: boolean; groups: { id: string; name: string | null; role?: string | null }[] | null }

// Liste deroulante des comptes Roblox connectes (un compte dont la cle est invalide n'est pas selectionnable).
const accountSelect = (accounts: AccountChoice[], selected: string | number | undefined) => `
    <select name="robloxAccountId" required>
      ${selected ? '' : '<option value="" selected disabled>Choisir un compte…</option>'}
      ${accounts.map((a) => `<option value="${a.id}"${String(selected) === String(a.id) ? ' selected' : ''}${a.invalid ? ' disabled' : ''}>${esc(a.label)}${a.invalid ? ' (cle invalide)' : ''}</option>`).join('')}
    </select>`

// Menu des groupes : pour chaque compte, ses groupes ou l'on peut gerer des experiences (le script masque ceux des autres comptes).
// Sans JavaScript tout reste visible : le serveur verifie de toute facon que le groupe appartient bien au compte choisi.
const groupSelect = (accounts: AccountChoice[], selected: string | number | null | undefined, manual = '') => {
  const sel = selected ? String(selected) : ''
  const options = accounts.flatMap((a) => (a.groups ?? []).map((g) =>
    `<option value="${esc(g.id)}" data-account="${a.id}"${sel === g.id ? ' selected' : ''}>${esc(g.name ?? 'Groupe')}${g.role ? ` (${esc(g.role)})` : ''} · ${esc(g.id)}</option>`))
  const unavailable = accounts.some((a) => a.groups === null && !a.invalid)
  const none = options.length === 0
  const known = accounts.some((a) => (a.groups ?? []).some((g) => g.id === sel))
  return `<div class="picker">
    <select name="groupId">
      <option value="">Aucun groupe (experiences personnelles)</option>
      ${options.join('')}
    </select>
    ${unavailable ? '<p class="muted small">Liste des groupes indisponible pour le moment : saisis l\'identifiant a la main.</p>'
      : none ? '<p class="muted small">Aucun groupe ou ce compte peut gerer des experiences (ajoute la permission <code>legacy-group:manage</code> a la cle si c\'est une erreur).</p>' : ''}
    <details${manual || (sel && !known) ? ' open' : ''}><summary>Saisir un identifiant de groupe a la main</summary>
      <label>Identifiant du groupe <input type="text" name="groupIdManual" value="${esc(manual || (sel && !known ? sel : ''))}" inputmode="numeric" pattern="[0-9]*" placeholder="12345678"></label>
    </details></div>`
}

export interface PlacesByAccount { accountId: number; label: string; /** null : la liste n'a pas pu etre lue */ places: KnownPlace[] | null }

const placeLabel = (p: KnownPlace) => `${p.universeName} › ${p.placeName}${p.isRoot ? ' (accueil)' : ''} · ${p.placeId}`

// Choix d'une place : liste des places connues du (des) compte(s), ou identifiants a la main. Les noms de champs sont parametrables.
function placePicker(names: { known: string; universeId: string; placeId: string }, groups: PlacesByAccount[], v: { known?: string; universeId?: string; placeId?: string } = {}, emptyLabel = '— Aucune pour l\'instant —') {
  const withPlaces = groups.filter((g) => g.places && g.places.length)
  const unavailable = groups.some((g) => g.places === null)
  const select = `<select name="${names.known}" data-place-select>
      <option value="">${emptyLabel}</option>
      ${withPlaces.map((g) => `<optgroup label="${esc(g.label)}">${g.places!.map((p) => { const val = `${p.universeId}:${p.placeId}`; return `<option value="${val}" data-account="${g.accountId}" data-owner="${p.owner?.type === 'Group' ? `group:${esc(p.owner.id)}` : 'user'}"${v.known === val ? ' selected' : ''}>${esc(placeLabel(p))}</option>` }).join('')}</optgroup>`).join('')}
    </select>`
  const note = unavailable ? '<p class="muted small">Liste des places indisponible pour le moment : saisis les identifiants.</p>'
    : withPlaces.length === 0 ? '<p class="muted small">Aucune place publique connue pour ce compte (les experiences privees ne sont pas listees) : saisis les identifiants.</p>' : ''
  return `<div class="picker">${select}${note}
    <details${v.universeId || v.placeId ? ' open' : ''}><summary>Saisir des identifiants a la main</summary>
      <div class="two">
        <label>Identifiant d'univers <input type="text" name="${names.universeId}" value="${esc(v.universeId ?? '')}" inputmode="numeric" pattern="[0-9]*" placeholder="123456789"></label>
        <label>Identifiant de place <input type="text" name="${names.placeId}" value="${esc(v.placeId ?? '')}" inputmode="numeric" pattern="[0-9]*" placeholder="987654321"></label>
      </div>
    </details></div>`
}

export interface NewProjectForm {
  releaseKnown?: string; releaseUniverseId?: string; releasePlaceId?: string; devKnown?: string; devUniverseId?: string; devPlaceId?: string
  name?: string; robloxAccountId?: string; groupId?: string; groupIdManual?: string
  repoMode?: 'template' | 'existing' | 'none'
  template?: string; branch?: string; owner?: string; isPrivate?: boolean; existing?: string
}

export function newProjectPage(o: Viewer & { error?: string; form: NewProjectForm; accounts: AccountChoice[]; places: PlacesByAccount[]; githubLogin: string | null; defaults: { template: string; branch: string; owner: string } }) {
  const f = o.form
  const githubEnabled = !!o.githubLogin
  const mode = f.repoMode ?? (githubEnabled ? 'template' : 'none')
  const radio = (value: string, label: string, hint: string, disabled = false) => `
      <label class="choice${disabled ? ' disabled' : ''}">
        <input type="radio" name="repoMode" value="${value}"${mode === value ? ' checked' : ''}${disabled ? ' disabled' : ''}>
        <span><strong>${label}</strong><small>${hint}</small></span>
      </label>`
  return appPage('Nouveau projet', o, 'projects', `
<section class="card">
  <h1>Nouveau projet</h1>
  ${alert(o.error)}
  <form method="post" action="/projects" autocomplete="off" data-cascade>
    ${csrfField(o.csrf)}
    <label>Nom du projet
      <input type="text" name="name" value="${esc(f.name ?? '')}" maxlength="60" required autofocus placeholder="Steal Treasure">
    </label>
    <fieldset>
      <legend>Compte Roblox</legend>
      ${o.accounts.length ? `<label>Compte qui publie ce projet
        ${accountSelect(o.accounts, f.robloxAccountId)}
      </label>` : '<div class="alert error" role="note">Aucun compte Roblox connecte. <a href="/account">Connecte-en un dans la page Compte</a> pour creer un projet.</div>'}
    </fieldset>
    <fieldset>
      <legend>Groupe Roblox <span class="hint">facultatif : seuls les groupes ou le compte choisi peut gerer des experiences</span></legend>
      ${groupSelect(o.accounts, f.groupId, f.groupIdManual)}
    </fieldset>
    <fieldset>
      <legend>Places Roblox <span class="hint">facultatif : elles peuvent ne pas exister encore, tu pourras les renseigner plus tard dans la page du projet</span></legend>
      <div class="place-block"><strong>Release</strong><span class="muted small">L'experience publiee aux joueurs.</span>
        ${placePicker({ known: 'releaseKnown', universeId: 'releaseUniverseId', placeId: 'releasePlaceId' }, o.places, { known: f.releaseKnown, universeId: f.releaseUniverseId, placeId: f.releasePlaceId })}</div>
      <div class="place-block"><strong>Dev</strong><span class="muted small">L'experience de developpement.</span>
        ${placePicker({ known: 'devKnown', universeId: 'devUniverseId', placeId: 'devPlaceId' }, o.places, { known: f.devKnown, universeId: f.devUniverseId, placeId: f.devPlaceId })}</div>
    </fieldset>
    <fieldset>
      <legend>Depot GitHub</legend>
      ${radio('template', 'Creer depuis un template', githubEnabled ? `Cree un depot a partir du template, avec ton compte GitHub ${esc(o.githubLogin)}.` : 'Indisponible : connecte ton compte GitHub dans la page Compte.', !githubEnabled)}
      ${githubEnabled ? '' : '<p class="muted small"><a href="/account">Connecter GitHub</a></p>'}
      <div class="sub">
        <div class="two">
          <label>Depot template
            <input type="text" name="template" value="${esc(f.template ?? o.defaults.template)}" placeholder="mon-compte/roblox-ts-template">
          </label>
          <label>Branche du template <span class="hint">vide = branche par defaut</span>
            <input type="text" name="branch" value="${esc(f.branch ?? o.defaults.branch)}" placeholder="main">
          </label>
        </div>
        <label>Proprietaire du nouveau depot
          <input type="text" name="owner" value="${esc(f.owner ?? o.defaults.owner)}" placeholder="mon-compte">
        </label>
        <p class="muted small">Valeurs par defaut modifiables dans <a href="/account/github/template">Compte → GitHub</a>.</p>
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

function experienceSection(kind: ExperienceKind, items: Experience[], v: Viewer, projectId: number, places: PlacesByAccount[]) {
  const title = kind === 'release' ? 'Release' : kind === 'dev' ? 'Dev' : 'Bancs d\'essai'
  const hint = kind === 'release' ? 'L\'experience publiee aux joueurs.' : kind === 'dev' ? 'L\'experience de developpement partagee.' : 'Places jetables pour tester une fonctionnalite sans toucher au reste.'
  const rows = items.map((e) => `
    <li class="exp">
      <div class="row-main"><strong>${esc(e.label)}</strong><span class="muted">${placeLink(e)} · univers ${e.universe_id}</span></div>
      <form method="post" action="/projects/${projectId}/experiences/${e.id}/delete" class="inline">${csrfField(v.csrf)}<button class="ghost danger" type="submit">Retirer</button></form>
      <details class="change"><summary>Changer la place</summary>
        <form method="post" action="/projects/${projectId}/experiences/${e.id}/place" autocomplete="off">${csrfField(v.csrf)}
          ${placePicker({ known: 'known', universeId: 'universeId', placeId: 'placeId' }, places, {}, '— Choisir une place —')}
          <div class="actions"><button class="primary" type="submit">Enregistrer</button></div>
        </form></details>
    </li>`).join('')
  return `
  <div class="exp-group">
    <h3>${title} <span class="pill">${items.length}</span></h3>
    <p class="muted small">${hint}</p>
    ${items.length ? `<ul class="exps">${rows}</ul>` : `<p class="muted small empty-line">${kind === 'bench' ? 'Aucun banc d\'essai.' : 'Non renseignee.'}</p>`}
  </div>`
}

export function projectPage(o: Viewer & { project: Project; experiences: Experience[]; accounts: AccountChoice[]; places: PlacesByAccount[]; error?: string; notice?: string; experienceError?: string }) {
  const p = o.project
  const by = (k: ExperienceKind) => o.experiences.filter((e) => e.kind === k)
  const has = (k: ExperienceKind) => by(k).length > 0
  const options = (['release', 'dev', 'bench'] as ExperienceKind[])
    .map((k) => `<option value="${k}"${(k === 'release' || k === 'dev') && has(k) ? ' disabled' : ''}>${KIND_LABEL[k]}${(k === 'release' || k === 'dev') && has(k) ? ' (deja ajoutee)' : ''}</option>`).join('')
  return appPage(p.name, o, 'projects', `
<p class="crumbs"><a href="/projects">Projets</a> <span aria-hidden="true">/</span> ${esc(p.name)}</p>
<nav class="tabs" aria-label="Sections du projet"><a href="/projects/${p.id}" class="active" aria-current="page">Apercu</a><a href="/projects/${p.id}/chats">Chats IA</a></nav>
<section class="card">
  <div class="card-head">
    <div><h1>${esc(p.name)}</h1><p class="muted">${groupText(p)}</p></div>
    <a class="button primary" href="/projects/${p.id}/chats">Discuter avec l'IA</a>
  </div>
  ${alert(o.notice, 'ok')}${alert(o.error)}
  <dl class="facts">
    <dt>Compte Roblox</dt><dd>${(() => { const acc = o.accounts.find((a) => a.id === p.roblox_account_id); return acc ? `${esc(acc.label)}${acc.invalid ? ' <span class="pill warn">Cle invalide</span>' : ''}` : '<span class="muted">Aucun</span>' })()}</dd>
    <dt>Depot GitHub</dt><dd>${repoLink(p.github_repo)}</dd>
    <dt>Identifiant</dt><dd><code>${esc(p.slug)}</code></dd>
  </dl>
  <details class="edit">
    <summary>Modifier le projet</summary>
    <form method="post" action="/projects/${p.id}" autocomplete="off" data-cascade>
      ${csrfField(o.csrf)}
      <label>Nom <input type="text" name="name" value="${esc(p.name)}" maxlength="60" required></label>
      <label>Compte Roblox ${accountSelect(o.accounts, p.roblox_account_id ?? undefined)}</label>
      <div class="field"><span class="label">Groupe Roblox</span>${groupSelect(o.accounts, p.roblox_group_id, '')}</div>
      <label>Depot GitHub <input type="text" name="repo" value="${esc(p.github_repo ?? '')}" placeholder="proprietaire/depot"></label>
      <div class="actions"><button class="primary" type="submit">Enregistrer</button></div>
    </form>
  </details>
</section>

<section class="card">
  <h2>Experiences</h2>
  ${alert(o.experienceError)}
  ${experienceSection('release', by('release'), o, p.id, o.places)}
  ${experienceSection('dev', by('dev'), o, p.id, o.places)}
  ${experienceSection('bench', by('bench'), o, p.id, o.places)}
  <form method="post" action="/projects/${p.id}/experiences" class="add-exp" autocomplete="off">
    ${csrfField(o.csrf)}
    <h3>Ajouter une experience</h3>
    <label>Type <select name="kind">${options}</select></label>
    <div class="field"><span class="label">Place</span>${placePicker({ known: 'known', universeId: 'universeId', placeId: 'placeId' }, o.places, {}, '— Choisir une place —')}</div>
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
