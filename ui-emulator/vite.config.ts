import { defineConfig, type Plugin } from 'vite'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import ts from 'typescript'

const HERE = path.posix.normalize(fileURLToPath(new URL('.', import.meta.url)).replace(/\\/g, '/')).replace(/\/$/, '')
// Fichier `.env` du dossier de l'outil (RBX_PROFILE, RBX_PROJECT...). Vite ne le charge PAS dans process.env pour sa propre
// configuration : on le lit ici. Une variable deja definie dans l'environnement reste prioritaire.
function loadDotEnv(file: string) {
  if (!fs.existsSync(file)) return
  for (const raw of fs.readFileSync(file, 'utf8').replace(/^﻿/, '').split(/\r?\n/)) {
    if (raw.trim().startsWith('#')) continue
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(raw)
    if (!m) continue
    const value = /^(['"]).*\1$/.test(m[2]) ? m[2].slice(1, -1) : m[2]
    if (process.env[m[1]] === undefined) process.env[m[1]] = value
  }
}
loadDotEnv(`${HERE}/.env`)

// Un PROFIL decrit le projet Roblox a emuler (lu en lecture seule, jamais modifie) :
//   RBX_PROFILE=dont-fish | giant-tower   (voir profiles/*.json)
const PROFILE = process.env.RBX_PROFILE ?? 'dont-fish'
// RBX_PROFILE_FILE : profil donne par un fichier (genere a la volee pour construire l'apercu d'un depot, voir « Paquet d'apercu » dans le README).
const profile = JSON.parse(fs.readFileSync(process.env.RBX_PROFILE_FILE ?? `${HERE}/profiles/${PROFILE}.json`, 'utf8'))
const PROJECT: string = (process.env.RBX_PROJECT ?? profile.project).replace(/\\/g, '/')
const shim = (n: string) => `${HERE}/src/shims/${n}`

// Alias et baseUrl lus depuis le tsconfig du projet (extends compris).
const tsconfigFile = path.posix.join(PROJECT, profile.tsconfig ?? 'tsconfig.json')
const rawCfg = ts.readConfigFile(tsconfigFile, ts.sys.readFile)
const parsedCfg = ts.parseJsonConfigFileContent({ ...rawCfg.config, include: [], files: [] }, ts.sys, path.posix.dirname(tsconfigFile))
const BASE_URL: string | undefined = parsedCfg.options.baseUrl?.replace(/\\/g, '/')
const PATHS_BASE: string = (BASE_URL ?? ((parsedCfg.options as any).pathsBasePath as string) ?? path.posix.dirname(tsconfigFile)).replace(/\\/g, '/')
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const pathAliases = Object.entries(parsedCfg.options.paths ?? {}).map(([k, v]) => {
  const target = (v as string[])[0]
  return k.endsWith('/*')
    ? { find: new RegExp('^' + escapeRe(k.slice(0, -2)) + '/(.*)$'), replacement: path.posix.join(PATHS_BASE, target.replace(/\/\*$/, '')) + '/$1' }
    : { find: k, replacement: path.posix.join(PATHS_BASE, target) }
})

// `rootDirs` du tsconfig : plusieurs dossiers sources superposes (ex. places/game/src + places/common/src). Un import relatif
// qui ne se resout pas tel quel est retente depuis chacun des autres dossiers racines.
const ROOT_DIRS: string[] = ((parsedCfg.options.rootDirs ?? []) as string[]).map((d) => d.replace(/\\/g, '/').replace(/\/$/, ''))
function rootDirsResolver(): Plugin {
  return {
    name: 'rootdirs-resolver',
    enforce: 'pre',
    async resolveId(source, importer, options) {
      if (ROOT_DIRS.length < 2 || !importer || !source.startsWith('.')) return null
      const imp = importer.replace(/\\/g, '/')
      const own = ROOT_DIRS.find((r) => imp.startsWith(r + '/'))
      if (!own) return null
      const normal = await this.resolve(source, importer, { ...options, skipSelf: true })
      if (normal) return null // la resolution normale fonctionne
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(imp), source))
      if (!target.startsWith(own + '/')) return null
      const rel = target.slice(own.length + 1)
      for (const other of ROOT_DIRS) {
        if (other === own) continue
        const r = await this.resolve(`${other}/${rel}`, importer, { ...options, skipSelf: true })
        if (r) return r
      }
      return null
    },
  }
}

