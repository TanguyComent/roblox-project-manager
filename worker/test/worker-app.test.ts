import assert from 'node:assert/strict'
import { mkdtempSync, existsSync, readFileSync, writeFileSync, statSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createAgent } from '../src/agent.ts'
import { createAutostart, type Autostart } from '../src/autostart.ts'
import { parseEnv, readConfig, writeConfig } from '../src/config.ts'
import { PAIRING_PREFIX, parsePairingCode, readPairingInput } from '../src/protocol.ts'
import { createUi } from '../src/ui.ts'
import type { RunningWorker, WorkerOptions } from '../src/worker.ts'

const TOKEN = 'rpmw_' + 'a'.repeat(43)
const code = (u = 'http://localhost:3000', t = TOKEN) => PAIRING_PREFIX + Buffer.from(JSON.stringify({ u, t })).toString('base64url')
const tmp = () => mkdtempSync(join(tmpdir(), 'rpm-worker-'))

test('.env : lecture, ecriture, conservation du reste du fichier', () => {
  assert.deepEqual(parseEnv('# c\nA=1\nB="deux"\n\nC = x=y\n'), { A: '1', B: 'deux', C: 'x=y' })
  const path = join(tmp(), '.env')
  assert.equal(readConfig(path), null)
  writeFileSync(path, '# mon fichier\nRPM_UI_PORT=4999\nRPM_HOST_URL=http://old\n')
  writeConfig({ hostUrl: 'http://localhost:3000', token: TOKEN }, path)
  assert.deepEqual(readConfig(path), { hostUrl: 'http://localhost:3000', token: TOKEN })
  const text = readFileSync(path, 'utf8')
  assert.match(text, /# mon fichier/)
  assert.match(text, /RPM_UI_PORT=4999/)
  assert.equal(text.match(/RPM_HOST_URL/g)!.length, 1)
  if (process.platform !== 'win32') assert.equal(statSync(path).mode & 0o077, 0, 'lisible par le seul proprietaire')
  writeConfig(null, path)
  assert.equal(readConfig(path), null)
  assert.match(readFileSync(path, 'utf8'), /RPM_UI_PORT=4999/)
})

test('code de jumelage : valide, et refus des entrees douteuses', () => {
  assert.deepEqual(parsePairingCode(`  ${code()}\n`), { hostUrl: 'http://localhost:3000', token: TOKEN })
  assert.equal(parsePairingCode(code('https://rpm.example.com/chemin?x=1'))!.hostUrl, 'https://rpm.example.com')
  assert.equal(parsePairingCode(''), null)
  assert.equal(parsePairingCode('rpm1.%%%'), null)
  assert.equal(parsePairingCode(TOKEN), null, "un jeton nu n'est pas un code")
  assert.equal(parsePairingCode(code('javascript:alert(1)')), null)
  assert.equal(parsePairingCode(code('ftp://host')), null)
  assert.equal(parsePairingCode(code('http://localhost:3000', 'court')), null)
  assert.equal(parsePairingCode(code('http://localhost:3000', 'rpmw_' + 'a'.repeat(5000))), null)
})

// Faux « startWorker » : enregistre ce qu'on lui demande et laisse le test piloter les etats.
function fakeLauncher() {
  const started: { opts: WorkerOptions; stopped: boolean }[] = []
  const launch = (opts: WorkerOptions): RunningWorker => {
    const rec = { opts, stopped: false }
    started.push(rec)
    return { state: 'connecting', async stop() { rec.stopped = true } }
  }
  return { started, launch }
}

test('agent : non jumele, jumelage, arret, demarrage, oubli', async () => {
  const envPath = join(tmp(), '.env')
  const f = fakeLauncher()
  const agent = createAgent({ envPath, version: 't', info: {}, launch: f.launch })
  agent.start()
  assert.equal(agent.snapshot().state, 'unconfigured')
  assert.equal(f.started.length, 0)

  assert.equal((await agent.pair('nimporte quoi')).ok, false)
  assert.equal(existsSync(envPath), false, "un code invalide n'ecrit rien")

  assert.equal((await agent.pair(code())).ok, true)
  assert.equal(f.started.length, 1)
  assert.equal(f.started[0].opts.token, TOKEN)
  assert.equal(f.started[0].opts.hostUrl, 'http://localhost:3000')
  assert.equal(agent.snapshot().state, 'connecting')
  f.started[0].opts.onState!('connected', 'Mon PC')
  assert.equal(agent.snapshot().state, 'connected')
  assert.equal(agent.snapshot().workerName, 'Mon PC')

  await agent.stop()
  assert.equal(f.started[0].stopped, true)
  assert.equal(agent.snapshot().state, 'stopped')
  f.started[0].opts.onState!('connected', 'fantome') // evenement tardif d'une ancienne connexion : ignore
  assert.equal(agent.snapshot().state, 'stopped')

  agent.start()
  assert.equal(f.started.length, 2)
  f.started[1].opts.onState!('rejected', 'jeton invalide')
  assert.equal(agent.snapshot().state, 'rejected')

  // re-jumelage : l'ancienne connexion est coupee, la nouvelle utilise le nouveau code
  const other = 'rpmw_' + 'b'.repeat(43)
  assert.equal((await agent.pair(code('http://autre:3000', other))).ok, true)
  assert.equal(f.started[2].opts.token, other)

  await agent.forget()
  assert.equal(readConfig(envPath), null)
  assert.equal(agent.snapshot().state, 'unconfigured')
  assert.ok(agent.snapshot().logs.length > 0)
})

test('demarrage automatique : fichiers par systeme, detection, desactivation', () => {
  for (const platform of ['win32', 'darwin', 'linux'] as const) {
    const home = tmp()
    const a: Autostart = createAutostart(platform, home, platform === 'win32' ? { APPDATA: join(home, 'Roaming') } : {}, '/usr/bin/node')
    assert.equal(a.supported, true)
    assert.equal(a.enabled(), false, platform)
    a.set(true)
    assert.equal(existsSync(a.where), true, platform)
    assert.equal(a.enabled(), true, platform)
    const text = readFileSync(a.where, 'utf8')
    assert.match(text, /--no-open/)
    assert.match(text, /main\.ts/)
    if (platform === 'win32') assert.match(text, /, 0, False/, 'fenetre cachee')
    writeFileSync(a.where, text + '\n# modifie')
    assert.equal(a.enabled(), false, 'fichier different (projet deplace) : a regenerer')
    a.set(false)
    assert.equal(existsSync(a.where), false, platform)
  }
  const none = createAutostart('freebsd' as NodeJS.Platform)
  assert.equal(none.supported, false)
  assert.throws(() => none.set(true))
})

// --- interface locale ---------------------------------------------------------------------------------------------------------
async function ui() {
  const envPath = join(tmp(), '.env')
  const f = fakeLauncher()
  const agent = createAgent({ envPath, version: 't', info: {}, launch: f.launch })
  const autostart = createAutostart('linux', tmp(), {}, '/usr/bin/node')
  let quit = 0
  // le port est choisi par le systeme, puis la vraie interface est lancee dessus (elle n'accepte que son propre port)
  const probe = (await import('node:net')).createServer()
  await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r))
  const port = (probe.address() as AddressInfo).port
  await new Promise((r) => probe.close(r))
  const server = createUi({ agent, autostart, port, quit: () => { quit++ } })
  await new Promise<void>((r) => server.listen(port, '127.0.0.1', r))
  const base = `http://127.0.0.1:${port}`
  const get = (path = '/', headers: Record<string, string> = {}) => fetch(base + path, { redirect: 'manual', headers })
  const csrf = async () => /name="csrf" value="([^"]+)"/.exec(await (await get()).text())![1]
  const post = (path: string, body: Record<string, string>, headers: Record<string, string> = {}) =>
    fetch(base + path, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers }, body: new URLSearchParams(body).toString() })
  return { agent, autostart, f, envPath, get, post, csrf, port, quit: () => quit, close: () => server.close() }
}

