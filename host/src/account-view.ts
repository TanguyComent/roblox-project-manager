import type { Context } from 'hono'
import type { Env } from './app.ts'
import { remainingRecoveryCodes } from './auth.ts'
import type { Db } from './db.ts'
import { getConnection } from './github-connection.ts'
import { EXPIRY_WARNING_MS, canPublish, listAccounts, listAuthorizedGroups, manageableGroups, projectsUsingAccount, scopeLabels } from './roblox-accounts.ts'
import { RobloxError, type RobloxClient } from './roblox.ts'
import { accountPage } from './views.ts'

type Auth = NonNullable<Context<Env>['var']['auth']>

const GITHUB_NOTICES: Record<string, string> = {
  connected: 'GitHub connecte.', saved: 'Reglages enregistres.', disconnected: 'GitHub deconnecte.',
  template: 'Template par defaut enregistre.', 'template-cleared': 'Template par defaut retire.',
  'ui-template': 'Depot de maquette UI enregistre.', 'ui-template-cleared': 'Depot de maquette UI retire.',
}
const ROBLOX_NOTICES: Record<string, string> = {
  connected: 'Compte Roblox connecte.', updated: 'Cle mise a jour.', verified: 'Cle verifiee : elle est valide.', disconnected: 'Compte Roblox deconnecte.',
}

const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T> =>
  Promise.race([p, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), ms).unref())])

// Rend la page Compte (utilisee par la page elle-meme et par les formulaires qui re-affichent une erreur).
export async function renderAccount(
  db: Db, roblox: RobloxClient, a: Auth,
  extra: { notice?: string; githubError?: string; githubNotice?: string; githubKey?: string; robloxError?: string; robloxKey?: string } = {},
) {
  const c = getConnection(db, a.user.id)
  const now = Date.now()
  const accounts = await Promise.all(listAccounts(db, a.user.id).map(async (acc) => {
    // groupes du compte : lecture « au mieux » (cache 5 min, 4 s maximum) pour ne jamais bloquer la page
    let groupsError: string | null = null
    const all = acc.status === 'ok'
      ? await withTimeout(listAuthorizedGroups(db, roblox, acc), 4000).catch((e) => {
        groupsError = e instanceof RobloxError ? `${e.message} (HTTP ${e.status})` : 'pas de reponse de Roblox (delai depasse)'
        return null
      })
      : null
    const useful = all ? manageableGroups(all) : null
    return {
    id: acc.id, label: acc.label, username: acc.username, robloxId: acc.roblox_user_id, keyName: acc.key_name,
    invalid: acc.status !== 'ok', invalidDetail: acc.status_detail,
    permissions: scopeLabels(acc.scopes), canPublish: canPublish(acc.scopes),
    expiresAt: acc.expires_at, expiresSoon: acc.expires_at !== null && acc.expires_at - now < EXPIRY_WARNING_MS && acc.expires_at > now,
    checkedAt: acc.checked_at,
    projects: projectsUsingAccount(db, acc.id),
    groups: useful?.map((g) => ({ id: g.id, name: g.name, role: g.role })) ?? null,
    otherGroups: all && useful ? all.filter((g) => !useful.includes(g)).map((g) => ({ id: g.id, name: g.name })) : [],
    rolesUnreadable: !!all && all.some((g) => g.canManage === null),
    groupsError,
    diagnostic: all?.map((g) => ({ id: g.id, name: g.name, role: g.role, canManage: g.canManage, lines: g.diagnostic })) ?? [],
  }}))
  return accountPage({
    email: a.user.email, csrf: a.session.csrf, recoveryLeft: remainingRecoveryCodes(db, a.user.id), notice: extra.notice,
    roblox: { accounts, error: extra.robloxError, notice: ROBLOX_NOTICES[extra.robloxKey ?? ''] },
    github: {
      connection: c ? { login: c.login, template: c.template_repo ?? '', branch: c.template_branch ?? '', uiTemplate: c.ui_template_repo ?? '', uiBranch: c.ui_template_branch ?? '', owner: c.default_owner ?? '' } : null,
      error: extra.githubError, notice: extra.githubNotice ?? GITHUB_NOTICES[extra.githubKey ?? ''],
    },
  })
}