// Imports "nus" relatifs a baseUrl (ex. `client/UI/...`) : resolus depuis baseUrl s'ils correspondent a un dossier de premier niveau.
function baseUrlResolver(): Plugin {
  const tops = BASE_URL && fs.existsSync(BASE_URL) ? new Set(fs.readdirSync(BASE_URL)) : new Set<string>()
  return {
    name: 'baseurl-resolver',
    enforce: 'pre',
    async resolveId(source, importer, options) {
      if (!BASE_URL || !importer || /^(\.|\/|[A-Za-z]:|\0|virtual:)/.test(source)) return null
      if (!tops.has(source.split('/')[0])) return null
      return this.resolve(`${BASE_URL}/${source}`, importer, { ...options, skipSelf: true })
    },
  }
}

// Liste des stories (*.story.tsx) : generee depuis le disque a partir des dossiers du profil.
function storiesIndex(): Plugin {
  const VIRT = 'virtual:stories'
  const ONLY = process.env.RBX_ONLY
  const ignore = new Set<string>(['node_modules', 'out', 'include', '.git', '.claude', ...(profile.ignore ?? [])])
  const walk = (dir: string, out: string[]) => {
    if (!fs.existsSync(dir)) return
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) { if (!ignore.has(e.name)) walk(`${dir}/${e.name}`, out) } else if (/\.story\.tsx?$/.test(e.name)) out.push(`${dir}/${e.name}`)
    }
  }
  return {
    name: 'stories-index',
    resolveId(id) { return id === VIRT ? '\0' + VIRT : null },
    load(id) {
      if (id !== '\0' + VIRT) return null
      const items: string[] = []
      for (const root of profile.storiesRoots as Array<{ dir: string; label?: string }>) {
        const base = path.posix.join(PROJECT, root.dir)
        const files: string[] = []
        walk(base, files)
        for (const f of files.sort()) {
          const rel = f.slice(base.length + 1).replace(/\.story\.tsx?$/, '')
          const name = (root.label ? root.label + '/' : '') + rel
          if (ONLY && name !== ONLY) continue // RBX_ONLY : paquet d'apercu d'UNE story (plus petit, sans la liste des autres)
          items.push(`{ name: ${JSON.stringify(name)}, load: () => import(${JSON.stringify(f)}) }`)
        }
      }
      return `export default [${items.join(',\n')}]\nexport const meta = ${JSON.stringify({ viewport: profile.viewport, background: profile.background })}`
    },
  }
}

