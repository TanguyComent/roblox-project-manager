// Lancement : RPM_HOST_URL=http://localhost:3000 RPM_WORKER_TOKEN=rpmw_... npm start
import { hostname, platform, arch } from 'node:os'
import { startWorker } from './worker.ts'

const hostUrl = process.env.RPM_HOST_URL
const token = process.env.RPM_WORKER_TOKEN
if (!hostUrl || !token) {
  console.error('Variables manquantes : RPM_HOST_URL (adresse du Host) et RPM_WORKER_TOKEN (jeton affiche a la creation du Worker).')
  process.exit(2)
}

const log = (m: string) => console.log(`[worker ${new Date().toLocaleTimeString('fr-FR')}] ${m}`)
const worker = startWorker({
  hostUrl, token, log,
  info: { hostname: hostname(), platform: platform(), arch: arch(), node: process.version },
  onState: (s, d) => { if (s === 'rejected') process.exitCode = 1; void d },
})

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => { log('arret demande'); void worker.stop().then(() => process.exit(0)) })
}
