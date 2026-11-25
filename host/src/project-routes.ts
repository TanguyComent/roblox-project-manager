import type { Context, Hono } from 'hono'
import type { Env } from './app.ts'
import type { Db } from './db.ts'
import { getConnection, getToken } from './github-connection.ts'
import { GithubError, type GithubFactory } from './github.ts'
import { newProjectPage, projectPage, projectsPage, type NewProjectForm, type PlacesByAccount } from './project-views.ts'
import {
  addExperience, createProject, deleteExperience, deleteProject, getExperience, getProject, listExperiences, listProjects, parseRepo, parseRobloxId,
  slugify, updateExperiencePlace, updateProject, type ExperienceKind, type Project,
} from './projects.ts'
import { resolvePlace } from './place-choice.ts'
import { checkGroupAccess, getAccount, listAccounts, listAuthorizedGroups, listKnownPlaces, manageableGroups, ownerKey, type RobloxAccount } from './roblox-accounts.ts'
import type { RobloxClient } from './roblox.ts'
import { messagePage } from './views.ts'

type Status = 200 | 400 | 403 | 404 | 502
type Auth = NonNullable<Context<Env>['var']['auth']>

interface Ctx {
  db: Db
  githubFor: GithubFactory
  roblox: RobloxClient
  html: (c: Context, body: string, status?: Status) => Response
  form: (c: Context) => Promise<{ s: (k: string) => string }>
  csrfOk: (c: Context, given: string) => boolean
  requireFull: (c: Context) => Auth | Response
}

const GROUP_UNVERIFIED = "Projet cree. L'acces du compte au groupe n'a pas pu etre verifie (sa cle n'a pas le droit de lire les appartenances) : verifie que ce compte est bien membre du groupe."

const NOTICES: Record<string, string> = {
  created: 'Projet cree.', updated: 'Projet mis a jour.', added: 'Experience ajoutee.', placechanged: 'Place mise a jour.', removed: 'Experience retiree.', deleted: 'Projet supprime.',
}