// Modules deja doubles (alias ci-dessous) : tout autre import @rbxts/* ou @flamework/* devient un module "fantome"
// (proxy qui enregistre ce qui est utilise) pour que le rendu continue et que le rapport liste les doublures manquantes.
const KNOWN = new Set([
  '@rbxts/react', '@rbxts/react-roblox', '@rbxts/react-charm', '@rbxts/services', '@rbxts/charm', '@rbxts/pretty-react-hooks',
  '@rbxts/ui-labs', '@rbxts/janitor', '@rbxts/immut', '@rbxts/object-utils', '@flamework/core', '@rbxts/signal', '@rbxts/serikanum',
])
const IMPORT_RE = /^[ \t]*import\s+(type\s+)?([^;"'`]*?)\s+from\s+["'](@rbxts\/[^"']+|@flamework\/[^"']+)["'];?[ \t]*$/gm
let ghostN = 0

function ghostImports(code: string) {
  return code.replace(IMPORT_RE, (_m, isType: string | undefined, clause: string, mod: string) => {
    if (KNOWN.has(mod)) return _m
    if (isType) return ''
    const v = `__ghost${ghostN++}`
    let out = `import __ghostFactory${v} from "/src/shims/ghostModule.ts"; const ${v} = __ghostFactory${v}("${mod}");`
    const ns = /\*\s+as\s+(\w+)/.exec(clause)
    if (ns) out += ` const ${ns[1]} = ${v};`
    const named = /\{([\s\S]*?)\}/.exec(clause)
    if (named) {
      const items = named[1].split(',').map((x) => x.trim().replace(/^type\s+/, '')).filter(Boolean).map((x) => x.replace(/\s+as\s+/, ': '))
      if (items.length) out += ` const { ${items.join(', ')} } = ${v};`
    }
    const def = /^\s*(\w+)\s*(?:,|$)/.exec(clause.replace(/\{[\s\S]*\}/, '').replace(/\*\s+as\s+\w+/, ''))
    if (def && def[1] !== 'type') out += ` const ${def[1]} = ${v};`
    return out
  })
}

// En Luau, task.wait() suspend le fil. En JS on le simule : dans une fonction passee a task.spawn/defer/delay,
// `task.wait(x)` devient `await task.wait(x)` et la fonction devient `async`.
function awaitTaskWaits(code: string, fileName: string) {
  if (!/\btask\s*\.\s*wait\s*\(|\.Wait\s*\(\s*\)/.test(code)) return code
  const sf = ts.createSourceFile(fileName, code, ts.ScriptTarget.ESNext, true, /\.tsx$/.test(fileName) ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const edits: Array<{ pos: number; text: string }> = []
  const asyncFns = new Set<ts.Node>()
  const isTaskCall = (n: ts.Node, names: string[]) =>
    ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.expression.getText(sf) === 'task' && names.includes(n.expression.name.text)
  const enclosingFn = (n: ts.Node) => {
    for (let p = n.parent; p; p = p.parent) if (ts.isArrowFunction(p) || ts.isFunctionExpression(p) || ts.isFunctionDeclaration(p) || ts.isMethodDeclaration(p)) return p
    return undefined
  }
  // task.wait(x) et signal.Wait() (ex. tween.Completed.Wait()) suspendent le fil en Luau
  const isYield = (n: ts.Node) =>
    isTaskCall(n, ['wait']) || (ts.isCallExpression(n) && n.arguments.length === 0 && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === 'Wait')
  const visit = (n: ts.Node) => {
    if (isYield(n)) {
      const fn = enclosingFn(n)
      if (fn && fn.parent && isTaskCall(fn.parent, ['spawn', 'defer', 'delay'])) {
        edits.push({ pos: n.getStart(sf), text: 'await ' })
        asyncFns.add(fn)
      }
    }
    ts.forEachChild(n, visit)
  }
  visit(sf)
  for (const fn of asyncFns) {
    const already = (ts.getCombinedModifierFlags(fn as ts.Declaration) & ts.ModifierFlags.Async) !== 0
    if (!already) edits.push({ pos: fn.getStart(sf), text: 'async ' })
  }
  edits.sort((a, b) => b.pos - a.pos)
  let out = code
  for (const e of edits) out = out.slice(0, e.pos) + e.text + out.slice(e.pos)
  return out
}

// Luau : une cle a `nil` n'existe pas dans une table, donc `{ Position: centre, ...props }` garde `centre` quand props.Position est nil.
// En JS, `{ ...props }` avec `Position: undefined` ECRASE la valeur par defaut (composants "Wrapper", "DefaultTextLabel"... qui
// recoivent des props optionnelles non fournies). On enveloppe donc chaque spread (objet et attributs JSX) dans `__defined(...)`,
// qui retire les cles valant `undefined`.
function definedSpreads(code: string, fileName: string) {
  if (!code.includes('...')) return code
  const sf = ts.createSourceFile(fileName, code, ts.ScriptTarget.ESNext, true, /\.tsx$/.test(fileName) ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const inserts: Array<{ pos: number; text: string }> = []
  const wrap = (e: ts.Expression) => { inserts.push({ pos: e.getStart(sf), text: '__defined(' }, { pos: e.getEnd(), text: ')' }) }
  const visit = (n: ts.Node) => {
    if (ts.isSpreadAssignment(n) || ts.isJsxSpreadAttribute(n)) wrap(n.expression)
    ts.forEachChild(n, visit)
  }
  visit(sf)
  // insertions appliquees de la fin vers le debut ; a position egale on applique '(' d'abord, ce qui place ensuite ')' devant lui
  inserts.sort((a, b) => b.pos - a.pos || (a.text === ')' ? 1 : -1))
  let out = code
  for (const i of inserts) out = out.slice(0, i.pos) + i.text + out.slice(i.pos)
  return out
}

// Luau : `setmetatable(obj, { __call: f })` rend `obj` appelable (`px(100)`). Un objet JS ne peut pas le devenir apres coup :
// on remplace donc la declaration `const obj = {...}` par `__callable({...})` (une fonction portant les memes proprietes)
// et le setmetatable par `__setCall(obj, mt)` qui branche le __call.
function callableMetatables(code: string, fileName: string) {
  if (!/\bsetmetatable\s*\(/.test(code) || !code.includes('__call')) return code
  const sf = ts.createSourceFile(fileName, code, ts.ScriptTarget.ESNext, true, /\.tsx$/.test(fileName) ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const edits: Array<{ start: number; end: number; text: string }> = []
  const findDecl = (from: ts.Node, name: string): ts.VariableDeclaration | undefined => {
    for (let p: ts.Node | undefined = from.parent; p; p = p.parent) {
      const stmts = ts.isBlock(p) || ts.isSourceFile(p) ? p.statements : undefined
      if (!stmts) continue
      for (const s of stmts) {
        if (!ts.isVariableStatement(s)) continue
        for (const d of s.declarationList.declarations) if (ts.isIdentifier(d.name) && d.name.text === name && d.initializer && ts.isObjectLiteralExpression(d.initializer)) return d
      }
    }
    return undefined
  }
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n) && n.expression.getText(sf) === 'setmetatable' && n.arguments.length === 2 && ts.isIdentifier(n.arguments[0]) && ts.isObjectLiteralExpression(n.arguments[1]) && n.arguments[1].properties.some((p) => p.name?.getText(sf) === '__call')) {
      const decl = findDecl(n, (n.arguments[0] as ts.Identifier).text)
      if (decl?.initializer) {
        edits.push({ start: decl.initializer.getStart(sf), end: decl.initializer.getEnd(), text: `__callable(${decl.initializer.getText(sf)})` })
        edits.push({ start: n.expression.getStart(sf), end: n.expression.getEnd(), text: '__setCall' })
      }
    }
    ts.forEachChild(n, visit)
  }
  visit(sf)
  edits.sort((a, b) => b.start - a.start)
  let out = code
  for (const e of edits) out = out.slice(0, e.start) + e.text + out.slice(e.end)
  return out
}

// `export = story` (CommonJS roblox-ts) -> `export default story` + un export nomme par propriete de l'objet litteral,
// car roblox-ts autorise `import { reactRoblox } from "./x.story"` sur un tel module.
function exportEqualsToEsm(code: string, fileName: string) {
  if (!/^export\s*=\s*/m.test(code)) return code
  const sf = ts.createSourceFile(fileName, code, ts.ScriptTarget.ESNext, true, /\.tsx$/.test(fileName) ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  let out = code
  const stmts = sf.statements.filter((s): s is ts.ExportAssignment => ts.isExportAssignment(s) && !!s.isExportEquals)
  for (const st of stmts.reverse()) {
    let extra = ''
    if (ts.isIdentifier(st.expression)) {
      const name = st.expression.text
      for (const s of sf.statements) {
        if (!ts.isVariableStatement(s)) continue
        for (const d of s.declarationList.declarations) {
          if (ts.isIdentifier(d.name) && d.name.text === name && d.initializer && ts.isObjectLiteralExpression(d.initializer)) {
            for (const p of d.initializer.properties) {
              const k = p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) ? p.name.text : undefined
              // nom local unique : evite toute collision avec les variables du fichier (`controls`, `story`...)
              if (k && /^[A-Za-z_$][\w$]*$/.test(k) && k !== 'default') extra += ` const __ex_${k} = ${name}.${k}; export { __ex_${k} as ${k} };`
            }
          }
        }
      }
    }
    out = out.slice(0, st.getStart(sf)) + `export default ${st.expression.getText(sf)};${extra}` + out.slice(st.getEnd())
  }
  return out
}

// Diagnostic : liste les fichiers du node_modules DU PROJET que la compilation a reellement lus (RBX_TRACE_NM=<fichier de sortie>).
function traceProjectNodeModules(): Plugin {
  const hits = new Set<string>()
  let projectModules = 0
  return {
    name: 'trace-project-node-modules',
    enforce: 'post',
    transform(_code, id) {
      const f = id.split('?')[0].replace(/\\/g, '/')
      if (f.startsWith(PROJECT + '/node_modules/')) hits.add(f.slice(PROJECT.length + 1))
      else if (f.startsWith(PROJECT + '/')) projectModules++
      return null
    },
    buildEnd() {
      if (process.env.RBX_TRACE_NM) fs.writeFileSync(process.env.RBX_TRACE_NM, JSON.stringify({ projectSourceModules: projectModules, nodeModulesFilesRead: [...hits] }, null, 1))
    },
  }
}

// Compat roblox-ts -> JS : `export = x`, `.size()` (methode roblox-ts, propriete en JS) et imports fantomes.
function rbxCompat(): Plugin {
  return {
    name: 'rbx-compat',
    enforce: 'pre',
    transform(code, id) {
      const clean = id.split('?')[0].replace(/\\/g, '/')
      if (!clean.startsWith(PROJECT) || !/\.(tsx?|jsx?)$/.test(clean)) return null
      let out = code
      out = definedSpreads(out, clean)
      out = callableMetatables(out, clean)
      out = exportEqualsToEsm(out, clean)
      out = out.replace(/^export\s*=\s*/gm, 'export default ')
      out = out.replace(/\.size\(\)/g, '.__size()')
      out = ghostImports(out)
      out = awaitTaskWaits(out, clean)
      return out === code ? null : { code: out, map: null }
    },
  }
}

// Doublures par projet : fichier du projet (relatif a src/) -> doublure de l'emulateur.
// Sert aux modules dont le comportement n'existe pas en JS (ex. metatable __call). Le projet n'est jamais modifie.
const OVERRIDES: Record<string, string> = Object.fromEntries(
  Object.entries(profile.overrides ?? {}).map(([k, v]) => [k, shim(String(v))]),
)
function projectOverrides(): Plugin {
  return {
    name: 'project-overrides',
    enforce: 'pre',
    async resolveId(source, importer, options) {
      if (!importer || /^(\0|virtual:)/.test(source) || !importer.replace(/\\/g, '/').startsWith(PROJECT)) return null
      const r = await this.resolve(source, importer, { ...options, skipSelf: true })
      if (!r) return null
      const rel = r.id.replace(/\\/g, '/').replace(PROJECT + '/', '')
      return OVERRIDES[rel] ?? null
    },
  }
}

export default defineConfig({
  root: HERE,
  base: process.env.RBX_BASE ?? '/',
  build: { outDir: process.env.RBX_OUT ?? 'dist', emptyOutDir: true, sourcemap: false, chunkSizeWarningLimit: 4000 },
  plugins: [storiesIndex(), projectOverrides(), rootDirsResolver(), baseUrlResolver(), rbxCompat(), traceProjectNodeModules()],
  esbuild: { jsx: 'transform', jsxFactory: 'React.createElement', jsxFragment: 'React.Fragment' },
  resolve: {
    dedupe: ['react', 'react-dom', 'react-reconciler'],
    alias: [
      ...pathAliases,
      { find: '@rbxts/react-roblox', replacement: shim('reactRoblox.ts') },
      { find: '@rbxts/react-charm', replacement: shim('reactCharm.ts') },
      { find: '@rbxts/react', replacement: shim('rbxReact.ts') },
      { find: '@rbxts/services', replacement: shim('services.ts') },
      { find: '@rbxts/charm', replacement: shim('charm.ts') },
      { find: '@rbxts/pretty-react-hooks', replacement: shim('prettyReactHooks.ts') },
      { find: '@rbxts/ui-labs', replacement: shim('uiLabs.ts') },
      { find: '@rbxts/janitor', replacement: shim('janitor.ts') },
      { find: '@rbxts/signal', replacement: shim('signal.ts') },
      { find: '@rbxts/serikanum', replacement: shim('serikanum.ts') },
      { find: '@rbxts/immut', replacement: shim('immut.ts') },
      { find: '@rbxts/object-utils', replacement: shim('objectUtils.ts') },
      { find: '@flamework/core', replacement: shim('flamework.ts') },
    ],
  },
  // Pas de scan des sources du projet lie (paquets Luau non resolvables) : on pre-bundle seulement nos dependances.
  optimizeDeps: { noDiscovery: true, include: ['react', 'react-dom', 'react-dom/client', 'react-reconciler', 'react-reconciler/constants', 'scheduler'] },
  server: { fs: { strict: false, allow: [HERE, PROJECT] }, port: 5174, host: '127.0.0.1' },
})
