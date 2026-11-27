// Paquet d'apercu d'UNE story : construit l'emulateur en site statique (un dossier index.html + assets/) pour la story donnee d'un projet, puis,
// si un Chrome/Edge est disponible, la rend pour verifier qu'elle s'affiche (erreurs, modules manquants) et en tirer une vignette.
// Le projet est lu en lecture seule ; le paquet ne contient que le code de l'emulateur et de la story (aucun fichier du projet n'est copie tel quel).
//
//   node tools/preview.mjs --project <dossier du projet> --file <story relative au projet> --out <dossier de sortie> [--viewport Telephone] [--no-check]
//
// Derniere ligne de la sortie standard : un objet JSON { ok, name, bytes, checked, nodes, errors, missing, thumb, error }.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const opt = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : d }
const flag = (n) => argv.includes('--' + n)
const posix = (p) => p.replace(/\\/g, '/')
const fail = (error) => { console.log(JSON.stringify({ ok: false, error })); process.exit(1) }

const project = opt('project') && path.resolve(opt('project'))
const file = opt('file')
const out = opt('out') && path.resolve(opt('out'))
if (!project || !file || !out) fail('arguments manquants : --project, --file et --out sont obligatoires')
if (!fs.existsSync(project)) fail('projet introuvable')

// La story doit etre un fichier *.story.tsx / *.story.ts DANS le projet (pas de sortie par « .. » ni par lien symbolique).
const abs = path.resolve(project, file)
const realProject = fs.realpathSync(project)
if (!/\.story\.tsx?$/.test(abs)) fail('le fichier doit se terminer par .story.tsx ou .story.ts')
if (!fs.existsSync(abs)) fail(`story introuvable : ${file}`)
if (!fs.realpathSync(abs).startsWith(realProject + path.sep)) fail('la story sort du projet')

// tsconfig le plus proche en remontant depuis la story (monodepots : places/game/tsconfig.json...).
let tsconfig = null
for (let d = path.dirname(abs); d.startsWith(realProject) || d.startsWith(project); d = path.dirname(d)) {
  if (fs.existsSync(path.join(d, 'tsconfig.json'))) { tsconfig = posix(path.relative(project, path.join(d, 'tsconfig.json'))); break }
  if (path.resolve(d) === path.resolve(project)) break
}
if (!tsconfig) fail('aucun tsconfig.json trouve au-dessus de la story')

const dir = posix(path.relative(project, path.dirname(abs))) || '.'
const name = path.basename(abs).replace(/\.story\.tsx?$/, '')
const viewport = opt('viewport', 'UI Labs')
const imagesDir = opt('images') && path.resolve(opt('images'))
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rpm-preview-'))
const cleanup = () => { try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* deja supprime */ } }
process.on('exit', cleanup)

const profileFile = path.join(tmp, 'profile.json')
fs.writeFileSync(profileFile, JSON.stringify({
  project: posix(project), tsconfig, storiesRoots: [{ dir }], ignore: [], viewport, background: 'dots', overrides: {},
}))

const run = (cmd, args, env, timeoutMs) => new Promise((resolve) => {
  const child = spawn(cmd, args, { cwd: HERE, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  let output = ''
  child.stdout.on('data', (d) => { output += d })
  child.stderr.on('data', (d) => { output += d })
  const timer = setTimeout(() => { try { child.kill() } catch { /* termine */ } }, timeoutMs)
  child.on('close', (code) => { clearTimeout(timer); resolve({ code, output }) })
  child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, output: String(e) }) })
})

