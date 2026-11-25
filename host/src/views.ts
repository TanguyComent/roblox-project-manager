// Pages HTML (rendues cote serveur). Tout texte dynamique passe par esc() ; aucun script en ligne (CSP stricte).
import { statSync } from 'node:fs'
import { join } from 'node:path'
import { config } from './config.ts'

// Version de la feuille de style (date de modification) : l'adresse change des qu'elle change, donc pas de cache perime.
const CSS_FILE = join(import.meta.dirname, '..', 'public', 'app.css')
const cssVersion = () => { try { return Math.floor(statSync(CSS_FILE).mtimeMs) } catch { return 0 } }

export const esc = (s: unknown) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

const LOGO = `<svg class="logo" viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="8" fill="url(#g)"/><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#6d8cff"/><stop offset="1" stop-color="#9b6dff"/></linearGradient></defs><path d="M9 11.5 16 8l7 3.5v9L16 24l-7-3.5z" fill="none" stroke="#fff" stroke-width="2" stroke-linejoin="round"/><path d="M9 11.5 16 15l7-3.5M16 15v9" fill="none" stroke="#fff" stroke-width="2" stroke-linejoin="round"/></svg>`

export function layout(title: string, body: string, opts: { wide?: boolean } = {}) {
  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<title>${esc(title)} · ${esc(config.appName)}</title>
<link rel="stylesheet" href="/static/app.css?v=${cssVersion()}">
</head>
<body>
<main class="shell${opts.wide ? ' wide' : ''}">
${body}
</main>
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

export interface Viewer { email: string; csrf: string; admin?: boolean }

// Page d'une session complete : barre de navigation commune (Projets, Compte) + deconnexion.
export function appPage(title: string, v: Viewer, active: 'projects' | 'account' | 'settings', body: string) {
  const link = (href: string, label: string, key: string) => `<a href="${href}"${active === key ? ' class="active" aria-current="page"' : ''}>${label}</a>`
  return layout(title, `
<header class="topbar">
  <a class="brand-link" href="/">${brand}</a>
  <nav class="nav">${link('/projects', 'Projets', 'projects')}${link('/account', 'Compte', 'account')}${v.admin ? link('/settings', 'Reglages', 'settings') : ''}</nav>
  <div class="who">
    <span class="muted">${esc(v.email)}</span>
    <form method="post" action="/logout" class="inline">${csrfField(v.csrf)}<button class="ghost" type="submit">Se deconnecter</button></form>
  </div>
</header>
${body}`, { wide: true })
}

export interface RobloxCardData {
  /** false : l'application OAuth de l'instance n'est pas configuree. */
  enabled: boolean
  /** true : l'utilisateur est l'administrateur et peut la configurer (page Reglages). */
  canConfigure: boolean
  accounts: { id: number; username: string; displayName: string | null; robloxId: string; needsReauth: boolean; groups: { id: string; name: string | null }[] | null; projects: string[] }[]
  error?: string
  notice?: string
}

function robloxCard(r: RobloxCardData, csrf: string) {
  const setup = !r.enabled ? `
  <div class="alert error" role="note">
    La connexion Roblox n'est pas encore configuree sur cette instance.
    ${r.canConfigure ? '<a href="/settings">Configure-la dans les Reglages</a> (une application OAuth Roblox, a creer une seule fois).' : 'Demande a l\'administrateur de la configurer.'}
  </div>` : ''
  const rows = r.accounts.map((a) => `
    <li class="exp acct">
      <div class="row-main">
        <strong>${esc(a.displayName && a.displayName !== a.username ? `${a.displayName} (@${a.username})` : `@${a.username}`)}</strong>
        <span class="muted">identifiant ${esc(a.robloxId)} · ${a.needsReauth ? '<span class="pill warn">A reconnecter</span>' : '<span class="pill ok">Connecte</span>'}</span>
        ${a.groups === null ? '' : a.groups.length
          ? `<span class="muted small">Groupes autorises : ${a.groups.map((g) => `${esc(g.name ?? 'Groupe')} <code>${esc(g.id)}</code>`).join(' · ')}</span>`
          : '<span class="muted small">Aucun groupe autorise (seulement ce compte).</span>'}
        ${a.projects.length ? `<span class="muted small">Utilise par : ${a.projects.map(esc).join(', ')}</span>` : ''}
      </div>
      <div class="acct-actions">
        ${r.enabled ? `<a class="button" href="/account/roblox/connect">${a.needsReauth ? 'Reconnecter' : 'Mettre a jour'}</a>` : ''}
        <form method="post" action="/account/roblox/${a.id}/disconnect" class="inline">${csrfField(csrf)}<button class="ghost danger" type="submit"${a.projects.length ? ' disabled title="Utilise par un projet"' : ''}>Deconnecter</button></form>
      </div>
    </li>`).join('')
  return `
<section class="card">
  <h2>Comptes Roblox</h2>
  <p class="muted">Les comptes qui publient tes experiences (Open Cloud, OAuth 2.0). Tu peux en connecter plusieurs ; chaque projet utilise l'un d'eux.</p>
  ${alert(r.notice, 'ok')}${alert(r.error)}${setup}
  ${r.accounts.length ? `<ul class="exps">${rows}</ul>` : r.enabled ? '<div class="empty"><p><strong>Aucun compte Roblox connecte.</strong></p></div>' : ''}
  ${r.enabled ? `<div class="actions"><a class="button primary" href="/account/roblox/connect">${r.accounts.length ? 'Connecter un autre compte' : 'Connecter un compte Roblox'}</a></div>
  <p class="muted small">Roblox te demande de choisir le compte, puis les experiences et groupes que ce compte autorise. Pour qu'un groupe soit utilisable dans un projet, autorise-le a cette etape.</p>` : ''}
</section>`
}

export interface GithubCardData {
  connection: { login: string; template: string; branch: string; owner: string } | null
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
      <p class="muted small">Sur <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener noreferrer">github.com/settings/personal-access-tokens/new</a> :
      choisis le proprietaire (ton compte ou l'organisation), donne l'acces a <em>tous les depots</em>, puis les permissions <strong>Administration</strong>
      et <strong>Contents</strong> en ecriture (Metadata en lecture). Un jeton classique avec la portee <code>repo</code> fonctionne aussi.
      Si GitHub refuse la creation d'un depot, c'est en general une permission qui manque.</p>
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
