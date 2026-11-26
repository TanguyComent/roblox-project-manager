// Configuration du Worker : fichier worker/.env (RPM_HOST_URL, RPM_WORKER_TOKEN). Relu a chaque demarrage de la connexion, donc modifiable sans relancer.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, normalize } from 'node:path'

export const WORKER_DIR = join(import.meta.dirname, '..')
export const DEFAULT_ENV_PATH = join(WORKER_DIR, '.env')

export interface WorkerConfig { hostUrl: string; token: string }

export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq < 1) continue
    let value = line.slice(eq + 1).trim()
    if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1)
    out[line.slice(0, eq).trim()] = value
  }
  return out
}

export function readConfig(path = DEFAULT_ENV_PATH): WorkerConfig | null {
  const env = existsSync(path) ? parseEnv(readFileSync(path, 'utf8')) : {}
  const hostUrl = env.RPM_HOST_URL ?? ''
  const token = env.RPM_WORKER_TOKEN ?? ''
  return hostUrl && token ? { hostUrl, token } : null
}

// Reecrit les deux cles en conservant le reste du fichier (commentaires, autres reglages).
export function writeConfig(cfg: WorkerConfig | null, path = DEFAULT_ENV_PATH) {
  const keep = (existsSync(path) ? readFileSync(path, 'utf8').split(/\r?\n/) : []).filter((l) => !/^\s*RPM_(HOST_URL|WORKER_TOKEN)\s*=/.test(l))
  while (keep.length && keep[keep.length - 1].trim() === '') keep.pop()
  const lines = cfg ? [...keep, `RPM_HOST_URL=${cfg.hostUrl}`, `RPM_WORKER_TOKEN=${cfg.token}`] : keep
  writeFileSync(path, lines.join('\n') + '\n', { mode: 0o600 })
  try { chmodSync(path, 0o600) } catch { /* Windows : sans effet */ }
}

/** Port de l'interface locale (RPM_UI_PORT dans le .env ou l'environnement). */
export function uiPort(path = DEFAULT_ENV_PATH): number {
  const env = existsSync(path) ? parseEnv(readFileSync(path, 'utf8')) : {}
  const n = Number(env.RPM_UI_PORT ?? process.env.RPM_UI_PORT ?? 4180)
  return Number.isInteger(n) && n >= 1024 && n <= 65535 ? n : 4180
}

/** Espace de travail : dossier ou les depots git sont clones (RPM_WORKSPACE_DIR). Relu a chaque tache. */
export function readWorkspace(path = DEFAULT_ENV_PATH): string | null {
  const env = existsSync(path) ? parseEnv(readFileSync(path, 'utf8')) : {}
  const dir = env.RPM_WORKSPACE_DIR ?? process.env.RPM_WORKSPACE_DIR ?? ''
  return dir && isAbsolute(dir) ? dir : null
}

export function workspaceProblem(dir: string): string | null {
  if (!dir.trim()) return null // vide = non configure
  if (/[\r\n]/.test(dir)) return 'Chemin invalide.'
  if (!isAbsolute(dir)) return 'Donne un chemin complet (par exemple C:/Users/toi/RPM-Workspace).'
  const n = normalize(dir).replace(/[\\/]+$/, '')
  if (n === '' || /^[A-Za-z]:$/.test(n) || n === homedir()) return 'Choisis un dossier dedie (pas la racine du disque ni ton dossier personnel).'
  return null
}

/** Enregistre (ou retire, si vide) l'espace de travail dans .env et cree le dossier. Le reste du fichier est conserve. */
export function writeWorkspace(dir: string | null, path = DEFAULT_ENV_PATH) {
  const keep = (existsSync(path) ? readFileSync(path, 'utf8').split(/\r?\n/) : []).filter((l) => !/^\s*RPM_WORKSPACE_DIR\s*=/.test(l))
  while (keep.length && keep[keep.length - 1].trim() === '') keep.pop()
  if (dir) { mkdirSync(dir, { recursive: true }); keep.push(`RPM_WORKSPACE_DIR=${dir}`) }
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, keep.join('\n') + '\n', { mode: 0o600 })
}
