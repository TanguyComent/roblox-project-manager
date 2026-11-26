import assert from 'node:assert/strict'
import { test } from 'node:test'
import { detectCapabilities, TOOLS, type Deps } from '../src/capabilities.ts'
import { createAgent } from '../src/agent.ts'
import type { Capability } from '../src/protocol.ts'
import type { RunningWorker, WorkerOptions } from '../src/worker.ts'

function deps(over: Partial<Deps> & { answers?: Record<string, string> } = {}): Deps & { ran: string[] } {
  const ran: string[] = []
  const answers = over.answers ?? {}
  return {
    platform: 'win32', env: { ProgramFiles: 'C:\\PF', LOCALAPPDATA: 'C:\\Local' },
    run: async (c) => { ran.push(c); return answers[c] ?? null },
    listDir: () => [], exists: () => false, ...over, ran,
  }
}

test('outils sur le PATH : presence et version', async () => {
  const d = deps({ answers: {
    'git --version': 'git version 2.43.0.windows.1', 'claude --version': '2.0.5 (Claude Code)', 'codex --version': 'codex-cli 0.5.1',
  } })
  const caps = await detectCapabilities(d)
  assert.deepEqual(caps.map((c) => [c.id, c.version]), [['git', '2.43.0'], ['claude', '2.0.5'], ['codex', '0.5.1']])
  assert.ok(!caps.some((c) => c.id === 'blender' || c.id === 'gemini'), 'ce qui est absent n\'est pas declare')
})

test('Blender et Studio hors PATH : installations classiques', async () => {
  const win = deps({
    listDir: (dir) => (dir.endsWith('Blender Foundation') ? ['Blender 4.1', 'Blender 4.2', 'autre'] : dir.endsWith('Versions') ? ['version-a1', 'version-b2'] : []),
    exists: (p) => /Blender 4\.2.*blender\.exe$/.test(p) || /version-b2.*RobloxStudioBeta\.exe$/.test(p),
    answers: { '"C:\\PF\\Blender Foundation\\Blender 4.2\\blender.exe" --version': 'Blender 4.2.0\n\tbuild date' },
  })
  const caps = await detectCapabilities(win)
  assert.deepEqual(caps.find((c) => c.id === 'blender'), { id: 'blender', label: 'Blender', version: '4.2.0' })
  assert.deepEqual(caps.find((c) => c.id === 'studio'), { id: 'studio', label: 'Roblox Studio', version: null })

  const mac = deps({ platform: 'darwin', exists: (p) => p === '/Applications/RobloxStudio.app' })
  assert.deepEqual((await detectCapabilities(mac)).map((c) => c.id), ['studio'])
})

test('une commande muette ou un dossier illisible ne casse pas la detection', async () => {
  const d = deps({ answers: { 'git --version': ' ' }, listDir: () => { throw new Error('acces refuse') } })
  const caps = await detectCapabilities(d)
  assert.deepEqual(caps, [{ id: 'git', label: 'Git', version: null }])
})

test('seules des commandes constantes sont executees', () => {
  for (const t of TOOLS) for (const c of t.commands ?? []) assert.match(c, /^[a-z]+ --version$/)
})

test('agent : detection, journal, et prevenir le Host sans reconnexion', async () => {
  const sent: Capability[][] = []
  const launched: WorkerOptions[] = []
  const launch = (opts: WorkerOptions): RunningWorker => { launched.push(opts); return { state: 'connecting', setCapabilities: (c) => { sent.push(c) }, async stop() {} } }
  let result: Capability[] = [{ id: 'git', label: 'Git', version: '2.43.0' }]
  const { mkdtempSync, writeFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { tmpdir } = await import('node:os')
  const envPath = join(mkdtempSync(join(tmpdir(), 'rpm-cap-')), '.env')
  writeFileSync(envPath, 'RPM_HOST_URL=http://localhost:3000\nRPM_WORKER_TOKEN=rpmw_' + 'a'.repeat(43) + '\n')
  const agent = createAgent({ envPath, version: 't', info: {}, launch, detect: async () => result })
  agent.start()
  assert.deepEqual(launched[0].getCapabilities!(), [], 'rien avant la premiere detection')
  await agent.rescan()
  assert.deepEqual(agent.snapshot().capabilities, result)
  assert.deepEqual(sent.at(-1), result)
  assert.deepEqual(launched[0].getCapabilities!(), result, 'le hello suivant (reconnexion) portera les outils')
  assert.ok(agent.snapshot().logs.some((l) => /outils detectes : Git 2\.43\.0/.test(l)))
  const before = agent.snapshot().logs.length
  await agent.rescan()
  assert.equal(agent.snapshot().logs.length, before, 'pas de bruit si rien n\'a change')
  result = [...result, { id: 'claude', label: 'Claude Code', version: '2.0.5' }]
  await agent.rescan()
  assert.deepEqual(sent.at(-1), result)
})
