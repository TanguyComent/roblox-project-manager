// Client GitHub minimal, construit avec le jeton d'UN utilisateur (jamais un jeton du serveur).
// Le jeton n'est jamais renvoye au navigateur ni journalise.

export interface RepoSummary { fullName: string; defaultBranch: string; isTemplate: boolean; isPrivate: boolean }
export interface CreatedRepo { fullName: string; url: string; warning?: string }
export interface CreateFromTemplateOptions {
  template: string
  /** Branche du template a utiliser (vide = branche par defaut du template). */
  branch?: string
  name: string
  owner?: string
  description?: string
  isPrivate: boolean
}
export interface GithubClient {
  /** Compte GitHub auquel appartient le jeton (valide aussi le jeton). */
  getViewer(): Promise<{ login: string }>
  /** Depots accessibles (les templates d'abord, puis par date de mise a jour). */
  listRepos(): Promise<RepoSummary[]>
  listBranches(fullName: string): Promise<string[]>
  getDefaultBranch(fullName: string): Promise<string>
  createFromTemplate(o: CreateFromTemplateOptions): Promise<CreatedRepo>
  /** Cherche pourquoi une creation depuis un template renvoie 404 (template invisible ? pas marque template ? droit de creation ?). */
  diagnoseTemplate(template: string, owner?: string): Promise<string | null>
}
export type GithubFactory = (token: string) => GithubClient

export class GithubError extends Error {
  status: number
  constructor(message: string, status: number) { super(message); this.status = status }
}

type Fetch = typeof fetch
type Sleep = (ms: number) => Promise<void>

const hint = (status: number) =>
  status === 401 ? 'jeton GitHub invalide ou expire'
  : status === 403 ? 'jeton sans droit suffisant'
  : status === 404 ? 'depot introuvable, ou jeton sans acces'
  : status === 409 ? 'depot pas encore pret'
  : status === 422 ? 'nom deja utilise ou invalide'
  : 'erreur GitHub'

async function failure(res: Response): Promise<GithubError> {
  let detail = ''
  try { detail = ((await res.json()) as { message?: string }).message ?? '' } catch { /* corps non JSON */ }
  // GitHub indique, pour un jeton « fine-grained », les permissions que la route accepte
  const accepted = res.headers?.get?.('x-accepted-github-permissions')
  return new GithubError(`${hint(res.status)}${detail ? ` (${detail})` : ''}${accepted && res.status !== 422 ? ` — permissions acceptees par GitHub pour cette operation : ${accepted}` : ''}`, res.status)
}

