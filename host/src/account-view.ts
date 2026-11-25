import type { Context } from 'hono'
import type { Env } from './app.ts'
import { remainingRecoveryCodes } from './auth.ts'
import type { Db } from './db.ts'
import { getConnection } from './github-connection.ts'
import { listAccounts, listAuthorizedGroups, projectsUsingAccount } from './roblox-accounts.ts'
import type { RobloxClient } from './roblox.ts'
import { accountPage } from './views.ts'

type Auth = NonNullable<Context<Env>['var']['auth']>

const GITHUB_NOTICES: Record<string, string> = {
  connected: 'GitHub connecte.', saved: 'Reglages enregistres.', disconnected: 'GitHub deconnecte.',
  template: 'Template par defaut enregistre.', 'template-cleared': 'Template par defaut retire.',
}
const ROBLOX_NOTICES: Record<string, string> = {
  connected: 'Compte Roblox connecte.', disconnected: 'Compte Roblox deconnecte.',
}

const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T> =>
  Promise.race([p, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), ms).unref())])

// Rend la page Compte (utilisee par la page elle-meme et par les formulaires qui re-affichent une erreur).
export async function renderAccount(
  db: Db, roblox: RobloxClient, a: Auth,
  extra: { notice?: string; githubError?: string; githubNotice?: string; githubKey?: string; robloxError?: string; robloxKey?: string } = {},
) {
  const c = getConnection(db, a.user.id)
  const accounts = await Promise.all(listAccounts(db, a.user.id).map(async (acc) => ({
    id: acc.id, username: acc.username, displayName: acc.display_name, robloxId: acc.roblox_user_id,
    needsReauth: acc.status !== 'ok', projects: projectsUsingAccount(db, acc.id),
    // groupes autorises : lecture « au mieux » (cache 5 min, 4 s maximum) pour ne jamais bloquer la page
    groups: acc.status === 'ok' && roblox.enabled ? await withTimeout(listAuthorizedGroups(db, roblox, acc.id), 4000).catch(() => null) : null,
  })))
  return accountPage({
    email: a.user.email, csrf: a.session.csrf, admin: a.user.is_admin === 1, recoveryLeft: remainingRecoveryCodes(db, a.user.id), notice: extra.notice,
    roblox: { enabled: roblox.enabled, canConfigure: a.user.is_admin === 1, accounts, error: extra.robloxError, notice: ROBLOX_NOTICES[extra.robloxKey ?? ''] },
    github: {
      connection: c ? { login: c.login, template: c.template_repo ?? '', branch: c.template_branch ?? '', owner: c.default_owner ?? '' } : null,
      error: extra.githubError, notice: extra.githubNotice ?? GITHUB_NOTICES[extra.githubKey ?? ''],
    },
  })
}
