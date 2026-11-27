import assert from 'node:assert/strict'
import { request } from 'node:http'
import { test } from 'node:test'
import { ToolServer, text, type ToolDef } from '../src/tools.ts'

const echo: ToolDef = {
  name: 'echo', description: 'Renvoie ce qu\'on lui donne.', inputSchema: { type: 'object', properties: { msg: { type: 'string' } }, required: ['msg'] },
  async run(args) { return text(`echo: ${String(args.msg)}`) },
}
const photo: ToolDef = {
  name: 'photo', description: 'Image.', inputSchema: { type: 'object', properties: {} },
  async run() { return { content: [{ type: 'text', text: 'ok' }, { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' }] } },
}
const boom: ToolDef = { name: 'boom', description: 'Echoue.', inputSchema: { type: 'object', properties: {} }, async run() { throw new Error('casse') } }
const slow: ToolDef = {
  name: 'slow', description: 'Attend.', inputSchema: { type: 'object', properties: {} },
  run: (_a, signal) => new Promise((_res, rej) => { signal.addEventListener('abort', () => rej(new Error('interrompu'))) }),
}

async function rpc(url: string, token: string | null, body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, body: JSON.stringify(body) })
  const raw = await res.text()
  return { status: res.status, json: raw ? JSON.parse(raw) : null }
}

test('protocole : initialize, liste des outils, appel, image, erreurs', async () => {
  const server = new ToolServer()
  const ac = new AbortController()
  const s = await server.register([echo, photo, boom], ac.signal)
  try {
    assert.match(s.url, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/)
    const init = await rpc(s.url, s.token, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } } })
    assert.equal(init.json.result.protocolVersion, '2025-03-26', 'repond avec la version demandee')
    assert.deepEqual(init.json.result.serverInfo.name, 'rpm')
    assert.equal((await rpc(s.url, s.token, { jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202)
    assert.deepEqual((await rpc(s.url, s.token, { jsonrpc: '2.0', id: 2, method: 'ping' })).json.result, {})

    const list = await rpc(s.url, s.token, { jsonrpc: '2.0', id: 3, method: 'tools/list' })
    assert.deepEqual(list.json.result.tools.map((t: { name: string }) => t.name), ['echo', 'photo', 'boom'])
    assert.equal(list.json.result.tools[0].inputSchema.required[0], 'msg')

    const call = (name: string, args?: unknown) => rpc(s.url, s.token, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name, arguments: args } })
    assert.deepEqual((await call('echo', { msg: 'salut' })).json.result.content, [{ type: 'text', text: 'echo: salut' }])
    const img = (await call('photo')).json.result.content
    assert.deepEqual([img[1].type, img[1].mimeType, img[1].data], ['image', 'image/png', 'iVBORw0KGgo='])
    const failed = (await call('boom')).json.result
    assert.equal(failed.isError, true)
    assert.match(failed.content[0].text, /casse/)
    assert.equal((await call('inconnu')).json.error.code, -32602)
    assert.equal((await call('echo', ['pas', 'un', 'objet'])).json.result.content[0].text, 'echo: undefined', 'arguments non objet : traites comme vides')
    assert.equal((await rpc(s.url, s.token, { jsonrpc: '2.0', id: 5, method: 'resources/list' })).json.error.code, -32601)
  } finally { s.dispose(); server.close() }
})

test('securite : jeton obligatoire, un jeton par tache, hote verifie, methode et taille limitees', async () => {
  const server = new ToolServer()
  const a = await server.register([echo], new AbortController().signal)
  const b = await server.register([photo], new AbortController().signal)
  try {
    const body = { jsonrpc: '2.0', id: 1, method: 'tools/list' }
    assert.equal((await rpc(a.url, null, body)).status, 401, 'sans jeton')
    assert.equal((await rpc(a.url, 'faux-jeton', body)).status, 401)
    assert.equal((await rpc(a.url, a.token + 'x', body)).status, 401)
    // chaque tache ne voit que ses outils
    assert.deepEqual((await rpc(a.url, a.token, body)).json.result.tools.map((t: { name: string }) => t.name), ['echo'])
    assert.deepEqual((await rpc(b.url, b.token, body)).json.result.tools.map((t: { name: string }) => t.name), ['photo'])
    // jeton revoque a la fin de la tache
    a.dispose()
    assert.equal((await rpc(a.url, a.token, body)).status, 401)
    assert.equal((await rpc(b.url, b.token, body)).status, 200, 'l\'autre tache continue')

    // autre nom d'hote (DNS rebinding) : refuse, meme avec un bon jeton
    const port = new URL(b.url).port
    const status = await new Promise<number>((resolve) => {
      const r = request({ host: '127.0.0.1', port, path: '/mcp', method: 'POST', headers: { host: `evil.example:${port}`, authorization: `Bearer ${b.token}`, 'content-type': 'application/json' } }, (res) => { res.resume(); resolve(res.statusCode ?? 0) })
      r.end(JSON.stringify(body))
    })
    assert.equal(status, 403)
    assert.equal((await fetch(b.url, { headers: { authorization: `Bearer ${b.token}` } })).status, 405, 'GET refuse')
    assert.equal((await fetch(b.url.replace('/mcp', '/autre'), { method: 'POST', headers: { authorization: `Bearer ${b.token}` }, body: '{}' })).status, 404)
    assert.equal((await fetch(b.url, { method: 'POST', headers: { authorization: `Bearer ${b.token}` }, body: 'x'.repeat(300_000) })).status, 413)
    assert.equal((await fetch(b.url, { method: 'POST', headers: { authorization: `Bearer ${b.token}` }, body: 'pas du json' })).status, 400)
    assert.equal((await rpc(b.url, b.token, [1, 2])).status, 400, 'lot non accepte')
    assert.equal((await rpc(b.url, b.token, { jsonrpc: '2.0', id: 1 })).status, 400, 'methode absente')
  } finally { b.dispose(); server.close() }
})

test('annulation de la tache : les outils en cours sont interrompus', async () => {
  const server = new ToolServer()
  const ac = new AbortController()
  const s = await server.register([slow], ac.signal)
  try {
    setTimeout(() => ac.abort(), 150)
    const r = await rpc(s.url, s.token, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'slow', arguments: {} } })
    assert.equal(r.json.result.isError, true)
    assert.match(r.json.result.content[0].text, /interrompu/)
  } finally { s.dispose(); server.close() }
})
