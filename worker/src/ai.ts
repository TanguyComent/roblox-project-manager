// Requetes IA : la tache `ai.chat` prepare le dossier de la branche (voir git.ts), lance le CLI Claude Code dessus avec le message de l'utilisateur,
// puis renvoie la reponse, les commits et le diff. Le travail est commite et pousse sur la branche dediee : jamais sur la branche principale.
//
// Securite : le prompt passe par l'entree standard (jamais dans la ligne de commande), les autres arguments sont constants ou valides, et les droits
// de l'IA sont limites par un fichier de reglages (lecture / edition de fichiers + git hors push) ; tout ce qui demanderait une autorisation est refuse.
import { spawn, execFile } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Git } from './git.ts'
import { GitError } from './git.ts'
import { JobCancelled, type JobContext, type JobHandler } from './jobs.ts'

export interface AiOptions {
  git: Git
  /** Commande du CLI (par defaut `claude`). Les tests y mettent un faux CLI. */
  claude?: { cmd: string; args: string[] }
  timeoutMs?: number
  /** Outils autorises pour l'IA (regles de permissions Claude Code). */
  allow?: string[]
  deny?: string[]
}

// Par defaut : lire / modifier des fichiers, chercher, et git pour commiter. Pas de push (c'est le Worker qui pousse), pas d'acces reseau, pas de commandes quelconques.
export const DEFAULT_ALLOW = ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash(git *)']
export const DEFAULT_DENY = ['Bash(git push *)', 'Bash(git push)', 'Bash(git remote *)', 'WebFetch', 'WebSearch']

const MAX_PROMPT = 20_000
const MAX_DIFF = 30_000
const MAX_TEXT = 40_000
// Premier caractere alphanumerique : une valeur ne peut jamais etre prise pour une option du CLI (« --... »).
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9-]{7,63}$/
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

const EFFORT = ['low', 'medium', 'high', 'xhigh', 'max']

type Step = { kind: 'thinking' | 'tool' | 'text'; text: string }

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

// Chemins affiches relativement au dossier de travail (pas de chemin absolu de la machine dans les journaux).
function relPath(p: unknown, cwd: string): string {
  const s = String(p ?? '').replace(/\\/g, '/')
  const base = cwd.replace(/\\/g, '/').replace(/\/+$/, '')
  return s.toLowerCase().startsWith(`${base.toLowerCase()}/`) ? s.slice(base.length + 1) : s
}

function toolSummary(name: string, input: Record<string, unknown>, cwd: string): string {
  switch (name) {
    case 'Read': return `Lecture de ${relPath(input.file_path, cwd)}`
    case 'Edit': case 'MultiEdit': return `Modification de ${relPath(input.file_path, cwd)}`
    case 'Write': return `Ecriture de ${relPath(input.file_path, cwd)}`
    case 'NotebookEdit': return `Modification de ${relPath(input.notebook_path, cwd)}`
    case 'Glob': return `Recherche de fichiers : ${String(input.pattern ?? '')}`
    case 'Grep': return `Recherche : ${String(input.pattern ?? '')}`
    case 'Bash': case 'PowerShell': return `Commande : ${String(input.command ?? '')}`
    case 'Task': case 'Agent': return `Sous-agent : ${String(input.description ?? '')}`
    case 'TodoWrite': return 'Mise a jour de la liste de taches'
    default: return name
  }
}

/** Etapes visibles d'un evenement du flux `--output-format stream-json` : pensee, appel d'outil, texte. Le reste est ignore. */
export function describeStreamEvent(obj: unknown, cwd: string): Step[] {
  const j = obj as { type?: string; message?: { content?: unknown } }
  if (j?.type !== 'assistant' || !Array.isArray(j.message?.content)) return []
  const steps: Step[] = []
  for (const b of j.message!.content as Record<string, unknown>[]) {
    if (b.type === 'thinking' && typeof b.thinking === 'string' && b.thinking.trim()) steps.push({ kind: 'thinking', text: clip(b.thinking.trim(), 8000) })
    else if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) steps.push({ kind: 'text', text: clip(b.text.trim(), 6000) })
    else if (b.type === 'tool_use' && typeof b.name === 'string') steps.push({ kind: 'tool', text: clip(toolSummary(b.name, (b.input ?? {}) as Record<string, unknown>, cwd), 300) })
  }
  return steps
}

const field = (p: unknown, key: string): unknown => (p && typeof p === 'object' ? (p as Record<string, unknown>)[key] : undefined)

interface ClaudeResult { text: string; sessionId: string | null; costUsd: number | null; durationMs: number | null; turns: number | null }

