// Client GitHub minimal, construit avec le jeton d'UN utilisateur (jamais un jeton du serveur).
// Le jeton n'est jamais renvoye au navigateur ni journalise.

export interface CreatedRepo { fullName: string; url: string }
export interface GithubClient {
  /** Compte GitHub auquel appartient le jeton (valide aussi le jeton). */
  getViewer(): Promise<{ login: string }>
  createFromTemplate(o: { template: string; name: string; owner?: string; description?: string; isPrivate: boolean }): Promise<CreatedRepo>
}
export type GithubFactory = (token: string) => GithubClient

export class GithubError extends Error {
  status: number
  constructor(message: string, status: number) { super(message); this.status = status }
}

type Fetch = typeof fetch

const hint = (status: number) =>
  status === 401 ? 'jeton GitHub invalide ou expire'
  : status === 403 ? 'jeton sans droit suffisant'
  : status === 404 ? 'depot template introuvable, ou jeton sans acces'
  : status === 422 ? 'nom deja utilise ou invalide'
  : 'erreur GitHub'

async function failure(res: Response): Promise<GithubError> {
  let detail = ''
  try { detail = ((await res.json()) as { message?: string }).message ?? '' } catch { /* corps non JSON */ }
  return new GithubError(`${hint(res.status)}${detail ? ` (${detail})` : ''}`, res.status)
}

export function createGithubClient(token: string, fetchImpl: Fetch = fetch): GithubClient {
  const call = (path: string, init: RequestInit = {}) =>
    fetchImpl(`https://api.github.com${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'roblox-project-manager-host',
        ...(init.body ? { 'content-type': 'application/json' } : {}),
      },
    })

  return {
    async getViewer() {
      const res = await call('/user')
      if (!res.ok) throw await failure(res)
      return { login: ((await res.json()) as { login: string }).login }
    },
    async createFromTemplate({ template, name, owner, description, isPrivate }) {
      const m = /^([\w.-]+)\/([\w.-]+)$/.exec(template)
      if (!m) throw new GithubError('Depot template invalide (attendu : proprietaire/depot).', 400)
      const res = await call(`/repos/${m[1]}/${m[2]}/generate`, {
        method: 'POST',
        body: JSON.stringify({ ...(owner ? { owner } : {}), name, description: description ?? '', private: isPrivate, include_all_branches: false }),
      })
      if (!res.ok) throw await failure(res)
      const j = (await res.json()) as { full_name: string; html_url: string }
      return { fullName: j.full_name, url: j.html_url }
    },
  }
}
