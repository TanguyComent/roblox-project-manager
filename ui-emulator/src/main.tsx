import './rbx/globals'
import React from 'react'
import { createInstance } from './rbx/instance'
import { MISSING, setViewportSize } from './rbx/services'
import { createRoot } from './shims/reactRoblox'
import { mount } from './view/dom'

// Les stories du projet LIE (lecture seule) : *.story.tsx (convention UI Labs), listees d'apres le profil (vite.config.ts).
// @ts-ignore module virtuel genere par le plugin `stories-index`
import stories, { meta } from 'virtual:stories'
const modules: Record<string, () => Promise<any>> = Object.fromEntries((stories as any[]).map((s) => [s.name, s.load]))
const entries = (stories as any[]).map((s) => ({ key: s.name as string, name: s.name as string })).sort((a, b) => a.name.localeCompare(b.name))

const VIEWPORTS: Record<string, [number, number]> = { 'UI Labs': [960, 480], Desktop: [1280, 720], Tablette: [820, 1180], Telephone: [390, 844] }
// Fond de l'apercu : "dots" = fond sombre a petits points comme l'apercu UI Labs de Studio, sinon un ciel neutre.
const BACKGROUNDS: Record<string, string> = {
  dots: '#141515 radial-gradient(circle, #2a2d2d 1.2px, transparent 1.6px) 0 0 / 26px 26px',
}

const $ = (id: string) => document.getElementById(id)!
const side = $('side'), bar = $('bar'), errBox = $('err'), vp = $('viewport')

const params = new URLSearchParams(location.search)
;(window as any).__logEv = !!params.get('events') // ?events=1 : journalise les evenements d'entree (diagnostic)
let current = params.get('story') ?? ''
let vpName = params.get('vp') ?? (meta as any)?.viewport ?? 'Desktop'
let controlValues: Record<string, any> = {}
let dispose: (() => void) | null = null
let rootApi: ReturnType<typeof createRoot> | null = null
const report: any = ((window as any).__report = { story: '', ok: false, errors: [] as string[], missing: [] as string[] })

function showError(msg: string) {
  errBox.textContent = msg
  report.errors.push(msg)
}
window.addEventListener('error', (e) => {
  // message bénin du navigateur (boucle de redimensionnement), pas une erreur de la story
  if (String(e.message).startsWith('ResizeObserver loop')) return
  showError(String(e.error?.stack ?? e.message))
})
window.addEventListener('unhandledrejection', (e) => showError('Promise rejetee: ' + String((e.reason as any)?.stack ?? e.reason)))

function renderSidebar() {
  side.innerHTML = '<h4>Stories (' + entries.length + ')</h4>'
  for (const e of entries) {
    const a = document.createElement('a')
    a.textContent = e.name
    a.className = e.name === current ? 'on' : ''
    a.onclick = () => select(e.name)
    side.appendChild(a)
  }
}

function renderBar(story: any) {
  bar.innerHTML = ''
  for (const n of Object.keys(VIEWPORTS)) {
    const b = document.createElement('button')
    b.textContent = n
    b.className = n === vpName ? 'on' : ''
    b.onclick = () => { vpName = n; select(current, false) }
    bar.appendChild(b)
  }
  const ctl = document.createElement('div')
  ctl.id = 'controls'
  for (const [k, c] of Object.entries<any>(story?.controls ?? {})) {
    const l = document.createElement('label')
    l.textContent = k + ' '
    let input: HTMLInputElement | HTMLSelectElement
    if (c.ControlType === 'Boolean') {
      input = document.createElement('input'); input.type = 'checkbox'; input.checked = !!controlValues[k]
      input.onchange = () => { controlValues[k] = (input as HTMLInputElement).checked; draw(story) }
    } else if (c.ControlType === 'Number') {
      input = document.createElement('input'); input.type = 'range'
      input.min = String(c.Min ?? 0); input.max = String(c.Max ?? 100); input.step = String(c.Step ?? 1); input.value = String(controlValues[k])
      input.oninput = () => { controlValues[k] = Number(input.value); draw(story) }
    } else if (c.ControlType === 'Choose') {
      input = document.createElement('select')
      for (const o of c.Options) { const op = document.createElement('option'); op.textContent = String(o); input.appendChild(op) }
      input.value = String(controlValues[k]); input.onchange = () => { controlValues[k] = input.value; draw(story) }
    } else {
      input = document.createElement('input'); input.type = 'text'; input.value = String(controlValues[k] ?? '')
      input.oninput = () => { controlValues[k] = input.value; draw(story) }
    }
    l.appendChild(input)
    ctl.appendChild(l)
  }
  bar.appendChild(ctl)
}