// 1. construction (vite en processus separe, sans shell : le chemin de vite est celui des dependances de l'emulateur)
const vite = path.join(HERE, 'node_modules', 'vite', 'bin', 'vite.js')
if (!fs.existsSync(vite)) fail("dependances de l'emulateur absentes : lance « npm ci » dans ui-emulator")
fs.rmSync(out, { recursive: true, force: true })
const built = await run(process.execPath, [vite, 'build'], { RBX_PROFILE_FILE: profileFile, RBX_ONLY: name, RBX_BASE: './', RBX_OUT: out, RBX_PROFILE: '' }, 180_000)
if (built.code !== 0 || !fs.existsSync(path.join(out, 'index.html'))) fail(`construction impossible : ${built.output.trim().split(/\r?\n/).slice(-6).join(' | ').slice(0, 800)}`)
// 1 bis. images de la bibliotheque de l'utilisateur : <dossier>/index.json lie des references (rbxlib://..., rbxassetid://...) a des fichiers du dossier.
// Elles sont copiees dans le paquet (lib/) et declarees a l'emulateur par un script (rpm-images.js) charge avant l'application.
if (imagesDir && fs.existsSync(path.join(imagesDir, 'index.json'))) {
  try {
    const index = JSON.parse(fs.readFileSync(path.join(imagesDir, 'index.json'), 'utf8'))
    const map = {}
    fs.mkdirSync(path.join(out, 'lib'), { recursive: true })
    for (const [key, file] of Object.entries(index)) {
      if (typeof file !== 'string' || !/^[A-Za-z0-9][\w.-]{0,100}\.(png|jpe?g|webp|gif)$/i.test(file) || !/^rbx(lib|assetid):\/\/[\w-]{1,64}$/.test(key)) continue
      const src = path.join(imagesDir, file)
      if (!fs.existsSync(src) || !fs.statSync(src).isFile()) continue
      fs.copyFileSync(src, path.join(out, 'lib', file))
      map[key] = `lib/${file}`
    }
    if (Object.keys(map).length) {
      fs.writeFileSync(path.join(out, 'rpm-images.js'), `window.__RPM_IMAGES__=${JSON.stringify(map)};` + String.fromCharCode(10))
      const html = path.join(out, 'index.html')
      fs.writeFileSync(html, fs.readFileSync(html, 'utf8').replace('<head>', '<head><script src="./rpm-images.js"></script>'))
    }
  } catch { /* images illisibles : l'apercu s'affiche avec des blocs hachures */ }
}
const size = (d) => fs.readdirSync(d, { withFileTypes: true }).reduce((n, e) => n + (e.isDirectory() ? size(path.join(d, e.name)) : fs.statSync(path.join(d, e.name)).size), 0)
const result = { ok: true, name, bytes: size(out), checked: false, nodes: 0, errors: [], missing: [], thumb: null }

// 2. controle dans un navigateur sans fenetre (facultatif : sans Chrome/Edge, le paquet est livre tel quel)
const EDGE = process.env.EDGE ?? [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium',
].find((p) => fs.existsSync(p))

if (!flag('no-check') && EDGE) {
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent((req.url ?? '/').split('?')[0]).replace(/^\/+/, '') || 'index.html'
    const f = path.resolve(out, rel)
    if (!f.startsWith(out + path.sep) || !fs.existsSync(f) || !fs.statSync(f).isFile()) { res.writeHead(404).end(); return }
    const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' }
    res.writeHead(200, { 'Content-Type': types[path.extname(f)] ?? 'application/octet-stream' }).end(fs.readFileSync(f))
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${server.address().port}`
  const shots = path.join(tmp, 'shots')
  const checked = await run(process.execPath, [path.join(HERE, 'tools', 'cdp.mjs'), 'run', '--only', name, '--shots', shots, '--wait', '1200'], { EMU_URL: url, EDGE, EMU_QS: 'embed=1' }, 120_000)
  server.close()
  try {
    const rep = JSON.parse(fs.readFileSync(path.join(shots, 'report.json'), 'utf8'))[0]
    if (rep) {
      result.checked = true
      result.nodes = rep.nodes
      result.errors = rep.errors.slice(0, 5)
      result.missing = rep.missing.slice(0, 20)
      const png = fs.readdirSync(shots).find((f) => f.endsWith('.png'))
      if (png) { fs.copyFileSync(path.join(shots, png), path.join(out, 'thumb.png')); result.thumb = 'thumb.png' }
    }
  } catch { result.errors.push(`controle impossible : ${checked.output.trim().split(/\r?\n/).slice(-2).join(' | ').slice(0, 200)}`) }
}
console.log(JSON.stringify(result))
