// Requetes IA : la tache `ai.chat` prepare le dossier de la branche (voir git.ts), lance le CLI Claude Code dessus avec le message de l'utilisateur,
// puis renvoie la reponse, les commits et le diff. Le travail est commite et pousse sur la branche dediee : jamais sur la branche principale.
//
// Securite : le prompt passe par l'entree standard (jamais dans la ligne de commande), les autres arguments sont constants ou valides, et les droits
// de l'IA sont limites par un fichier de reglages (lecture / edition de fichiers + git hors push) ; tout ce qui demanderait une autorisation est refuse.
import { spawn, execFile } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Git } from './git.ts'
import { GitError } from './git.ts'
import { JobCancelled, type JobContext, type JobHandler } from './jobs.ts'
import { attachmentList, attachmentsBlock, deliverAttachments, type Delivered } from './attachments.ts'
import { chatTools, type ChatToolsState } from './chat-tools.ts'
import { buildPreviews, fixRequest, type PreviewResult } from './preview.ts'
import { ToolServer } from './tools.ts'
import { WORKER_DIR } from './config.ts'

export interface AiOptions {
  git: Git
  /** Dossier de l'emulateur d'UI (par defaut ../ui-emulator) et du plugin Claude qui apprend a l'IA a construire et afficher des UI (par defaut ../ui-framework/plugin). */
  emulatorDir?: string
  pluginDir?: string
  /** Passes de correction automatique quand un apercu echoue (0 = aucune). */
  fixRounds?: number
  /** Serveur des outils donnes a l'IA (capture d'UI, acces au projet) ; un par Worker, demarre au premier besoin. */
  toolServer?: ToolServer
  /** Commande du CLI (par defaut `claude`). Les tests y mettent un faux CLI. */
  claude?: { cmd: string; args: string[] }
  timeoutMs?: number
  /** Outils autorises pour l'IA (regles de permissions Claude Code). */
  allow?: string[]
  deny?: string[]
}

// Par defaut : lire / modifier des fichiers, chercher, et git pour commiter. Pas de push (c'est le Worker qui pousse), pas d'acces reseau, pas de commandes quelconques.
// Les motifs « git * push » couvrent aussi `git -C <dossier> push` : l'IA commite dans les dossiers du projet par -C.
export const DEFAULT_ALLOW = ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash(git *)']
export const DEFAULT_DENY = ['Bash(git push *)', 'Bash(git push)', 'Bash(git * push *)', 'Bash(git * push)', 'Bash(git remote *)', 'Bash(git * remote *)', 'WebFetch', 'WebSearch']
/** Nos outils (serveur « rpm », voir chat-tools.ts) : les seuls outils MCP autorises. */
export const TOOL_ALLOW = ['mcp__rpm__ui_preview', 'mcp__rpm__project']

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
    case 'mcp__rpm__ui_preview': return `Capture de ${String(input.file ?? '')}${input.root === 'sandbox' ? ' (atelier)' : ''}`
    case 'mcp__rpm__project': return input.action === 'open_branch' ? 'Ouverture de la branche de travail du projet' : 'Lecture du projet'
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

interface ChatPayload {
  chatId: number
  /** Le projet du chat (depot GitHub). `open` : la branche de travail est deja ouverte (un tour precedent l'a ouverte). null : pas de depot, atelier seul. */
  project: { slug: string; url: string; branch: string; base: string | null; open: boolean } | null
  /** Depot de maquette dont l'atelier est copie a sa creation (null : atelier vide). */
  atelier: { url: string; base: string | null } | null
}

function chatPayload(p: unknown): ChatPayload {
  const chatId = field(p, 'chatId')
  if (typeof chatId !== 'number' || !Number.isInteger(chatId) || chatId < 1) throw new GitError('Identifiant de chat invalide.')
  const proj = field(p, 'project')
  let project: ChatPayload['project'] = null
  if (proj !== undefined && proj !== null) {
    const slug = field(proj, 'slug')
    const url = field(proj, 'url')
    const branch = field(proj, 'branch')
    if (typeof slug !== 'string' || typeof url !== 'string' || typeof branch !== 'string') throw new GitError('Projet invalide.')
    const base = field(proj, 'base')
    project = { slug, url, branch, base: typeof base === 'string' && base ? base : null, open: field(proj, 'open') === true }
  }
  const at = field(p, 'atelier')
  let atelier: ChatPayload['atelier'] = null
  if (at !== undefined && at !== null) {
    const url = field(at, 'url')
    if (typeof url !== 'string') throw new GitError('Depot de maquette invalide.')
    const base = field(at, 'base')
    atelier = { url, base: typeof base === 'string' && base ? base : null }
  }
  return { chatId, project, atelier }
}

