import type { Context, Hono } from 'hono'
import type { Env } from './app.ts'
import type { Db } from './db.ts'
import { getConnection, getToken } from './github-connection.ts'
import { GithubError, type GithubFactory } from './github.ts'
import { newProjectPage, projectPage, projectsPage, type NewProjectForm } from './project-views.ts'
import {
  addExperience, createProject, deleteExperience, deleteProject, getProject, listExperiences, listProjects, parseRepo, parseRobloxId,
  slugify, updateProject, type ExperienceKind, type Project,
} from './projects.ts'
import { messagePage } from './views.ts'

type Status = 200 | 400 | 403 | 404 | 502
type Auth = NonNullable<Context<Env>['var']['auth']>

interface Ctx {
  db: Db
  githubFor: GithubFactory
  html: (c: Context, body: string, status?: Status) => Response
  form: (c: Context) => Promise<{ s: (k: string) => string }>
  csrfOk: (c: Context, given: string) => boolean
  requireFull: (c: Context) => Auth | Response
}

const NOTICES: Record<string, string> = {
  created: 'Projet cree.', updated: 'Projet mis a jour.', added: 'Experience ajoutee.', removed: 'Experience retiree.', deleted: 'Projet supprime.',
}

export function projectRoutes(app: Hono<Env>, ctx: Ctx) {
  const { db, githubFor, html, form, csrfOk, requireFull } = ctx

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
  const newPage = (c: Context, a: Auth, form: NewProjectForm, error?: string, status: Status = 200) =>
    html(c, newProjectPage({
      ...viewer(a), error, form, githubLogin: getConnection(db, a.user.id)?.login ?? null,
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
      name: s('name').trim(), groupId: s('groupId').trim(), groupName: s('groupName').trim(), repoMode: mode,
      template: s('template').trim(), branch: s('branch').trim(), owner: s('owner').trim(), isPrivate: s('isPrivate') === '1', existing: s('existing').trim(),
    }
    const fail = (msg: string, status: Status = 400) => newPage(c, a, values, msg, status)

    if (!values.name || values.name.length > 60) return fail('Le nom doit faire entre 1 et 60 caracteres.')
    let groupId: number | null = null
    if (values.groupId) {
      groupId = parseRobloxId(values.groupId)
      if (groupId === null) return fail('Identifiant de groupe invalide (chiffres uniquement).')
    }
    if ((values.groupName ?? '').length > 80) return fail('Le nom du groupe est trop long.')

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

    const project = createProject(db, a.user.id, { name: values.name, groupId, groupName: values.groupName || null, githubRepo })
    // l'avertissement (branche non appliquee) est garde le temps d'un affichage, sans passer par l'URL
    if (warning) pendingWarnings.set(project.id, warning)
    return c.redirect(`/projects/${project.id}?n=created`, 303)
  })

  const takeWarning = (id: number) => { const w = pendingWarnings.get(id); pendingWarnings.delete(id); return w }

  // --- detail ---------------------------------------------------------------------------------------------------------------
  const detail = (c: Context, a: Auth, project: Project, extra: { error?: string; experienceError?: string; notice?: string } = {}, status: Status = 200) =>
    html(c, projectPage({
      ...viewer(a), project, experiences: listExperiences(db, project.id),
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
    const groupRaw = f.s('groupId').trim()
    const groupName = f.s('groupName').trim()
    const repoRaw = f.s('repo').trim()
    if (!name || name.length > 60) return detail(c, a, project!, { error: 'Le nom doit faire entre 1 et 60 caracteres.' }, 400)
    const groupId = groupRaw ? parseRobloxId(groupRaw) : null
    if (groupRaw && groupId === null) return detail(c, a, project!, { error: 'Identifiant de groupe invalide (chiffres uniquement).' }, 400)
    if (groupName.length > 80) return detail(c, a, project!, { error: 'Le nom du groupe est trop long.' }, 400)
    const githubRepo = repoRaw ? parseRepo(repoRaw) : null
    if (repoRaw && !githubRepo) return detail(c, a, project!, { error: 'Depot invalide : attendu « proprietaire/depot » ou une URL GitHub.' }, 400)
    updateProject(db, a.user.id, project!.id, { name, groupId, groupName: groupName || null, githubRepo })
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
  app.post('/projects/:id{[0-9]+}/experiences', async (c) => {
    const g = await guard(c, { post: true, project: true })
    if ('res' in g) return g.res
    const { a, f, project } = g
    const kind = f.s('kind') as ExperienceKind
    const universeId = parseRobloxId(f.s('universeId'))
    const placeId = parseRobloxId(f.s('placeId'))
    if (universeId === null || placeId === null) {
      return detail(c, a, project!, { experienceError: 'Les identifiants d\'univers et de place doivent etre des nombres.' }, 400)
    }
    const r = addExperience(db, project!.id, { kind, universeId, placeId, label: f.s('label') })
    if (!r.ok) return detail(c, a, project!, { experienceError: r.error }, 400)
    return c.redirect(`/projects/${project!.id}?n=added`, 303)
  })

  app.post('/projects/:id{[0-9]+}/experiences/:eid{[0-9]+}/delete', async (c) => {
    const g = await guard(c, { post: true, project: true })
    if ('res' in g) return g.res
    deleteExperience(db, g.project!.id, Number(c.req.param('eid')))
    return c.redirect(`/projects/${g.project!.id}?n=removed`, 303)
  })
}