// Le CLI affiche un seul objet JSON (--output-format json) ; on lit le dernier objet de la sortie pour ignorer d'eventuels avertissements avant.
export function parseClaudeOutput(out: string): ClaudeResult {
  const candidates = [out.trim(), ...out.trim().split(/\r?\n/).reverse()]
  for (const c of candidates) {
    if (!c.startsWith('{')) continue
    try {
      const j = JSON.parse(c) as Record<string, unknown>
      if (j.type !== 'result' && typeof j.result !== 'string') continue
      const text = typeof j.result === 'string' ? j.result : ''
      if (j.is_error === true) throw new GitError(`Claude a signale une erreur : ${text.slice(0, 500) || String(j.subtype ?? 'erreur')}`)
      return {
        text: text.slice(0, MAX_TEXT),
        sessionId: typeof j.session_id === 'string' && SESSION_ID.test(j.session_id) ? j.session_id : null,
        costUsd: typeof j.total_cost_usd === 'number' ? j.total_cost_usd : null,
        durationMs: typeof j.duration_ms === 'number' ? j.duration_ms : null,
        turns: typeof j.num_turns === 'number' ? j.num_turns : null,
      }
    } catch (e) { if (e instanceof GitError) throw e }
  }
  throw new GitError(`Reponse de Claude illisible : ${out.trim().slice(0, 300) || '(vide)'}`)
}

function killTree(pid: number | undefined) {
  if (!pid) return
  if (process.platform === 'win32') execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }, () => {})
  else { try { process.kill(-pid, 'SIGKILL') } catch { try { process.kill(pid, 'SIGKILL') } catch { /* deja termine */ } } }
}

