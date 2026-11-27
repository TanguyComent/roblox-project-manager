// Chats IA d'un projet : creer / ouvrir / renommer / supprimer un chat, envoyer un message (= une tache `ai.chat` sur un Worker), annuler une reponse,
// et un endpoint « live » que la page interroge pour se mettre a jour sans rechargement.
import type { Context, Hono } from 'hono'
import type { Env } from './app.ts'
import { chatListHtml, chatPage, threadHtml } from './chat-views.ts'
import {
  DEFAULT_TITLE, MAX_PROMPT, allJobIds, activityByJob, addExchange, createChat, deleteChat, effortOk, getChat, hasPendingReply, listChats, listMessages, markSeen, modelOk,
  pendingJobIds, renameChat, setChatPrefs, syncChat, titleFromFirstMessage, titleProblem, type Chat,
} from './chats.ts'
import { config } from './config.ts'
import { uiTemplateOf } from './github-connection.ts'
import type { Db } from './db.ts'
import { deletePreviewsOfJobs, previewsForJobs } from './previews.ts'
import { getProject, type Project } from './projects.ts'
import { messagePage } from './views.ts'
import type { WorkerHub } from './worker-hub.ts'

type Auth = NonNullable<Context<Env>['var']['auth']>
type Status = 200 | 400 | 403 | 404 | 409

interface Ctx {
  db: Db
  hub: WorkerHub
  html: (c: Context, body: string, status?: Status) => Response
  form: (c: Context) => Promise<{ s: (k: string) => string }>
  csrfOk: (c: Context, given: string) => boolean
  requireFull: (c: Context) => Auth | Response
}

/** Outils qu'un Worker doit avoir pour repondre : git (dossier de la branche) et le CLI Claude Code. */
export const CHAT_REQUIRES = ['git', 'claude']

const intParam = (c: Context, name: string) => { const v = c.req.param(name); return v && /^\d{1,12}$/.test(v) ? Number(v) : null }
const wantsJson = (c: Context) => (c.req.header('accept') ?? '').includes('application/json')

