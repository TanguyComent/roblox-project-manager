import type { Context } from 'hono'
import type { Env } from './app.ts'
import { remainingRecoveryCodes } from './auth.ts'
import type { Db } from './db.ts'
import { getConnection } from './github-connection.ts'
import { accountPage } from './views.ts'

type Auth = NonNullable<Context<Env>['var']['auth']>

const GITHUB_NOTICES: Record<string, string> = {
  connected: 'GitHub connecte.', saved: 'Reglages enregistres.', disconnected: 'GitHub deconnecte.',
  template: 'Template par defaut enregistre.', 'template-cleared': 'Template par defaut retire.',
}

// Rend la page Compte (utilisee par la page elle-meme et par les formulaires qui re-affichent une erreur).
export function renderAccount(db: Db, a: Auth, extra: { notice?: string; githubError?: string; githubNotice?: string; githubKey?: string } = {}) {
  const c = getConnection(db, a.user.id)
  return accountPage({
    email: a.user.email, csrf: a.session.csrf, recoveryLeft: remainingRecoveryCodes(db, a.user.id), notice: extra.notice,
    github: {
      connection: c ? { login: c.login, template: c.template_repo ?? '', branch: c.template_branch ?? '', owner: c.default_owner ?? '' } : null,
      error: extra.githubError, notice: extra.githubNotice ?? GITHUB_NOTICES[extra.githubKey ?? ''],
    },
  })
}