test('interface : page, jumelage, jeton jamais affiche, demarrage auto', async () => {
  const u = await ui()
  try {
    const page = await (await u.get()).text()
    assert.match(page, /Pas encore jumele/)
    assert.match(page, /Jumeler ce Worker/)

    const csrf = await u.csrf()
    const bad = await u.post('/pair', { csrf, code: 'nope' })
    assert.equal(bad.status, 303)
    assert.match(decodeURIComponent(bad.headers.get('location')!), /pas un code/)
    assert.equal(readConfig(u.envPath), null)

    const ok = await u.post('/pair', { csrf, code: code() })
    assert.equal(ok.status, 303)
    assert.deepEqual(readConfig(u.envPath), { hostUrl: 'http://localhost:3000', token: TOKEN })
    const after = await (await u.get()).text()
    assert.match(after, /Connexion/)
    assert.match(after, /http:\/\/localhost:3000/)
    assert.ok(!after.includes(TOKEN), "le jeton n'est jamais reaffiche")
    assert.ok(!after.includes('rpmw_'))

    assert.equal((await u.post('/autostart', { csrf, enabled: '1' })).status, 303)
    assert.equal(u.autostart.enabled(), true)
    assert.match(await (await u.get()).text(), /se lance tout seul/)
    await u.post('/autostart', { csrf, enabled: '0' })
    assert.equal(u.autostart.enabled(), false)

    await u.post('/stop', { csrf })
    assert.equal(u.agent.snapshot().state, 'stopped')
    await u.post('/start', { csrf })
    assert.equal(u.agent.snapshot().state, 'connecting')
    await u.post('/forget', { csrf })
    assert.equal(u.agent.snapshot().state, 'unconfigured')

    await u.post('/quit', { csrf })
    await new Promise((r) => setTimeout(r, 250))
    assert.equal(u.quit(), 1)
  } finally { u.close() }
})

