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
  // Depot de maquette par defaut (proprietaire/depot) pour les utilisateurs qui n'en ont pas choisi dans Compte > GitHub. Aucun par defaut.
  uiTemplateRepo: env.UI_TEMPLATE_REPO || null,
  // Fichiers joints aux messages (voir attachments.ts) : par fichier, par message, et total par utilisateur.
  attach: {
    maxFile: Number(env.ATTACH_MAX_FILE_MB ?? 20) * 1048576,
    maxPerMessage: Number(env.ATTACH_MAX_PER_MESSAGE ?? 10),
    maxMessage: Number(env.ATTACH_MAX_MESSAGE_MB ?? 50) * 1048576,
    userQuota: Number(env.ATTACH_USER_QUOTA_MB ?? 1024) * 1048576,
  },
  get secureCookies() { return this.publicUrl.startsWith('https://') },
}

export function ensureDataDir() {
  mkdirSync(config.dataDir, { recursive: true })
}
