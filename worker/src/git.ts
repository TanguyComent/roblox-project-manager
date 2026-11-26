// Gestion de git par le Worker, dans l'ESPACE DE TRAVAIL (RPM_WORKSPACE_DIR). Organisation :
//
//   <espace>/<projet>/repo                  un seul clone du depot (HEAD detache : aucune branche n'y est « prise »)
//   <espace>/<projet>/branches/<branche>    un dossier de travail (git worktree) par branche, cree a la demande puis reutilise
//   <espace>/.rpm/registry.json             registre : ce que ce Worker possede et quand c'est utilise pour la derniere fois
//
// Les taches travaillent TOUJOURS sur une branche dediee, jamais sur la branche principale. Les dossiers inutilises depuis plus de 3 jours sont
// supprimes, mais seulement s'ils n'ont aucune modification en cours et que tout est deja pousse (rien n'est jamais perdu).
// Rien n'est lance via un shell, chaque argument est valide, aucun « force push ».
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, sep } from 'node:path'
import { JobCancelled, type JobContext, type JobHandler } from './jobs.ts'

export interface GitOptions {
  /** Dossier de travail (relu a chaque tache) ; null = non configure. */
  workspace: () => string | null
  /** URL de depot acceptees (par defaut : https et ssh seulement). */
  allowUrl?: (url: string) => boolean
  gitPath?: string
  /** Horloge (injectable pour les tests). */
  now?: () => number
  /** Anciennete (jours) au-dela de laquelle un dossier inutilise est nettoye. */
  maxAgeDays?: number
}

export interface SweepResult { removed: string[]; kept: { item: string; reason: string }[] }
export interface RegistryView { project: string; url: string; lastUsed: number; branches: { name: string; lastUsed: number }[] }
export interface Git {
  handlers: Record<string, JobHandler>
  sweep(maxAgeDays?: number): Promise<SweepResult>
  registry(): RegistryView[]
  /** Dossier de travail (absolu) d'une branche deja preparee. */
  worktreePath(project: string, branch: string): string
  /** Lance une commande git dans le dossier d'une branche preparee (sortie renvoyee, rien n'est emis en evenement). */
  exec(project: string, branch: string, args: string[], ctx: Pick<JobContext, 'signal' | 'event'>): Promise<string>
  /** Marque un projet « en cours d'utilisation » le temps de `fn` : le nettoyage ne le touche pas. */
  withProject<T>(project: string, fn: () => Promise<T>): Promise<T>
}

const DAY = 86_400_000
const PROJECT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/
const WIN_RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i
const SSH_URL = /^(?:ssh:\/\/)?git@[A-Za-z0-9.-]+[:/][A-Za-z0-9._~/-]+$/
const HTTPS_URL = /^https:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?\/[A-Za-z0-9._~/%-]+$/ // pas d'identifiants dans l'URL : le jeton passe par un autre canal

export const defaultAllowUrl = (url: string) => HTTPS_URL.test(url) || SSH_URL.test(url)

export class GitError extends Error {}
const fail = (m: string): never => { throw new GitError(m) }