const contextBlock = (o: { atelier: string; project: ChatPayload['project']; reference: string | null; worktree: string | null; open: boolean }) => `[Contexte automatique]
Ton dossier de travail est l'ATELIER de ce chat : ${o.atelier}
C'est un espace libre (copie du kit de composants du studio quand il y en a un), jamais pousse sur GitHub : ideal pour discuter et imaginer des interfaces avec de FAUSSES donnees.
${o.project ? `Le projet « ${o.project.slug} » (depot GitHub) est accessible par l'outil project :
- project(action="read") : copie en LECTURE SEULE de la branche principale (${o.reference}). Lis-y le code et les composants existants ; n'y modifie JAMAIS rien (tout est restaure apres ton tour).
- project(action="open_branch") : cree la branche de travail de ce chat (« ${o.project.branch} ») dans ${o.worktree} : c'est la qu'on modifie le vrai projet, avec des chemins absolus. Commit et push sont faits automatiquement ; pour commiter toi-meme : git -C "<dossier>" add -A, puis git -C "<dossier>" commit. Ne fais jamais de git push.
${o.open ? `La branche de travail est DEJA ouverte : ${o.worktree}` : "La branche de travail n'est pas encore ouverte."}` : "Ce projet n'a pas de depot GitHub : tu travailles uniquement dans l'atelier."}

Regles de travail :
1. Simple question, discussion, analyse : reponds. N'ouvre pas de branche et ne touche pas au projet.
2. L'utilisateur te demande de CODER, MODIFIER ou CORRIGER quelque chose dans le projet : ouvre la branche (project open_branch) IMMEDIATEMENT, sans demander la permission, implemente, puis montre le resultat. Ne demande jamais « puis-je creer une branche ? ».
3. L'utilisateur te demande un CONCEPT, une MAQUETTE, une idee ou une UI a partir de zero : fais-la dans l'atelier avec de fausses donnees, VERIFIE-la avec l'outil ui_preview (tu vois la capture) et corrige jusqu'a ce que le rendu soit bon, montre-la avec un bloc rpm-ui (root "sandbox"), puis ARRETE-TOI : demande a l'utilisateur de valider le concept. N'implemente RIEN dans le projet avant sa validation.
4. Une fois le concept valide (ou si l'utilisateur te demande directement de l'integrer) : ouvre la branche, integre-le dans le projet avec les vrais composants et les vraies donnees, verifie avec ui_preview (root "project"), puis montre le resultat.
Tu n'as pas de shell general (seul git est autorise) : lis avec Read / Glob / Grep, ecris avec Write / Edit (Write cree les dossiers manquants : inutile de faire mkdir ou ls).
Pour MONTRER une interface a l'utilisateur, termine ta reponse par un bloc \`\`\`rpm-ui contenant {"file": "<story depuis la racine du depot>", "root": "sandbox|project", "viewport": "UI Labs|Desktop|Tablette|Telephone", "title": "<titre>"}. Le skill rpm-ui detaille tout : utilise-le.
A la fin, resume en quelques phrases ce que tu as fait.

[Demande]
`

const reserve = (dir: string) => { if (!existsSync(dir)) mkdirSync(dir, { recursive: true }) }

