// Lancement : double-clic sur start.vbs / start.cmd / start.command (ou `npm start`). Ouvre l'interface locale ; le jumelage est dans .env.
// Options : --no-open (ne pas ouvrir le navigateur : utilise par le demarrage automatique).
import { spawn } from 'node:child_process'
import { hostname, platform, arch } from 'node:os'
import { createAgent } from './agent.ts'
import { createAutostart } from './autostart.ts'
import { uiPort } from './config.ts'
import { createUi } from './ui.ts'

const VERSION = '0.2.0'
const noOpen = process.argv.includes('--no-open')
const port = uiPort()
const address = `http://127.0.0.1:${port}/`

function openBrowser(url: string) {
  const [cmd, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]]
  try { spawn(cmd, args, { stdio: 'ignore', detached: true, windowsHide: true }).on('error', () => {}).unref() } catch { /* pas de navigateur : l'adresse est affichee */ }
}

const agent = createAgent({
  version: VERSION,
  info: { hostname: hostname(), platform: platform(), arch: arch(), node: process.version },
  echo: (line) => console.log(`[worker] ${line}`),
})

let shuttingDown = false
const quit = async () => {
  if (shuttingDown) return
  shuttingDown = true
  await agent.stop()
  process.exit(0)
}

const server = createUi({ agent, autostart: createAutostart(), port, quit })
server.on('error', (e: NodeJS.ErrnoException) => {
  if (e.code === 'EADDRINUSE') {
    // Deja lance : on montre simplement l'interface existante.
    console.log(`Le Worker tourne deja : ${address}`)
    if (!noOpen) openBrowser(address)
    process.exit(0)
  }
  console.error(e)
  process.exit(1)
})
server.listen(port, '127.0.0.1', () => {
  console.log(`Interface du Worker : ${address}`)
  agent.start()
  if (!noOpen) openBrowser(address)
})

for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => void quit())
