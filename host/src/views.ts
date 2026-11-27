// Pages HTML (rendues cote serveur). Tout texte dynamique passe par esc() ; aucun script en ligne (CSP stricte).
import { statSync } from 'node:fs'
import { join } from 'node:path'
import { config } from './config.ts'

// Version de la feuille de style (date de modification) : l'adresse change des qu'elle change, donc pas de cache perime.
const fileVersion = (name: string) => { try { return Math.floor(statSync(join(import.meta.dirname, '..', 'public', name)).mtimeMs) } catch { return 0 } }

export const esc = (s: unknown) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

const LOGO = `<svg class="logo" viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="8" fill="url(#g)"/><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#6d8cff"/><stop offset="1" stop-color="#9b6dff"/></linearGradient></defs><path d="M9 11.5 16 8l7 3.5v9L16 24l-7-3.5z" fill="none" stroke="#fff" stroke-width="2" stroke-linejoin="round"/><path d="M9 11.5 16 15l7-3.5M16 15v9" fill="none" stroke="#fff" stroke-width="2" stroke-linejoin="round"/></svg>`

export function layout(title: string, body: string, opts: { wide?: boolean; refreshSeconds?: number; refreshUrl?: string; app?: boolean; scripts?: string[] } = {}) {
  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
${opts.refreshSeconds ? `<meta http-equiv="refresh" content="${Math.max(2, Math.floor(opts.refreshSeconds))}${opts.refreshUrl ? `;url=${esc(opts.refreshUrl)}` : ''}">\n` : ''}<title>${esc(title)} · ${esc(config.appName)}</title>
<link rel="stylesheet" href="/static/app.css?v=${fileVersion('app.css')}">
<script src="/static/app.js?v=${fileVersion('app.js')}" defer></script>
${(opts.scripts ?? []).map((n) => `<script src="/static/${n}?v=${fileVersion(n)}" defer></script>`).join('\n')}
</head>
<body>
${opts.app ? body : `<main class="shell${opts.wide ? ' wide' : ''}">\n${body}\n</main>`}
</body>
</html>`
}

export const brand = `<div class="brand">${LOGO}<span>${esc(config.appName)}</span></div>`
export const alert = (msg?: string, kind: 'error' | 'ok' = 'error') => (msg ? `<p class="alert ${kind}" role="alert">${esc(msg)}</p>` : '')
export const csrfField = (csrf?: string) => (csrf ? `<input type="hidden" name="csrf" value="${esc(csrf)}">` : '')

export function loginPage(o: { error?: string; email?: string; canSignup: boolean; notice?: string }) {
  return layout('Connexion', `
${brand}
<section class="card">
  <h1>Connexion</h1>
  <p class="muted">Accede a tes projets et a tes agents.</p>
  ${alert(o.notice, 'ok')}${alert(o.error)}
  <form method="post" action="/login" autocomplete="on">
    <label>Adresse e-mail
      <input type="email" name="email" value="${esc(o.email ?? '')}" autocomplete="username" required autofocus>
    </label>
    <label>Mot de passe
      <input type="password" name="password" autocomplete="current-password" required>
    </label>
    <button class="primary" type="submit">Se connecter</button>
  </form>
  ${o.canSignup ? '<p class="foot">Pas encore de compte ? <a href="/register">Creer un compte</a></p>' : ''}
</section>`)
}

export function registerPage(o: { error?: string; email?: string; first: boolean }) {
  return layout('Creer un compte', `
${brand}
<section class="card">
  <h1>${o.first ? 'Creer le premier compte' : 'Creer un compte'}</h1>
  <p class="muted">${o.first ? 'Ce compte sera le proprietaire de l\'instance.' : 'Tu configureras ensuite l\'authentification a deux facteurs.'}</p>
  ${alert(o.error)}
  <form method="post" action="/register" autocomplete="on">
    <label>Adresse e-mail
      <input type="email" name="email" value="${esc(o.email ?? '')}" autocomplete="username" required autofocus>
    </label>
    <label>Mot de passe <span class="hint">10 caracteres minimum</span>
      <input type="password" name="password" autocomplete="new-password" minlength="10" required>
    </label>
    <label>Confirmer le mot de passe
      <input type="password" name="confirm" autocomplete="new-password" minlength="10" required>
    </label>
    <button class="primary" type="submit">Creer le compte</button>
  </form>
  <p class="foot">Deja un compte ? <a href="/login">Se connecter</a></p>
</section>`)
}

export function mfaPage(o: { error?: string; csrf: string; email: string }) {
  return layout('Verification', `
${brand}
<section class="card">
  <h1>Verification en deux etapes</h1>
  <p class="muted">Compte <strong>${esc(o.email)}</strong>. Saisis le code a 6 chiffres de ton application d'authentification, ou l'un de tes codes de secours.</p>
  ${alert(o.error)}
  <form method="post" action="/login/2fa" autocomplete="off">
    ${csrfField(o.csrf)}
    <label>Code
      <input class="code" type="text" name="code" inputmode="text" autocomplete="one-time-code" spellcheck="false" maxlength="14" required autofocus placeholder="123 456">
    </label>
    <button class="primary" type="submit">Valider</button>
  </form>
  <form method="post" action="/logout" class="inline">${csrfField(o.csrf)}<button class="link" type="submit">Annuler et revenir a la connexion</button></form>
</section>`)
}

export function setupPage(o: { error?: string; csrf: string; email: string; secret: string; qrSvg: string }) {
  const spaced = o.secret.match(/.{1,4}/g)!.join(' ')
  return layout('Authentification a deux facteurs', `
${brand}
<section class="card">
  <h1>Active l'authentification a deux facteurs</h1>
  <p class="muted">Elle est obligatoire. Utilise Google Authenticator, 1Password, Authy ou toute application compatible TOTP.</p>
  ${alert(o.error)}
  <ol class="steps">
    <li>
      <strong>Scanne ce QR code</strong>
      <div class="qr" role="img" aria-label="QR code a scanner">${o.qrSvg}</div>
      <details><summary>Je ne peux pas scanner</summary>
        <p class="muted">Saisis cette cle a la main (type : temporel, SHA-1, 6 chiffres) :</p>
        <code class="secret">${esc(spaced)}</code>
      </details>
    </li>
    <li>
      <strong>Saisis le code affiche</strong>
      <form method="post" action="/2fa/setup" autocomplete="off">
        ${csrfField(o.csrf)}
        <input class="code" type="text" name="code" inputmode="numeric" pattern="[0-9 ]*" autocomplete="one-time-code" maxlength="7" required placeholder="123 456">
        <button class="primary" type="submit">Activer</button>
      </form>
    </li>
  </ol>
  <form method="post" action="/logout" class="inline">${csrfField(o.csrf)}<button class="link" type="submit">Se deconnecter</button></form>
</section>`, { wide: true })
}

export function recoveryPage(o: { codes: string[] }) {
  return layout('Codes de secours', `
${brand}
<section class="card">
  <h1>Conserve tes codes de secours</h1>
  <p class="alert ok">L'authentification a deux facteurs est active.</p>
  <p class="muted">Chaque code ne sert qu'une fois, si tu perds ton telephone. <strong>Ils ne seront plus affiches</strong> : copie-les dans un gestionnaire de mots de passe.</p>
  <ul class="codes">${o.codes.map((c) => `<li><code>${esc(c)}</code></li>`).join('')}</ul>
  <a class="button primary" href="/">J'ai enregistre mes codes, continuer</a>
</section>`, { wide: true })
}

export interface Viewer { email: string; csrf: string }

const NAV_ICONS = {
  projects: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>',
  workers: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/><path d="M7 7.5h.01M7 16.5h.01"/></svg>',
  account: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="8" r="3.6"/><path d="M5 20c.8-3.6 3.6-5.4 7-5.4s6.2 1.8 7 5.4"/></svg>',
}

// Page d'une session complete : coque d'application (barre laterale : Projets, Workers, Compte, deconnexion) + contenu.
// `full` : le contenu occupe toute la hauteur de l'ecran, sans marges (interface de chat).
export function appPage(title: string, v: Viewer, active: 'projects' | 'workers' | 'account', body: string,
  opts: { refreshSeconds?: number; refreshUrl?: string; full?: boolean; scripts?: string[] } = {}) {
  const link = (href: string, label: string, key: keyof typeof NAV_ICONS) =>
    `<a href="${href}"${active === key ? ' class="active" aria-current="page"' : ''}>${NAV_ICONS[key]}<span>${label}</span></a>`
  return layout(title, `
<div class="app">
  <aside class="rail">
    <a class="rail-brand" href="/">${LOGO}<span>${esc(config.appName)}</span></a>
    <nav class="rail-nav">${link('/projects', 'Projets', 'projects')}${link('/workers', 'Workers', 'workers')}${link('/account', 'Compte', 'account')}</nav>
    <div class="rail-foot">
      <span class="who">${esc(v.email)}</span>
      <form method="post" action="/logout">${csrfField(v.csrf)}<button class="ghost" type="submit">Se deconnecter</button></form>
    </div>
  </aside>
  <main class="content${opts.full ? ' full' : ''}">${opts.full ? body : `<div class="page">${body}</div>`}</main>
</div>`, { app: true, refreshSeconds: opts.refreshSeconds, refreshUrl: opts.refreshUrl, scripts: opts.scripts })
}

export interface RobloxCardData {
  accounts: {
    id: number; label: string; username: string | null; robloxId: string; keyName: string | null
    invalid: boolean; invalidDetail: string | null
    permissions: string[]; canPublish: boolean
    expiresAt: number | null; expiresSoon: boolean; checkedAt: number
    /** Groupes ou le role du compte permet de gerer les experiences (ou dont on ne peut pas savoir). null : liste indisponible. */
    groups: { id: string; name: string | null; role: string | null }[] | null
    /** Groupes dont le compte est membre sans pouvoir y gerer d'experiences (masques par defaut). */
    otherGroups: { id: string; name: string | null }[]
    /** Les permissions des roles ne sont pas lisibles avec cette cle (permission group:read manquante). */
    rolesUnreadable: boolean
    /** Pourquoi la liste des groupes n'a pas pu etre lue (null : aucun probleme). */
    groupsError: string | null
    /** Ce que Roblox a repondu, groupe par groupe (pour comprendre un classement). */
    diagnostic: { id: string; name: string | null; role: string | null; canManage: boolean | null; lines: string[] }[]
    projects: string[]
  }[]
  error?: string
  notice?: string
}

const dateFr = (ms: number) => new Date(ms).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' })

function robloxCard(r: RobloxCardData, csrf: string) {
  const rows = r.accounts.map((a) => `
    <li class="exp acct">
      <div class="row-main">
        <strong>${esc(a.label)}</strong>
        <span class="muted">${a.username ? `@${esc(a.username)} · ` : ''}compte ${esc(a.robloxId)}${a.keyName ? ` · cle « ${esc(a.keyName)} »` : ''}
          · ${a.invalid ? '<span class="pill warn">Cle invalide</span>' : '<span class="pill ok">Cle valide</span>'}
          ${a.expiresSoon ? `<span class="pill warn">Expire le ${esc(dateFr(a.expiresAt!))}</span>` : ''}</span>
        ${a.invalid ? `<span class="muted small">${esc(a.invalidDetail ?? 'Roblox ne reconnait plus cette cle.')} Colle une nouvelle cle ci-dessous.</span>` : ''}
        ${!a.invalid && !a.canPublish ? '<span class="muted small">Cette cle n\'a pas la permission de publier des places (<code>universe-places:write</code>) : utile plus tard.</span>' : ''}
        ${a.permissions.length ? `<span class="muted small">Permissions : ${a.permissions.map((p) => `<code>${esc(p)}</code>`).join(' ')}</span>` : ''}
        ${a.groups === null ? '' : a.groups.length
          ? `<span class="muted small">Groupes ou gerer des experiences : ${a.groups.map((g) => `${esc(g.name ?? 'Groupe')}${g.role ? ` (${esc(g.role)})` : ''} <code>${esc(g.id)}</code>`).join(' · ')}</span>`
          : '<span class="muted small">Aucun groupe ou ce compte peut gerer des experiences.</span>'}
        ${a.groupsError ? `<span class="muted small">Liste des groupes illisible : ${esc(a.groupsError)}. Si c'est un refus (403), ajoute la permission <code>group:read</code> a la cle.</span>` : ''}
        ${a.rolesUnreadable ? '<span class="muted small">Les permissions des roles ne sont pas lisibles avec cette cle : ajoute-lui la permission <code>legacy-group:manage</code> (liste des groupes que tu peux gerer) pour ne voir que les groupes utiles.</span>' : ''}
        ${a.diagnostic.length ? `<details class="others"><summary>Diagnostic des groupes</summary><ul class="diag">${a.diagnostic.map((g) => `<li><strong>${esc(g.name ?? 'Groupe')}</strong> <code>${esc(g.id)}</code> · ${g.canManage === true ? 'gestion des experiences : oui' : g.canManage === false ? 'gestion des experiences : non' : 'gestion des experiences : inconnue'}${g.role ? ` · role « ${esc(g.role)} »` : ''}<br>${g.lines.map((l) => `<span class="muted small">${esc(l)}</span>`).join('<br>')}</li>`).join('')}</ul></details>` : ''}
        ${a.otherGroups.length ? `<details class="others"><summary>${a.otherGroups.length} autre${a.otherGroups.length > 1 ? 's' : ''} groupe${a.otherGroups.length > 1 ? 's' : ''} (role sans permission de gestion)</summary><span class="muted small">${a.otherGroups.map((g) => `${esc(g.name ?? 'Groupe')} <code>${esc(g.id)}</code>`).join(' · ')}</span></details>` : ''}
        ${a.projects.length ? `<span class="muted small">Utilise par : ${a.projects.map(esc).join(', ')}</span>` : ''}
        <details class="change"><summary>Changer la cle</summary>
          <form method="post" action="/account/roblox/${a.id}/key" autocomplete="off">${csrfField(csrf)}
            <label>Nouvelle cle de ce meme compte Roblox
              <input type="password" name="apiKey" autocomplete="off" spellcheck="false" required placeholder="Colle la cle d'API">
            </label>
            <div class="actions"><button class="primary" type="submit">Remplacer la cle</button></div>
          </form></details>
      </div>
      <div class="acct-actions">
        <form method="post" action="/account/roblox/${a.id}/verify" class="inline">${csrfField(csrf)}<button type="submit">Verifier</button></form>
        <form method="post" action="/account/roblox/${a.id}/disconnect" class="inline">${csrfField(csrf)}<button class="ghost danger" type="submit"${a.projects.length ? ' disabled title="Utilise par un projet"' : ''}>Deconnecter</button></form>
      </div>
    </li>`).join('')
  return `
<section class="card">
  <h2>Comptes Roblox</h2>
  <p class="muted">Un compte = une <strong>cle d'API</strong> Open Cloud. Elle agit au nom de son proprietaire et couvre aussi les experiences creees plus tard. Chaque projet utilise l'un de ces comptes.</p>
  ${alert(r.notice, 'ok')}${alert(r.error)}
  ${r.accounts.length ? `<ul class="exps">${rows}</ul>` : '<div class="empty"><p><strong>Aucun compte Roblox connecte.</strong></p></div>'}
  <form method="post" action="/account/roblox" autocomplete="off" class="add-key">
    ${csrfField(csrf)}
    <h3>${r.accounts.length ? 'Connecter un autre compte' : 'Connecter un compte Roblox'}</h3>
    <div class="two">
      <label>Nom <span class="hint">facultatif</span>
        <input type="text" name="label" maxlength="60" placeholder="Compte principal">
      </label>
      <label>Cle d'API
        <input type="password" name="apiKey" autocomplete="off" spellcheck="false" required placeholder="Colle la cle d'API">
      </label>
    </div>
    <details>
      <summary>Comment creer une cle ?</summary>
      <ol class="how">
        <li>Ouvre le <a href="https://create.roblox.com/dashboard/credentials" target="_blank" rel="noopener noreferrer">Creator Dashboard → Cles d'API</a> avec le compte concerne, puis <em>Create API Key</em>.</li>
        <li>Donne-lui un nom, puis ajoute les permissions voulues (« Access Permissions »), par exemple <code>universe-places</code> en ecriture pour publier. <strong>Laisse « Restrict by Experience » desactive</strong> : la cle couvre alors toutes tes experiences, <em>y compris celles que tu creeras plus tard</em>.</li>
        <li>Pour un groupe : la cle s'obtient avec un compte membre du groupe (idealement un compte dedie) ; elle couvre les experiences du groupe selon son role. Ajoute-lui la permission <code>legacy-group:manage</code> (c'est la seule permission « legacy » utile ici) : le site peut alors ne proposer que les groupes ou tu peux <em>gerer les experiences</em>.</li>
        <li>Evite les restrictions d'adresse IP, et si tu fixes une expiration, pense a la renouveler (une cle inutilisee 60 jours expire aussi).</li>
        <li>Copie la cle : <strong>Roblox ne l'affiche qu'une seule fois</strong>.</li>
      </ol>
    </details>
    <div class="actions"><button class="primary" type="submit">Connecter</button></div>
  </form>
