import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { aiHandlers, DEFAULT_ALLOW, DEFAULT_DENY, parseClaudeOutput } from '../src/ai.ts'
import { createGit } from '../src/git.ts'
import type { JobContext } from '../src/jobs.ts'

const FAKE = join(import.meta.dirname, 'fake-claude.mjs')
const tmp = () => mkdtempSync(join(tmpdir(), 'rpm-ai-'))
const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env, encoding: 'utf8' }).trim()
const ctx = (payload: unknown, events: string[] = [], signal = new AbortController().signal): JobContext => ({ jobId: 1, payload, signal, event: (_l, t) => { events.push(t) } })
const rejects = (p: Promise<unknown>, re: RegExp) => assert.rejects(p, (e: Error) => { assert.match(e.message, re); return true })

function remote() {
  const seed = tmp()
  git(seed, 'init', '-q', '-b', 'main')
  writeFileSync(join(seed, 'a.txt'), 'un'); git(seed, 'add', '.'); git(seed, 'commit', '-q', '-m', 'init')
  const bare = join(tmp(), 'remote.git')
  git(seed, 'clone', '-q', '--bare', '.', bare)
  return bare
}

function setup() {
  const logFile = join(tmp(), 'calls.jsonl')
  process.env.FAKE_CLAUDE_LOG = logFile
  const g = createGit({ workspace: () => ws, allowUrl: () => true })
  const ws = tmp()
  const h = aiHandlers({ git: g, claude: { cmd: process.execPath, args: [FAKE] } })
  const calls = () => (existsSync(logFile) ? readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []) as {
    args: string[]; prompt: string; cwd: string; settings: { permissions: { allow: string[]; deny: string[] } } | null
  }[]
  return { ws, g, h, calls }
}

const chat = (bare: string, over: Record<string, unknown> = {}) => ({ project: 'jeu', url: bare, branch: 'ai/chat-1', prompt: 'Ajoute un fichier', ...over })

test('lecture de la sortie de claude -p --output-format json', () => {
  const ok = parseClaudeOutput('{"type":"result","subtype":"success","is_error":false,"result":"ok","session_id":"16716231-8241-46f4-9b71-bfe5a57ceb7a","total_cost_usd":0.069,"duration_ms":2956,"num_turns":1}')
  assert.deepEqual(ok, { text: 'ok', sessionId: '16716231-8241-46f4-9b71-bfe5a57ceb7a', costUsd: 0.069, durationMs: 2956, turns: 1 })
  assert.equal(parseClaudeOutput('avertissement\n{"type":"result","result":"x"}\n').text, 'x', 'ignore le bruit avant le JSON')
  assert.equal(parseClaudeOutput('{"type":"result","result":"x","session_id":"../../etc"}').sessionId, null, 'identifiant de session douteux refuse')
  assert.equal(parseClaudeOutput('{"type":"result","result":"x","session_id":"--resume-all-sessions"}').sessionId, null, "jamais pris pour une option")
  assert.throws(() => parseClaudeOutput('{"type":"result","is_error":true,"result":"Not logged in"}'), /Not logged in/)
  assert.throws(() => parseClaudeOutput('pas du json'), /illisible/)
  assert.throws(() => parseClaudeOutput(''), /illisible/)
})

