import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { DEFAULT_EMULATOR_DIR, buildPreviews, fileProblem, fixRequest, listFiles, parseUiBlocks, renderStory, type PreviewMeta, type PreviewResult } from '../src/preview.ts'
import { uploadPreview } from '../src/upload.ts'

const tmp = () => mkdtempSync(join(tmpdir(), 'rpm-prev-'))
const fence = (obj: unknown) => '```rpm-ui\n' + (typeof obj === 'string' ? obj : JSON.stringify(obj)) + '\n```'

test('blocs rpm-ui : lecture, numerotation, valeurs par defaut', () => {
  const text = `Voila.\n\n${fence({ file: 'src/ui/hud.story.tsx', viewport: 'Telephone', title: 'Le HUD' })}\n\nEt aussi :\n${fence({ file: './src/ui/shop.story.tsx' })}\n`
  const { blocks, invalid } = parseUiBlocks(text)
  assert.deepEqual(invalid, [])
  assert.deepEqual(blocks, [
    { n: 0, file: 'src/ui/hud.story.tsx', viewport: 'Telephone', root: 'project', title: 'Le HUD' },
    { n: 1, file: 'src/ui/shop.story.tsx', viewport: 'UI Labs', root: 'project', title: 'shop' },
  ])
  assert.deepEqual(parseUiBlocks('pas de bloc').blocks, [])
  assert.deepEqual(parseUiBlocks('```lua\nprint(1)\n```').blocks, [], 'les autres blocs de code sont ignores')
  // un exemple de bloc rpm-ui DANS un autre bloc de code n'est que du texte : meme regle que le rendu Markdown du Host
  const nested = '```markdown\n```rpm-ui\n{"file": "x.story.tsx"}\n```\n' + fence({ file: 'src/vrai.story.tsx' })
  assert.deepEqual(parseUiBlocks(nested).blocks.map((b) => [b.n, b.file]), [[0, 'src/vrai.story.tsx']])
})

test('blocs rpm-ui : erreurs explicites, numerotation conservee', () => {
  const text = [fence('{pas du json'), fence({ file: 'a.story.tsx', viewport: 'Cinema' }), fence([1]), fence({ file: 'src/ok.story.tsx' })].join('\n')
  const { blocks, invalid } = parseUiBlocks(text)
  assert.deepEqual(blocks.map((b) => b.n), [3], 'le bloc valide garde son rang (3e) pour que le Host retrouve son apercu')
  assert.deepEqual(invalid.map((b) => b.n), [0, 1, 2])
  assert.match(invalid[0].error, /JSON/)
  assert.match(invalid[1].error, /viewport inconnu/)
  assert.match(invalid[2].error, /objet JSON/)
  const many = Array.from({ length: 8 }, (_, i) => fence({ file: `s${i}.story.tsx` })).join('\n')
  const r = parseUiBlocks(many)
  assert.equal(r.blocks.length, 6)
  assert.equal(r.invalid.length, 2)
})

test('chemins de story : seuls les fichiers *.story.ts(x) du depot sont acceptes', () => {
  assert.equal(fileProblem('src/a/b.story.tsx'), null)
  assert.equal(fileProblem('b.story.ts'), null)
  for (const bad of ['', 'src/a.tsx', '../x.story.tsx', 'a/../../x.story.tsx', '/etc/x.story.tsx', 'C:/x.story.tsx', 'c:x.story.tsx', 'a<b>.story.tsx', 'a|b.story.tsx', 'x'.repeat(300) + '.story.tsx', 'a\u0000.story.tsx']) {
    assert.ok(fileProblem(bad), JSON.stringify(bad))
  }
  assert.equal(parseUiBlocks(fence({ file: '..\\..\\secret.story.tsx' })).blocks.length, 0)
})

