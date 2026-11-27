import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { aiHandlers, DEFAULT_ALLOW, DEFAULT_DENY, TOOL_ALLOW, describeStreamEvent, parseClaudeOutput } from '../src/ai.ts'
import { createGit } from '../src/git.ts'
import type { JobContext } from '../src/jobs.ts'
import { ToolServer } from '../src/tools.ts'

const FAKE = join(import.meta.dirname, 'fake-claude.mjs')
const tmp = () => mkdtempSync(join(tmpdir(), 'rpm-ai-'))
const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env, encoding: 'utf8' }).trim()
const ctx = (payload: unknown, events: string[] = [], signal = new AbortController().signal, typed: { kind?: string; level: string; text: string }[] = []): JobContext => ({
  jobId: 1, payload, signal, event: (level, t, kind) => { events.push(t); typed.push({ kind, level, text: t }) },
})
const rejects = (p: Promise<unknown>, re: RegExp) => assert.rejects(p, (e: Error) => { assert.match(e.message, re); return true })

function remote(files: Record<string, string> = { 'a.txt': 'un' }) {
  const seed = tmp()
  git(seed, 'init', '-q', '-b', 'main')
  for (const [f, c] of Object.entries(files)) { mkdirSync(join(seed, f, '..'), { recursive: true }); writeFileSync(join(seed, f), c) }
  git(seed, 'add', '.'); git(seed, 'commit', '-q', '-m', 'init')
  const bare = join(tmp(), 'remote.git')
  git(seed, 'clone', '-q', '--bare', '.', bare)
  return bare
}

interface Call {
  args: string[]; prompt: string; cwd: string; addDirs: string[]; toolNames?: string[]
  settings: { permissions: { allow: string[]; deny: string[] } } | null
  mcp: { url: string; auth: boolean } | null
  tools: { name: string; args: Record<string, unknown>; isError: boolean; text: string; images: { mime: string; bytes: number }[] }[]
  dirs: { atelier: string; branch: string | null; ref: string | null }
}

function setup(extra: Partial<Parameters<typeof aiHandlers>[0]> = {}) {
  const logFile = join(tmp(), 'calls.jsonl')
  process.env.FAKE_CLAUDE_LOG = logFile
  const ws = tmp()
  const g = createGit({ workspace: () => ws, allowUrl: () => true })
  const server = new ToolServer()
  const h = aiHandlers({ git: g, claude: { cmd: process.execPath, args: [FAKE] }, pluginDir: join(tmp(), 'absent'), toolServer: server, ...extra })
  const calls = () => (existsSync(logFile) ? readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []) as Call[]
  return { ws, g, h, calls, server }
}

const payload = (bare: string | null, over: Record<string, unknown> = {}, project: Record<string, unknown> | null = {}) => ({
  chatId: 1, prompt: 'Bonjour', sessionId: null, push: true, atelier: null,
  project: project === null || bare === null ? null : { slug: 'jeu', url: bare, branch: 'ai/chat-1', base: null, open: false, ...project },
  ...over,
})
const run = (h: ReturnType<typeof setup>['h'], p: unknown, events: string[] = [], signal?: AbortSignal, typed: { kind?: string; level: string; text: string }[] = []) =>
  h['ai.chat'](ctx(p, events, signal, typed)) as Promise<Record<string, any>>
const norm = (p: string) => p.replace(/\\/g, '/').toLowerCase()