const FULL_NAME = /^[\w.-]+\/[\w.-]+$/
const BRANCH = /^[\w./-]{1,200}$/
const enc = (s: string) => s.split('/').map(encodeURIComponent).join('/')
const realSleep: Sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export function createGithubClient(token: string, fetchImpl: Fetch = fetch, sleep: Sleep = realSleep): GithubClient {
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
  const json = async <T>(res: Response): Promise<T> => { if (!res.ok) throw await failure(res); return (await res.json()) as T }
  const checkRepo = (fullName: string) => { if (!FULL_NAME.test(fullName)) throw new GithubError('Depot invalide (attendu : proprietaire/depot).', 400) }

  const listBranches = async (fullName: string) => {
    checkRepo(fullName)
    const out: string[] = []
    for (let page = 1; page <= 3; page++) {
      const items = await json<{ name: string }[]>(await call(`/repos/${fullName}/branches?per_page=100&page=${page}`))
      out.push(...items.map((b) => b.name))
      if (items.length < 100) break
    }
    return out
  }
  const getDefaultBranch = async (fullName: string) => {
    checkRepo(fullName)
    return (await json<{ default_branch: string }>(await call(`/repos/${fullName}`))).default_branch
  }

  return {
    async getViewer() {
      return { login: (await json<{ login: string }>(await call('/user'))).login }
    },

    async listRepos() {
      const out: RepoSummary[] = []
      for (let page = 1; page <= 3; page++) {
        const items = await json<{ full_name: string; default_branch: string; is_template?: boolean; private: boolean }[]>(
          await call(`/user/repos?per_page=100&page=${page}&sort=updated&affiliation=owner,collaborator,organization_member`),
        )
        out.push(...items.map((r) => ({ fullName: r.full_name, defaultBranch: r.default_branch, isTemplate: !!r.is_template, isPrivate: r.private })))
        if (items.length < 100) break
      }
      return out.sort((a, b) => Number(b.isTemplate) - Number(a.isTemplate)) // tri stable : les templates d'abord
    },

    listBranches,
    getDefaultBranch,

    // Explique un « 404 Not Found » : GitHub repond pareil quand le template est invisible pour le jeton, quand il n'est pas marque
    // « template », ou quand le jeton n'a pas le droit de creer un depot chez ce proprietaire.
    async diagnoseTemplate(template, owner) {
      checkRepo(template)
      const res = await call(`/repos/${template}`)
      if (res.status === 404 || res.status === 403 || res.status === 401) {
        return `Le depot template « ${template} » n'est pas visible avec ce jeton : verifie son nom, et que le jeton y a acces (Repository access : ce depot ou « All repositories », permission Contents en lecture).`
      }
      if (!res.ok) return null
      const info = (await res.json()) as { is_template?: boolean; private?: boolean }
      if (info.is_template === false) {
        return `Le depot « ${template} » est lisible mais n'est PAS marque comme template : sur GitHub, ouvre ses Settings et coche « Template repository ».`
      }
      return `Le template « ${template} » est bien lisible et marque comme template : c'est la creation du nouveau depot${owner ? ` chez « ${owner} »` : ''} que GitHub refuse. Le jeton doit pouvoir creer des depots pour ce proprietaire : `
        + `jeton « fine-grained » → « Resource owner » = ${owner ? `« ${owner} »` : 'ton compte'} et permission Administration en ecriture ; si ca ne suffit pas, utilise un jeton classique (portee « repo »).`
    },

    async createFromTemplate({ template, branch, name, owner, description, isPrivate }) {
      checkRepo(template)
      if (branch && !BRANCH.test(branch)) throw new GithubError('Nom de branche invalide.', 400)
      // GitHub ne copie que la branche par defaut du template. Pour une autre branche : on copie toutes les branches,
      // on rend la branche voulue "par defaut" dans le NOUVEAU depot, puis on retire les autres branches de ce depot.
      const wanted = branch && branch !== (await getDefaultBranch(template)) ? branch : undefined
      const created = await json<{ full_name: string; html_url: string }>(await call(`/repos/${template}/generate`, {
        method: 'POST',
        body: JSON.stringify({ ...(owner ? { owner } : {}), name, description: description ?? '', private: isPrivate, include_all_branches: !!wanted }),
      }))
      const repo: CreatedRepo = { fullName: created.full_name, url: created.html_url }
      if (!wanted) return repo

      try {
        // Le depot est rempli de facon asynchrone : on attend que la branche existe.
        let branches: string[] = []
        for (let i = 0; i < 8; i++) {
          try { branches = await listBranches(repo.fullName) } catch { branches = [] }
          if (branches.includes(wanted)) break
          await sleep(1000)
        }
        if (!branches.includes(wanted)) throw new GithubError(`la branche « ${wanted} » n'existe pas dans le template`, 404)
        const patch = await call(`/repos/${repo.fullName}`, { method: 'PATCH', body: JSON.stringify({ default_branch: wanted }) })
        if (!patch.ok) throw await failure(patch)
        for (const other of branches.filter((b) => b !== wanted)) {
          await call(`/repos/${repo.fullName}/git/refs/heads/${enc(other)}`, { method: 'DELETE' }) // echec d'une suppression : sans gravite
        }
      } catch (e) {
        repo.warning = `Depot cree, mais la branche « ${wanted} » n'a pas pu devenir la branche principale : ${e instanceof GithubError ? e.message : 'erreur GitHub'}.`
      }
      return repo
    },
  }
}
