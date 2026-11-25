// Client GitHub minimal : creation d'un depot a partir d'un depot "template".
// Le jeton vient de la configuration du Host (GITHUB_TOKEN) ; il n'est jamais renvoye au navigateur ni journalise.
import { config } from './config.ts'

export interface CreatedRepo { fullName: string; url: string }
export interface GithubClient {
  enabled: boolean
  createFromTemplate(o: { template: string; name: string; owner?: string; description?: string; isPrivate: boolean }): Promise<CreatedRepo>
}

export class GithubError extends Error {
  status: number
  constructor(message: string, status: number) { super(message); this.status = status }
}

type Fetch = typeof fetch

export function createGithubClient(opts: { token?: string; fetchImpl?: Fetch } = {}): GithubClient {
  const token = opts.token ?? config.githubToken
  const doFetch = opts.fetchImpl ?? fetch
  return {
    enabled: !!token,
    async createFromTemplate({ template, name, owner, description, isPrivate }) {
      if (!token) throw new GithubError('Aucun jeton GitHub configure (GITHUB_TOKEN).', 500)
      const m = /^([\w.-]+)\/([\w.-]+)$/.exec(template)
      if (!m) throw new GithubError('Depot template invalide (attendu : proprietaire/depot).', 400)
      const res = await doFetch(`https://api.github.com/repos/${m[1]}/${m[2]}/generate`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/vnd.github+json',
          'x-github-api-version': '2022-11-28',
          'content-type': 'application/json',
          'user-agent': 'roblox-project-manager-host',
        },
        body: JSON.stringify({ ...(owner ? { owner } : {}), name, description: description ?? '', private: isPrivate, include_all_branches: false }),
      })
      if (!res.ok) {
        let detail = ''
        try { detail = ((await res.json()) as { message?: string }).message ?? '' } catch { /* corps non JSON */ }
        const hint =
          res.status === 401 ? 'jeton GitHub invalide ou expire'
          : res.status === 403 ? 'jeton sans droit suffisant'
          : res.status === 404 ? 'depot template introuvable, ou jeton sans acces'
          : res.status === 422 ? 'nom deja utilise ou invalide'
          : 'erreur GitHub'
        throw new GithubError(`${hint}${detail ? ` (${detail})` : ''}`, res.status)
      }
      const j = (await res.json()) as { full_name: string; html_url: string }
      return { fullName: j.full_name, url: j.html_url }
    },
  }
}