// Faux emulateur : meme interface que ui-emulator/tools/preview.mjs, sans Vite ni navigateur.
function fakeEmulator() {
  const dir = tmp()
  mkdirSync(join(dir, 'tools'))
  writeFileSync(join(dir, 'tools', 'preview.mjs'), `
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
const a = process.argv.slice(2); const o = (n) => a[a.indexOf('--' + n) + 1]
const file = o('file'), out = o('out')
writeFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'last-args.txt'), a.join(' '))
if (file.includes('bad')) { console.log('du bruit avant'); console.log(JSON.stringify({ ok: false, error: 'construction impossible : boom' })); process.exit(1) }
mkdirSync(join(out, 'assets'), { recursive: true })
writeFileSync(join(out, 'index.html'), '<html>' + file + ' ' + o('viewport') + '</html>')
writeFileSync(join(out, 'assets', 'a.js'), 'console.log(1)')
writeFileSync(join(out, 'thumb.png'), Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'))
if (file.includes('empty')) console.log(JSON.stringify({ ok: true, name: 'empty', checked: true, nodes: 1, errors: [], missing: [] }))
else if (file.includes('err')) console.log(JSON.stringify({ ok: true, name: 'err', checked: true, nodes: 9, errors: ['TypeError: x is undefined'], missing: [] }))
else console.log(JSON.stringify({ ok: true, name: 'x', checked: true, nodes: 12, errors: [], missing: ['@flamework/networking'] }))
`)
  return dir
}

function recorder() {
  const uploads: { meta: PreviewMeta; files: string[] | null; index: string | null }[] = []
  const upload = async (dir: string | null, meta: PreviewMeta) => {
    const files = dir ? listFiles(dir).map((f) => f.path).sort() : null
    uploads.push({ meta, files, index: dir ? readFileSync(join(dir, 'index.html'), 'utf8') : null })
    return `id${uploads.length}`
  }
  return { uploads, upload }
}
const ctrl = () => new AbortController().signal
const noop = () => {}

test('construction : un apercu par bloc valide, paquet envoye, erreurs signalees sans bloquer les autres', async () => {
  const { uploads, upload } = recorder()
  const text = [fence({ file: 'src/ok.story.tsx', viewport: 'Telephone', title: 'OK' }), fence({ file: 'src/bad.story.tsx' }), fence({ file: 'src/err.story.tsx' }), fence('{nope')].join('\n')
  const events: string[] = []
  const res = await buildPreviews(text, { project: tmp(), emulatorDir: fakeEmulator(), upload, signal: ctrl(), event: (_l, t) => { events.push(t) } })

  assert.deepEqual(res.map((r) => [r.n, r.ok, r.previewId !== null]), [[0, true, true], [1, false, true], [2, true, true], [3, false, true]])
  assert.deepEqual(res[0].missing, ['@flamework/networking'])
  assert.equal(res[0].nodes, 12)
  assert.match(res[1].error!, /boom/, 'le bruit avant le JSON est ignore')
  assert.deepEqual(res[2].errors, ['TypeError: x is undefined'])
  assert.match(res[3].error!, /JSON/)

  const ok = uploads.find((u) => u.meta.n === 0)!
  assert.deepEqual(ok.files, ['assets/a.js', 'index.html', 'thumb.png'])
  assert.match(ok.index!, /Telephone/, 'le viewport demande est transmis a l\'emulateur')
  assert.equal(uploads.find((u) => u.meta.n === 1)!.files, null, 'un echec ne depose que ses metadonnees')
  assert.ok(events.some((e) => /Apercu : src\/ok\.story\.tsx/.test(e)))
})

test('emulateur absent : chaque bloc echoue avec un message clair', async () => {
  const { uploads, upload } = recorder()
  const res = await buildPreviews(fence({ file: 'src/a.story.tsx' }), { project: tmp(), emulatorDir: join(tmp(), 'absent'), upload, signal: ctrl(), event: noop })
  assert.equal(res.length, 1)
  assert.equal(res[0].ok, false)
  assert.match(res[0].error!, /pas installe/)
  assert.equal(uploads.length, 1)
})

test('echec de l\'envoi : l\'apercu est marque en echec avec la raison', async () => {
  const res = await buildPreviews(fence({ file: 'src/ok.story.tsx' }), {
    project: tmp(), emulatorDir: fakeEmulator(), signal: ctrl(), event: noop,
    upload: async (dir) => { if (dir) throw new Error('refuse par le Host (413)'); return 'x' },
  })
  assert.equal(res[0].ok, false)
  assert.match(res[0].error!, /refuse par le Host/)
})