export function aiHandlers(o: AiOptions): Record<string, JobHandler> {
  const claude = o.claude ?? { cmd: 'claude', args: [] }
  const toolServer = o.toolServer ?? new ToolServer()
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
      const push = field(ctx.payload, 'push') !== false
      const p = chatPayload(ctx.payload)

      const work = async () => {
        // 1. l'ATELIER du chat : dossier de travail de l'IA, stable (la conversation Claude est rattachee a ce dossier)
        ctx.event('info', "Preparation de l'atelier…")
        let atelier: { path: string; seeded: boolean }
        try { atelier = await o.git.ensureAtelier(p.chatId, p.atelier, ctx) } catch (e) {
          if (e instanceof JobCancelled) throw e
          ctx.event('warn', `Kit de composants indisponible (${e instanceof Error ? e.message.slice(0, 160) : 'erreur'}) : atelier vide.`)
          atelier = await o.git.ensureAtelier(p.chatId, null, ctx)
        }
        const cwd = atelier.path

        // 1 bis. fichiers joints : telecharges dans <atelier>/_uploads (un echec n'arrete pas la conversation)
        let delivered: Delivered[] = []
        const wanted = attachmentList(ctx.payload)
        if (wanted.length) {
          if (!ctx.downloadAttachment) ctx.event('warn', 'Ce Worker ne sait pas telecharger les fichiers joints.')
          else {
            ctx.event('info', `Telechargement de ${wanted.length} fichier(s) joint(s)…`)
            delivered = await deliverAttachments(cwd, wanted, ctx.downloadAttachment, (t) => ctx.event('warn', t))
          }
        }

        // 2. le projet : dossiers reserves d'avance (pour que l'IA puisse y lire / ecrire), branche ouverte seulement si elle l'a deja ete
        const paths = p.project ? o.git.projectPaths(p.project.slug, p.project.branch) : null
        if (paths) { reserve(paths.repo); reserve(paths.worktree) }
        const state: ChatToolsState = {
          git: o.git, ctx, atelier: cwd, emulatorDir: o.emulatorDir, branchOpen: false, startHead: null,
          referenceReady: !!paths && existsSync(join(paths.repo, '.git')),
          project: p.project ? { slug: p.project.slug, url: p.project.url, branch: p.project.branch, base: p.project.base } : null,
        }
        if (p.project?.open) {
          ctx.event('info', 'Preparation de la branche…')
          await o.git.handlers['git.prepare']({ ...ctx, payload: { project: p.project.slug, url: p.project.url, branch: p.project.branch, ...(p.project.base ? { base: p.project.base } : {}) } })
          state.branchOpen = true
          state.referenceReady = true
          state.startHead = (await o.git.exec(p.project.slug, p.project.branch, ['rev-parse', 'HEAD'], ctx)).trim()
        }

        // 3. Claude, avec des droits limites et NOS outils (capture d'UI, acces au projet) a l'exclusion de tout autre serveur d'outils de la machine
        const dir = mkdtempSync(join(tmpdir(), 'rpm-claude-'))
        const pluginDir = o.pluginDir ?? join(WORKER_DIR, '..', 'ui-framework', 'plugin')
        const session = await toolServer.register(chatTools(state), ctx.signal)
        let result: ClaudeResult
        let previews: PreviewResult[] = []
        let fixed = false
        try {
          const settings = join(dir, 'settings.json')
          writeFileSync(settings, JSON.stringify({ permissions: { allow: [...(o.allow ?? DEFAULT_ALLOW), ...TOOL_ALLOW], deny: o.deny ?? DEFAULT_DENY } }))
          const mcp = join(dir, 'mcp.json')
          writeFileSync(mcp, JSON.stringify({ mcpServers: { rpm: { type: 'http', url: session.url, headers: { Authorization: `Bearer ${session.token}` } } } }), { mode: 0o600 })
          const turn = async (text: string, resume: string | null) => {
            const args = [...claude.args, '-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'acceptEdits', '--permission-prompts', 'none', '--settings', settings,
              '--mcp-config', mcp, '--strict-mcp-config']
            for (const d of paths ? [paths.worktree, paths.repo] : []) args.push('--add-dir', d)
            if (existsSync(join(pluginDir, '.claude-plugin', 'plugin.json'))) args.push('--plugin-dir', pluginDir)
            if (resume) args.push('--resume', resume)
            if (model) args.push('--model', model as string)
            if (effort) args.push('--effort', effort as string)
            return parseClaudeOutput(await runClaude(claude.cmd, args, cwd, text, ctx, o.timeoutMs ?? 30 * 60_000, (obj) => { for (const s of describeStreamEvent(obj, cwd)) ctx.event('info', s.text, s.kind) }))
          }
          const context = () => contextBlock({ atelier: cwd, project: p.project, reference: paths?.repo ?? null, worktree: paths?.worktree ?? null, open: state.branchOpen })
          const build = (text: string) => {
            if (!ctx.uploadPreview) return Promise.resolve([] as PreviewResult[])
            const roots = { project: paths ? (state.branchOpen ? paths.worktree : state.referenceReady ? paths.repo : undefined) : undefined, sandbox: cwd }
            return buildPreviews(text, { project: roots.project, sandbox: roots.sandbox, emulatorDir: o.emulatorDir, upload: ctx.uploadPreview, signal: ctx.signal, event: ctx.event })
          }
          ctx.event('info', sessionId ? 'Claude reprend la conversation…' : 'Claude demarre…')
          result = await turn(context() + attachmentsBlock(delivered) + prompt, sessionId as string | null)
          previews = await build(result.text)
          const problems = fixRequest(previews)
          if (problems && result.sessionId && (o.fixRounds ?? 1) > 0) {
            ctx.event('info', "Un apercu pose probleme : l'IA le corrige…")
            const first = result
            result = await turn(`[Retour automatique]\nLes apercus demandes ont ces problemes :\n${problems}\nCorrige la story (ou les composants), verifie avec ui_preview, puis montre-la de nouveau avec un bloc rpm-ui.`, first.sessionId)
            result = { ...result, sessionId: result.sessionId ?? first.sessionId, costUsd: (first.costUsd ?? 0) + (result.costUsd ?? 0), durationMs: (first.durationMs ?? 0) + (result.durationMs ?? 0), turns: (first.turns ?? 0) + (result.turns ?? 0) }
            previews = await build(result.text)
            fixed = true
          }
        } finally { session.dispose(); rmSync(dir, { recursive: true, force: true }) }

        // 4. la copie en lecture seule du projet est remise a zero ; la branche (si elle est ouverte) est sauvegardee : commit des oublis, diff, push
        if (p.project) {
          const touched = await o.git.cleanReference(p.project.slug, ctx).catch(() => 0)
          if (touched) ctx.event('warn', `${touched} fichier(s) modifie(s) dans la copie en lecture seule du projet : restaures.`)
        }
        let commits: string[] = []
        let diffStat = ''
        let diff = ''
        let leftover = 0
        let pushed = false
        let pushError: string | null = null
        let head: string | null = null
        if (p.project && state.branchOpen) {
          const { slug, branch } = p.project
          const git = (args: string[]) => o.git.exec(slug, branch, args, ctx)
          const dirty = (await git(['status', '--porcelain'])).trim()
          if (dirty) {
            try {
              await git(['add', '-A'])
              await git(['-c', 'user.name=RPM Worker', '-c', 'user.email=worker@rpm.local', 'commit', '-q', '-m', 'Modifications de la conversation IA (non commitees par l\'IA)'])
            } catch { /* rien a commiter ou configuration git manquante : on garde les modifications telles quelles */ }
          }
          head = (await git(['rev-parse', 'HEAD'])).trim()
          const start = state.startHead ?? head
          const changed = head !== start
          const range = `${start}..${head}`
          commits = changed ? (await git(['log', '--format=%h %s', '-n', '30', range])).split('\n').filter(Boolean) : []
          diffStat = changed ? (await git(['diff', '--stat', range])).trim().slice(0, 4000) : ''
          diff = changed ? (await git(['diff', range])).slice(0, MAX_DIFF) : ''
          leftover = (await git(['status', '--porcelain'])).split('\n').filter(Boolean).length
          if (push && changed) {
            try { await o.git.handlers['git.push']({ ...ctx, payload: { project: slug, branch, token: field(ctx.payload, 'token') } }); pushed = true }
            catch (e) { if (e instanceof JobCancelled) throw e; pushError = e instanceof Error ? e.message.slice(0, 400) : String(e) }
          }
        }
        return {
          text: result.text, sessionId: result.sessionId, costUsd: result.costUsd, durationMs: result.durationMs, turns: result.turns,
          chatId: p.chatId, project: p.project?.slug ?? null,
          // la branche n'existe (pour l'utilisateur) qu'une fois ouverte ; `branchOpened` : ouverte pendant CE tour
          branch: state.branchOpen ? p.project!.branch : null, branchOpened: state.branchOpen && !p.project?.open, atelierSeeded: atelier.seeded,
          head: head ? head.slice(0, 8) : null, commits, diffStat, diff, leftoverFiles: leftover, pushed, pushError,
          previews: previews.map((r) => ({ n: r.n, title: r.title, file: r.file, viewport: r.viewport, root: r.root, ok: r.ok, error: r.error, previewId: r.previewId, nodes: r.nodes, errors: r.errors, missing: r.missing })), previewFixed: fixed,
        }
      }
      return o.git.withAtelier(p.chatId, () => (p.project ? o.git.withProject(p.project.slug, work) : work()))
    },
  }
}