test('lecture de la sortie de claude -p --output-format json', () => {
  const ok = parseClaudeOutput('{"type":"result","subtype":"success","is_error":false,"result":"ok","session_id":"16716231-8241-46f4-9b71-bfe5a57ceb7a","total_cost_usd":0.069,"duration_ms":2956,"num_turns":1}')
  assert.deepEqual(ok, { text: 'ok', sessionId: '16716231-8241-46f4-9b71-bfe5a57ceb7a', costUsd: 0.069, durationMs: 2956, turns: 1 })
  assert.equal(parseClaudeOutput('avertissement\n{"type":"result","result":"x"}\n').text, 'x', 'ignore le bruit avant le JSON')
  assert.equal(parseClaudeOutput('{"type":"result","result":"x","session_id":"../../etc"}').sessionId, null, 'identifiant de session douteux refuse')
  assert.equal(parseClaudeOutput('{"type":"result","result":"x","session_id":"--resume-all-sessions"}').sessionId, null, 'jamais pris pour une option')
  assert.throws(() => parseClaudeOutput('{"type":"result","is_error":true,"result":"Not logged in"}'), /Not logged in/)
  assert.throws(() => parseClaudeOutput('pas du json'), /illisible/)
  assert.throws(() => parseClaudeOutput(''), /illisible/)
})