function draw(story: any) {
  dispose?.()
  rootApi?.unmount()
  vp.innerHTML = ''
  const [w, h] = VIEWPORTS[vpName] ?? VIEWPORTS.Desktop
  vp.style.width = w + 'px'
  vp.style.height = h + 'px'
  const bg = BACKGROUNDS[(meta as any)?.background ?? '']
  if (bg) vp.style.background = bg
  setViewportSize(w, h)
  const stage = $('stage')
  const fit = params.get('fit') !== '0'
  ;(vp.style as any).zoom = fit ? String(Math.min(1, (stage.clientWidth - 32) / w, (stage.clientHeight - 32) / h)) : '1'
  const target = createInstance('ScreenGui')
  target.Name = 'StoryTarget'
  ;(window as any).__tree = (depth = 4) => {
    const walk = (i: any, d: number): any => ({ c: i.ClassName, n: i.Name, k: d >= depth ? i._children.length : i._children.map((x: any) => walk(x, d + 1)) })
    return walk(target, 0)
  }
  dispose = params.get('nodom') ? null : mount(target, vp) // ?nodom=1 : interrupteur de diagnostic
  rootApi = createRoot(target)
  const Comp = story.story
  rootApi.render(React.createElement(Comp, { controls: { ...controlValues }, target, subscribe: () => {}, converted: {} }))
}

async function select(name: string, reset = true) {
  current = name
  errBox.textContent = ''
  report.story = name
  report.errors = []
  renderSidebar()
  const e = entries.find((x) => x.name === name)
  if (!e) return
  try {
    const mod = await modules[e.key]()
    const story = mod.default
    if (reset) { controlValues = {}; for (const [k, c] of Object.entries<any>(story.controls ?? {})) controlValues[k] = c.Default }
    renderBar(story)
    draw(story)
    setTimeout(() => { report.ok = report.errors.length === 0; report.missing = [...MISSING] }, 800)
  } catch (err: any) {
    showError('Import/rendu impossible: ' + String(err?.stack ?? err))
    report.ok = false
  }
}

// Lanceur de test : rend chaque story, attend, et renvoie un resume (erreurs, doublures manquantes, nombre de noeuds).
;(window as any).__runAll = async (wait = 1500) => {
  const out: any[] = []
  for (const e of entries) {
    MISSING.clear()
    await select(e.name)
    await new Promise((r) => setTimeout(r, wait))
    out.push({
      story: e.name,
      nodes: vp.querySelectorAll('.rbx').length,
      errors: [...new Set<string>(report.errors.map((x: string) => x.split('\n')[0].slice(0, 200)))],
      missing: [...MISSING],
    })
  }
  return out
}
;(window as any).__select = select
;(window as any).__missing = (clear = false) => { const a = [...MISSING]; if (clear) MISSING.clear(); return a }

// Mode automatique (?auto=1) pour un navigateur sans fenetre : ecrit le bilan dans <pre id="__result">.
if (params.get('auto')) {
  ;(async () => {
    await new Promise((r) => setTimeout(r, 500))
    const res = await (window as any).__runAll(Number(params.get('wait') ?? 400))
    const pre = document.createElement('pre')
    pre.id = '__result'
    pre.textContent = JSON.stringify(res)
    document.body.appendChild(pre)
  })()
}

renderSidebar()
renderBar(null)
if (current) select(current)
