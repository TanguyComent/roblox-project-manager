// Page Reglages (administrateur) : application OAuth Roblox de l'instance.
import { alert, appPage, csrfField, esc, type Viewer } from './views.ts'
import type { SettingsSource } from './settings.ts'

export interface SettingsPageData {
  redirectUri: string
  roblox: { source: SettingsSource; clientId: string; hasSecret: boolean; scopes: string; enabled: boolean }
  error?: string
  notice?: string
}

const SOURCE_LABEL: Record<SettingsSource, string> = {
  database: '<span class="pill ok">Configure</span>',
  env: '<span class="pill ok">Configure via le fichier .env</span>',
  none: '<span class="pill warn">Non configure</span>',
}

export function settingsPage(o: Viewer & SettingsPageData) {
  const r = o.roblox
  return appPage('Reglages', o, 'settings', `
<section class="card">
  <h1>Reglages de l'instance</h1>
  <p class="muted">Reserve a l'administrateur (le premier compte). Les valeurs sont chiffrees en base, le secret n'est jamais reaffiche.</p>
  ${alert(o.notice, 'ok')}${alert(o.error)}
</section>

<section class="card">
  <div class="card-head"><div><h2>Application Roblox (OAuth 2.0)</h2><p class="muted small">Permet aux utilisateurs de connecter leurs comptes Roblox.</p></div>${SOURCE_LABEL[r.source]}</div>
  <ol class="steps">
    <li>
      <strong>Cree l'application chez Roblox</strong>
      <p class="muted small">Sur <a href="https://create.roblox.com/dashboard/credentials?activeTab=OAuthTab" target="_blank" rel="noopener noreferrer">create.roblox.com → OAuth 2.0 Apps</a>
      (compte verifie par piece d'identite) : <em>Create App</em>, puis dans la configuration ajoute :</p>
      <p class="muted small">• l'adresse de redirection <code class="copy">${esc(o.redirectUri)}</code><br>• les permissions <code>${esc(r.scopes)}</code> (categorie « Creation &amp; Productivity Tools »)</p>
    </li>
    <li>
      <strong>Colle ici l'identifiant et le secret</strong>
      <form method="post" action="/settings/roblox" autocomplete="off">
        ${csrfField(o.csrf)}
        <label>Client ID
          <input type="text" name="clientId" value="${esc(r.clientId)}" inputmode="numeric" autocomplete="off" spellcheck="false" required placeholder="816547628409595165403873012">
        </label>
        <label>Secret ${r.hasSecret ? '<span class="hint">deja enregistre : laisse vide pour le conserver</span>' : ''}
          <input type="password" name="clientSecret" autocomplete="new-password" spellcheck="false" ${r.hasSecret ? '' : 'required'} placeholder="${r.hasSecret ? '••••••••••••' : 'RBX-…'}">
        </label>
        <label>Permissions demandees <span class="hint">separees par des espaces, les memes que dans l'application Roblox</span>
          <input type="text" name="scopes" value="${esc(r.scopes)}" autocomplete="off" spellcheck="false" required>
        </label>
        <div class="actions"><button class="primary" type="submit">Enregistrer</button></div>
      </form>
    </li>
  </ol>
  ${r.enabled ? `
  <div class="actions">
    <form method="post" action="/settings/roblox/check" class="inline">${csrfField(o.csrf)}<button type="submit">Verifier les identifiants</button></form>
    ${r.source === 'database' ? `<form method="post" action="/settings/roblox/clear" class="inline">${csrfField(o.csrf)}<button class="ghost danger" type="submit">Supprimer la configuration</button></form>` : ''}
  </div>` : ''}
</section>`)
}