test('requete IA : prepare la branche, lance claude dessus avec des droits limites, renvoie reponse, commits et diff, pousse', async () => {
  const bare = remote()
  const { ws, h, calls } = setup()
  const events: string[] = []
  const r = await h['ai.chat'](ctx(chat(bare), events)) as Record<string, any>

  assert.equal(r.text, 'Fait : un fichier ajoute.')
  assert.equal(r.sessionId, '11111111-2222-3333-4444-555555555555')
  assert.equal(r.newBranch, true)
  assert.equal(r.commits.length, 1)
  assert.match(r.commits[0], /Travail de l'IA/)
  assert.match(r.diffStat, /ia-\d+\.txt/)
  assert.match(r.diff, /\+contenu/)
  assert.equal(r.leftoverFiles, 0)
  assert.equal(r.pushed, true)
  assert.match(git(bare, 'branch', '--list'), /ai\/chat-1/, 'le travail est sur le depot distant')

  const [call] = calls()
  assert.equal(call.cwd.replace(/\\/g, '/').toLowerCase(), join(ws, 'jeu', 'branches', 'ai+chat-1').replace(/\\/g, '/').toLowerCase(), 'claude travaille dans le dossier de la branche')
  assert.ok(call.args.includes('-p') && call.args.includes('json'))
  assert.equal(call.args[call.args.indexOf('--permission-mode') + 1], 'acceptEdits')
  assert.equal(call.args[call.args.indexOf('--permission-prompts') + 1], 'none')
  assert.ok(!call.args.includes('--resume'))
  assert.ok(!call.args.some((a) => a.includes('Ajoute un fichier')), 'le prompt ne passe jamais dans la ligne de commande')
  assert.match(call.prompt, /Ajoute un fichier/)
  assert.match(call.prompt, /branche « ai\/chat-1 »/)
  assert.deepEqual(call.settings!.permissions, { allow: DEFAULT_ALLOW, deny: DEFAULT_DENY })
  assert.ok(call.settings!.permissions.deny.includes('Bash(git push *)'))
  assert.ok(events.some((e) => /Claude demarre/.test(e)))
})

test('deuxieme message : conversation reprise (--resume), meme dossier, pas de nouveau clone', async () => {
  const bare = remote()
  const { h, calls } = setup()
  await h['ai.chat'](ctx(chat(bare)))
  const r = await h['ai.chat'](ctx(chat(bare, { prompt: 'Et maintenant MODIFIE', sessionId: '11111111-2222-3333-4444-555555555555', model: 'sonnet' }))) as Record<string, any>
  const second = calls()[1]
  assert.equal(second.args[second.args.indexOf('--resume') + 1], '11111111-2222-3333-4444-555555555555')
  assert.equal(second.args[second.args.indexOf('--model') + 1], 'sonnet')
  assert.equal(r.newBranch, false)
  assert.equal(r.commits.length, 1, 'seuls les commits de CE message sont listes')
  assert.equal(r.pushed, true)
})

test('travail laisse non commite : le Worker le commite pour ne rien perdre', async () => {
  const bare = remote()
  const { h } = setup()
  const r = await h['ai.chat'](ctx(chat(bare, { prompt: 'LEAVE_DIRTY' }))) as Record<string, any>
  assert.equal(r.commits.length, 1)
  assert.match(r.commits[0], /non commitees par l'IA/)
  assert.equal(r.leftoverFiles, 0)
  assert.equal(r.pushed, true)
})

test('un push impossible ne fait pas echouer la reponse', async () => {
  const bare = remote()
  const { h } = setup()
  await h['ai.chat'](ctx(chat(bare)))
  // le depot distant refuse desormais tout push : la reponse de l'IA reste exploitable
  writeFileSync(join(bare, 'hooks', 'pre-receive'), '#!/bin/sh\necho refuse >&2\nexit 1\n', { mode: 0o755 })
  const r = await h['ai.chat'](ctx(chat(bare, { prompt: 'encore', push: true }))) as Record<string, any>
  assert.equal(r.pushed, false)
  assert.ok(r.pushError)
  assert.equal(r.text, 'Fait : un fichier ajoute.')
})

test('erreurs : message vide ou trop long, session / modele invalides, branche principale, claude en panne', async () => {
  const bare = remote()
  const { h } = setup()
  await rejects(h['ai.chat'](ctx(chat(bare, { prompt: '   ' }))), /Message vide/)
  await rejects(h['ai.chat'](ctx(chat(bare, { prompt: 'x'.repeat(20_001) }))), /trop long/)
  await rejects(h['ai.chat'](ctx(chat(bare, { sessionId: '--dangerously-skip-permissions' }))), /session invalide/)
  await rejects(h['ai.chat'](ctx(chat(bare, { sessionId: '-r-12345678' }))), /session invalide/)
  await rejects(h['ai.chat'](ctx(chat(bare, { model: 'a b; rm -rf /' }))), /Modele invalide/)
  await rejects(h['ai.chat'](ctx(chat(bare, { model: '--dangerously-skip-permissions' }))), /Modele invalide/)
  await rejects(h['ai.chat'](ctx(chat(bare, { branch: 'main' }))), /jamais directement/)
  await rejects(h['ai.chat'](ctx(chat(bare, { prompt: 'CRASH' }))), /code 3.*pas connecte/)
  await rejects(h['ai.chat'](ctx(chat(bare, { prompt: 'ERROR' }))), /Not logged in/)
  await rejects(h['ai.chat'](ctx(chat(bare, { prompt: 'GARBAGE' }))), /illisible/)

  const wsMissing = tmp()
  const missing = aiHandlers({ git: createGit({ workspace: () => wsMissing, allowUrl: () => true }), claude: { cmd: join(tmp(), 'absent-claude'), args: [] } })
  await rejects(missing['ai.chat'](ctx(chat(bare))), /introuvable/)
})

test('annulation : le processus claude est arrete', async () => {
  const bare = remote()
  const { h } = setup()
  const ac = new AbortController()
  const started = Date.now()
  const p = h['ai.chat'](ctx(chat(bare, { prompt: 'SLOW' }), [], ac.signal))
  setTimeout(() => ac.abort(), 1500)
  await rejects(p, /annulee/)
  assert.ok(Date.now() - started < 20_000, 'ne reste pas bloque 60 s')
})

test('le projet reste protege du nettoyage pendant la requete', async () => {
  const bare = remote()
  const { g, h } = setup()
  await h['ai.chat'](ctx(chat(bare)))
  const p = h['ai.chat'](ctx(chat(bare, { prompt: 'SLOW' }), [], AbortSignal.timeout(2500)))
  await new Promise((r) => setTimeout(r, 800))
  const swept = await g.sweep(0) // « tout est vieux » : le projet en cours ne doit pas etre touche
  assert.deepEqual(swept.removed, [])
  await rejects(p, /annulee/)
})