test('interface : protegee contre les autres sites (CSRF, origine, DNS rebinding)', async () => {
  const u = await ui()
  try {
    const csrf = await u.csrf()
    assert.equal((await u.post('/pair', { code: code() })).status, 403, 'sans jeton')
    assert.equal((await u.post('/pair', { csrf: 'x'.repeat(csrf.length), code: code() })).status, 403, 'mauvais jeton')
    assert.equal((await u.post('/pair', { csrf, code: code() }, { origin: 'http://evil.example' })).status, 403, 'autre origine')
    assert.equal(readConfig(u.envPath), null)
    assert.equal((await u.post('/quit', { csrf: 'nope' })).status, 403)
    assert.equal(u.quit(), 0)
    assert.equal((await u.get('/secret')).status, 404)
    assert.equal((await fetch(`http://127.0.0.1:${u.port}/`, { method: 'PUT' })).status, 405)
    const h = (await u.get()).headers
    assert.match(h.get('content-security-policy')!, /default-src 'none'/)
    assert.equal(h.get('x-frame-options'), 'DENY')
  } finally { u.close() }
})

test('code de jumelage : tolere le texte autour et les retours a la ligne, explique les erreurs', () => {
  const c = code()
  const wrapped = c.replace(/(.{20})/g, '$1\n')
  assert.equal(readPairingInput(`Voici : "${wrapped}" merci`).ok, true)
  assert.equal(readPairingInput(`RPM_HOST_URL=http://localhost:3000\nRPM_WORKER_TOKEN=${TOKEN}\n`).ok, true)
  const reason = (s: string) => { const r = readPairingInput(s); return r.ok ? '' : r.reason }
  assert.match(reason(TOKEN), /jeton seul/)
  assert.match(reason('bonjour'), /pas un code/)
  assert.match(reason(c.slice(0, 20)), /incomplet|jeton|abime/)
  assert.match(reason(code('localhost:3000')), /http/)
  assert.match(reason(code('http://x', 'court')), /jeton/)
})

test('interface : Origin « null » (formulaire sans referer) accepte avec le jeton, origine illisible ou inter-sites refusee', async () => {
  const u = await ui()
  try {
    const csrf = await u.csrf()
    assert.equal((await u.post('/stop', { csrf }, { origin: 'null' })).status, 303)
    assert.equal((await u.post('/stop', { csrf }, { origin: 'pas une url' })).status, 403)
    assert.equal((await u.post('/stop', { csrf }, { 'sec-fetch-site': 'cross-site' })).status, 403)
    assert.equal((await u.post('/stop', { csrf: 'x' }, { origin: 'null' })).status, 403, 'sans le bon jeton, toujours refuse')
  } finally { u.close() }
})