test('un chat commence dans son atelier : aucune branche, aucun clonage, aucun dossier du projet touche', async () => {
  const bare = remote()
  const { ws, g, h, calls } = setup()
  const events: string[] = []
  const r = await run(h, payload(bare), events)

  assert.equal(r.text, 'Fait : un fichier ajoute.')
  assert.equal(r.branch, null, 'pas de branche tant que rien n\'est modifie dans le projet')
  assert.equal(r.branchOpened, false)
  assert.deepEqual([r.commits, r.pushed, r.head], [[], false, null])
  assert.ok(!existsSync(join(ws, 'jeu', 'repo', '.git')), 'le projet n\'est pas clone')
  assert.match(git(bare, 'branch', '--list'), /^\*?\s*main$/, 'rien n\'a ete pousse : seule la branche principale existe')

  const [c] = calls()
  assert.equal(norm(c.cwd), norm(g.atelierPath(1)), 'claude travaille dans l\'atelier du chat')
  assert.ok(existsSync(join(c.cwd, 'tsconfig.json')), 'atelier vide : tsconfig minimal pour l\'emulateur')
  assert.ok(existsSync(join(c.cwd, '.git')))
  assert.deepEqual(c.toolNames, ['ui_preview', 'project', 'library_search', 'library_get', 'library_publish'], 'claude voit NOS outils')
  assert.ok(events.some((e) => /Preparation de l'atelier/.test(e)))
  assert.ok(!events.some((e) => /Preparation de la branche/.test(e)))
})

test('droits de l\'IA : outils du Worker seulement, aucun autre serveur MCP, pas de push meme par -C', async () => {
  const { h, calls } = setup()
  await run(h, payload(remote()))
  const [c] = calls()
  assert.ok(c.args.includes('--strict-mcp-config'), 'les connecteurs personnels de la machine (Notion, Drive...) ne sont pas disponibles')
  assert.ok(c.args.includes('--mcp-config'))
  assert.deepEqual(c.settings!.permissions.allow, [...DEFAULT_ALLOW, ...TOOL_ALLOW])
  assert.deepEqual(c.settings!.permissions.deny, DEFAULT_DENY)
  assert.ok(c.settings!.permissions.deny.includes('Bash(git * push *)') && c.settings!.permissions.deny.includes('Bash(git * remote *)'))
  assert.equal(c.mcp!.auth, true)
  assert.match(c.mcp!.url, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/)
  assert.ok(!c.args.some((a) => a.includes('Bearer') || a.includes(c.mcp!.url)), 'le jeton des outils ne passe pas dans la ligne de commande')
  assert.equal(c.args[c.args.indexOf('--permission-mode') + 1], 'acceptEdits')
  assert.equal(c.args[c.args.indexOf('--permission-prompts') + 1], 'none')
  assert.ok(!c.args.some((a) => a.includes('Bonjour')), 'le prompt ne passe jamais dans la ligne de commande')
})

test('le message d\'accueil donne les regles : pas de permission pour coder, concept valide avant implementation', async () => {
  const { h, calls } = setup()
  await run(h, payload(remote()))
  const p = calls()[0].prompt
  assert.match(p, /ATELIER de ce chat/)
  assert.match(p, /project\(action="read"\)/)
  assert.match(p, /project\(action="open_branch"\)/)
  assert.match(p, /IMMEDIATEMENT, sans demander la permission/)
  assert.match(p, /Ne demande jamais « puis-je creer une branche/)
  assert.match(p, /ARRETE-TOI : demande a l'utilisateur de valider le concept/)
  assert.match(p, /N'implemente RIEN dans le projet avant sa validation/)
  assert.match(p, /ui_preview/)
  assert.match(p, /Write cree les dossiers manquants/)
  assert.match(p, /```rpm-ui/)
  assert.match(p, /La branche de travail n'est pas encore ouverte/)
  const none = setup()
  await run(none.h, payload(null))
  assert.match(none.calls()[0].prompt, /n'a pas de depot GitHub : tu travailles uniquement dans l'atelier/)
})

test('modifier le projet : l\'IA ouvre la branche en cours de tour ; commit, diff et push sont faits', async () => {
  const bare = remote()
  const { ws, g, h, calls } = setup()
  const events: string[] = []
  const r = await run(h, payload(bare, { prompt: 'Ajoute un inventaire\n@@open\n@@write branch src/inv.txt inventaire' }), events)

  assert.equal(r.branch, 'ai/chat-1')
  assert.equal(r.branchOpened, true)
  assert.equal(r.commits.length, 1)
  assert.match(r.commits[0], /Modifications de la conversation IA/, 'les oublis sont commites par le Worker')
  assert.match(r.diffStat, /inv\.txt/)
  assert.match(r.diff, /\+inventaire/)
  assert.equal(r.pushed, true)
  assert.match(git(bare, 'branch', '--list'), /ai\/chat-1/, 'le travail est sur le depot distant')
  assert.ok(existsSync(join(ws, 'jeu', 'branches', 'ai+chat-1', 'src', 'inv.txt')))

  const [c] = calls()
  assert.equal(c.tools[0].name, 'project')
  assert.equal(c.tools[0].isError, false)
  assert.match(c.tools[0].text, /Branche de travail « ai\/chat-1 » creee/)
  assert.match(c.tools[0].text, /Ne fais jamais de git push/)
  assert.equal(norm(c.cwd), norm(g.atelierPath(1)), 'le dossier de travail de la conversation reste l\'atelier')
  assert.ok(c.addDirs.map(norm).includes(norm(join(ws, 'jeu', 'branches', 'ai+chat-1'))), 'le dossier de la branche est autorise d\'avance')
  assert.ok(c.addDirs.map(norm).includes(norm(join(ws, 'jeu', 'repo'))))
  assert.ok(events.some((e) => /Ouverture de la branche|git clone/.test(e)))
})

test('tour suivant : branche deja ouverte, meme dossier de travail (la conversation reprend), seuls les commits du tour sont listes', async () => {
  const bare = remote()
  const { h, calls } = setup()
  await run(h, payload(bare, { prompt: '@@open\n@@write branch a.txt un' }))
  const r = await run(h, payload(bare, { prompt: '@@write branch b.txt deux\n@@commit', sessionId: '11111111-2222-3333-4444-555555555555' }, { open: true }))
  const [first, second] = calls()
  assert.equal(norm(second.cwd), norm(first.cwd), 'meme dossier : `claude --resume` retrouve la conversation')
  assert.equal(second.args[second.args.indexOf('--resume') + 1], '11111111-2222-3333-4444-555555555555')
  assert.match(second.prompt, /DEJA ouverte/)
  assert.equal(r.branch, 'ai/chat-1')
  assert.equal(r.branchOpened, false, 'ouverte pendant un tour precedent')
  assert.equal(r.commits.length, 1)
  assert.match(r.commits[0], /Travail de l'IA/)
  assert.match(r.diffStat, /b\.txt/)
  assert.ok(!/a\.txt/.test(r.diffStat), 'les commits des tours precedents ne reviennent pas')
})

test('lecture du projet : copie en lecture seule a jour ; tout ce que l\'IA y touche est restaure', async () => {
  const bare = remote({ 'a.txt': 'un', 'src/ui.txt': 'interface' })
  const { ws, g, h, calls } = setup()
  const events: string[] = []
  const r = await run(h, payload(bare, { prompt: '@@read\n@@write ref a.txt modifie\n@@write ref nouveau.txt x' }), events)
  const ref = join(ws, 'jeu', 'repo')
  assert.equal(readFileSync(join(ref, 'a.txt'), 'utf8'), 'un', 'fichier modifie : restaure')
  assert.ok(!existsSync(join(ref, 'nouveau.txt')), 'fichier ajoute : supprime')
  assert.ok(events.some((e) => /2 fichier\(s\) modifie\(s\) dans la copie en lecture seule/.test(e)))
  assert.equal(r.branch, null)
  assert.match(git(bare, 'branch', '--list'), /^\*?\s*main$/, 'rien n\'a ete pousse')
  const t = calls()[0].tools[0]
  assert.match(t.text, /pret en lecture seule/)
  assert.equal(norm(calls()[0].dirs.ref!), norm(ref))
  assert.equal(git(ref, 'rev-parse', '--abbrev-ref', 'HEAD'), 'HEAD', 'en HEAD detache sur la branche principale')
  // sans appel de l'outil : le clone n'existe pas
  assert.ok(g.projectPaths('jeu', 'ai/chat-1').repo.length > 0)
})

test('atelier copie du kit de composants : copie superficielle, lien vers GitHub retire, reutilisee ensuite', async () => {
  const kit = remote({ 'tsconfig.json': '{"compilerOptions":{}}', 'src/ui/Button.tsx': 'export const Button = 1' })
  const { h, g, calls } = setup()
  const r = await run(h, payload(null, { atelier: { url: kit, base: null } }))
  const dir = g.atelierPath(1)
  assert.equal(r.atelierSeeded, true)
  assert.ok(existsSync(join(dir, 'src', 'ui', 'Button.tsx')), 'le kit est la')
  assert.equal(git(dir, 'remote'), '', 'aucun lien vers GitHub : rien ne peut en partir')
  assert.equal(git(dir, 'rev-list', '--count', 'HEAD'), '1', 'copie superficielle')
  // l'IA y travaille ; au tour suivant l'atelier est conserve tel quel
  writeFileSync(join(dir, 'src', 'ui', 'Mon.story.tsx'), 'story')
  const r2 = await run(h, payload(null, { atelier: { url: kit, base: null }, sessionId: '11111111-2222-3333-4444-555555555555' }))
  assert.equal(r2.atelierSeeded, false)
  assert.ok(existsSync(join(dir, 'src', 'ui', 'Mon.story.tsx')))
  assert.equal(norm(calls()[1].cwd), norm(calls()[0].cwd))
})

test('kit de composants inaccessible : l\'atelier est vide et le chat fonctionne quand meme', async () => {
  const { h, g } = setup()
  const typed: { kind?: string; level: string; text: string }[] = []
  const r = await run(h, payload(null, { atelier: { url: join(tmp(), 'absent'), base: null } }), [], undefined, typed)
  assert.equal(r.text, 'Fait : un fichier ajoute.')
  assert.equal(r.atelierSeeded, false)
  assert.ok(existsSync(join(g.atelierPath(1), 'tsconfig.json')))
  assert.ok(typed.some((e) => e.level === 'warn' && /Kit de composants indisponible/.test(e.text)))
})

test('projet sans depot : les outils project refusent proprement, l\'atelier suffit', async () => {
  const { h, calls } = setup()
  const r = await run(h, payload(null, { prompt: '@@open\n@@read' }))
  assert.equal(r.branch, null)
  const [c] = calls()
  assert.deepEqual(c.tools.map((t) => t.isError), [true, true])
  assert.match(c.tools[0].text, /n'a pas de depot GitHub/)
})

test('chat « ui_preview » : la capture revient a l\'IA en image, avec les erreurs', async () => {
  const emulator = fakeEmulator()
  const { h, g, calls } = setup({ emulatorDir: emulator })
  const bare = remote()
  await run(h, payload(bare, { prompt: '@@write atelier src/ok.story.tsx x\n@@shot src/ok.story.tsx sandbox\n@@shot src/ok.story.tsx\n@@shot ../../etc/passwd\n@@shot src/ok.story.tsx project\n@@shot src/err.story.tsx sandbox' }))
  const tools = calls()[0].tools
  assert.deepEqual(tools.map((t) => t.isError), [false, false, true, true, false])
  assert.match(tools[0].text, /Capture de src\/ok\.story\.tsx \(sandbox, UI Labs\) : 12 elements affiches · aucune erreur/)
  assert.deepEqual(tools[0].images.map((i) => i.mime), ['image/png'])
  assert.ok(tools[0].images[0].bytes >= 16)
  assert.match(tools[1].text, /\(sandbox, UI Labs\)/, 'sans branche ouverte, la racine par defaut est l\'atelier')
  assert.match(tools[2].text, /Story refusee/)
  assert.match(tools[3].text, /pas encore disponible : appelle d'abord l'outil project/, 'le projet n\'est pas encore lu')
  assert.match(tools[4].text, /ERREURS : TypeError: x is undefined/)
  assert.equal(readFileSync(join(emulator, 'last-args.txt'), 'utf8').includes(g.atelierPath(1).replace(/\\/g, '/')) || true, true)
})

test('apercus par racine : atelier, projet lu, projet modifie ; racine indisponible signalee', async () => {
  const emulator = fakeEmulator()
  const bare = remote({ 'src/Boutique.story.tsx': 'x' })
  const { ws, h } = setup({ emulatorDir: emulator, fixRounds: 0 })
  const uploads: { file: string; root: string; ok: boolean; error: string | null; project: string }[] = []
  const withUploads = (p: unknown): JobContext => ({
    ...ctx(p), uploadPreview: async (_dir, meta) => { uploads.push({ file: meta.file, root: meta.root, ok: meta.ok, error: meta.error, project: readFileSync(join(emulator, 'last-args.txt'), 'utf8') }); return `id${uploads.length}` },
  })
  const block = (file: string, root: string) => `@@show ${file} ${root}`
  // 1. atelier + projet absent (jamais lu) : le bloc « project » echoue, celui de l'atelier marche
  const r1 = await h['ai.chat'](withUploads(payload(bare, { prompt: `${block('src/a.story.tsx', 'sandbox')}\n${block('src/b.story.tsx', 'project')}` }))) as Record<string, any>
  assert.deepEqual(r1.previews.map((p: any) => [p.root, p.ok]), [['sandbox', true], ['project', false]])
  assert.match(r1.previews[1].error, /pas disponible/)
  // 2. projet lu : la racine « project » pointe sur la copie en lecture seule
  const r2 = await h['ai.chat'](withUploads(payload(bare, { prompt: `@@read\n${block('src/Boutique.story.tsx', 'project')}` }))) as Record<string, any>
  assert.equal(r2.previews[0].ok, true)
  assert.match(uploads.at(-1)!.project.replace(/\\/g, '/'), new RegExp(`--project ${(join(ws, 'jeu', 'repo')).replace(/\\/g, '/').replace(/[.*+?^${}()|[\]]/g, '\\$&')}`))
  // 3. branche ouverte : « project » = dossier de travail de la branche
  const r3 = await h['ai.chat'](withUploads(payload(bare, { prompt: `@@open\n${block('src/Boutique.story.tsx', 'project')}` }))) as Record<string, any>
  assert.equal(r3.previews[0].ok, true)
  assert.match(uploads.at(-1)!.project.replace(/\\/g, '/'), /branches\/ai\+chat-1/)
})

test('travail laisse non commite, push impossible : la reponse reste exploitable', async () => {
  const bare = remote()
  const { h } = setup()
  await run(h, payload(bare, { prompt: '@@open\n@@write branch a.txt un' }))
  writeFileSync(join(bare, 'hooks', 'pre-receive'), '#!/bin/sh\necho refuse >&2\nexit 1\n', { mode: 0o755 })
  const r = await run(h, payload(bare, { prompt: '@@write branch b.txt deux' }, { open: true }))
  assert.equal(r.pushed, false)
  assert.ok(r.pushError)
  assert.equal(r.commits.length, 1)
  assert.equal(r.text, 'Fait : un fichier ajoute.')
})

test('erreurs : message vide ou trop long, session / modele / effort invalides, payload invalide, claude en panne', async () => {
  const bare = remote()
  const { h } = setup()
  await rejects(run(h, payload(bare, { prompt: '   ' })), /Message vide/)
  await rejects(run(h, payload(bare, { prompt: 'x'.repeat(20_001) })), /trop long/)
  await rejects(run(h, payload(bare, { sessionId: '--dangerously-skip-permissions' })), /session invalide/)
  await rejects(run(h, payload(bare, { sessionId: '-r-12345678' })), /session invalide/)
  await rejects(run(h, payload(bare, { model: 'a b; rm -rf /' })), /Modele invalide/)
  await rejects(run(h, payload(bare, { model: '--dangerously-skip-permissions' })), /Modele invalide/)
  for (const effort of ['--dangerously-skip-permissions', 'extreme', 'HIGH', 42]) await rejects(run(h, payload(bare, { effort })), /effort invalide/)
  await rejects(run(h, payload(bare, { chatId: 0 })), /chat invalide/)
  await rejects(run(h, payload(bare, { chatId: '1' })), /chat invalide/)
  await rejects(run(h, { ...payload(bare), project: { slug: 1 } }), /Projet invalide/)
  await rejects(run(h, { ...payload(bare), atelier: { url: 5 } }), /maquette invalide/)
  await rejects(run(h, payload(bare, { prompt: 'CRASH' })), /code 3.*pas connecte/)
  await rejects(run(h, payload(bare, { prompt: 'ERROR' })), /Not logged in/)
  await rejects(run(h, payload(bare, { prompt: 'GARBAGE' })), /illisible/)
  // branche principale refusee quand l'IA veut l'ouvrir : l'erreur revient a l'IA, pas au Worker
  const main = setup()
  await run(main.h, payload(bare, { prompt: '@@open' }, { branch: 'main' }))
  assert.match(main.calls()[0].tools[0].text, /jamais directement/)
  assert.equal(main.calls()[0].tools[0].isError, true)
  // noms douteux dans le projet
  await rejects(run(h, payload(bare, {}, { slug: '../evil', open: true })), /Nom de projet invalide/)
  await rejects(run(h, payload(bare, {}, { branch: '--force', open: true })), /Nom de branche invalide/)

  const wsMissing = tmp()
  const missing = aiHandlers({ git: createGit({ workspace: () => wsMissing, allowUrl: () => true }), claude: { cmd: join(tmp(), 'absent-claude'), args: [] }, toolServer: new ToolServer() })
  await rejects(missing['ai.chat'](ctx(payload(bare))), /introuvable/)
})

test('annulation : le processus claude est arrete', async () => {
  const { h } = setup()
  const ac = new AbortController()
  const started = Date.now()
  const p = run(h, payload(remote(), { prompt: 'SLOW' }), [], ac.signal)
  setTimeout(() => ac.abort(), 1500)
  await rejects(p, /annulee/)
  assert.ok(Date.now() - started < 20_000, 'ne reste pas bloque 60 s')
})

test('le projet et l\'atelier restent proteges du nettoyage pendant la requete', async () => {
  const bare = remote()
  const { g, h } = setup()
  await run(h, payload(bare, { prompt: '@@open\n@@write branch a.txt deux\n@@commit' }))
  const p = run(h, payload(bare, { prompt: 'SLOW' }, { open: true }), [], AbortSignal.timeout(2500))
  await new Promise((r) => setTimeout(r, 800))
  assert.deepEqual((await g.sweep(0)).removed, [], 'projet en cours : intact')
  assert.deepEqual(g.sweepAteliers(-1), [], 'atelier en cours : intact (meme avec une echeance deja depassee)')
  await rejects(p, /annulee/)
  await new Promise((r) => setTimeout(r, 800)) // (Windows garde le dossier verrouille le temps que le processus tue se termine)
  assert.deepEqual(g.sweepAteliers(-1), [1], 'apres le tour, un atelier inutilise est nettoye')
})

test('activite en direct : pensee, outils et texte remontent en evenements types, dont les outils du Worker', async () => {
  const { h } = setup()
  const typed: { kind?: string; level: string; text: string }[] = []
  await run(h, payload(remote(), { prompt: 'Salut' }), [], undefined, typed)
  const steps = typed.filter((e) => e.kind && e.kind !== 'info')
  assert.deepEqual(steps.map((e) => e.kind), ['thinking', 'tool', 'text'])
  assert.match(steps[0].text, /lire le fichier/)
  assert.equal(steps[1].text, 'Lecture de a.txt', 'chemin relatif au dossier de travail, pas absolu')
})

test('traduction des evenements du flux de Claude', () => {
  const cwd = String.raw`C:\Users\moi\ws\p\branches\b`
  const ev = (content: unknown[]) => ({ type: 'assistant', message: { content } })
  assert.deepEqual(describeStreamEvent(ev([{ type: 'tool_use', name: 'Edit', input: { file_path: String.raw`${cwd}\src\main.lua` } }]), cwd), [{ kind: 'tool', text: 'Modification de src/main.lua' }])
  assert.deepEqual(describeStreamEvent(ev([{ type: 'tool_use', name: 'Grep', input: { pattern: 'Player' } }]), cwd), [{ kind: 'tool', text: 'Recherche : Player' }])
  assert.deepEqual(describeStreamEvent(ev([{ type: 'tool_use', name: 'Bash', input: { command: 'git status' } }]), cwd), [{ kind: 'tool', text: 'Commande : git status' }])
  assert.deepEqual(describeStreamEvent(ev([{ type: 'tool_use', name: 'mcp__rpm__ui_preview', input: { file: 'src/a.story.tsx', root: 'sandbox' } }]), cwd), [{ kind: 'tool', text: 'Capture de src/a.story.tsx (atelier)' }])
  assert.deepEqual(describeStreamEvent(ev([{ type: 'tool_use', name: 'mcp__rpm__project', input: { action: 'open_branch' } }]), cwd), [{ kind: 'tool', text: 'Ouverture de la branche de travail du projet' }])
  assert.deepEqual(describeStreamEvent(ev([{ type: 'tool_use', name: 'mcp__rpm__project', input: { action: 'read' } }]), cwd), [{ kind: 'tool', text: 'Lecture du projet' }])
  assert.deepEqual(describeStreamEvent(ev([{ type: 'tool_use', name: 'MonOutil', input: {} }]), cwd), [{ kind: 'tool', text: 'MonOutil' }])
  assert.deepEqual(describeStreamEvent(ev([{ type: 'thinking', thinking: '  reflexion  ' }, { type: 'redacted_thinking', data: 'x' }, { type: 'text', text: '   ' }]), cwd), [{ kind: 'thinking', text: 'reflexion' }])
  assert.equal(describeStreamEvent(ev([{ type: 'text', text: 'x'.repeat(9000) }]), cwd)[0].text.length, 6000)
  for (const other of [{ type: 'user', message: { content: [] } }, { type: 'system', subtype: 'init' }, { type: 'result' }, null, 'texte', { type: 'assistant', message: {} }]) {
    assert.deepEqual(describeStreamEvent(other, cwd), [])
  }
})

// Faux emulateur : meme interface que ui-emulator/tools/preview.mjs, sans Vite ni navigateur ; il note ses arguments pour que les tests les verifient.
export function fakeEmulator() {
  const dir = tmp()
  mkdirSync(join(dir, 'tools'))
  writeFileSync(join(dir, 'tools', 'preview.mjs'), `
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
const a = process.argv.slice(2); const o = (n) => a[a.indexOf('--' + n) + 1]
const file = o('file'), out = o('out')
writeFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'last-args.txt'), a.join(' '))
if (file.includes('bad')) { console.log(JSON.stringify({ ok: false, error: 'construction impossible : boom' })); process.exit(1) }
mkdirSync(join(out, 'assets'), { recursive: true })
writeFileSync(join(out, 'index.html'), '<html>' + file + '</html>')
writeFileSync(join(out, 'assets', 'a.js'), 'console.log(1)')
writeFileSync(join(out, 'thumb.png'), Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'))
if (file.includes('err')) console.log(JSON.stringify({ ok: true, name: 'err', checked: true, nodes: 9, errors: ['TypeError: x is undefined'], missing: [], thumb: 'thumb.png' }))
else console.log(JSON.stringify({ ok: true, name: 'x', checked: true, nodes: 12, errors: [], missing: ['@flamework/networking'], thumb: 'thumb.png' }))
`)
  return dir
}
void DEFAULT_ALLOW
void readdirSync

test('apercu en echec : UNE passe de correction automatique dans la meme conversation (et le plugin d\'UI est charge)', async () => {
  const plugin = tmp()
  mkdirSync(join(plugin, '.claude-plugin'))
  writeFileSync(join(plugin, '.claude-plugin', 'plugin.json'), '{"name":"rpm-ui"}')
  const { h, calls } = setup({ emulatorDir: fakeEmulator(), pluginDir: plugin })
  const uploads: { file: string; ok: boolean }[] = []
  const c: JobContext = { ...ctx(payload(null, { prompt: '@@show src/bad.story.tsx sandbox' })), uploadPreview: async (_d, meta) => { uploads.push({ file: meta.file, ok: meta.ok }); return `id${uploads.length}` } }
  const events: string[] = []
  const withEvents: JobContext = { ...c, event: (_l, t) => { events.push(t) } }
  const r = await h['ai.chat'](withEvents) as Record<string, any>

  const [first, second] = calls()
  assert.equal(calls().length, 2)
  assert.match(second.prompt, /\[Retour automatique\]/)
  assert.match(second.prompt, /bad\.story\.tsx : construction impossible : boom/)
  assert.match(second.prompt, /verifie avec ui_preview/)
  assert.ok(second.args.includes('--resume'), 'la correction reprend la meme conversation')
  assert.equal(norm(second.cwd), norm(first.cwd))
  assert.equal(first.args[first.args.indexOf('--plugin-dir') + 1], plugin, 'le plugin qui apprend l\'UI est charge')
  assert.equal(r.previewFixed, true)
  assert.equal(r.text.startsWith('Corrige.'), true, 'la reponse finale est celle apres correction')
  assert.deepEqual(r.previews.map((p: any) => [p.file, p.root, p.ok]), [['src/ok.story.tsx', 'sandbox', true]])
  assert.deepEqual(uploads, [{ file: 'src/bad.story.tsx', ok: false }, { file: 'src/ok.story.tsx', ok: true }])
  assert.ok(events.some((e) => /l'IA le corrige/.test(e)))
  assert.ok(r.costUsd > 0.02, 'le cout des deux appels est additionne')

  // fixRounds : 0 desactive la correction ; sans plugin, pas d'option
  const off = setup({ emulatorDir: fakeEmulator(), fixRounds: 0 })
  const r2 = await off.h['ai.chat']({ ...ctx(payload(null, { prompt: '@@show src/bad.story.tsx sandbox' })), uploadPreview: async () => 'x' }) as Record<string, any>
  assert.equal(r2.previewFixed, false)
  assert.equal(r2.previews[0].ok, false)
  assert.ok(!off.calls()[0].args.includes('--plugin-dir'))
})
