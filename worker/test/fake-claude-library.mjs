// Faux CLI `claude` pour le tri de la bibliotheque : lit le prompt (stdin), regarde inbox/ et vault/, ecrit result.json.
// FAKE_LIB_MODE : ok (defaut) | none (pas de result.json) | bad (json illisible) | odd (entrees hostiles) | crash
import { appendFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const args = process.argv.slice(2)
const chunks = []
for await (const c of process.stdin) chunks.push(c)
const prompt = Buffer.concat(chunks).toString('utf8')
const flag = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null }
const cwd = process.cwd()
const walk = (d, base = '') => (existsSync(d) ? readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name), `${base}${e.name}/`) : [`${base}${e.name}`])) : [])
const inbox = walk(join(cwd, 'inbox'))
const vault = walk(join(cwd, 'vault'))
const settings = flag('--settings') ? JSON.parse(readFileSync(flag('--settings'), 'utf8')) : null
const mcp = flag('--mcp-config') ? JSON.parse(readFileSync(flag('--mcp-config'), 'utf8')) : null
if (process.env.FAKE_LIB_LOG) appendFileSync(process.env.FAKE_LIB_LOG, JSON.stringify({ args, cwd, prompt, inbox, vault, settings, mcp, inboxBytes: inbox.map((f) => readFileSync(join(cwd, 'inbox', f)).length) }) + '\n')

const mode = process.env.FAKE_LIB_MODE ?? 'ok'
if (mode === 'crash') { process.stderr.write('boom'); process.exit(2) }
console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Je regarde les images.' }] } }))
const items = [...prompt.matchAll(/^(\d+)\. inbox\/(.+)$/gm)].map((m) => ({ n: Number(m[1]), file: m[2] }))
if (mode === 'ok') {
  writeFileSync(join(cwd, 'result.json'), JSON.stringify({ images: items.map((i) => ({ n: i.n, scope: i.n === 1 ? 'icon' : 'background', title: `image-${i.n}`, style: 'cartoon-test', style_definition: 'Contours epais.', traits: ['cartoon', 'saturee'], subject: `sujet-${i.n}`, colors: ['rouge', 'or'], description: `Description de ${i.file}`, tags: ['un', 'deux'], extra: 'x'.repeat(5000) })) }))
} else if (mode === 'bad') writeFileSync(join(cwd, 'result.json'), '{pas du json')
else if (mode === 'odd') writeFileSync(join(cwd, 'result.json'), JSON.stringify({ images: [{ n: 99, folder: 'x', title: 'x', description: 'inconnue' }, { n: 1, scope: '../../etc', title: '../evil', description: 'ok', tags: 'a,b', style_definition: 'y'.repeat(1000) }, { n: 1, folder: 'doublon', title: 'd', description: 'd' }, 'x', { n: 'un' }] }))
console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'Fini.', session_id: '11111111-2222-3333-4444-555555555555', total_cost_usd: 0.01, duration_ms: 5, num_turns: 2 }))
