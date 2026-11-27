// Faux CLI « claude » pour les tests : lit le prompt sur stdin, se connecte au serveur d'outils du Worker (--mcp-config, comme le vrai) et execute les consignes
// « @@... » du message de l'utilisateur, puis affiche un flux d'evenements JSON comme `claude -p --output-format stream-json`.
//
//   @@open                       appelle l'outil project(open_branch)
//   @@read                       appelle l'outil project(read)
//   @@shot <story> [root]        appelle l'outil ui_preview
//   @@write <ou> <chemin> <txt>  ecrit un fichier (ou : atelier | branch | ref | <dossier absolu>)
//   @@commit                     git add / git commit dans le dossier de la branche
//   @@show <story> [root]        ajoute un bloc rpm-ui a la reponse
// Mots-cles : CRASH, SLOW, GARBAGE, ERROR (comme avant), MODIFIE (contenu du fichier d'essai).
import { execFileSync } from 'node:child_process'
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'

let prompt = ''
process.stdin.setEncoding('utf8')
for await (const chunk of process.stdin) prompt += chunk
const args = process.argv.slice(2)
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null }
const flags = (name) => args.flatMap((a, i) => (a === name ? [args[i + 1]] : []))
const settingsPath = flag('--settings')
const mcpPath = flag('--mcp-config')
const mcp = mcpPath ? JSON.parse(readFileSync(mcpPath, 'utf8')).mcpServers?.rpm : null
const entry = { args, prompt, cwd: process.cwd(), addDirs: flags('--add-dir'), settings: settingsPath ? JSON.parse(readFileSync(settingsPath, 'utf8')) : null, mcp: mcp ? { url: mcp.url, auth: !!mcp.headers?.Authorization } : null, tools: [], events: [] }
const flush = () => { if (process.env.FAKE_CLAUDE_LOG) appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify(entry) + '\n') }

const emit = (o) => console.log(JSON.stringify(o))
const git = (cwd, ...a) => execFileSync('git', ['-C', cwd, '-c', 'user.name=ia', '-c', 'user.email=ia@x', ...a], { encoding: 'utf8' })

const user = prompt.split('[Demande]\n').pop() ?? ''
if (user.includes('CRASH')) { flush(); process.stderr.write('boom: pas connecte'); process.exit(3) }
if (user.includes('SLOW')) await new Promise((r) => setTimeout(r, 60_000))
if (user.includes('GARBAGE')) { flush(); console.log('pas du json'); process.exit(0) }
if (user.includes('ERROR')) { flush(); console.log(JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'Not logged in' })); process.exit(0) }

emit({ type: 'system', subtype: 'init', session_id: flag('--resume') ?? '11111111-2222-3333-4444-555555555555' })
emit({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'Je dois d abord lire le fichier.' }] } })
emit({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: process.cwd() + '/a.txt' } }] } })
emit({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'un' }] } })
emit({ type: 'assistant', message: { content: [{ type: 'text', text: 'Je vais ajouter un fichier.' }] } })

// --- les outils du Worker, par le protocole MCP (HTTP) ---------------------------------------------------------------------------------------
let rid = 0
const rpc = async (method, params) => {
  const res = await fetch(mcp.url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: mcp.headers.Authorization }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rid, method, params }) })
  return res.json()
}
const call = async (name, a) => {
  const r = (await rpc('tools/call', { name, arguments: a })).result
  entry.tools.push({ name, args: a, isError: !!r.isError, text: r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n'), images: r.content.filter((c) => c.type === 'image').map((c) => ({ mime: c.mimeType, bytes: Buffer.from(c.data, 'base64').length })) })
  return entry.tools.at(-1)
}
if (mcp) {
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake-claude', version: '1' } })
  entry.toolNames = (await rpc('tools/list', {})).result.tools.map((t) => t.name)
}

const dirs = { atelier: process.cwd(), branch: /DEJA ouverte : (.+)/.exec(prompt)?.[1]?.trim() ?? null, ref: null }
const blocks = []
const show = (file, root = 'project') => '\n\n```rpm-ui\n' + JSON.stringify({ file, root, viewport: 'Telephone', title: 'Essai' }) + '\n```'
for (const raw of user.split('\n')) {
  const m = /^@@(\w+)\s*(.*)$/.exec(raw.trim())
  if (!m) continue
  const [, cmd, rest] = m
  const parts = rest.split(' ')
  if (cmd === 'open') { const t = await call('project', { action: 'open_branch' }); dirs.branch = /: (.+)\n/.exec(t.text + '\n')?.[1]?.trim() ?? dirs.branch }
  else if (cmd === 'read') { const t = await call('project', { action: 'read' }); dirs.ref = /: (.+)\n/.exec(t.text)?.[1]?.trim() ?? null }
  else if (cmd === 'shot') await call('ui_preview', { file: parts[0], ...(parts[1] ? { root: parts[1] } : {}) })
  else if (cmd === 'write') {
    const base = parts[0] === 'atelier' ? dirs.atelier : parts[0] === 'branch' ? dirs.branch : parts[0] === 'ref' ? dirs.ref : parts[0]
    const target = isAbsolute(parts[1]) ? parts[1] : join(base, parts[1])
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, parts.slice(2).join(' ') || 'contenu')
  } else if (cmd === 'commit') { git(dirs.branch, 'add', '-A'); git(dirs.branch, 'commit', '-q', '-m', 'Travail de l\'IA') }
  else if (cmd === 'show') blocks.push(show(parts[0], parts[1]))
}
entry.dirs = dirs

// Retour automatique : une story qui marche.
let text = 'Fait : un fichier ajoute.'
if (prompt.includes('[Retour automatique]')) text = 'Corrige.' + show('src/ok.story.tsx', 'sandbox')
else text += blocks.join('')
if (user.includes('MODIFIE')) text += ' (v2)'
flush()
emit({
  type: 'result', subtype: 'success', is_error: false, result: text,
  session_id: flag('--resume') ?? '11111111-2222-3333-4444-555555555555', total_cost_usd: 0.012, duration_ms: 42, num_turns: 3,
})
emit({ type: 'system', subtype: 'task_summary', detail: null })
