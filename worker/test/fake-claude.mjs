// Faux CLI « claude » pour les tests : lit le prompt sur stdin, agit dans le dossier courant et affiche un resultat JSON comme `claude -p --output-format json`.
import { execFileSync } from 'node:child_process'
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'

let prompt = ''
process.stdin.setEncoding('utf8')
for await (const chunk of process.stdin) prompt += chunk
const args = process.argv.slice(2)
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null }
const settingsPath = flag('--settings')
if (process.env.FAKE_CLAUDE_LOG) {
  appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ args, prompt, cwd: process.cwd(), settings: settingsPath ? JSON.parse(readFileSync(settingsPath, 'utf8')) : null }) + '\n')
}
const git = (...a) => execFileSync('git', ['-c', 'user.name=ia', '-c', 'user.email=ia@x', ...a], { encoding: 'utf8' })

if (prompt.includes('CRASH')) { process.stderr.write('boom: pas connecte'); process.exit(3) }
if (prompt.includes('SLOW')) await new Promise((r) => setTimeout(r, 60_000))
if (prompt.includes('GARBAGE')) { console.log('pas du json'); process.exit(0) }
if (prompt.includes('ERROR')) { console.log(JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'Not logged in' })); process.exit(0) }

// Flux d'evenements comme `--output-format stream-json --verbose` : init, pensee, outil, resultat d'outil, texte, puis « result ».
const emit = (o) => console.log(JSON.stringify(o))
emit({ type: 'system', subtype: 'init', session_id: flag('--resume') ?? '11111111-2222-3333-4444-555555555555' })
emit({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'Je dois d abord lire le fichier.' }] } })
emit({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: process.cwd() + '/a.txt' } }] } })
emit({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'un' }] } })
emit({ type: 'assistant', message: { content: [{ type: 'text', text: 'Je vais ajouter un fichier.' }] } })
const n = Date.now()
writeFileSync(`ia-${n}.txt`, prompt.includes('MODIFIE') ? 'v2' : 'contenu')
if (!prompt.includes('LEAVE_DIRTY')) { git('add', '.'); git('commit', '-q', '-m', 'Travail de l\'IA') }
emit({
  type: 'result', subtype: 'success', is_error: false, result: 'Fait : un fichier ajoute.',
  session_id: flag('--resume') ?? '11111111-2222-3333-4444-555555555555', total_cost_usd: 0.012, duration_ms: 42, num_turns: 3,
})
emit({ type: 'system', subtype: 'task_summary', detail: null })
