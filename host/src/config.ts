import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

const env = process.env

export const config = {
  port: Number(env.PORT ?? 3000),
  host: env.HOST ?? '127.0.0.1',
  publicUrl: (env.PUBLIC_URL ?? `http://localhost:${env.PORT ?? 3000}`).replace(/\/$/, ''),
  dataDir: resolve(env.DATA_DIR ?? './data'),
  secretKey: env.HOST_SECRET_KEY,
  allowSignup: env.ALLOW_SIGNUP === 'true',
  trustProxy: env.TRUST_PROXY === 'true', // true seulement derriere un reverse proxy qui pose X-Forwarded-For
  appName: env.APP_NAME ?? 'Roblox Project Manager',
  githubToken: env.GITHUB_TOKEN,                    // jeton (fine-grained) pour creer des depots depuis un template
  githubTemplate: env.GITHUB_TEMPLATE_REPO ?? '',   // "proprietaire/depot" propose par defaut
  githubOwner: env.GITHUB_OWNER ?? '',              // compte ou organisation qui recevra les nouveaux depots (vide = le compte du jeton)
  get secureCookies() { return this.publicUrl.startsWith('https://') },
}

export function ensureDataDir() {
  mkdirSync(config.dataDir, { recursive: true })
}