test('demande de correction : erreurs et apercus vides, pas les modules manquants', () => {
  const r = (over: Partial<PreviewResult>): PreviewResult => ({ n: 0, title: 't', file: 'a.story.tsx', viewport: 'UI Labs', root: 'project', ok: true, error: null, checked: true, nodes: 10, errors: [], missing: [], previewId: 'x', ...over })
  assert.equal(fixRequest([r({ missing: ['@flamework/networking', 'GamepadService'] })]), '', 'modules manquants : l\'emulateur les remplace')
  assert.equal(fixRequest([r({ checked: false, nodes: 0 })]), '', 'non controle : rien a dire')
  assert.match(fixRequest([r({ ok: false, error: 'construction impossible' })]), /a\.story\.tsx : construction impossible/)
  assert.match(fixRequest([r({ errors: ['TypeError: boom'] })]), /TypeError: boom/)
  assert.match(fixRequest([r({ nodes: 1 })]), /vide/)
})

test('envoi au Host : requete authentifiee, paquet en base64, limites', async () => {
  const dir = tmp()
  mkdirSync(join(dir, 'assets'))
  writeFileSync(join(dir, 'index.html'), '<html></html>')
  writeFileSync(join(dir, 'assets', 'a.js'), 'x')
  const calls: { url: string; init: RequestInit }[] = []
  const fakeFetch = (async (url: string | URL, init: RequestInit) => { calls.push({ url: String(url), init }); return new Response(JSON.stringify({ id: 'abc123' }), { status: 200 }) }) as typeof fetch
  const meta: PreviewMeta = { n: 0, title: 'T', file: 'a.story.tsx', viewport: 'UI Labs', root: 'project', ok: true, error: null, checked: true, nodes: 5, errors: [], missing: [] }
  const id = await uploadPreview('http://localhost:3000/', 'rpmw_secret', 42, dir, meta, fakeFetch)
  assert.equal(id, 'abc123')
  assert.equal(calls[0].url, 'http://localhost:3000/api/worker/previews')
  assert.equal((calls[0].init.headers as Record<string, string>).Authorization, 'Bearer rpmw_secret')
  const body = JSON.parse(String(calls[0].init.body)) as { jobId: number; files: { path: string; data: string }[] }
  assert.equal(body.jobId, 42)
  assert.deepEqual(body.files.map((f) => f.path).sort(), ['assets/a.js', 'index.html'])
  assert.equal(Buffer.from(body.files.find((f) => f.path === 'assets/a.js')!.data, 'base64').toString(), 'x')
  const refused = (async () => new Response(JSON.stringify({ error: 'Apercu trop gros' }), { status: 413 })) as unknown as typeof fetch
  await assert.rejects(uploadPreview('http://h', 't', 1, dir, meta, refused), /Apercu trop gros/)
  const noBody = (async () => new Response('nope', { status: 500 })) as unknown as typeof fetch
  await assert.rejects(uploadPreview('http://h', 't', 1, null, meta, noBody), /500/)
})

