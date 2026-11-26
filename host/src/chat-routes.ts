// Chats IA d'un projet : lister / creer / ouvrir / supprimer un chat, envoyer un message (= une tache `ai.chat` sur un Worker), annuler une reponse.
import type { Context, Hono } from 'hono'
import type { Env } from './app.ts'
import { chatPage, chatsPage } from './chat-views.ts'
import {
  MAX_PROMPT, addExchange, createChat, deleteChat, getChat, hasPendingReply, listChats, listMessages, pendingJobIds, syncChat, titleProblem, type Chat,
} from './chats.ts'
import type { Db } from './db.ts'
import { getProject, type Project } from './projects.ts'
import { messagePage } from './views.ts'
import type { WorkerHub } from './worker-hub.ts'
import { listJobEvents } from './workers.ts'

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

const NOTICES: Record<string, string> = { deleted: 'Chat supprime.', cancelled: 'Annulation demandee.' }
const intParam = (c: Context, name: string) => { const v = c.req.param(name); return v && /^\d{1,12}$/.test(v) ? Number(v) : null }

export function chatRoutes(app: Hono<Env>, ctx: Ctx) {
  const { db, hub, html, form, csrfOk, requireFull } = ctx

  // Garde commune : session complete, jeton CSRF (POST), projet de l'utilisateur et, si l'adresse en contient un, chat de ce projet.
  const guard = async (c: Context, opts: { post?: boolean; chat?: boolean } = {}) => {
    const a = requireFull(c)
    if (a instanceof Response) return { res: a } as const
    const f = opts.post ? await form(c) : { s: (_: string) => '' }
    if (opts.post && !csrfOk(c, f.s('csrf'))) return { res: c.text('Jeton invalide', 403) } as const
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

  const renderChat = (c: Context, a: Auth, project: Project, chatId: number, extra: { error?: string; notice?: string; draft?: string } = {}, status: Status = 200) => {
    syncChat(db, a.user.id, chatId)
    const chat = getChat(db, project.id, chatId)!
    const messages = listMessages(db, chatId)
    const pending = messages.find((m) => m.status === 'pending')
    return html(c, chatPage({
      ...viewer(a), project, chat, messages,
      pendingEvents: pending?.job_id ? listJobEvents(db, pending.job_id, 100) : [],
      noWorker: !!pending && pending.job_status === 'queued' && !hub.hasCapable(a.user.id, CHAT_REQUIRES, chat.worker_id),
      hasRepo: !!project.github_repo, ...extra,
    }), status)
  }

  app.get('/projects/:id{[0-9]+}/chats', async (c) => {
    const g = await guard(c)
    if ('res' in g) return g.res
    return html(c, chatsPage({ ...viewer(g.a), project: g.project, chats: listChats(db, g.project.id), notice: NOTICES[c.req.query('n') ?? ''] }))
  })

  app.post('/projects/:id{[0-9]+}/chats', async (c) => {
    const g = await guard(c, { post: true })
    if ('res' in g) return g.res
    const title = g.f.s('title').trim()
    const problem = titleProblem(title)
    if (problem) return html(c, chatsPage({ ...viewer(g.a), project: g.project, chats: listChats(db, g.project.id), error: problem, title }), 400)
    const chat = createChat(db, g.project.id, title)
    return c.redirect(`/projects/${g.project.id}/chats/${chat.id}`, 303)
  })

  app.get('/projects/:id{[0-9]+}/chats/:cid{[0-9]+}', async (c) => {
    const g = await guard(c, { chat: true })
    if ('res' in g) return g.res
    return renderChat(c, g.a, g.project, g.chat!.id)
  })

  app.post('/projects/:id{[0-9]+}/chats/:cid{[0-9]+}/messages', async (c) => {
    const g = await guard(c, { post: true, chat: true })
    if ('res' in g) return g.res
    const { a, project, chat } = g
    const prompt = g.f.s('prompt').replace(/\r\n/g, '\n').trim()
    const fail = (error: string, status: Status = 400) => renderChat(c, a, project, chat!.id, { error, draft: prompt }, status)
    if (!prompt) return fail('Ecris un message.')
    if (prompt.length > MAX_PROMPT) return fail(`Message trop long (${MAX_PROMPT} caracteres maximum).`)
    if (!project.github_repo) return fail("Ce projet n'a pas de depot GitHub : renseigne-le dans le projet.")
    syncChat(db, a.user.id, chat!.id)
    if (hasPendingReply(db, chat!.id)) return fail('Une reponse est deja en cours pour ce chat.', 409)

    const fresh = getChat(db, project.id, chat!.id)!
    // Le Worker qui detient le dossier et la conversation Claude est reutilise ; s'il n'existe plus, un autre prend le relais (nouvelle conversation, meme branche).
    const sessionId = fresh.worker_id ? fresh.session_id : null
    const jobId = hub.enqueue(a.user.id, 'ai.chat', {
      project: project.slug, url: `https://github.com/${project.github_repo}.git`, branch: fresh.branch, prompt, sessionId, push: true,
    }, { workerId: fresh.worker_id, requires: CHAT_REQUIRES })
    addExchange(db, fresh.id, prompt, jobId)
    return c.redirect(`/projects/${project.id}/chats/${fresh.id}#bas`, 303)
  })

  app.post('/projects/:id{[0-9]+}/chats/:cid{[0-9]+}/cancel', async (c) => {
    const g = await guard(c, { post: true, chat: true })
    if ('res' in g) return g.res
    for (const jobId of pendingJobIds(db, g.chat!.id)) hub.cancel(g.a.user.id, jobId)
    syncChat(db, g.a.user.id, g.chat!.id)
    return c.redirect(`/projects/${g.project.id}/chats/${g.chat!.id}`, 303)
  })

  app.post('/projects/:id{[0-9]+}/chats/:cid{[0-9]+}/delete', async (c) => {
    const g = await guard(c, { post: true, chat: true })
    if ('res' in g) return g.res
    for (const jobId of pendingJobIds(db, g.chat!.id)) hub.cancel(g.a.user.id, jobId) // une reponse en cours est arretee
    deleteChat(db, g.project.id, g.chat!.id)
    return c.redirect(`/projects/${g.project.id}/chats?n=deleted`, 303)
  })
}