</section>`
}

export interface GithubCardData {
  connection: { login: string; template: string; branch: string; uiTemplate: string; uiBranch: string; owner: string } | null
  error?: string
  notice?: string
}

function githubCard(g: GithubCardData, csrf: string) {
  const intro = g.connection
    ? `<p class="muted">Connecte en tant que <strong>${esc(g.connection.login)}</strong> <span class="pill ok">Connecte</span></p>`
    : `<p class="muted">Connecte ton compte GitHub pour creer automatiquement le depot de tes projets a partir de ton template. Le jeton est chiffre et ne quitte jamais le serveur.</p>`
  const connect = `
  <form method="post" action="/account/github" autocomplete="off">
    ${csrfField(csrf)}
    <label>${g.connection ? 'Remplacer le jeton' : "Jeton d'acces GitHub"}
      <input type="password" name="token" autocomplete="off" spellcheck="false" placeholder="github_pat_…" required>
    </label>
    <details>
      <summary>Quel jeton creer ?</summary>
      <p class="muted small"><strong>Le plus simple : un jeton classique.</strong> Sur <a href="https://github.com/settings/tokens/new" target="_blank" rel="noopener noreferrer">github.com/settings/tokens/new</a>,
      coche la portee <code>repo</code> (et <code>read:org</code> si tu crees les depots dans une organisation). Il couvre tous tes depots, y compris les futurs.</p>
      <p class="muted small"><strong>Jeton « fine-grained »</strong> (<a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener noreferrer">github.com/settings/personal-access-tokens/new</a>) :
      « Resource owner » = le compte ou l'organisation qui recevra les nouveaux depots ; « Repository access » = <em>All repositories</em> (ou au moins le template) ;
      permissions <strong>Administration</strong> en ecriture et <strong>Contents</strong> en lecture/ecriture.</p>
      <p class="muted small"><strong>Dans tous les cas</strong>, le depot choisi comme template doit etre marque <em>Template repository</em> (sur GitHub : Settings du depot).
      Si la creation echoue avec « Not Found », le site te dit lequel de ces points pose probleme.</p>
    </details>
    <div class="actions"><button class="${g.connection ? '' : 'primary'}" type="submit">${g.connection ? 'Mettre a jour le jeton' : 'Connecter GitHub'}</button></div>
  </form>`
  const settings = g.connection ? `
  <div class="gh-settings">
    <h3>Template par defaut</h3>
    <p class="muted small">Copie pour chaque nouveau projet.</p>
    ${g.connection.template
      ? `<div class="exp"><div class="row-main"><strong>${esc(g.connection.template)}</strong><span class="muted">${g.connection.branch ? `branche <code>${esc(g.connection.branch)}</code>` : 'branche par defaut'}</span></div><a class="button" href="/account/github/template">Changer</a></div>`
      : '<a class="button primary" href="/account/github/template">Choisir un template</a>'}
  </div>
  <div class="gh-settings">
    <h3>Depot de maquette UI</h3>
    <p class="muted small">Le depot minimal dont partent les chats « Maquette UI » (kit de composants, sans le reste d'un jeu).</p>
    ${g.connection.uiTemplate
      ? `<div class="exp"><div class="row-main"><strong>${esc(g.connection.uiTemplate)}</strong><span class="muted">${g.connection.uiBranch ? `branche <code>${esc(g.connection.uiBranch)}</code>` : 'branche par defaut'}</span></div><a class="button" href="/account/github/ui-template">Changer</a></div>`
      : '<a class="button primary" href="/account/github/ui-template">Choisir un depot de maquette</a>'}
  </div>
  <form method="post" action="/account/github/settings" autocomplete="off" class="gh-settings">
    ${csrfField(csrf)}
    <label>Proprietaire des nouveaux depots <span class="hint">compte ou organisation, ${esc(g.connection.login)} par defaut</span>
      <input type="text" name="owner" value="${esc(g.connection.owner)}" placeholder="${esc(g.connection.login)}">
    </label>
    <div class="actions"><button class="primary" type="submit">Enregistrer</button></div>
  </form>
  <form method="post" action="/account/github/disconnect" class="inline">${csrfField(csrf)}<button class="ghost danger" type="submit">Deconnecter GitHub</button></form>` : ''
  return `
<section class="card">
  <h2>GitHub</h2>
  ${alert(g.notice, 'ok')}${alert(g.error)}
  ${intro}
  ${g.connection ? settings : ''}
  ${g.connection ? '<details class="edit"><summary>Changer de jeton</summary>' + connect + '</details>' : connect}
</section>`
}

export function accountPage(o: Viewer & { recoveryLeft: number; notice?: string; github: GithubCardData; roblox: RobloxCardData }) {
  return appPage('Compte', o, 'account', `
<section class="card">
  <h1>Compte</h1>
  ${alert(o.notice, 'ok')}
  <p class="muted">${esc(o.email)}</p>
</section>
${robloxCard(o.roblox, o.csrf)}
${githubCard(o.github, o.csrf)}
<section class="card">
  <h2>Securite</h2>
  <dl class="facts">
    <dt>Authentification a deux facteurs</dt><dd><span class="pill ok">Active</span></dd>
    <dt>Codes de secours restants</dt><dd>${o.recoveryLeft} / 10${o.recoveryLeft <= 2 ? ' <span class="pill warn">Bientot epuises</span>' : ''}</dd>
  </dl>
  <form method="post" action="/logout-all" class="inline">${csrfField(o.csrf)}<button class="ghost danger" type="submit">Deconnecter tous les autres appareils</button></form>
</section>`)
}

export function messagePage(title: string, text: string, status = 200) {
  return { status, html: layout(title, `${brand}<section class="card"><h1>${esc(title)}</h1><p class="muted">${esc(text)}</p><a class="button" href="/">Retour</a></section>`) }
}
