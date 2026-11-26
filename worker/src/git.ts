// Gestion de git par le Worker : cloner, creer / changer de branche, pull, push, etat. Tout se passe dans l'ESPACE DE TRAVAIL (RPM_WORKSPACE_DIR) :
// un depot = un sous-dossier direct, designe par son nom. Rien n'est lance via un shell, chaque argument est valide, aucun « force push ».
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, realpathSync, statSync } from 'node:fs'
import { join, sep } from 'node:path'
import { JobCancelled, type JobContext, type JobHandler } from './jobs.ts'

export interface GitOptions {
  /** Dossier de travail (relu a chaque tache) ; null = non configure. */
  workspace: () => string | null
  /** URL de depot acceptees (par defaut : https et ssh seulement). */
  allowUrl?: (url: string) => boolean
  gitPath?: string
}

const DIR = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/
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
const dirName = (p: unknown) => { const d = str(p, 'dir')!; return DIR.test(d) && !d.endsWith('.') ? d : fail('Nom de dossier invalide (lettres, chiffres, point, tiret, souligne ; 64 max).') }
const branchName = (p: unknown, key: string, required = true) => {
  const b = str(p, key, required)
  if (b === undefined) return undefined
  if (!BRANCH.test(b) || b.includes('..') || b.includes('//') || b.endsWith('/') || b.endsWith('.') || b.endsWith('.lock') || b.includes('@{')) fail(`Nom de branche invalide : ${b.slice(0, 60)}`)
  return b
}

function workspaceOf(o: GitOptions): string {
  const ws = o.workspace()
  if (!ws) return fail("Espace de travail non configure : choisis un dossier dans la page locale du Worker (ou RPM_WORKSPACE_DIR dans .env).")
  if (!existsSync(ws)) mkdirSync(ws, { recursive: true })
  return realpathSync(ws)
}

// Un depot existant : sous-dossier direct de l'espace de travail, qui n'en sort pas (liens symboliques compris) et qui est bien un depot git.
function repoPath(o: GitOptions, name: string): string {
  const ws = workspaceOf(o)
  const full = join(ws, name)
  if (!existsSync(full) || !statSync(full).isDirectory()) return fail(`Depot introuvable dans l'espace de travail : ${name}`)
  const real = realpathSync(full)
  if (!real.startsWith(ws + sep)) fail('Ce dossier sort de l\'espace de travail.')
  if (!existsSync(join(real, '.git'))) fail(`Ce dossier n'est pas un depot git : ${name}`)
  return real
}

interface RunOpts { cwd: string; ctx: JobContext; token?: string | null; timeoutMs?: number }

function run(o: GitOptions, args: string[], r: RunOpts): Promise<string> {
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
      if (tail) r.ctx.event('info', `git ${args[0]} : ${tail}`.slice(0, 1500))
      resolve(out)
    })
  })
}

async function summary(o: GitOptions, cwd: string, ctx: JobContext) {
  const branch = (await run(o, ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd, ctx })).trim()
  const head = (await run(o, ['rev-parse', '--short', 'HEAD'], { cwd, ctx }).catch(() => '')).trim() // vide : depot sans commit
  return { branch, head: head || null }
}

const token = (p: unknown) => { const t = str(p, 'token', false); return t && /^[\w.-]{8,255}$/.test(t) ? t : t ? fail('Jeton invalide.') : null }

export function gitHandlers(o: GitOptions): Record<string, JobHandler> {
  const allow = o.allowUrl ?? defaultAllowUrl
  return {
    async 'git.clone'(ctx) {
      const url = str(ctx.payload, 'url')!
      if (url.startsWith('-') || !allow(url)) fail('Adresse de depot refusee (https ou ssh uniquement, sans identifiants dans l\'URL).')
      const dir = dirName(ctx.payload)
      const branch = branchName(ctx.payload, 'branch', false)
      const ws = workspaceOf(o)
      if (existsSync(join(ws, dir))) fail(`Le dossier existe deja dans l'espace de travail : ${dir}`)
      await run(o, ['clone', ...(branch ? ['--branch', branch] : []), '--', url, dir], { cwd: ws, ctx, token: token(ctx.payload), timeoutMs: 1_800_000 })
      return { dir, ...(await summary(o, repoPath(o, dir), ctx)) }
    },

    async 'git.branch'(ctx) { // cree une branche et s'y place
      const cwd = repoPath(o, dirName(ctx.payload))
      const name = branchName(ctx.payload, 'name')!
      const from = branchName(ctx.payload, 'from', false)
      await run(o, ['switch', '-c', name, ...(from ? [from] : [])], { cwd, ctx })
      return { dir: str(ctx.payload, 'dir'), ...(await summary(o, cwd, ctx)) }
    },

    async 'git.checkout'(ctx) { // se place sur une branche existante (locale, ou distante : elle est alors suivie)
      const cwd = repoPath(o, dirName(ctx.payload))
      await run(o, ['switch', branchName(ctx.payload, 'branch')!], { cwd, ctx })
      return { dir: str(ctx.payload, 'dir'), ...(await summary(o, cwd, ctx)) }
    },

    async 'git.pull'(ctx) { // fast-forward uniquement : jamais de fusion automatique ni de conflit laisse en plan
      const cwd = repoPath(o, dirName(ctx.payload))
      await run(o, ['pull', '--ff-only'], { cwd, ctx, token: token(ctx.payload), timeoutMs: 600_000 })
      return { dir: str(ctx.payload, 'dir'), ...(await summary(o, cwd, ctx)) }
    },

    async 'git.push'(ctx) { // jamais de push force
      const cwd = repoPath(o, dirName(ctx.payload))
      const current = (await run(o, ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd, ctx })).trim()
      const branch = branchName(ctx.payload, 'branch', false) ?? current
      if (branch === 'HEAD') fail('Aucune branche active (HEAD detache).')
      await run(o, ['push', '--set-upstream', 'origin', branch], { cwd, ctx, token: token(ctx.payload), timeoutMs: 600_000 })
      return { dir: str(ctx.payload, 'dir'), pushed: branch, ...(await summary(o, cwd, ctx)) }
    },

    async 'git.status'(ctx) {
      const cwd = repoPath(o, dirName(ctx.payload))
      const dirty = (await run(o, ['status', '--porcelain'], { cwd, ctx })).split('\n').filter(Boolean).length
      let ahead = null as number | null
      let behind = null as number | null
      try {
        const [a, b] = (await run(o, ['rev-list', '--left-right', '--count', 'HEAD...@{u}'], { cwd, ctx })).trim().split(/\s+/).map(Number)
        ahead = a; behind = b
      } catch { /* pas de branche distante suivie */ }
      return { dir: str(ctx.payload, 'dir'), ...(await summary(o, cwd, ctx)), dirtyFiles: dirty, ahead, behind }
    },
  }
}
