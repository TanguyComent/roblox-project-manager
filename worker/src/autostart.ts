// Demarrage automatique a l'ouverture de session (sans droits administrateur) :
// Windows = fichier dans le dossier « Demarrage », macOS = LaunchAgent, Linux = entree autostart XDG.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { WORKER_DIR } from './config.ts'

export interface Autostart { supported: boolean; enabled(): boolean; set(on: boolean): void; where: string }

const MAIN = join(WORKER_DIR, 'src', 'main.ts')
const ARGS = ['--disable-warning=ExperimentalWarning', MAIN, '--no-open']
const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

export function createAutostart(platform = process.platform, home = homedir(), env = process.env, nodePath = process.execPath): Autostart {
  let file: string
  let content: string
  if (platform === 'win32') {
    file = join(env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'RPM-Worker.vbs')
    const q = (s: string) => `"${s.replace(/"/g, '""')}"` // guillemets VBScript
    content = ['Set sh = CreateObject("WScript.Shell")', `sh.CurrentDirectory = ${q(WORKER_DIR)}`,
      `sh.Run ${q(`${q(nodePath)} ${ARGS.map((a) => q(a)).join(' ')}`)}, 0, False`, ''].join('\r\n') // 0 = fenetre cachee
  } else if (platform === 'darwin') {
    file = join(home, 'Library', 'LaunchAgents', 'io.rpm.worker.plist')
    content = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>io.rpm.worker</string>
<key>ProgramArguments</key><array>${[nodePath, ...ARGS].map((a) => `<string>${xml(a)}</string>`).join('')}</array>
<key>WorkingDirectory</key><string>${xml(WORKER_DIR)}</string>
<key>RunAtLoad</key><true/>
</dict></plist>
`
  } else if (platform === 'linux') {
    file = join(env.XDG_CONFIG_HOME ?? join(home, '.config'), 'autostart', 'rpm-worker.desktop')
    const q = (s: string) => `"${s.replace(/(["\$`])/g, '\$1')}"`
    content = `[Desktop Entry]\nType=Application\nName=RPM Worker\nPath=${WORKER_DIR}\nExec=${[nodePath, ...ARGS].map(q).join(' ')}\nTerminal=false\n`
  } else {
    return { supported: false, enabled: () => false, set: () => { throw new Error('Demarrage automatique non pris en charge sur ce systeme.') }, where: '' }
  }
  return {
    supported: true,
    where: file,
    // « active » = le fichier existe ET pointe vers CE dossier (apres un deplacement du projet, il faut le regenerer).
    enabled: () => existsSync(file) && readFileSync(file, 'utf8').replace(/\r\n/g, '\n') === content.replace(/\r\n/g, '\n'),
    set(on) {
      if (on) { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, content) } else rmSync(file, { force: true })
    },
  }
}