export function chatRoutes(app: Hono<Env>, ctx: Ctx) {
  const { db, hub, html, form, csrfOk, requireFull } = ctx

  // Garde commune : session complete, jeton CSRF (POST), projet de l'utilisateur et, si l'adresse en contient un, chat de ce projet.
  const guard = async (c: Context, opts: { post?: boolean; chat?: boolean } = {}) => {
    const a = requireFull(c)
    if (a instanceof Response) return { res: a } as const
    const f = opts.post ? await form(c) : { s: (_: string) => '' }
    if (opts.post && !csrfOk(c, f.s('csrf'))) return { res: wantsJson(c) ? c.json({ error: 'Session expiree : recharge la page.' }, 403) : c.text('Jeton invalide', 403) } as const
    const pid = intParam(c, 'id')
    const project = pid === null ? undefined : getProject(db, a.user.id, pid)
    const notFound = (what: string) => ({ res: html(c, messagePage(`${what} introuvable`, "Cet element n'existe pas ou ne t'appartient pas.", 404).html, 404) }) as const
    if (!project) return notFound('Projet')
    let chat: Chat | undefined
    if (opts.chat) {
      const cid = intParam(c, 'cid')
      chat = cid === null ? undefined : getChat(db, project.id, cid)
      if (!chat) return notFound('Chat')
    }
    return { a, f, project, chat } as const
  }

  const viewer = (a: Auth) => ({ email: a.user.email, csrf: a.session.csrf })

  /** Reporte les taches terminees dans tous les chats du projet (le chat ouvert est ensuite marque comme lu). */
  const syncProject = (a: Auth, project: Project, activeId: number | null) => {
    for (const ch of listChats(db, project.id)) syncChat(db, a.user.id, ch.id)
    if (activeId !== null) markSeen(db, activeId)
    return listChats(db, project.id)
  }

  const snapshot = (a: Auth, project: Project, activeId: number | null) => {
    const chats = syncProject(a, project, activeId)
    const chat = activeId === null ? null : chats.find((x) => x.id === activeId) ?? null
    const messages = chat ? listMessages(db, chat.id) : []
    const jobIds = messages.flatMap((m) => (m.job_id ? [m.job_id] : []))
    const events = activityByJob(db, jobIds)
    const previews = previewsForJobs(db, jobIds)
    const pendingMsg = messages.find((m) => m.status === 'pending')
    const pending = !!pendingMsg
    const noWorker = !!pendingMsg && pendingMsg.job_status === 'queued' && !!chat && !hub.hasCapable(a.user.id, CHAT_REQUIRES, chat.worker_id)
    return { chats, chat, messages, events, previews, pending, noWorker, hasProjectRepo: !!project.github_repo }
  }

  const renderPage = (c: Context, a: Auth, project: Project, activeId: number | null, error?: string, status: Status = 200) => {
    const s = snapshot(a, project, activeId)
    return html(c, chatPage({ ...viewer(a), project, ...s, error }), status)
  }

  // Sans chat choisi : on ouvre le plus recent (ou l'ecran d'accueil s'il n'y en a pas encore).
  app.get('/projects/:id{[0-9]+}/chats', async (c) => {
    const g = await guard(c)
    if ('res' in g) return g.res
    const chats = listChats(db, g.project.id)
    if (chats.length) return c.redirect(`/projects/${g.project.id}/chats/${chats[0].id}`, 302)
    return renderPage(c, g.a, g.project, null)
  })

  app.post('/projects/:id{[0-9]+}/chats', async (c) => {
    const g = await guard(c, { post: true })
    if ('res' in g) return g.res
    const title = g.f.s('title').trim() || DEFAULT_TITLE
    const problem = titleProblem(title)
    if (problem) return renderPage(c, g.a, g.project, null, problem, 400)
    const chat = createChat(db, g.project.id, title)
    return c.redirect(`/projects/${g.project.id}/chats/${chat.id}`, 303)
  })

  app.get('/projects/:id{[0-9]+}/chats/:cid{[0-9]+}', async (c) => {
    const g = await guard(c, { chat: true })
    if ('res' in g) return g.res
    return renderPage(c, g.a, g.project, g.chat!.id)
  })

  // Fragments HTML + etat, interroges par la page (voir public/chat.js).
  app.get('/projects/:id{[0-9]+}/chats/:cid{[0-9]+}/live', async (c) => {
    const g = await guard(c, { chat: true })
    if ('res' in g) return g.res
    const s = snapshot(g.a, g.project, g.chat!.id)
    c.header('Cache-Control', 'no-store')
    return c.json({
      list: chatListHtml({ project: g.project, chats: s.chats, activeId: g.chat!.id, csrf: g.a.session.csrf }),
      thread: threadHtml({ messages: s.messages, events: s.events, previews: s.previews, noWorker: s.noWorker, workerName: s.chat?.worker_name ?? null }),
      pending: s.pending,
      busy: s.chats.some((x) => x.state === 'running' || x.state === 'queued'),
      unread: s.chats.filter((x) => x.state === 'unread').length,
      title: s.chat?.title ?? '',
    })
  })

  app.post('/projects/:id{[0-9]+}/chats/:cid{[0-9]+}/messages', async (c) => {
    const g = await guard(c, { post: true, chat: true })
    if ('res' in g) return g.res
    const { a, project, chat, f } = g
    const prompt = f.s('prompt').replace(/\r\n/g, '\n').trim()
    const model = f.s('model')
    const effort = f.s('effort')
    const back = `/projects/${project.id}/chats/${chat!.id}`
    const fail = (error: string, status: Status = 400) => (wantsJson(c) ? c.json({ error }, status) : renderPage(c, a, project, chat!.id, error, status))
    if (!prompt) return fail('Ecris un message.')
    if (prompt.length > MAX_PROMPT) return fail(`Message trop long (${MAX_PROMPT} caracteres maximum).`)
    if (!modelOk(model) || !effortOk(effort)) return fail('Modele ou effort inconnu.')
    syncChat(db, a.user.id, chat!.id)
    if (hasPendingReply(db, chat!.id)) return fail('Une reponse est deja en cours pour ce chat.', 409)

    const fresh = getChat(db, project.id, chat!.id)!
    titleFromFirstMessage(db, fresh, prompt) // premier message : le titre (et la branche, pas encore utilisee) en sont deduits
    setChatPrefs(db, fresh.id, model, effort)
    const current = getChat(db, project.id, fresh.id)!
    // Le Worker qui detient le dossier et la conversation Claude est reutilise ; s'il n'existe plus, un autre prend le relais (nouvelle conversation, meme branche).
    const sessionId = current.worker_id ? current.session_id : null
    // Un chat ne demande rien d'avance : pas de branche, pas de depot. Le Worker lui donne un ATELIER (dossier libre, copie du depot de maquette du compte GitHub
    // s'il y en a un, jamais pousse). Le projet (depot GitHub) est lu et sa branche ouverte A LA DEMANDE de l'IA, quand elle doit vraiment le modifier ;
    // `open` dit si elle l'a deja fait. Un projet sans depot : l'atelier seul.
    const template = uiTemplateOf(db, a.user.id, config.uiTemplateRepo)
    const jobId = hub.enqueue(a.user.id, 'ai.chat', {
      chatId: current.id, prompt, sessionId, model: model || null, effort: effort || null, push: true,
      project: project.github_repo ? { slug: project.slug, url: `https://github.com/${project.github_repo}.git`, branch: current.branch, base: null, open: current.branch_open } : null,
      atelier: template ? { url: `https://github.com/${template.repo}.git`, base: template.branch } : null,
    }, { workerId: current.worker_id, requires: CHAT_REQUIRES })
    addExchange(db, current.id, prompt, jobId)
    return wantsJson(c) ? c.json({ ok: true }) : c.redirect(back, 303)
  })

  app.post('/projects/:id{[0-9]+}/chats/:cid{[0-9]+}/cancel', async (c) => {
    const g = await guard(c, { post: true, chat: true })
    if ('res' in g) return g.res
    for (const jobId of pendingJobIds(db, g.chat!.id)) hub.cancel(g.a.user.id, jobId)
    syncChat(db, g.a.user.id, g.chat!.id)
    return wantsJson(c) ? c.json({ ok: true }) : c.redirect(`/projects/${g.project.id}/chats/${g.chat!.id}`, 303)
  })

  app.post('/projects/:id{[0-9]+}/chats/:cid{[0-9]+}/rename', async (c) => {
    const g = await guard(c, { post: true, chat: true })
    if ('res' in g) return g.res
    const title = g.f.s('title').trim()
    const problem = titleProblem(title)
    if (problem) return renderPage(c, g.a, g.project, g.chat!.id, problem, 400)
    renameChat(db, g.project.id, g.chat!.id, title) // la branche ne change pas : elle est deja liee au travail pousse
    return c.redirect(`/projects/${g.project.id}/chats/${g.chat!.id}`, 303)
  })

  app.post('/projects/:id{[0-9]+}/chats/:cid{[0-9]+}/delete', async (c) => {
    const g = await guard(c, { post: true, chat: true })
    if ('res' in g) return g.res
    for (const jobId of pendingJobIds(db, g.chat!.id)) hub.cancel(g.a.user.id, jobId) // une reponse en cours est arretee
    deletePreviewsOfJobs(db, allJobIds(db, g.chat!.id)) // paquets d'apercu : lignes et fichiers
    deleteChat(db, g.project.id, g.chat!.id)
    return c.redirect(`/projects/${g.project.id}/chats`, 303)
  })
}