function runClaude(cmd: string, args: string[], cwd: string, prompt: string, ctx: Pick<JobContext, 'signal'>, timeoutMs: number, onLine?: (obj: unknown) => void): Promise<string> {
  return new Promise((resolve, reject) => {
    // Sous Windows, `claude` est souvent un script .cmd (npm) : il faut un shell. Les arguments sont des constantes ou des valeurs validees ; le prompt passe par stdin.
    const viaShell = process.platform === 'win32' && cmd === 'claude'
    const finalArgs = viaShell ? args.map((a) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '')}"` : a)) : args
    const child = spawn(cmd, finalArgs, { cwd, shell: viaShell, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    let pendingLine = ''
    let lastResult = ''
    let done = false
    // Flux : une ligne JSON par evenement. On les transmet au fur et a mesure et on garde la ligne « result » finale.
    const handleLine = (line: string) => {
      const t = line.trim()
      if (!t.startsWith('{')) return
      try {
        const obj = JSON.parse(t) as { type?: string }
        if (obj.type === 'result') lastResult = t
        onLine?.(obj)
      } catch { /* ligne partielle ou illisible : ignoree */ }
    }
    const finish = (fn: () => void) => { if (done) return; done = true; clearTimeout(timer); ctx.signal.removeEventListener('abort', onAbort); fn() }
    const onAbort = () => { killTree(child.pid); finish(() => reject(new JobCancelled())) }
    const timer = setTimeout(() => { killTree(child.pid); finish(() => reject(new GitError(`Claude n'a pas termine en ${Math.round(timeoutMs / 60000)} min : interrompu.`))) }, timeoutMs)
    if (ctx.signal.aborted) return onAbort()
    ctx.signal.addEventListener('abort', onAbort, { once: true })
    child.stdout.on('data', (d: Buffer) => {
      const text = d.toString('utf8')
      if (out.length < 2_000_000) out += text
      pendingLine += text
      const lines = pendingLine.split('\n')
      pendingLine = lines.pop() ?? ''
      for (const l of lines) handleLine(l)
    })
    child.stderr.on('data', (d: Buffer) => { if (err.length < 20_000) err += d.toString('utf8') })
    child.on('error', (e: NodeJS.ErrnoException) => finish(() => reject(new GitError(e.code === 'ENOENT' ? "Le CLI « claude » est introuvable sur cette machine." : `Impossible de lancer Claude : ${e.message}`))))
    child.on('close', (code) => finish(() => {
      handleLine(pendingLine)
      if (code === 0) return resolve(lastResult || out)
      // Claude ecrit parfois son erreur en JSON sur stdout : on la lit pour un message utile.
      let detail = err.trim() || out.trim()
      try { const j = JSON.parse(out.trim()) as { result?: unknown }; if (typeof j.result === 'string') detail = j.result } catch { /* texte brut */ }
      reject(new GitError(`Claude s'est arrete avec le code ${code} : ${detail.slice(0, 600)}`))
    }))
    child.stdin.on('error', () => { /* le processus a pu se terminer avant d'avoir tout lu */ })
    child.stdin.end(prompt)
  })
}

const contextBlock = (branch: string) => `[Contexte automatique]
Tu travailles dans un depot git, sur la branche « ${branch} » qui t'est dediee. Ne change jamais de branche.
Commite ton travail avec des messages clairs (git add / git commit) ; ne fais pas de git push, c'est fait automatiquement ensuite.
A la fin, resume en quelques phrases ce que tu as fait.

[Demande]
`

export function aiHandlers(o: AiOptions): Record<string, JobHandler> {
  const claude = o.claude ?? { cmd: 'claude', args: [] }
  return {
    async 'ai.chat'(ctx) {
      const prompt = field(ctx.payload, 'prompt')
      if (typeof prompt !== 'string' || !prompt.trim()) throw new GitError('Message vide.')
      if (prompt.length > MAX_PROMPT) throw new GitError(`Message trop long (${MAX_PROMPT} caracteres maximum).`)
      const sessionId = field(ctx.payload, 'sessionId')
      if (sessionId !== undefined && sessionId !== null && (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId))) throw new GitError('Identifiant de session invalide.')
      const effort = field(ctx.payload, 'effort')
      if (effort !== undefined && effort !== null && effort !== '' && !EFFORT.includes(effort as string)) throw new GitError('Niveau d\'effort invalide.')
      const model = field(ctx.payload, 'model')
      if (model !== undefined && model !== null && model !== '' && (typeof model !== 'string' || !MODEL.test(model))) throw new GitError('Modele invalide.')
      const project = String(field(ctx.payload, 'project') ?? '')
      const branch = String(field(ctx.payload, 'branch') ?? '')
      const push = field(ctx.payload, 'push') !== false

      return o.git.withProject(project, async () => {
        // 1. dossier de travail de la branche (clone / mise a jour / creation selon l'etat) ; la validation des champs project, url et branch est faite la
        ctx.event('info', 'Preparation du depot et de la branche…')
        const prep = await o.git.handlers['git.prepare'](ctx) as { path: string; created: boolean; newBranch: boolean }
        const cwd = o.git.worktreePath(project, branch)
        const git = (args: string[]) => o.git.exec(project, branch, args, ctx)
        const startHead = (await git(['rev-parse', 'HEAD'])).trim()

        // 2. Claude, avec des droits limites
        const dir = mkdtempSync(join(tmpdir(), 'rpm-claude-'))
        let result: ClaudeResult
        try {
          const settings = join(dir, 'settings.json')
          writeFileSync(settings, JSON.stringify({ permissions: { allow: o.allow ?? DEFAULT_ALLOW, deny: o.deny ?? DEFAULT_DENY } }))
          const args = [...claude.args, '-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'acceptEdits', '--permission-prompts', 'none', '--settings', settings]
          if (sessionId) args.push('--resume', sessionId as string)
          if (model) args.push('--model', model as string)
          if (effort) args.push('--effort', effort as string)
          ctx.event('info', sessionId ? 'Claude reprend la conversation…' : 'Claude demarre…')
          result = parseClaudeOutput(await runClaude(claude.cmd, args, cwd, contextBlock(branch) + prompt, ctx, o.timeoutMs ?? 30 * 60_000, (obj) => { for (const s of describeStreamEvent(obj, cwd)) ctx.event('info', s.text, s.kind) }))
        } finally { rmSync(dir, { recursive: true, force: true }) }

        // 3. ce qui a change : un travail oublie en cours de route est commite pour ne rien perdre
        const dirty = (await git(['status', '--porcelain'])).trim()
        if (dirty) {
          try {
            await git(['add', '-A'])
            await git(['-c', 'user.name=RPM Worker', '-c', 'user.email=worker@rpm.local', 'commit', '-q', '-m', 'Modifications de la conversation IA (non commitees par l\'IA)'])
          } catch { /* rien a commiter ou configuration git manquante : on garde les modifications telles quelles */ }
        }
        const head = (await git(['rev-parse', 'HEAD'])).trim()
        const range = `${startHead}..${head}`
        const changed = head !== startHead
        const commits = changed ? (await git(['log', '--format=%h %s', '-n', '30', range])).split('\n').filter(Boolean) : []
        const diffStat = changed ? (await git(['diff', '--stat', range])).trim().slice(0, 4000) : ''
        const diff = changed ? (await git(['diff', range])).slice(0, MAX_DIFF) : ''
        const leftover = (await git(['status', '--porcelain'])).split('\n').filter(Boolean).length

        // 4. sauvegarde sur le depot distant (sans jamais faire echouer la reponse si le push n'est pas possible)
        let pushed = false
        let pushError: string | null = null
        if (push && changed) {
          try { await o.git.handlers['git.push']({ ...ctx, payload: { project, branch, token: field(ctx.payload, 'token') } }); pushed = true }
          catch (e) { if (e instanceof JobCancelled) throw e; pushError = e instanceof Error ? e.message.slice(0, 400) : String(e) }
        }
        return {
          text: result.text, sessionId: result.sessionId, costUsd: result.costUsd, durationMs: result.durationMs, turns: result.turns,
          project, branch, path: prep.path, newBranch: prep.newBranch, startHead: startHead.slice(0, 8), head: head.slice(0, 8),
          commits, diffStat, diff, leftoverFiles: leftover, pushed, pushError,
        }
      })
    },
  }
}