// --- l'emulateur reel (si ses dependances sont installees) ------------------------------------------------------------------------
test('emulateur reel : une story minimale est construite, controlee et rendue', { skip: !existsSync(join(DEFAULT_EMULATOR_DIR, 'node_modules', 'vite')) }, async () => {
  const project = tmp()
  mkdirSync(join(project, 'src'))
  writeFileSync(join(project, 'tsconfig.json'), '{"compilerOptions":{}}')
  writeFileSync(join(project, 'src', 'mini.story.tsx'), `import React from "@rbxts/react"
import ReactRoblox from "@rbxts/react-roblox"
const story = {
  react: React, reactRoblox: ReactRoblox, controls: {},
  story: () => (
    <frame Size={UDim2.fromOffset(200, 100)} BackgroundColor3={Color3.fromRGB(40, 60, 90)}>
      <textlabel Text="Bonjour" Size={UDim2.fromScale(1, 1)} BackgroundTransparency={1} TextColor3={Color3.fromRGB(255, 255, 255)} />
    </frame>
  ),
}
export = story
`)
  const { uploads, upload } = recorder()
  const res = await buildPreviews(fence({ file: 'src/mini.story.tsx', viewport: 'Desktop', title: 'Mini' }), { project, upload, signal: ctrl(), event: noop })
  assert.equal(res[0].ok, true, JSON.stringify(res[0]))
  assert.ok(res[0].nodes >= 2, `elements rendus : ${res[0].nodes}`)
  assert.deepEqual(res[0].errors, [])
  assert.ok(uploads[0].files!.includes('index.html'))
  assert.ok(uploads[0].files!.some((f) => /^assets\/.*\.js$/.test(f)))
  assert.ok(!uploads[0].files!.some((f) => /\.(tsx?|story)$/.test(f)), 'aucun fichier du projet n\'est copie')

  const missing = await buildPreviews(fence({ file: 'src/absente.story.tsx' }), { project, upload, signal: ctrl(), event: noop })
  assert.equal(missing[0].ok, false)
  assert.match(missing[0].error!, /introuvable/)
})

test('bloc rpm-ui : racine « project » par defaut ou « sandbox » (atelier), autre valeur refusee', () => {
  const text = [fence({ file: 'a.story.tsx' }), fence({ file: 'b.story.tsx', root: 'sandbox' }), fence({ file: 'c.story.tsx', root: 'project' }), fence({ file: 'd.story.tsx', root: 'atelier' }), fence({ file: 'e.story.tsx', root: 42 })].join('\n')
  const { blocks, invalid } = parseUiBlocks(text)
  assert.deepEqual(blocks.map((b) => [b.n, b.root]), [[0, 'project'], [1, 'sandbox'], [2, 'project']])
  assert.deepEqual(invalid.map((b) => b.n), [3, 4])
  assert.match(invalid[0].error, /racine inconnue/)
})

test('construction par racine : une racine sans dossier disponible echoue proprement', async () => {
  const { uploads, upload } = recorder()
  const emulator = fakeEmulator()
  const text = [fence({ file: 'src/a.story.tsx', root: 'sandbox' }), fence({ file: 'src/b.story.tsx', root: 'project' })].join('\n')
  const res = await buildPreviews(text, { sandbox: tmp(), emulatorDir: emulator, upload, signal: ctrl(), event: noop }) // pas de projet disponible
  assert.deepEqual(res.map((r) => [r.root, r.ok]), [['sandbox', true], ['project', false]])
  assert.match(res[1].error!, /pas disponible/)
  assert.equal(uploads.find((u) => u.meta.n === 1)!.files, null)
  assert.ok(uploads.every((u) => u.meta.root === (u.meta.n === 0 ? 'sandbox' : 'project')), 'la racine est transmise au Host')
})

test('renderStory : la capture, ou la raison de l\'echec', async () => {
  const emulator = fakeEmulator()
  const project = tmp()
  const ok = await renderStory({ emulatorDir: emulator, project, file: 'src/ok.story.tsx', viewport: 'Telephone', signal: ctrl() })
  assert.equal(ok.ok, true)
  assert.ok(ok.png && ok.png.length >= 8)
  assert.equal(ok.nodes, 12)
  assert.deepEqual(ok.missing, ['@flamework/networking'])
  assert.match(readFileSync(join(emulator, 'last-args.txt'), 'utf8'), /--viewport Telephone/)
  const err = await renderStory({ emulatorDir: emulator, project, file: 'src/err.story.tsx', signal: ctrl() })
  assert.deepEqual(err.errors, ['TypeError: x is undefined'])
  const bad = await renderStory({ emulatorDir: emulator, project, file: 'src/bad.story.tsx', signal: ctrl() })
  assert.equal(bad.ok, false)
  assert.match(bad.error!, /boom/)
  assert.match((await renderStory({ emulatorDir: emulator, project, file: '../x.story.tsx', signal: ctrl() })).error!, /invalide/)
  assert.match((await renderStory({ emulatorDir: join(tmp(), 'absent'), project, file: 'a.story.tsx', signal: ctrl() })).error!, /pas installe/)
})