export function projectRoutes(app: Hono<Env>, ctx: Ctx) {
  const { db, githubFor, roblox, html, form, csrfOk, requireFull } = ctx

  // Garde commune : session complete + jeton CSRF (pour les POST) + projet appartenant a l'utilisateur.
  const guard = async (c: Context, opts: { post?: boolean; project?: boolean } = {}) => {
    const a = requireFull(c)
    if (a instanceof Response) return { res: a } as const
    const f = opts.post ? await form(c) : { s: (_: string) => '' }
    if (opts.post && !csrfOk(c, f.s('csrf'))) return { res: c.text('Jeton invalide', 403) } as const
    let project: Project | undefined
    if (opts.project) {
      const id = c.req.param('id')
      project = /^\d{1,12}$/.test(id ?? '') ? getProject(db, a.user.id, Number(id)) : undefined
      if (!project) {
        const m = messagePage('Projet introuvable', 'Ce projet n\'existe pas ou ne t\'appartient pas.', 404)
        return { res: html(c, m.html, 404) } as const
      }
    }
    return { a, f, project } as const
  }

  const pendingWarnings = new Map<number, string>()
  const viewer = (a: Auth) => ({ email: a.user.email, csrf: a.session.csrf })

  // --- liste ----------------------------------------------------------------------------------------------------------------
  app.get('/projects', async (c) => {
    const g = await guard(c)
    if ('res' in g) return g.res
    return html(c, projectsPage({ ...viewer(g.a), projects: listProjects(db, g.a.user.id), notice: NOTICES[c.req.query('n') ?? ''] }))
  })

  // --- creation -------------------------------------------------------------------------------------------------------------
  // Comptes Roblox de l'utilisateur et, pour aider a choisir un groupe, ceux que chaque compte a autorise (lecture au mieux, 4 s max).
  const robloxChoices = async (userId: number) => {
    const accounts = listAccounts(db, userId)
    const timeout = <T,>(p: Promise<T>) => Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), 4000).unref())])
    return Promise.all(accounts.map(async (acc) => ({
      id: acc.id, label: acc.label, invalid: acc.status !== 'ok',
      groups: acc.status === 'ok' ? await timeout(listAuthorizedGroups(db, roblox, acc).then(manageableGroups)).catch(() => null) : null,
    })))
  }

  // Places connues de chaque compte (lecture au mieux : 4 s au maximum, mise en cache 5 min) ; null = liste indisponible.
  const placeChoices = async (userId: number, onlyAccountId?: number | null, owner?: string): Promise<PlacesByAccount[]> => {
    const timeout = <T,>(p: Promise<T>) => Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), 4000).unref())])
    const accounts = listAccounts(db, userId).filter((a) => a.status === 'ok' && (onlyAccountId == null || a.id === onlyAccountId))
    return Promise.all(accounts.map(async (a) => ({ accountId: a.id, label: a.label, places: await timeout(listKnownPlaces(db, roblox, a).then((l) => (owner ? l.filter((p) => ownerKey(p.owner) === owner) : l))).catch(() => null) })))
  }

  const newPage = async (c: Context, a: Auth, form: NewProjectForm, error?: string, status: Status = 200) =>
    html(c, newProjectPage({
      ...viewer(a), error, form, accounts: await robloxChoices(a.user.id), places: await placeChoices(a.user.id), githubLogin: getConnection(db, a.user.id)?.login ?? null,
      defaults: (() => {
        const gc = getConnection(db, a.user.id)
        return { template: gc?.template_repo ?? '', branch: gc?.template_branch ?? '', owner: gc?.default_owner ?? gc?.login ?? '' }
      })(),
    }), status)

  app.get('/projects/new', async (c) => {
    const g = await guard(c)
    if ('res' in g) return g.res
    return newPage(c, g.a, {})
  })

  app.post('/projects', async (c) => {
    const g = await guard(c, { post: true })
    if ('res' in g) return g.res
    const { a, f } = g
    const s = f.s
    const mode = (['template', 'existing', 'none'].includes(s('repoMode')) ? s('repoMode') : 'none') as 'template' | 'existing' | 'none'
    const values: NewProjectForm = {
      releaseKnown: s('releaseKnown').trim(), releaseUniverseId: s('releaseUniverseId').trim(), releasePlaceId: s('releasePlaceId').trim(),
      devKnown: s('devKnown').trim(), devUniverseId: s('devUniverseId').trim(), devPlaceId: s('devPlaceId').trim(),
      name: s('name').trim(), robloxAccountId: s('robloxAccountId').trim(), groupId: s('groupId').trim() || s('groupIdManual').trim(), groupIdManual: s('groupIdManual').trim(), repoMode: mode,
      template: s('template').trim(), branch: s('branch').trim(), owner: s('owner').trim(), isPrivate: s('isPrivate') === '1', existing: s('existing').trim(),
    }
    const fail = (msg: string, status: Status = 400) => newPage(c, a, values, msg, status)

    if (!values.name || values.name.length > 60) return fail('Le nom doit faire entre 1 et 60 caracteres.')

    // compte Roblox obligatoire, et le groupe (facultatif) doit etre accessible via SON jeton ; verifie AVANT de creer quoi que ce soit
    if (listAccounts(db, a.user.id).length === 0) return fail('Connecte d\'abord un compte Roblox (page Compte) : un projet en a besoin pour publier.')
    const account = /^\d{1,12}$/.test(values.robloxAccountId ?? '') ? getAccount(db, a.user.id, Number(values.robloxAccountId)) : undefined
    if (!account) return fail('Choisis un compte Roblox parmi ceux que tu as connectes.')
    if (account.status !== 'ok') return fail(`La cle du compte Roblox « ${account.label} » n'est plus valide : mets-la a jour (page Compte).`)
    let groupId: number | null = null
    let groupName: string | null = null
    let groupWarning: string | undefined
    if (values.groupId) {
      groupId = parseRobloxId(values.groupId)
      if (groupId === null) return fail('Identifiant de groupe invalide (chiffres uniquement).')
      const check = await checkGroupAccess(db, roblox, account, groupId)
      if (!check.ok) return fail(check.error, check.status)
      groupName = check.name
      if (!check.verified) groupWarning = GROUP_UNVERIFIED
    }

    // places Release / Dev (facultatives) : verifiees avant de creer quoi que ce soit
    const release = await resolvePlace(db, roblox, account, { known: values.releaseKnown ?? '', universeId: values.releaseUniverseId ?? '', placeId: values.releasePlaceId ?? '' }, 'Release', groupId)
    if (!release.ok) return fail(release.error, release.status)
    const dev = await resolvePlace(db, roblox, account, { known: values.devKnown ?? '', universeId: values.devUniverseId ?? '', placeId: values.devPlaceId ?? '' }, 'Dev', groupId)
    if (!dev.ok) return fail(dev.error, dev.status)
    if (release.place && dev.place && release.place.placeId === dev.place.placeId) return fail('La release et la dev ne peuvent pas etre la meme place.')

    let githubRepo: string | null = null
    let warning: string | undefined
    if (mode === 'existing') {
      githubRepo = parseRepo(values.existing ?? '')
      if (!githubRepo) return fail('Depot invalide : attendu « proprietaire/depot » ou une URL GitHub.')
    } else if (mode === 'template') {
      const token = getToken(db, a.user.id)
      if (!token) return fail("Connecte d'abord ton compte GitHub (page Compte) pour creer un depot depuis un template.")
      if (!/^[\w.-]+\/[\w.-]+$/.test(values.template ?? '')) return fail('Depot template invalide : attendu « proprietaire/depot ».')
      if (values.owner && !/^[A-Za-z0-9-]{1,39}$/.test(values.owner)) return fail('Proprietaire GitHub invalide.')
      if (values.branch && !/^[\w./-]{1,200}$/.test(values.branch)) return fail('Nom de branche invalide.')
      try {
        const repo = await githubFor(token).createFromTemplate({
          template: values.template!, branch: values.branch || undefined, name: slugify(values.name), owner: values.owner || undefined,
          description: `${values.name} (projet Roblox)`, isPrivate: values.isPrivate !== false,
        })
        githubRepo = repo.fullName
        warning = repo.warning
      } catch (e) {
        const msg = e instanceof GithubError ? e.message : 'GitHub ne repond pas.'
        return fail(`Creation du depot impossible : ${msg}.`, 502)
      }
    }

    const project = createProject(db, a.user.id, { name: values.name, groupId, groupName, githubRepo, robloxAccountId: account.id })
    if (release.place) addExperience(db, project.id, { kind: 'release', universeId: release.place.universeId, placeId: release.place.placeId })
    if (dev.place) addExperience(db, project.id, { kind: 'dev', universeId: dev.place.universeId, placeId: dev.place.placeId })
    // l'avertissement (branche non appliquee) est garde le temps d'un affichage, sans passer par l'URL
    if (warning || groupWarning) pendingWarnings.set(project.id, [groupWarning, warning].filter(Boolean).join(' '))
    return c.redirect(`/projects/${project.id}?n=created`, 303)
  })

  const takeWarning = (id: number) => { const w = pendingWarnings.get(id); pendingWarnings.delete(id); return w }

  // --- detail ---------------------------------------------------------------------------------------------------------------
  const detail = async (c: Context, a: Auth, project: Project, extra: { error?: string; experienceError?: string; notice?: string } = {}, status: Status = 200) =>
    html(c, projectPage({
      ...viewer(a), project, experiences: listExperiences(db, project.id), accounts: await robloxChoices(a.user.id), places: await placeChoices(a.user.id, project.roblox_account_id ?? -1, project.roblox_group_id ? `group:${project.roblox_group_id}` : 'user'),
      notice: extra.notice ?? NOTICES[c.req.query('n') ?? ''], error: extra.error ?? takeWarning(project.id), experienceError: extra.experienceError,
    }), status)

  app.get('/projects/:id{[0-9]+}', async (c) => {
    const g = await guard(c, { project: true })
    if ('res' in g) return g.res
    return detail(c, g.a, g.project!)
  })

  app.post('/projects/:id{[0-9]+}', async (c) => {
    const g = await guard(c, { post: true, project: true })
    if ('res' in g) return g.res
    const { a, f, project } = g
    const name = f.s('name').trim()
    const groupRaw = f.s('groupId').trim() || f.s('groupIdManual').trim()
    const repoRaw = f.s('repo').trim()
    const accountRaw = f.s('robloxAccountId').trim()
    if (!name || name.length > 60) return detail(c, a, project!, { error: 'Le nom doit faire entre 1 et 60 caracteres.' }, 400)
    const account: RobloxAccount | undefined = /^\d{1,12}$/.test(accountRaw) ? getAccount(db, a.user.id, Number(accountRaw)) : undefined
    if (!account) return detail(c, a, project!, { error: 'Choisis un compte Roblox parmi ceux que tu as connectes.' }, 400)
    if (account.status !== 'ok') return detail(c, a, project!, { error: `La cle du compte Roblox « ${account.label} » n'est plus valide : mets-la a jour (page Compte).` }, 400)
    let groupId = groupRaw ? parseRobloxId(groupRaw) : null
    if (groupRaw && groupId === null) return detail(c, a, project!, { error: 'Identifiant de groupe invalide (chiffres uniquement).' }, 400)
    let resolvedName: string | null = null
    if (groupId !== null) {
      const check = await checkGroupAccess(db, roblox, account, groupId)
      if (!check.ok) return detail(c, a, project!, { error: check.error }, check.status)
      resolvedName = check.name
    }
    const githubRepo = repoRaw ? parseRepo(repoRaw) : null
    if (repoRaw && !githubRepo) return detail(c, a, project!, { error: 'Depot invalide : attendu « proprietaire/depot » ou une URL GitHub.' }, 400)
    updateProject(db, a.user.id, project!.id, { name, groupId, groupName: resolvedName, githubRepo, robloxAccountId: account.id })
    return c.redirect(`/projects/${project!.id}?n=updated`, 303)
  })

  app.post('/projects/:id{[0-9]+}/delete', async (c) => {
    const g = await guard(c, { post: true, project: true })
    if ('res' in g) return g.res
    const { a, f, project } = g
    if (f.s('confirm').trim() !== project!.name) return detail(c, a, project!, { error: 'Le nom saisi ne correspond pas : le projet n\'a pas ete supprime.' }, 400)
    deleteProject(db, a.user.id, project!.id)
    return c.redirect('/projects?n=deleted', 303)
  })

  // --- experiences ----------------------------------------------------------------------------------------------------------
  // La place se choisit dans la liste des places du compte du projet, ou par identifiants saisis a la main.
  const accountOf = (a: Auth, project: Project) => (project.roblox_account_id ? getAccount(db, a.user.id, project.roblox_account_id) : undefined)

  app.post('/projects/:id{[0-9]+}/experiences', async (c) => {
    const g = await guard(c, { post: true, project: true })
    if ('res' in g) return g.res
    const { a, f, project } = g
    const kind = f.s('kind') as ExperienceKind
    const r = await resolvePlace(db, roblox, accountOf(a, project!), { known: f.s('known'), universeId: f.s('universeId'), placeId: f.s('placeId') }, 'Place', project!.roblox_group_id)
    if (!r.ok) return detail(c, a, project!, { experienceError: r.error }, r.status)
    if (!r.place) return detail(c, a, project!, { experienceError: 'Choisis une place dans la liste ou saisis ses identifiants.' }, 400)
    const added = addExperience(db, project!.id, { kind, universeId: r.place.universeId, placeId: r.place.placeId, label: f.s('label') })
    if (!added.ok) return detail(c, a, project!, { experienceError: added.error }, 400)
    return c.redirect(`/projects/${project!.id}?n=added`, 303)
  })

  // Changer la place d'une experience existante (release, dev ou banc d'essai).
  app.post('/projects/:id{[0-9]+}/experiences/:eid{[0-9]+}/place', async (c) => {
    const g = await guard(c, { post: true, project: true })
    if ('res' in g) return g.res
    const { a, f, project } = g
    const eid = Number(c.req.param('eid'))
    if (!getExperience(db, project!.id, eid)) return detail(c, a, project!, { experienceError: 'Experience introuvable.' }, 404)
    const r = await resolvePlace(db, roblox, accountOf(a, project!), { known: f.s('known'), universeId: f.s('universeId'), placeId: f.s('placeId') }, 'Place', project!.roblox_group_id)
    if (!r.ok) return detail(c, a, project!, { experienceError: r.error }, r.status)
    if (!r.place) return detail(c, a, project!, { experienceError: 'Choisis une place dans la liste ou saisis ses identifiants.' }, 400)
    const u = updateExperiencePlace(db, project!.id, eid, r.place.universeId, r.place.placeId)
    if (!u.ok) return detail(c, a, project!, { experienceError: u.error }, 400)
    return c.redirect(`/projects/${project!.id}?n=placechanged`, 303)
  })

  app.post('/projects/:id{[0-9]+}/experiences/:eid{[0-9]+}/delete', async (c) => {
    const g = await guard(c, { post: true, project: true })
    if ('res' in g) return g.res
    deleteExperience(db, g.project!.id, Number(c.req.param('eid')))
    return c.redirect(`/projects/${g.project!.id}?n=removed`, 303)
  })
}
