// Detection de ce a quoi ce Worker a acces (Claude Code, Codex, Blender, git, Roblox Studio...), communiquee au Host.
// On ne verifie que la PRESENCE de l'outil (et sa version) : pas de connexion/compte, pas de chemin ni de nom d'utilisateur envoyes.
import { exec } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { WORKER_DIR } from './config.ts'
import type { Capability } from './protocol.ts'

export type Runner = (command: string) => Promise<string | null>
export interface Deps {
  platform: NodeJS.Platform
  env: NodeJS.ProcessEnv
  run: Runner
  /** Dossiers a explorer pour trouver un executable hors du PATH. */
  listDir: (dir: string) => string[]
  exists: (path: string) => boolean
}

interface Tool {
  id: string
  label: string
  /** Commandes essayees dans l'ordre (sur le PATH) ; la premiere qui repond gagne. */
  commands?: string[]
  /** Chemins d'executables hors PATH (installations classiques). Executes avec --version si `version` est vrai, sinon simple presence. */
  files?: (d: Deps) => string[]
  version?: boolean
}

const q = (p: string) => `"${p.replace(/"/g, '')}"`

const children = (d: Deps, dir: string) => { try { return d.listDir(dir) } catch { return [] } }

// Emplacements habituels d'un outil en ligne de commande installe hors PATH (npm global, installeur natif).
const cliFiles = (name: string) => (d: Deps): string[] => {
  const home = d.env.USERPROFILE ?? d.env.HOME ?? ''
  if (d.platform === 'win32') {
    return [join(d.env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'npm', `${name}.cmd`), join(home, '.local', 'bin', `${name}.exe`), join(home, '.claude', 'local', `${name}.exe`)]
  }
  return [join(home, '.local', 'bin', name), join(home, '.npm-global', 'bin', name), join(home, '.claude', 'local', name), `/opt/homebrew/bin/${name}`, `/usr/local/bin/${name}`]
}

// Chaque entree est une constante : aucune valeur venant du reseau n'entre dans une commande.
export const TOOLS: Tool[] = [
  { id: 'git', label: 'Git', commands: ['git --version'] },
  { id: 'claude', label: 'Claude Code', commands: ['claude --version'], files: cliFiles('claude'), version: true },
  { id: 'codex', label: 'Codex (OpenAI)', commands: ['codex --version'], files: cliFiles('codex'), version: true },
  { id: 'gemini', label: 'Gemini CLI', commands: ['gemini --version'], files: cliFiles('gemini'), version: true },
  {
    id: 'blender', label: 'Blender', commands: ['blender --version'], version: true,
    files: (d) => {
      if (d.platform === 'win32') {
        const base = join(d.env.ProgramFiles ?? 'C:\\Program Files', 'Blender Foundation')
        const steam = join(d.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Steam', 'steamapps', 'common', 'Blender', 'blender.exe')
        return [...children(d, base).filter((n) => /^Blender/i.test(n)).sort().reverse().map((n) => join(base, n, 'blender.exe')), steam]
      }
      if (d.platform === 'darwin') return ['/Applications/Blender.app/Contents/MacOS/Blender']
      return ['/usr/bin/blender', '/snap/bin/blender', '/var/lib/flatpak/exports/bin/org.blender.Blender']
    },
  },
  // Apercus d'interface : l'emulateur d'UI du depot est installe (npm ci dans ui-emulator) et un navigateur sans fenetre permet de le controler.
  { id: 'ui-preview', label: 'Apercus UI', files: () => [join(WORKER_DIR, '..', 'ui-emulator', 'node_modules', 'vite', 'package.json')] },
  {
    id: 'studio', label: 'Roblox Studio',
    files: (d) => {
      if (d.platform === 'win32') {
        const base = join(d.env.LOCALAPPDATA ?? '', 'Roblox', 'Versions')
        return children(d, base).sort().reverse().map((n) => join(base, n, 'RobloxStudioBeta.exe'))
      }
      if (d.platform === 'darwin') return ['/Applications/RobloxStudio.app']
      return []
    },
  },
]

const parseVersion = (out: string) => /\d+(?:\.\d+)+/.exec(out.split(/\r?\n/)[0] ?? '')?.[0] ?? /\d+(?:\.\d+)+/.exec(out)?.[0] ?? null

async function detectOne(t: Tool, d: Deps): Promise<Capability | null> {
  for (const c of t.commands ?? []) {
    const out = await d.run(c)
    if (out !== null) return { id: t.id, label: t.label, version: parseVersion(out) }
  }
  for (const f of t.files?.(d) ?? []) {
    if (!d.exists(f)) continue
    if (t.version) {
      const out = await d.run(`${q(f)} --version`)
      if (out !== null) return { id: t.id, label: t.label, version: parseVersion(out) }
    } else return { id: t.id, label: t.label, version: null }
  }
  return null
}

export const defaultRunner: Runner = (command) => new Promise((resolve) => {
  try {
    exec(command, { timeout: 8000, windowsHide: true, maxBuffer: 64 * 1024 }, (err, stdout) => resolve(err ? null : String(stdout).trim() || ' '))
  } catch { resolve(null) }
})

export const defaultDeps = (): Deps => ({
  platform: process.platform, env: process.env, run: defaultRunner,
  listDir: (dir) => readdirSync(dir), exists: (p) => existsSync(p),
})

export async function detectCapabilities(deps: Deps = defaultDeps()): Promise<Capability[]> {
  const found = await Promise.all(TOOLS.map((t) => detectOne(t, deps)))
  return found.filter((c): c is Capability => c !== null)
}