const field = (p: unknown, key: string): unknown => (p && typeof p === 'object' ? (p as Record<string, unknown>)[key] : undefined)
const str = (p: unknown, key: string, required = true): string | undefined => {
  const v = field(p, key)
  if (v === undefined || v === null || v === '') { if (required) fail(`Champ « ${key} » manquant.`); return undefined }
  if (typeof v !== 'string') return fail(`Champ « ${key} » invalide.`)
  return v
}
const projectName = (p: unknown) => {
  const d = str(p, 'project')!
  return PROJECT.test(d) && !d.endsWith('.') && !WIN_RESERVED.test(d) ? d : fail('Nom de projet invalide (lettres, chiffres, point, tiret, souligne ; 64 max).')
}
const branchName = (p: unknown, key: string, required = true) => {
  const b = str(p, key, required)
  if (b === undefined) return undefined
  const bad = !BRANCH.test(b) || b.includes('..') || b.includes('//') || b.endsWith('/') || b.endsWith('.') || b.endsWith('.lock') || b.includes('@{')
    || b.split('/').some((s) => s.startsWith('.') || s.endsWith('.lock') || WIN_RESERVED.test(s))
  if (bad) fail(`Nom de branche invalide : ${b.slice(0, 60)}`)
  return b
}
// « / » -> « + » : injectif (« + » est interdit dans un nom de branche ici), et valable dans un nom de dossier.
const encodeBranch = (b: string) => b.replace(/\//g, '+')
const optToken = (p: unknown) => { const t = str(p, 'token', false); return t && /^[\w.-]{8,255}$/.test(t) ? t : t ? fail('Jeton invalide.') : null }

// --- registre --------------------------------------------------------------------------------------------------------------------
interface Registry { projects: Record<string, { url: string; lastUsed: number; branches: Record<string, { lastUsed: number }> }> }
const registryFile = (ws: string) => join(ws, '.rpm', 'registry.json')
function loadRegistry(ws: string): Registry {
  try {
    const r = JSON.parse(readFileSync(registryFile(ws), 'utf8')) as Registry
    return r && typeof r === 'object' && r.projects && typeof r.projects === 'object' ? r : { projects: {} }
  } catch { return { projects: {} } }
}
function saveRegistry(ws: string, r: Registry) {
  mkdirSync(join(ws, '.rpm'), { recursive: true })
  const tmp = `${registryFile(ws)}.tmp`
  writeFileSync(tmp, JSON.stringify(r, null, 2))
  renameSync(tmp, registryFile(ws))
}

type RunCtx = Pick<JobContext, 'signal' | 'event'>
const noCtx = (): RunCtx => ({ signal: new AbortController().signal, event: () => {} })

export function createGit(o: GitOptions): Git {
  const now = o.now ?? Date.now
  const allow = o.allowUrl ?? defaultAllowUrl
  const busy = new Set<string>() // projets en cours d'utilisation : jamais nettoyes pendant une tache

  function workspaceOf(): string {
    const ws = o.workspace()
    if (!ws) return fail('Espace de travail non configure : choisis un dossier dans la page locale du Worker (ou RPM_WORKSPACE_DIR dans .env).')
    if (!existsSync(ws)) mkdirSync(ws, { recursive: true })
    return realpathSync(ws)
  }

  function run(args: string[], r: { cwd: string; ctx: RunCtx; token?: string | null; timeoutMs?: number; quiet?: boolean }): Promise<string> {
    const secret = r.token ? [r.token, Buffer.from(`x-access-token:${r.token}`).toString('base64')] : []
    const scrub = (s: string) => secret.reduce((t, x) => t.split(x).join('***'), s)
    const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GIT_SSH_COMMAND: 'ssh -o BatchMode=yes' }
    if (!o.allowUrl) env.GIT_ALLOW_PROTOCOL = 'https:ssh' // (les tests, qui clonent depuis un dossier local, fournissent leur propre filtre d'URL)
    const full = ['-c', 'protocol.ext.allow=never', '-c', 'core.fsmonitor=false']
    if (r.token) {
      // Jeton GitHub : transmis par variables d'environnement (jamais dans la ligne de commande ni dans .git/config), limite a github.com.
      env.GIT_CONFIG_COUNT = '1'
      env.GIT_CONFIG_KEY_0 = 'http.https://github.com/.extraHeader'
      env.GIT_CONFIG_VALUE_0 = `Authorization: Basic ${secret[1]}`
      full.push('-c', 'credential.helper=')
    }
    full.push(...args)
    return new Promise((resolve, reject) => {
      execFile(o.gitPath ?? 'git', full, { cwd: r.cwd, env, signal: r.ctx.signal, timeout: r.timeoutMs ?? 300_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
        const out = scrub(String(stdout))
        const errText = scrub(String(stderr))
        const tail = (errText || out).trim().split(/\r?\n/).slice(-12).join('\n')
        if (err) {
          if (r.ctx.signal.aborted) return reject(new JobCancelled())
          if ((err as NodeJS.ErrnoException).code === 'ENOENT') return reject(new GitError('git est introuvable sur cette machine.'))
          return reject(new GitError(`git ${args[0]} a echoue : ${tail || err.message}`.slice(0, 1500)))
        }
        if (tail && !r.quiet) r.ctx.event('info', `git ${args[0]} : ${tail}`.slice(0, 1500))
        resolve(out)
      })
    })
  }
  const ok = (args: string[], cwd: string, ctx: RunCtx) => run(args, { cwd, ctx }).then(() => true, () => false)

  async function defaultBranch(repo: string, ctx: RunCtx): Promise<string> {
    const ref = (await run(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], { cwd: repo, ctx }).catch(() => '')).trim()
    if (ref.startsWith('origin/')) return ref.slice(7)
    for (const b of ['main', 'master']) if (await ok(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${b}`], repo, ctx)) return b
    return fail('Branche principale du depot introuvable.')
  }
  const isProtected = (b: string, def: string) => b === def || b === 'main' || b === 'master'

  const touch = (ws: string, project: string, branch?: string) => {
    const reg = loadRegistry(ws)
    const p = reg.projects[project]
    if (!p) return
    p.lastUsed = now()
    if (branch && p.branches[branch]) p.branches[branch].lastUsed = now()
    saveRegistry(ws, reg)
  }

  // Dossier de travail d'une branche, qui doit exister, rester dans l'espace de travail et etre un worktree.
  function worktree(ws: string, project: string, branch: string): string {
    const path = join(ws, project, 'branches', encodeBranch(branch))
    if (!existsSync(path) || !statSync(path).isDirectory() || !existsSync(join(path, '.git'))) {
      return fail(`Aucun dossier de travail pour ${project} / ${branch} : lance d'abord « git.prepare ».`)
    }
    if (!realpathSync(path).startsWith(ws + sep)) fail("Ce dossier sort de l'espace de travail.")
    return path
  }

  const withProject = async <T>(project: string, fn: () => Promise<T>): Promise<T> => {
    busy.add(project)
    try { return await fn() } finally { busy.delete(project) }
  }

  const summary = async (cwd: string, ctx: RunCtx) => ({
    branch: (await run(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd, ctx })).trim(),
    head: (await run(['rev-parse', '--short', 'HEAD'], { cwd, ctx }).catch(() => '')).trim() || null,
  })

  const handlers: Record<string, JobHandler> = {
    // Prepare le dossier de travail d'une branche : clone le depot si besoin, sinon le met a jour ; cree le dossier de la branche s'il n'existe pas,
    // sinon s'y place simplement. Une branche inconnue est creee a partir de `base` (par defaut la branche principale).
    async 'git.prepare'(ctx) {
      const project = projectName(ctx.payload)
      const url = str(ctx.payload, 'url')!
      if (url.startsWith('-') || !allow(url)) fail("Adresse de depot refusee (https ou ssh uniquement, sans identifiants dans l'URL).")
      const branch = branchName(ctx.payload, 'branch')!
      const base = branchName(ctx.payload, 'base', false)
      const token = optToken(ctx.payload)
      return withProject(project, async () => {
        const ws = workspaceOf()
        const reg = loadRegistry(ws)
        const known = reg.projects[project]
        if (known && known.url !== url) fail('Ce projet est deja associe a un autre depot sur ce Worker.')
        const pdir = join(ws, project)
        const repo = join(pdir, 'repo')
        let cloned = false
        if (!existsSync(join(repo, '.git'))) {
          if (existsSync(repo)) rmSync(repo, { recursive: true, force: true }) // reste d'un clonage interrompu
          mkdirSync(pdir, { recursive: true })
          await run(['clone', '--', url, repo], { cwd: pdir, ctx, token, timeoutMs: 1_800_000 })
          await run(['checkout', '--detach'], { cwd: repo, ctx }) // aucune branche n'est « prise » dans le clone principal
          cloned = true
        } else {
          await run(['fetch', '--prune', 'origin'], { cwd: repo, ctx, token, timeoutMs: 600_000 })
        }
        const def = await defaultBranch(repo, ctx)
        if (isProtected(branch, def)) fail(`Les taches ne travaillent jamais directement sur « ${branch} » (branche principale) : utilise une branche dediee.`)

        const path = join(pdir, 'branches', encodeBranch(branch))
        let created = false
        let newBranch = false
        if (existsSync(path)) {
          if (!existsSync(join(path, '.git'))) fail(`Dossier inattendu, a supprimer a la main : ${project}/branches/${encodeBranch(branch)}`)
          const current = (await run(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: path, ctx })).trim()
          if (current !== branch) fail(`Le dossier de travail est sur « ${current} » et non « ${branch} ».`)
        } else {
          await run(['worktree', 'prune'], { cwd: repo, ctx }) // oublie les dossiers supprimes a la main
          mkdirSync(join(pdir, 'branches'), { recursive: true })
          if (await ok(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], repo, ctx)) {
            await run(['worktree', 'add', path, branch], { cwd: repo, ctx })
          } else if (await ok(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`], repo, ctx)) {
            await run(['worktree', 'add', '--track', '-b', branch, path, `origin/${branch}`], { cwd: repo, ctx })
          } else {
            const from = base ?? def
            if (!(await ok(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${from}`], repo, ctx))) fail(`Branche de depart introuvable : ${from}`)
            await run(['worktree', 'add', '--no-track', '-b', branch, path, `origin/${from}`], { cwd: repo, ctx })
            newBranch = true
          }
          created = true
        }
        const after = loadRegistry(ws)
        const p = (after.projects[project] ??= { url, lastUsed: now(), branches: {} })
        p.url = url
        p.lastUsed = now()
        p.branches[branch] = { lastUsed: now() }
        saveRegistry(ws, after)
        return { project, path: `${project}/branches/${encodeBranch(branch)}`, cloned, created, newBranch, ...(await summary(path, ctx)) }
      })
    },

    async 'git.pull'(ctx) { // fast-forward uniquement : jamais de fusion automatique ni de conflit laisse en plan
      const project = projectName(ctx.payload)
      const branch = branchName(ctx.payload, 'branch')!
      const token = optToken(ctx.payload)
      return withProject(project, async () => {
        const ws = workspaceOf()
        const cwd = worktree(ws, project, branch)
        let pulled = true
        if (await ok(['rev-parse', '--abbrev-ref', '@{u}'], cwd, ctx)) await run(['pull', '--ff-only'], { cwd, ctx, token, timeoutMs: 600_000 })
        else pulled = false // branche pas encore poussee : rien a recuperer
        touch(ws, project, branch)
        return { project, pulled, ...(await summary(cwd, ctx)) }
      })
    },

    async 'git.push'(ctx) { // jamais de push force, jamais sur la branche principale
      const project = projectName(ctx.payload)
      const branch = branchName(ctx.payload, 'branch')!
      const token = optToken(ctx.payload)
      if (branch === 'main' || branch === 'master') fail(`Push refuse sur la branche principale (« ${branch} ») : passe par une branche dediee.`)
      return withProject(project, async () => {
        const ws = workspaceOf()
        const cwd = worktree(ws, project, branch)
        const def = await defaultBranch(join(ws, project, 'repo'), ctx)
        if (isProtected(branch, def)) fail(`Push refuse sur la branche principale (« ${branch} ») : passe par une branche dediee.`)
        await run(['push', '--set-upstream', 'origin', branch], { cwd, ctx, token, timeoutMs: 600_000 })
        touch(ws, project, branch)
        return { project, pushed: branch, ...(await summary(cwd, ctx)) }
      })
    },

    async 'git.status'(ctx) {
      const project = projectName(ctx.payload)
      const branch = branchName(ctx.payload, 'branch')!
      return withProject(project, async () => {
        const ws = workspaceOf()
        const cwd = worktree(ws, project, branch)
        const dirty = (await run(['status', '--porcelain'], { cwd, ctx })).split('\n').filter(Boolean).length
        let ahead: number | null = null
        let behind: number | null = null
        try {
          const [a, b] = (await run(['rev-list', '--left-right', '--count', 'HEAD...@{u}'], { cwd, ctx })).trim().split(/\s+/).map(Number)
          ahead = a; behind = b
        } catch { /* pas de branche distante suivie */ }
        touch(ws, project, branch)
        return { project, ...(await summary(cwd, ctx)), dirtyFiles: dirty, ahead, behind }
      })
    },

    async 'git.cleanup'(ctx) {
      const raw = field(ctx.payload, 'maxAgeDays')
      const days = typeof raw === 'number' && raw >= 0 && raw <= 365 ? raw : undefined
      return sweep(days)
    },
  }

  // --- nettoyage ------------------------------------------------------------------------------------------------------------------
  // Un dossier est « sur » a supprimer s'il n'a aucune modification en cours ET que son travail existe deja sur le depot distant.
  async function unsafeReason(cwd: string, ctx: RunCtx): Promise<string | null> {
    try {
      if ((await run(['status', '--porcelain'], { cwd, ctx })).trim()) return 'modifications non enregistrees'
      if (!(await run(['branch', '-r', '--contains', 'HEAD'], { cwd, ctx })).trim()) return 'commits non pousses'
      return null
    } catch (e) { return `verification impossible (${e instanceof Error ? e.message.slice(0, 80) : 'erreur'})` }
  }
  async function repoUnsafeReason(repo: string, ctx: RunCtx): Promise<string | null> {
    try {
      if ((await run(['status', '--porcelain'], { cwd: repo, ctx })).trim()) return 'modifications non enregistrees'
      for (const sha of (await run(['for-each-ref', 'refs/heads', '--format=%(objectname)'], { cwd: repo, ctx })).split('\n').filter(Boolean)) {
        if (!(await run(['branch', '-r', '--contains', sha], { cwd: repo, ctx })).trim()) return 'branche locale non poussee'
      }
      return null
    } catch (e) { return `verification impossible (${e instanceof Error ? e.message.slice(0, 80) : 'erreur'})` }
  }

  async function sweep(days = o.maxAgeDays ?? 3): Promise<SweepResult> {
    const result: SweepResult = { removed: [], kept: [] }
    if (!o.workspace()) return result
    const ws = workspaceOf()
    const limit = now() - days * DAY
    const reg = loadRegistry(ws)
    const ctx = noCtx()
    for (const [project, p] of Object.entries(reg.projects)) {
      if (busy.has(project)) continue
      const repo = join(ws, project, 'repo')
      for (const [branch, b] of Object.entries(p.branches)) {
        const path = join(ws, project, 'branches', encodeBranch(branch))
        if (!existsSync(path)) { delete p.branches[branch]; continue } // supprime a la main : on l'oublie
        if (b.lastUsed > limit) continue
        const reason = await unsafeReason(path, ctx)
        if (reason) { result.kept.push({ item: `${project}/${branch}`, reason }); continue }
        try {
          await run(['worktree', 'remove', path], { cwd: repo, ctx })
          delete p.branches[branch]
          result.removed.push(`${project}/${branch}`)
        } catch (e) { result.kept.push({ item: `${project}/${branch}`, reason: e instanceof Error ? e.message.slice(0, 120) : 'erreur' }) }
      }
      // Plus aucun dossier de travail et projet inutilise : on supprime aussi le clone principal.
      if (Object.keys(p.branches).length === 0 && p.lastUsed <= limit) {
        const reason = existsSync(join(repo, '.git')) ? await repoUnsafeReason(repo, ctx) : null
        if (reason) { result.kept.push({ item: project, reason }); continue }
        rmSync(join(ws, project), { recursive: true, force: true })
        delete reg.projects[project]
        result.removed.push(project)
      }
    }
    saveRegistry(ws, reg)
    return result
  }

  return {
    handlers,
    sweep,
    withProject,
    worktreePath: (project, branch) => worktree(workspaceOf(), project, branch),
    exec: (project, branch, args, ctx) => run(args, { cwd: worktree(workspaceOf(), project, branch), ctx, quiet: true }),
    registry() {
      const ws = o.workspace()
      if (!ws || !existsSync(ws)) return []
      return Object.entries(loadRegistry(realpathSync(ws)).projects).map(([project, p]) => ({
        project, url: p.url, lastUsed: p.lastUsed, branches: Object.entries(p.branches).map(([name, b]) => ({ name, lastUsed: b.lastUsed })),
      }))
    },
  }
}

export const gitHandlers = (o: GitOptions) => createGit(o).handlers
