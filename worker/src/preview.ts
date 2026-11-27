// Apercus d'interface : l'IA ecrit dans sa reponse un bloc `rpm-ui` (voir ui-framework/plugin/skills/rpm-ui) ; le Worker construit alors l'apercu de la story
// designee avec l'emulateur (ui-emulator/tools/preview.mjs), le verifie dans un navigateur sans fenetre, et envoie le paquet au Host qui l'affiche dans le chat.
import { execFile } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'
import { WORKER_DIR } from './config.ts'

export const VIEWPORTS = ['UI Labs', 'Desktop', 'Tablette', 'Telephone'] as const
export const DEFAULT_EMULATOR_DIR = join(WORKER_DIR, '..', 'ui-emulator')
export const MAX_BLOCKS = 6

/** Ou vit la story : `project` (depot du projet, branche du chat) ou `sandbox` (depot de maquette du chat : concepts, fausses donnees, jamais pousse). */
export type UiRoot = 'project' | 'sandbox'
export const ROOTS: readonly UiRoot[] = ['project', 'sandbox']

export interface UiBlock { n: number; file: string; viewport: string; title: string; root: UiRoot }
export interface InvalidBlock { n: number; error: string }

// Un bloc : ```rpm-ui puis un objet JSON {"file": "...story.tsx", "viewport": "Telephone", "title": "..."} puis ```.
// Balayage ligne par ligne, IDENTIQUE a celui du rendu Markdown du Host (host/src/markdown.ts) : seuls les blocs de code de premier niveau comptent
// (un exemple de bloc rpm-ui a l'interieur d'un autre bloc de code est du texte), pour que les deux cotes numerotent les apercus de la meme facon.
export function scanFences(text: string): { info: string; body: string }[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const out: { info: string; body: string }[] = []
  for (let i = 0; i < lines.length; i++) {
    const open = /^```([\w+-]*)[ \t]*$/.exec(lines[i])
    if (!open) continue
    const body: string[] = []
    i++
    while (i < lines.length && !/^```[ \t]*$/.test(lines[i])) body.push(lines[i++])
    out.push({ info: open[1], body: body.join('\n') })
  }
  return out
}

