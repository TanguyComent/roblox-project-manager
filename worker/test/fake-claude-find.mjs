// Faux CLI `claude` pour la recherche par description : appelle library_search / library_get par le protocole MCP (comme le vrai), puis ecrit result.json.
// FAKE_FIND_MODE : ok (defaut) | none (pas de result.json) | bad (json illisible) | odd (entrees hostiles) | crash
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const args = process.argv.slice(2)
const chunks = []
for await (const c of process.stdin) chunks.push(c)
const prompt = Buffer.concat(chunks).toString('utf8')
const flag = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null }
const mcp = JSON.parse(readFileSync(flag('--mcp-config'), 'utf8')).mcpServers.rpm
const settings = JSON.parse(readFileSync(flag('--settings'), 'utf8'))
const mode = process.env.FAKE_FIND_MODE ?? 'ok'
const log = { args, prompt, cwd: process.cwd(), settings, mcpKeys: Object.keys(JSON.parse(readFileSync(flag('--mcp-config'), 'utf8')).mcpServers), tools: [] }
const flush = () => { if (process.env.FAKE_FIND_LOG) appendFileSync(process.env.FAKE_FIND_LOG, JSON.stringify(log) + '\n') }
if (mode === 'crash') { flush(); process.stderr.write('boom'); process.exit(2) }

let rid = 0
const rpc = async (method, params) => (await fetch(mcp.url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: mcp.headers.Authorization }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rid, method, params }) })).json()
await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake-claude-find', version: '1' } })
log.toolNames = (await rpc('tools/list', {})).result.tools.map((t) => t.name)
const call = async (name, a) => {
  const r = (await rpc('tools/call', { name, arguments: a })).result
  const text = r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n')
  log.tools.push({ name, args: a, isError: !!r.isError, text, images: r.content.filter((c) => c.type === 'image').length })
  return text
}

console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Je cherche.' }] } }))
const query = /«\s*([^»]+?)\s*»/.exec(prompt)?.[1] ?? ''
const found = await call('library_search', { query })
const ids = [...found.matchAll(/\[id ([0-9a-f]{32})\]/g)].map((m) => m[1])
if (ids[0]) await call('library_get', { id: ids[0] })
flush()
const out = join(process.cwd(), 'result.json')
if (mode === 'ok') writeFileSync(out, JSON.stringify({ matches: ids.slice(0, 2).map((id) => ({ id, why: `Correspond a « ${query} »` })) }))
else if (mode === 'bad') writeFileSync(out, '{pas du json')
else if (mode === 'odd') writeFileSync(out, JSON.stringify({ matches: [{ id: 'f'.repeat(32), why: 'x'.repeat(1000) }, { id: ids[0] ?? 'a'.repeat(32), why: 'bon' }, { id: ids[0] ?? 'a'.repeat(32), why: 'doublon' }, { id: '../../etc', why: 'chemin' }, 'x', { id: 5 }, ...Array.from({ length: 30 }, (_, i) => ({ id: String(i).padStart(32, 'b'), why: 'trop' }))] }))
console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'Fini.', session_id: '11111111-2222-3333-4444-555555555555', total_cost_usd: 0.02, duration_ms: 5, num_turns: 3 }))