/** Blocs `rpm-ui` de la reponse, numerotes dans l'ordre (le Host numerote de la meme facon pour retrouver l'apercu de chaque bloc). */
export function parseUiBlocks(text: string): { blocks: UiBlock[]; invalid: InvalidBlock[] } {
  const blocks: UiBlock[] = []
  const invalid: InvalidBlock[] = []
  let n = 0
  for (const f of scanFences(text)) {
    if (f.info !== 'rpm-ui') continue
    const i = n++
    if (i >= MAX_BLOCKS) { invalid.push({ n: i, error: `trop d'apercus dans une reponse (${MAX_BLOCKS} maximum)` }); continue }
    let data: unknown
    try { data = JSON.parse(f.body) } catch { invalid.push({ n: i, error: "le contenu du bloc rpm-ui n'est pas du JSON valide" }); continue }
    if (!data || typeof data !== 'object' || Array.isArray(data)) { invalid.push({ n: i, error: 'le bloc rpm-ui doit etre un objet JSON' }); continue }
    const o = data as Record<string, unknown>
    const file = typeof o.file === 'string' ? o.file.replace(/\\/g, '/').replace(/^\.\//, '') : ''
    const problem = fileProblem(file)
    if (problem) { invalid.push({ n: i, error: problem }); continue }
    const viewport = o.viewport === undefined ? 'UI Labs' : typeof o.viewport === 'string' && (VIEWPORTS as readonly string[]).includes(o.viewport) ? o.viewport : null
    if (viewport === null) { invalid.push({ n: i, error: `viewport inconnu (attendu : ${VIEWPORTS.join(', ')})` }); continue }
    const root = o.root === undefined ? 'project' : (ROOTS as readonly unknown[]).includes(o.root) ? (o.root as UiRoot) : null
    if (root === null) { invalid.push({ n: i, error: `racine inconnue (attendu : ${ROOTS.join(' ou ')})` }); continue }
    const title = typeof o.title === 'string' ? o.title.replace(/[\r\n\u0000-\u001f]/g, ' ').trim().slice(0, 80) : ''
    blocks.push({ n: i, file, viewport, root, title: title || file.split('/').pop()!.replace(/\.story\.tsx?$/, '') })
  }
  return { blocks, invalid }
}

/** Chemin de story acceptable : relatif au depot, sans « .. », sans lecteur ni chemin absolu, fichier *.story.ts(x). */
export function fileProblem(file: string): string | null {
  if (!file) return 'champ « file » manquant (chemin de la story depuis la racine du depot)'
  if (file.length > 300) return 'chemin trop long'
  if (!/\.story\.tsx?$/.test(file)) return 'le fichier doit se terminer par .story.tsx ou .story.ts'
  if (file.startsWith('/') || /^[A-Za-z]:/.test(file) || file.split('/').includes('..') || /[\u0000-\u001f<>"|?*]/.test(file)) return 'chemin de story invalide (relatif a la racine du depot, sans « .. »)'
  return null
}

export interface PreviewMeta { n: number; title: string; file: string; viewport: string; root: UiRoot; ok: boolean; error: string | null; checked: boolean; nodes: number; errors: string[]; missing: string[] }
export interface PreviewResult extends PreviewMeta { previewId: string | null }

export interface BuildOptions {
  /** Racine du projet (dossier de travail de la branche, ou copie en lecture seule) ; absente : pas de projet disponible. */
  project?: string
  /** Dossier du depot de maquette de ce chat, s'il y en a un (blocs `root: "sandbox"`). */
  sandbox?: string
  emulatorDir?: string
  /** Envoie un paquet (dossier) au Host ; renvoie l'identifiant de l'apercu. Sans dossier : ne depose que les metadonnees (apercu en echec). */
  upload: (dir: string | null, meta: PreviewMeta) => Promise<string>
  signal: AbortSignal
  event: (level: 'info' | 'warn' | 'error', text: string) => void
}

interface ToolResult { ok: boolean; error?: string; nodes?: number; errors?: string[]; missing?: string[]; checked?: boolean }

function runTool(emulatorDir: string, args: string[], signal: AbortSignal): Promise<ToolResult> {
  return new Promise((resolve) => {
    execFile(process.execPath, [join(emulatorDir, 'tools', 'preview.mjs'), ...args], { cwd: emulatorDir, timeout: 300_000, maxBuffer: 4_000_000, windowsHide: true, signal }, (err, stdout) => {
      const last = String(stdout).trim().split(/\r?\n/).filter((l) => l.startsWith('{')).pop()
      if (last) { try { resolve(JSON.parse(last) as ToolResult); return } catch { /* sortie illisible : erreur generique ci-dessous */ } }
      resolve({ ok: false, error: err ? `l'emulateur a echoue : ${String(err.message).slice(0, 200)}` : 'sortie de l\'emulateur illisible' })
    })
  })
}

/** Construit, controle et envoie l'apercu de chaque bloc valide ; un bloc invalide ou en echec est signale au Host avec son erreur. */
export async function buildPreviews(text: string, o: BuildOptions): Promise<PreviewResult[]> {
  const { blocks, invalid } = parseUiBlocks(text)
  const emulatorDir = o.emulatorDir ?? DEFAULT_EMULATOR_DIR
  const results: PreviewResult[] = []
  const meta = (b: { n: number; file?: string; viewport?: string; title?: string; root?: UiRoot }, error: string | null, extra: Partial<PreviewMeta> = {}): PreviewMeta => ({
    n: b.n, title: b.title ?? '', file: b.file ?? '', viewport: b.viewport ?? 'UI Labs', root: b.root ?? 'project', ok: error === null, error, checked: false, nodes: 0, errors: [], missing: [], ...extra,
  })

  for (const bad of invalid) {
    const m = meta({ n: bad.n }, bad.error)
    results.push({ ...m, previewId: await o.upload(null, m).catch(() => null) })
  }
  if (blocks.length && !existsSync(join(emulatorDir, 'tools', 'preview.mjs'))) {
    for (const b of blocks) {
      const m = meta(b, "l'emulateur d'UI n'est pas installe sur ce Worker (dossier ui-emulator)")
      results.push({ ...m, previewId: await o.upload(null, m).catch(() => null) })
    }
    return results.sort((a, b) => a.n - b.n)
  }

  for (const b of blocks) {
    const projectDir = b.root === 'sandbox' ? o.sandbox : o.project
    if (!projectDir) {
      const m = meta(b, "le depot de maquette de ce chat n'est pas disponible")
      results.push({ ...m, previewId: await o.upload(null, m).catch(() => null) })
      continue
    }
    o.event('info', `Apercu : ${b.file}${b.root === 'sandbox' ? ' (maquette)' : ''}`)
    const out = mkdtempSync(join(tmpdir(), 'rpm-prev-'))
    try {
      const r = await runTool(emulatorDir, ['--project', projectDir, '--file', b.file, '--out', join(out, 'bundle'), '--viewport', b.viewport], o.signal)
      if (o.signal.aborted) break
      if (!r.ok) {
        const m = meta(b, r.error ?? 'construction impossible')
        results.push({ ...m, previewId: await o.upload(null, m).catch(() => null) })
        o.event('warn', `Apercu en echec (${b.file}) : ${m.error}`.slice(0, 400))
        continue
      }
      // Une story qui s'affiche avec des erreurs (ou vide) est livree quand meme, avec ses erreurs : l'IA peut corriger, l'utilisateur voit le resultat.
      const errors = r.errors ?? []
      const m = meta(b, null, { checked: r.checked === true, nodes: r.nodes ?? 0, errors, missing: r.missing ?? [] })
      const previewId = await o.upload(join(out, 'bundle'), m).catch((e) => { m.ok = false; m.error = `envoi au Host impossible : ${e instanceof Error ? e.message : String(e)}`; return null })
      results.push({ ...m, previewId })
    } finally { rmSync(out, { recursive: true, force: true }) }
  }
  return results.sort((a, b) => a.n - b.n)
}

export interface RenderResult { ok: boolean; error?: string; png?: Buffer; nodes: number; errors: string[]; missing: string[] }

/**
 * « Photo » d'une story : la construit, la rend dans un navigateur sans fenetre et renvoie la capture (PNG) avec les erreurs et modules manquants.
 * C'est ce que l'outil `ui_preview` donne a l'IA pour VOIR ce qu'elle construit (voir mcp-ui.ts).
 */
export async function renderStory(o: { emulatorDir?: string; project: string; file: string; viewport?: string; signal: AbortSignal }): Promise<RenderResult> {
  const emulatorDir = o.emulatorDir ?? DEFAULT_EMULATOR_DIR
  const fail = (error: string): RenderResult => ({ ok: false, error, nodes: 0, errors: [], missing: [] })
  const problem = fileProblem(o.file)
  if (problem) return fail(problem)
  if (!existsSync(join(emulatorDir, 'tools', 'preview.mjs'))) return fail("l'emulateur d'UI n'est pas installe sur ce Worker (dossier ui-emulator)")
  const out = mkdtempSync(join(tmpdir(), 'rpm-shot-'))
  try {
    const r = await runTool(emulatorDir, ['--project', o.project, '--file', o.file, '--out', join(out, 'bundle'), '--viewport', o.viewport ?? 'UI Labs'], o.signal)
    if (!r.ok) return fail(r.error ?? 'construction impossible')
    const png = join(out, 'bundle', 'thumb.png')
    if (!r.checked || !existsSync(png)) return { ...fail('aucun navigateur (Edge ou Chrome) sur ce Worker : impossible de prendre une capture'), nodes: r.nodes ?? 0, errors: r.errors ?? [], missing: r.missing ?? [] }
    return { ok: true, png: readFileSync(png), nodes: r.nodes ?? 0, errors: r.errors ?? [], missing: r.missing ?? [] }
  } finally { rmSync(out, { recursive: true, force: true }) }
}

/** Resume pour l'IA des apercus a corriger (vide si tout va bien). Les modules « manquants » ne sont pas des erreurs : l'emulateur les remplace. */
export function fixRequest(results: PreviewResult[]): string {
  const problems = results.filter((r) => !r.ok || r.errors.length || (r.checked && r.nodes <= 1))
  if (!problems.length) return ''
  const reason = (r: PreviewResult) => (!r.ok ? r.error : r.errors.length ? r.errors.slice(0, 3).join(' | ') : "l'apercu est vide (aucun element affiche)")
  return problems.map((r) => `- ${r.file || `bloc n°${r.n + 1}`} : ${reason(r)}`).join('\n')
}

/** Lecture recursive d'un dossier de paquet : [{ path relatif en /, contenu }] (taille et nombre bornes par l'appelant). */
export function listFiles(dir: string): { path: string; size: number; abs: string }[] {
  const out: { path: string; size: number; abs: string }[] = []
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const abs = join(d, e.name)
      if (e.isDirectory()) walk(abs)
      else if (e.isFile()) out.push({ path: relative(dir, abs).split(sep).join('/'), size: statSync(abs).size, abs })
    }
  }
  walk(dir)
  return out
}

export const readBase64 = (abs: string) => readFileSync(abs).toString('base64')
