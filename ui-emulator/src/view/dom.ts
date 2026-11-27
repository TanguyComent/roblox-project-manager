// Projection du modele d'Instances Roblox vers le DOM (moteur de mise en page approximatif).
import { toCssColor, Vector2, Vector3, UDim, UDim2 } from '../rbx/datatypes'
import { Enum } from '../rbx/enums'
import { INPUT_EVENTS } from '../rbx/instance'

interface Node {
  inst: any
  el: HTMLElement
  content: HTMLElement
  txt?: HTMLElement
  txtStroke?: HTMLElement // calque du contour du texte, sous le remplissage
  vOffEm?: number // decalage vertical (en em) qui centre les capitales de la police utilisee
  aspect?: { ratio: number; type: string; axis: string }
  aspectRO?: ResizeObserver
  textKey?: string
  watcher: (i: any, prop: string) => void
  mods: Set<any>
  folders?: Set<any>
  ro?: ResizeObserver
  contentRO?: ResizeObserver
  scrollSentinel?: HTMLElement
  padRO?: ResizeObserver
  autoSize?: string // axes AutomaticSize ajustes par etendue des enfants (X, Y ou XY)
  autoW?: number
  autoH?: number
  cornerPx?: number // dernier rayon exact calcule (reutilise entre deux applications du style)
  cornerKey?: string
  cornerScale?: number
  cornerOffset?: number
}

const NODES = new WeakMap<object, Node>()
const BYEL = new WeakMap<HTMLElement, Node>()
const MODWATCH = new WeakMap<object, (i: any, p: string) => void>()

const TEXT_CLASSES = new Set(['TextLabel', 'TextButton', 'TextBox'])
const IMAGE_CLASSES = new Set(['ImageLabel', 'ImageButton'])

const isGui = (i: any) => i.IsA('GuiObject')
const isRoot = (i: any) => i.IsA('LayerCollector')
const isUI = (i: any) => i.IsA('UIComponent')

// Echelle nulle -> pixels purs (un pourcentage dans un conteneur AutomaticSize serait ignore : dimension "cyclique").
const udim = (d: { Scale: number; Offset: number }) =>
  d.Scale === 0 ? `${d.Offset}px` : d.Offset === 0 ? `${d.Scale * 100}%` : `calc(${d.Scale * 100}% + ${d.Offset}px)`
const px = (n: number) => `${n}px`

function layoutOf(parent: any) {
  for (const c of parent._children) if (c.ClassName === 'UIListLayout' || c.ClassName === 'UIGridLayout') return c
  return null
}
function modsOf(inst: any) {
  const m: Record<string, any> = {}
  const strokes: any[] = []
  for (const c of inst._children) {
    if (!isUI(c)) continue
    if (c.ClassName === 'UIStroke') strokes.push(c)
    else m[c.ClassName] = c
  }
  return { m, strokes }
}

// Centrage vertical du texte. Un navigateur place le texte d'apres la LIGNE DE BASE et les metriques de la police ; Roblox centre
// visuellement la hauteur des capitales dans la zone de texte. Pour chaque police on calcule donc (avec un canvas) le decalage
// qui amene le centre des capitales au centre de la ligne : (hauteur des capitales - ascendante + descendante) / 2, en em.
// Ca corrige l'ecart propre a une police de remplacement, et reste exact avec la vraie police une fois installee.
const VOFF = new Map<string, number>()
let vOffCtx: CanvasRenderingContext2D | null = null
function textVOffsetEm(family: string, weight: number, italic: boolean): number {
  const key = `${family}|${weight}|${italic}`
  let v = VOFF.get(key)
  if (v === undefined) {
    vOffCtx = vOffCtx ?? document.createElement('canvas').getContext('2d')
    if (!vOffCtx) return 0
    vOffCtx.font = `${italic ? 'italic ' : ''}${weight} 100px ${family}`
    const m = vOffCtx.measureText('H')
    v = (m.actualBoundingBoxAscent - m.fontBoundingBoxAscent + m.fontBoundingBoxDescent) / 2 / 100
    if (!Number.isFinite(v)) v = 0
    VOFF.set(key, v)
  }
  return v
}

function fontCss(inst: any) {
  const ff = inst.FontFace
  let family = 'Arial, sans-serif'
  let weight = 400
  const name: string = ff ? String(ff.Family) : 'enum:' + (inst.Font?.Name ?? 'Legacy')
  const n = name.toLowerCase()
  if (n.includes('gotham')) { family = '"Montserrat","Gotham","Segoe UI",sans-serif'; weight = n.includes('black') ? 900 : n.includes('bold') ? 700 : n.includes('semibold') ? 600 : n.includes('medium') ? 500 : 400 }
  else if (n.includes('builder')) { family = '"Nunito Sans","Segoe UI",sans-serif'; weight = n.includes('bold') ? 700 : n.includes('extra') ? 800 : 500 }
  else if (n.includes('sourcesans')) { family = '"Source Sans Pro","Segoe UI",sans-serif'; weight = n.includes('bold') ? 700 : n.includes('semibold') ? 600 : n.includes('light') ? 300 : 400 }
  else if (n.includes('fredoka') || n.includes('cartoon')) { family = '"Fredoka","Comic Sans MS",cursive'; weight = 600 }
  else if (n.includes('oswald')) { family = '"Oswald","Impact",sans-serif'; weight = 600 }
  else if (n.includes('robotomono') || n.includes('code')) family = 'ui-monospace,Consolas,monospace'
  else if (n.includes('merriweather') || n.includes('antique')) family = 'Georgia,serif'
  if (ff?.Weight?.Name) {
    const w: Record<string, number> = { Thin: 100, ExtraLight: 200, Light: 300, Regular: 400, Medium: 500, SemiBold: 600, Bold: 700, ExtraBold: 800, Heavy: 900 }
    weight = w[ff.Weight.Name] ?? weight
  }
  return { family, weight, italic: ff?.Style?.Name === 'Italic' }
}

function richToHtml(src: string) {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const unesc = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
  let out = ''
  const stack: string[] = []
  const re = /<(\/?)(\w+)([^>]*)>/g
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(src))) {
    out += esc(src.slice(last, m.index))
    last = m.index + m[0].length
    const [, close, tag, attrs] = m
    const t = tag.toLowerCase()
    if (close) { if (stack.length) out += stack.pop() ; continue }
    if (t === 'br') { out += '<br/>'; continue }
    let style = ''
    let wrap = 'span'
    if (t === 'b') style = 'font-weight:700'
    else if (t === 'i') style = 'font-style:italic'
    else if (t === 'u') wrap = 'u'
    else if (t === 's') wrap = 's'
    else if (t === 'font') {
      const col = /color\s*=\s*"([^"]+)"/.exec(attrs)?.[1]
      const size = /size\s*=\s*"(\d+)"/.exec(attrs)?.[1]
      const weight = /weight\s*=\s*"([^"]+)"/.exec(attrs)?.[1]
      if (col && /^[#\w(),.\s%]+$/.test(col)) style += `color:${col};`
      if (size) style += `font-size:${size}px;`
      if (weight) style += `font-weight:${weight};`
    } else if (t === 'uppercase') style = 'text-transform:uppercase'
    out += `<${wrap} style="${style}">`
    stack.push(`</${wrap}>`)
  }
  out += esc(src.slice(last))
  while (stack.length) out += stack.pop()
  void unesc
  return out
}

function gradientCss(g: any, base: any, baseAlpha: number) {
  const ck = g.Color.Keypoints
  const tk = g.Transparency.Keypoints
  const times = [...new Set([...ck.map((k: any) => k.Time), ...tk.map((k: any) => k.Time)])].sort((a: any, b: any) => a - b) as number[]
  const at = (kps: any[], t: number, get: (k: any) => any, mix: (a: any, b: any, f: number) => any) => {
    let prev = kps[0], next = kps[kps.length - 1]
    for (let i = 0; i < kps.length; i++) { if (kps[i].Time <= t) prev = kps[i]; if (kps[i].Time >= t) { next = kps[i]; break } }
    const f = next.Time === prev.Time ? 0 : (t - prev.Time) / (next.Time - prev.Time)
    return mix(get(prev), get(next), f)
  }
  const stops = times.map((t) => {
    const c = at(ck, t, (k) => k.Value, (a, b, f) => a.Lerp(b, f))
    const tr = at(tk, t, (k) => k.Value, (a, b, f) => a + (b - a) * f)
    const col = { R: c.R * base.R, G: c.G * base.G, B: c.B * base.B }
    return `${toCssColor(col as any, (1 - tr) * baseAlpha)} ${t * 100}%`
  })
  return `linear-gradient(${g.Rotation + 90}deg, ${stops.join(',')})`
}

function build(inst: any): Node | null {
  if (!isGui(inst) && !isRoot(inst)) {
    if (isUI(inst)) watchMod(inst)
    return null
  }
  const el = document.createElement('div')
  el.className = 'rbx'
  const content = document.createElement('div')
  content.className = 'content'
  el.appendChild(content)
  const node: Node = { inst, el, content, mods: new Set(), watcher: (i, p) => onChange(i, p) }
  if (TEXT_CLASSES.has(inst.ClassName)) {
    node.txtStroke = document.createElement('div')
    node.txtStroke.className = 'txt txts'
    el.insertBefore(node.txtStroke, content)
    node.txt = document.createElement('div')
    node.txt.className = 'txt'
    el.insertBefore(node.txt, content)
  }
  NODES.set(inst, node)
  BYEL.set(el, node)
  inst._watchers.add(node.watcher)
  inst._measure = () => {
    const r = el.getBoundingClientRect()
    const root = el.closest('#viewport')?.getBoundingClientRect()
    return { w: el.offsetWidth || r.width, h: el.offsetHeight || r.height, x: r.left - (root?.left ?? 0), y: r.top - (root?.top ?? 0) }
  }
  inst._contentMeasure = () => ({ w: content.scrollWidth, h: content.scrollHeight })
  el.dataset.name = inst.Name
  el.dataset.cls = inst.ClassName
  wireEvents(node)
  syncChildren(node)
  applyStyle(node)
  return node
}

const LAYOUT_MODS = new Set(['UIListLayout', 'UIGridLayout', 'UITableLayout', 'UIPageLayout', 'UIPadding'])

function watchMod(inst: any) {
  if (MODWATCH.has(inst)) return
  const w = (_i?: any, prop?: string) => {
    const p = inst.Parent
    const pn = p && NODES.get(p)
    if (prop === 'observeContent') { if (pn) ensureContentRO(pn, inst); return }
    if (pn) {
      applyStyle(pn)
      // Seuls les modificateurs de mise en page changent le style des ENFANTS (UIScale, UICorner, UIStroke... ne concernent que le parent :
      // les re-appliquer sur tous les enfants a chaque image d'une animation d'echelle etait lent et faisait clignoter leurs coins).
      if (LAYOUT_MODS.has(inst.ClassName)) for (const c of pn.inst._children) { const cn = NODES.get(c); if (cn) applyStyle(cn) }
    }
  }
  MODWATCH.set(inst, w)
  inst._watchers.add(w)
}

function unmountNode(n: Node) {
  n.inst._watchers.delete(n.watcher)
  n.ro?.disconnect()
  NODES.delete(n.inst)
  for (const c of Array.from(n.content.children) as HTMLElement[]) { const cn = BYEL.get(c); if (cn) unmountNode(cn) }
}

// Un Folder est transparent pour l'interface : ses enfants s'affichent comme s'ils etaient ceux du parent GUI.
const FOLDERWATCH = new WeakMap<object, (i: any, p: string) => void>()
function guiParent(inst: any) {
  let p = inst.Parent
  while (p && p.ClassName === 'Folder') p = p.Parent
  return p
}
function flatChildren(inst: any, folders: Set<any>): any[] {
  const out: any[] = []
  for (const c of inst._children) {
    if (c.ClassName === 'Folder') { folders.add(c); out.push(...flatChildren(c, folders)) } else out.push(c)
  }
  return out
}
function watchFolder(f: any) {
  if (FOLDERWATCH.has(f)) return
  const w = (_i: any, prop: string) => {
    if (prop !== 'children' && prop !== 'parent') return
    const gp = guiParent(f)
    const gn = gp && NODES.get(gp)
    if (gn) { syncChildren(gn); applyStyle(gn) }
  }
  FOLDERWATCH.set(f, w)
  f._watchers.add(w)
}

function syncChildren(node: Node) {
  trace('syncChildren', node.inst.ClassName + ':' + node.inst.Name + ' children=' + node.inst._children.length)
  const wanted: HTMLElement[] = []
  const mods = new Set<any>()
  const folders = new Set<any>()
  const flat = flatChildren(node.inst, folders)
  for (const f of folders) watchFolder(f)
  for (const f of node.folders ?? []) if (!folders.has(f)) { const w = FOLDERWATCH.get(f); if (w) { f._watchers.delete(w); FOLDERWATCH.delete(f) } }
  node.folders = folders
  for (const c of flat) {
    if (isUI(c)) { mods.add(c); watchMod(c); continue }
    let cn = NODES.get(c)
    if (!cn) cn = build(c) ?? undefined
    if (cn) wanted.push(cn.el)
  }
  for (const m of node.mods) if (!mods.has(m)) { const w = MODWATCH.get(m); if (w) { m._watchers.delete(w); MODWATCH.delete(m) } }
  node.mods = mods
  for (const el of Array.from(node.content.children) as HTMLElement[]) {
    if (!wanted.includes(el)) { const cn = BYEL.get(el); if (cn) unmountNode(cn); el.remove() }
  }
  wanted.forEach((el, i) => { if (node.content.children[i] !== el) node.content.insertBefore(el, node.content.children[i] ?? null) })
  if (node.contentRO) for (const el of wanted) node.contentRO.observe(el)
  for (const el of wanted) { const cn = BYEL.get(el); if (cn) applyStyle(cn) }
}

// AbsoluteContentSize : on observe le conteneur ET chacun de ses enfants, puis on declenche le signal de la liste.
function ensureContentRO(node: Node, layout: any) {
  const fire = () => layout.getSignal('prop:AbsoluteContentSize').Fire()
  if (!node.contentRO) {
    node.contentRO = new ResizeObserver(fire)
    node.contentRO.observe(node.content)
  }
  for (const ch of Array.from(node.content.children) as HTMLElement[]) node.contentRO.observe(ch)
  requestAnimationFrame(fire)
}

function onChange(inst: any, prop: string) {
  const node = NODES.get(inst)
  if (!node) return
  if (prop === 'destroyed') return
  if (prop === 'observeSize') { ensureRO(node); return }
  if (prop === 'observeInput') { applyStyle(node); return } // quelqu'un s'abonne a un evenement d'entree : l'element devient cliquable
  if (prop === 'children') { syncChildren(node); applyStyle(node); return }
  if (prop === 'parent') { applyStyle(node); return }
  applyStyle(node)
  const gp = guiParent(inst)
  if (gp && (prop === 'Size' || prop === 'AutomaticSize')) { const pn = NODES.get(gp); if (pn && layoutOf(gp)) applyStyle(pn) }
}

function ensureRO(node: Node) {
  if (node.ro) return
  if (new URLSearchParams(location.search).get('nort')) return // interrupteur de diagnostic
  node.ro = new ResizeObserver(() => {
    fitText(node)
    updateCorner(node)
    node.inst._signals.get('prop:AbsoluteSize')?.Fire()
    node.inst._signals.get('prop:AbsolutePosition')?.Fire()
  })
  node.ro.observe(node.el)
}

// Passage "apres mise en page" : ajuste le texte (TextScaled) et le rayon des coins une fois les tailles connues.
// Il se repete sur quelques images, car les tailles peuvent encore changer juste apres (contraintes de ratio, etc.) et
// l'observateur de taille ne rattrape pas toujours ces changements.
const POST = new Set<Node>()
let postFrames = 0
let postScheduled = false
function postLayout(node: Node) {
  POST.add(node)
  postFrames = 4
  if (!postScheduled) { postScheduled = true; requestAnimationFrame(runPost) }
}
function runPost() {
  postScheduled = false
  for (const n of POST) {
    if (!n.el.isConnected) { POST.delete(n); continue }
    fitAuto(n)
    fitText(n)
    updateCorner(n)
    if (n.inst.ClassName === 'ScrollingFrame') { fitScrollPad(n); syncScroll(n) }
  }
  if (--postFrames > 0) { postScheduled = true; requestAnimationFrame(runPost) } else POST.clear()
}

// AutomaticSize : taille = etendue des enfants (tels que positionnes, ancres comprises) + marges UIPadding, jamais moins que Size.
function fitAuto(node: Node) {
  const a = node.autoSize
  if (!a) return
  const { el, content: c } = node
  let w = 0
  let h = 0
  for (const ch of Array.from(c.children) as HTMLElement[]) {
    if (ch.style.display === 'none') continue
    // Mesures de MISE EN PAGE (offset*), pas de rectangles ecran : ces derniers incluent les transformations (UIScale d'un
    // ancetre, rotation) alors que la largeur a ecrire est en pixels de mise en page. On retire a la main l'ancrage de l'enfant.
    const cn = BYEL.get(ch)
    const ax = cn?.inst.AnchorPoint?.X ?? 0
    const ay = cn?.inst.AnchorPoint?.Y ?? 0
    w = Math.max(w, ch.offsetLeft - ax * ch.offsetWidth + ch.offsetWidth)
    h = Math.max(h, ch.offsetTop - ay * ch.offsetHeight + ch.offsetHeight)
  }
  const pl = parseFloat(c.style.left) || 0
  const pr = parseFloat(c.style.right) || 0
  const pt = parseFloat(c.style.top) || 0
  const pb = parseFloat(c.style.bottom) || 0
  if (a.includes('X') && w > 0) { node.autoW = Math.ceil(w + pl + pr); el.style.width = px(node.autoW) }
  if (a.includes('Y') && h > 0) { node.autoH = Math.ceil(h + pt + pb); el.style.height = px(node.autoH) }
}

// CanvasPosition (ecrite par le code du jeu) -> position de defilement reelle.
function padCss(pad: any, container: boolean): string {
  const v = (u: any) => (container && u?.Scale ? `calc(${u.Scale * 100}cqh + ${u.Offset ?? 0}px)` : udim(u))
  return `${v(pad.PaddingTop)} ${udim(pad.PaddingRight)} ${v(pad.PaddingBottom)} ${udim(pad.PaddingLeft)}`
}

// UIPadding (bas / droite) d'un ScrollingFrame : le canvas a la taille de la fenetre et les enfants debordent ; or le debordement
// CSS ignore le padding de fin. Une sentinelle invisible, placee apres le dernier enfant + padding, etend la zone defilable.
function fitScrollPad(node: Node) {
  const pad = [...node.mods].find((m: any) => m.ClassName === 'UIPadding') as any
  let sent = node.scrollSentinel as HTMLElement | undefined
  const pb = pad ? (pad.PaddingBottom?.Offset ?? 0) + (pad.PaddingBottom?.Scale ?? 0) * node.el.clientHeight : 0
  const pr = pad ? (pad.PaddingRight?.Offset ?? 0) + (pad.PaddingRight?.Scale ?? 0) * node.el.clientWidth : 0
  if (!(pb > 0 || pr > 0)) { sent?.remove(); node.scrollSentinel = undefined; return }
  if (!sent) {
    sent = document.createElement('div')
    Object.assign(sent.style, { position: 'absolute', width: '1px', height: '1px', pointerEvents: 'none', visibility: 'hidden' })
    node.scrollSentinel = sent
  }
  if (sent.parentElement !== node.el) node.el.appendChild(sent)
  let bottom = 0
  let right = 0
  for (const ch of Array.from(node.content.children) as HTMLElement[]) {
    if (ch.style.display === 'none') continue
    bottom = Math.max(bottom, ch.offsetTop + ch.offsetHeight)
    right = Math.max(right, ch.offsetLeft + ch.offsetWidth)
  }
  sent.style.top = px(Math.max(0, bottom + pb - 1))
  sent.style.left = px(Math.max(0, right + pr - 1))
}

function syncScroll(node: Node) {
  const cp = node.inst.CanvasPosition
  if (!cp) return
  if (Math.abs(node.el.scrollLeft - cp.X) > 1) node.el.scrollLeft = cp.X
  if (Math.abs(node.el.scrollTop - cp.Y) > 1) node.el.scrollTop = cp.Y
}

function updateCorner(node: Node) {
  if (node.cornerScale === undefined) return
  // Taille de MISE EN PAGE (offsetWidth/Height), pas getBoundingClientRect : ce dernier inclut transform (UIScale, rotation) et
  // fausserait le rayon d'un bouton presse (echelle appliquee deux fois).
  const m = Math.min(node.el.offsetWidth, node.el.offsetHeight)
  if (m === 0) return // pas encore mis en page : on garde le pourcentage pose par applyStyle
  const radius = (node.cornerScale as number) * m + (node.cornerOffset ?? 0)
  node.cornerPx = radius
  node.cornerKey = `${node.cornerScale}|${node.cornerOffset ?? 0}`
  node.el.style.borderRadius = px(radius)
}

function fitText(node: Node) {
  const { inst, txt } = node
  if (!txt || !inst.TextScaled) return
  const max = Math.min(inst._children.find((c: any) => c.ClassName === 'UITextSizeConstraint')?.MaxTextSize ?? 100, 100)
  const min = inst._children.find((c: any) => c.ClassName === 'UITextSizeConstraint')?.MinTextSize ?? 1
  let lo = min, hi = max
  const w = txt.clientWidth, h = txt.clientHeight
  if (!w || !h) return
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    txt.style.fontSize = px(mid)
    if (txt.scrollWidth <= w + 1 && txt.scrollHeight <= h + 1) lo = mid
    else hi = mid - 1
  }
  txt.style.fontSize = px(lo)
  txt.style.transform = `translateY(${(node.vOffEm ?? 0) * lo}px)`
  if (node.txtStroke) { node.txtStroke.style.fontSize = px(lo); node.txtStroke.style.transform = txt.style.transform }
}

const COUNTS: Record<string, number> = ((globalThis as any).__counts = {})
export function trace(kind: string, label = '') {
  const n = (COUNTS[kind] = (COUNTS[kind] ?? 0) + 1)
  if (n % 1500 === 0) console.log(`[trace] ${kind} #${n} ${label}`)
}

function applyStyle(node: Node) {
  trace('applyStyle', node.inst.ClassName + ':' + node.inst.Name)
  const { inst, el, content } = node
  const s = el.style
  const cs = content.style
  s.cssText = ''
  cs.cssText = ''
  el.dataset.name = inst.Name

  if (isRoot(inst)) {
    Object.assign(s, { position: 'absolute', inset: '0', overflow: 'hidden', pointerEvents: 'none', display: inst.Enabled === false ? 'none' : '' })
    Object.assign(cs, { position: 'absolute', inset: '0', pointerEvents: 'none' })
    return
  }

  const parent = guiParent(inst)
  const pl = parent && isGui(parent) ? layoutOf(parent) : null
  const { m: mods, strokes } = modsOf(inst)
  const cls: string = inst.ClassName
  const auto: string = inst.AutomaticSize?.Name ?? 'None'
  el.dataset.corner = mods.UICorner ? `${mods.UICorner.CornerRadius?.Scale},${mods.UICorner.CornerRadius?.Offset}` : '' // aide au diagnostic

  s.display = inst.Visible === false ? 'none' : ''

  // Entrees : comme dans Roblox, seuls les boutons, les cadres Active, les cadres defilables et ceux qui ecoutent un
  // evenement d'entree captent la souris ; les autres laissent passer. (pointer-events s'herite : on le fixe partout.)
  const wantsInput = [...INPUT_EVENTS].some((n) => inst._signals.has(n))
  const interactive = cls === 'TextButton' || cls === 'ImageButton' || cls === 'TextBox' || cls === 'ScrollingFrame' || inst.Active === true || wantsInput || !!mods.UIDragDetector
  s.pointerEvents = interactive ? 'auto' : 'none'
  cs.pointerEvents = 'none'
  if (mods.UIDragDetector) attachDrag(node, mods.UIDragDetector)
  s.zIndex = String(inst.ZIndex ?? 1)

  // taille
  const size = inst.Size
  let w = udim(size.X)
  let h = udim(size.Y)
  let gridAspect = 0
  if (pl?.ClassName === 'UIGridLayout') {
    w = udim(pl.CellSize.X); h = udim(pl.CellSize.Y)
    // Un UIAspectRatioConstraint enfant de la grille impose le ratio des cellules : la hauteur se deduit de la largeur.
    const gar = pl._children.find((c: any) => c.ClassName === 'UIAspectRatioConstraint')
    if (gar && gar.AspectRatio > 0) { gridAspect = gar.AspectRatio; h = 'auto' }
  }
  if (auto.includes('X')) { s.minWidth = w; w = 'fit-content' }
  if (auto.includes('Y')) { s.minHeight = h; h = 'fit-content' }
  const ar = mods.UIAspectRatioConstraint
  node.aspect = ar ? { ratio: ar.AspectRatio, type: ar.AspectType?.Name ?? 'FitWithinMaxSize', axis: ar.DominantAxis?.Name ?? 'Width' } : undefined
  s.width = w
  s.height = h
  if (gridAspect) s.aspectRatio = String(gridAspect)
  const sc = mods.UISizeConstraint
  if (sc) {
    if (sc.MinSize.X > 0) s.minWidth = px(sc.MinSize.X)
    if (sc.MinSize.Y > 0) s.minHeight = px(sc.MinSize.Y)
    if (Number.isFinite(sc.MaxSize.X)) s.maxWidth = px(sc.MaxSize.X)
    if (Number.isFinite(sc.MaxSize.Y)) s.maxHeight = px(sc.MaxSize.Y)
  }

  // position / transform
  const ax = inst.AnchorPoint?.X ?? 0
  const ay = inst.AnchorPoint?.Y ?? 0
  let tf = ''
  if (pl) {
    s.position = 'relative'
    s.flex = '0 0 auto'
    s.order = String(pl.SortOrder?.Name === 'Name' ? 0 : inst.LayoutOrder ?? 0)
    // UIFlexItem : comportement de l'element dans l'espace libre de la liste (Fill / Grow / Shrink / Custom)
    const fi = mods.UIFlexItem
    const parentFlex: string | undefined = pl.ClassName === 'UIListLayout' ? (pl.FillDirection?.Name === 'Horizontal' ? pl.HorizontalFlex : pl.VerticalFlex)?.Name : undefined
    if (fi) {
      const mode: string | undefined = fi.FlexMode?.Name
      if (mode === 'Fill') s.flex = '1 1 0%'
      else if (mode === 'Grow') s.flex = `${fi.GrowRatio || 1} 0 auto`
      else if (mode === 'Shrink') s.flex = `0 ${fi.ShrinkRatio || 1} auto`
      else if (mode === 'Custom') s.flex = `${fi.GrowRatio || 0} ${fi.ShrinkRatio || 0} auto`
    } else if (parentFlex === 'Fill') s.flex = '1 1 auto'
  } else {
    s.position = 'absolute'
    s.left = udim(inst.Position.X)
    s.top = udim(inst.Position.Y)
    if (ax || ay) tf += `translate(${-ax * 100}%, ${-ay * 100}%) ` // l'AnchorPoint tombe sur (left, top)
  }
  // Roblox : la rotation pivote autour du CENTRE de l'element ; UIScale agrandit/reduit autour de l'AnchorPoint (point fixe).
  // Dans une liste (AnchorPoint ignore) UIScale agit depuis le centre. On compose donc explicitement avec `transform-origin: 0 0`.
  if (inst.Rotation) tf += `translate(50%, 50%) rotate(${inst.Rotation}deg) translate(-50%, -50%) `
  const uiScale = mods.UIScale ? mods.UIScale.Scale : 1
  if (uiScale !== 1) {
    const ox = (pl ? 0.5 : ax) * 100
    const oy = (pl ? 0.5 : ay) * 100
    tf += `translate(${ox}%, ${oy}%) scale(${uiScale}) translate(${-ox}%, ${-oy}%) `
  }
  if (tf) s.transform = tf.trim()
  s.transformOrigin = '0 0'

  // fond / bordure
  const bgT = cls === 'CanvasGroup' ? inst.BackgroundTransparency : inst.BackgroundTransparency ?? 0
  const baseAlpha = 1 - (bgT ?? 0)
  const grad = mods.UIGradient && mods.UIGradient.Enabled !== false ? mods.UIGradient : null
  if (baseAlpha > 0) {
    if (grad) s.background = gradientCss(grad, inst.BackgroundColor3, baseAlpha)
    else s.backgroundColor = toCssColor(inst.BackgroundColor3, baseAlpha)
  }
  // Dans Roblox la bordure suit la transparence du fond : BackgroundTransparency = 1 masque aussi la bordure.
  if ((inst.BorderSizePixel ?? 0) > 0 && baseAlpha > 0) { s.outline = `${inst.BorderSizePixel}px solid ${toCssColor(inst.BorderColor3, baseAlpha)}`; s.outlineOffset = '0' }
  if (inst.ClipsDescendants || cls === 'CanvasGroup') s.overflow = 'hidden'
  // GuiObject.Transparency : s'applique a l'objet et a tous ses descendants (en plus de GroupTransparency pour un CanvasGroup).
  const groupT = cls === 'CanvasGroup' ? inst.GroupTransparency || 0 : 0
  const objT = typeof inst.Transparency === 'number' ? inst.Transparency : 0
  if (groupT || objT) s.opacity = String((1 - groupT) * (1 - objT))
  if (cls === 'ScrollingFrame') {
    const dir: string = inst.ScrollingDirection?.Name ?? 'XY'
    const on = inst.ScrollingEnabled !== false
    s.overflowX = on && dir.includes('X') ? 'auto' : 'hidden'
    s.overflowY = on && dir.includes('Y') ? 'auto' : 'hidden'
    s.scrollbarWidth = inst.ScrollBarThickness > 0 ? 'thin' : 'none'
    s.overscrollBehavior = 'contain'
    postLayout(node) // applique CanvasPosition une fois la taille du canvas connue
  }
  if (cls === 'TextButton' || cls === 'ImageButton') s.cursor = 'pointer'

  // coins arrondis
  node.cornerScale = undefined
  if (mods.UICorner) {
    const cr = mods.UICorner.CornerRadius
    // Echelle >= 0.5 : la moitie de la plus petite dimension ou plus = rond / pilule, quelle que soit la taille (pas de mesure).
    if (cr.Scale >= 0.5) s.borderRadius = '9999px'
    else if (cr.Scale > 0) {
      node.cornerScale = cr.Scale
      node.cornerOffset = cr.Offset
      ensureRO(node)
      // Rayon exact (= echelle x plus petite dimension), calcule apres la mise en page. Une fois connu il est REUTILISE a chaque
      // application du style : sinon une animation (UIScale d'un bouton presse) le remettrait en pourcentage -> coins elliptiques.
      const key = `${cr.Scale}|${cr.Offset}`
      s.borderRadius = node.cornerPx !== undefined && node.cornerKey === key ? px(node.cornerPx) : `${cr.Scale * 100}%`
      postLayout(node)
    }
    else s.borderRadius = px(cr.Offset)
  }

  // contours (UIStroke) : sur du texte -> contour du texte, sinon halo autour du cadre
  const textStrokes = strokes.filter((st) => st.Enabled !== false && TEXT_CLASSES.has(cls) && st.ApplyStrokeMode?.Name !== 'Border')
  const frameStrokes = strokes.filter((st) => st.Enabled !== false && !textStrokes.includes(st))
  if (frameStrokes.length) {
    // BorderStrokePosition : Outer (defaut, hors du cadre), Inner (a l'interieur) ou Center (a cheval)
    s.boxShadow = frameStrokes.map((st) => {
      const t = st.Thickness
      const col = toCssColor(st.Color, 1 - st.Transparency)
      const pos = st.BorderStrokePosition?.Name ?? 'Outer'
      return pos === 'Inner' ? `inset 0 0 0 ${t}px ${col}` : pos === 'Center' ? `0 0 0 ${t / 2}px ${col}, inset 0 0 0 ${t / 2}px ${col}` : `0 0 0 ${t}px ${col}`
    }).join(',')
  }

  // contenu : padding + mise en page
  const pad = mods.UIPadding
  // Padding haut/bas en echelle : Roblox le rapporte a la HAUTEUR, alors que le padding CSS en % se rapporte toujours a la largeur.
  // On passe par des unites de conteneur (cqh) : l'element devient un conteneur de taille (seulement s'il n'est pas AutomaticSize).
  const padVertScale = !!pad && (!!pad.PaddingTop?.Scale || !!pad.PaddingBottom?.Scale)
  if (padVertScale && auto === 'None') s.containerType = 'size'
  const lay = mods.UIListLayout ?? mods.UIGridLayout
  const isScroll = cls === 'ScrollingFrame'
  if (auto !== 'None' && lay) {
    // AutomaticSize avec liste/grille : les enfants sont dans le flux, le conteneur s'ajuste naturellement
    cs.position = 'relative'
    if (pad) cs.padding = padCss(pad, padVertScale && auto === 'None')
  } else if (isScroll) {
    // AutomaticCanvasSize : le canvas grandit avec son contenu (liste/grille en flux) au lieu d'une taille fixe.
    const ac: string = inst.AutomaticCanvasSize?.Name ?? 'None'
    cs.position = 'relative'
    // Roblox : les tailles en echelle des enfants (cellules d'une grille, etc.) se rapportent a la FENETRE visible. On garde donc
    // un canvas de la taille de la fenetre (dimension definie) et les enfants debordent ; la zone defilable les inclut.
    cs.width = ac.includes('X') ? '100%' : udim(inst.CanvasSize.X)
    cs.height = ac.includes('Y') ? '100%' : udim(inst.CanvasSize.Y)
    cs.minWidth = '100%'
    cs.minHeight = '100%'
    if (pad) {
      // la zone defilable doit inclure le padding du bas : on la recalcule des que le contenu change de taille
      if (!node.padRO) node.padRO = new ResizeObserver(() => postLayout(node))
      node.padRO.observe(node.content)
      for (const ch of Array.from(node.content.children) as HTMLElement[]) node.padRO.observe(ch)
      postLayout(node)
    }
    if (pad) cs.padding = padCss(pad, padVertScale && auto === 'None')
  } else {
    cs.position = 'absolute'
    cs.left = pad ? udim(pad.PaddingLeft) : '0'
    cs.right = pad ? udim(pad.PaddingRight) : '0'
    cs.top = pad ? udim(pad.PaddingTop) : '0'
    cs.bottom = pad ? udim(pad.PaddingBottom) : '0'
  }
  // AutomaticSize SANS liste : la taille vient de l'ETENDUE des enfants (positionnes librement), calculee apres la mise en page.
  // La derniere valeur est reutilisee entre deux applications du style pour eviter un clignotement.
  node.autoSize = auto !== 'None' && !lay && !node.txt ? auto : undefined
  if (node.autoSize) {
    if (node.autoW !== undefined && node.autoSize.includes('X')) s.width = px(node.autoW)
    if (node.autoH !== undefined && node.autoSize.includes('Y')) s.height = px(node.autoH)
    postLayout(node)
  }
  if (lay) {
    const horizontalFill = lay.FillDirection?.Name === 'Horizontal'
    const al = (n: string, a: Record<string, string>) => a[n] ?? 'flex-start'
    const hz = al(lay.HorizontalAlignment?.Name, { Left: 'flex-start', Center: 'center', Right: 'flex-end' })
    const vt = al(lay.VerticalAlignment?.Name, { Top: 'flex-start', Center: 'center', Bottom: 'flex-end' })
    cs.display = 'flex'
    cs.flexDirection = horizontalFill ? 'row' : 'column'
    if (lay.ClassName === 'UIListLayout') {
      cs.gap = udim(lay.Padding)
      cs.justifyContent = horizontalFill ? hz : vt
      cs.alignItems = horizontalFill ? vt : hz
      if (lay.Wraps) cs.flexWrap = 'wrap'
      // HorizontalFlex / VerticalFlex (UIFlexAlignment) : repartition de l'espace libre sur l'axe concerne.
      const flexMain: string | undefined = (horizontalFill ? lay.HorizontalFlex : lay.VerticalFlex)?.Name
      const flexCross: string | undefined = (horizontalFill ? lay.VerticalFlex : lay.HorizontalFlex)?.Name
      const SPACE: Record<string, string> = { SpaceBetween: 'space-between', SpaceAround: 'space-around', SpaceEvenly: 'space-evenly' }
      if (flexMain && SPACE[flexMain]) cs.justifyContent = SPACE[flexMain]
      if (flexCross === 'Fill') cs.alignItems = 'stretch'
    } else {
      cs.flexWrap = 'wrap'
      cs.gap = `${udim(lay.CellPadding.Y)} ${udim(lay.CellPadding.X)}`
      cs.justifyContent = hz
      cs.alignContent = vt
      cs.alignItems = 'flex-start'
    }
    if (lay.SortOrder?.Name === 'Name') {
      const sorted = [...inst._children].filter((c: any) => !isUI(c)).sort((a: any, b: any) => (a.Name < b.Name ? -1 : 1))
      sorted.forEach((c: any, i: number) => { const cn = NODES.get(c); if (cn) cn.el.style.order = String(i) })
    }
  }

  // texte
  if (node.txt) {
    const t = node.txt
    const ts = t.style
    ts.cssText = ''
    const rich = !!inst.RichText
    const key = (rich ? 'R:' : 'T:') + (inst.Text ?? '')
    if (node.textKey !== key) { node.textKey = key; if (rich) t.innerHTML = richToHtml(inst.Text ?? ''); else t.textContent = inst.Text ?? '' }
    const f = fontCss(inst)
    const xa = inst.TextXAlignment?.Name ?? 'Center'
    const ya = inst.TextYAlignment?.Name ?? 'Center'
    Object.assign(ts, {
      fontFamily: f.family, fontWeight: String(f.weight), fontStyle: f.italic ? 'italic' : 'normal',
      fontSize: px(inst.TextSize ?? 14), color: toCssColor(inst.TextColor3, 1 - (inst.TextTransparency ?? 0)),
      lineHeight: String(inst.LineHeight ?? 1), whiteSpace: inst.TextWrapped || inst.TextScaled ? 'pre-wrap' : 'pre',
      justifyContent: xa === 'Left' ? 'flex-start' : xa === 'Right' ? 'flex-end' : 'center',
      alignItems: ya === 'Top' ? 'flex-start' : ya === 'Bottom' ? 'flex-end' : 'center',
      textAlign: xa === 'Left' ? 'left' : xa === 'Right' ? 'right' : 'center', overflowWrap: 'anywhere',
    } as any)
    t.style.flexWrap = 'wrap'
    node.vOffEm = textVOffsetEm(f.family, f.weight, f.italic)
    ts.transform = `translateY(${node.vOffEm * (inst.TextSize ?? 14)}px)` // centrage vertical des capitales (voir textVOffsetEm)
    // AutomaticSize sur un texte : l'element doit s'ajuster A son texte. Le calque de texte entre donc dans le flux (sinon il est
    // superpose, ne compte pas dans la taille et l'element reste a sa taille minimale, texte deborde).
    if (auto !== 'None') {
      ts.position = 'relative'
      ts.inset = 'auto'
      // L'axe qui n'est PAS automatique garde la taille de l'element : le calque doit la remplir pour que l'alignement du texte
      // (centre, haut, bas) s'applique dans toute la zone, sinon le texte reste colle en haut / a gauche.
      if (!auto.includes('Y')) ts.height = '100%'
      if (!auto.includes('X')) ts.width = '100%'
    }
    if (pad) ts.padding = padCss(pad, padVertScale && auto === 'None')
    // Contour du texte (UIStroke Contextual ou TextStrokeTransparency) : calque separe SOUS le remplissage. Le texte par-dessus
    // masque la moitie interieure du trait, il reste donc un contour exterieur de `Thickness` pixels, et le remplissage
    // (couleur unie ou degrade) n'est jamais recouvert par le contour.
    const st0 = textStrokes.find((st) => st.Transparency < 1)
    let strokeColor: string | undefined
    let strokeW = 0
    if (st0) { strokeColor = toCssColor(st0.Color, 1 - st0.Transparency); strokeW = st0.Thickness }
    else if ((inst.TextStrokeTransparency ?? 1) < 1) { strokeColor = toCssColor(inst.TextStrokeColor3, 1 - inst.TextStrokeTransparency); strokeW = 1 }
    const sl = node.txtStroke!
    if (strokeColor && strokeW > 0) {
      sl.style.cssText = ts.cssText
      sl.style.position = 'absolute' // le calque de contour reste superpose, meme quand le texte (AutomaticSize) est dans le flux
      sl.style.inset = '0'
      sl.style.setProperty('-webkit-text-stroke', `${strokeW * 2}px ${strokeColor}`)
      sl.style.setProperty('--sc', strokeColor)
      sl.style.display = 'flex'
      if (sl.innerHTML !== t.innerHTML) sl.innerHTML = t.innerHTML
    } else sl.style.display = 'none'
    if (grad && baseAlpha === 0) { ts.setProperty('background', gradientCss(grad, { R: 1, G: 1, B: 1 }, 1)); ts.setProperty('-webkit-background-clip', 'text'); ts.setProperty('background-clip', 'text'); ts.color = 'transparent' }
    if (inst.TextScaled) { ensureRO(node); postLayout(node) }
  }

  // images : l'emulateur n'a pas acces aux assets Roblox -> bloc de remplacement, SAUF pour les images de la bibliotheque de l'utilisateur
  // (`window.__RPM_IMAGES__` : reference rbxlib:// ou rbxassetid:// -> fichier du paquet, voir tools/preview.mjs --images)
  if (IMAGE_CLASSES.has(cls) && inst.Image) {
    content.style.cssText += ''
    const known = ((globalThis as any).__RPM_IMAGES__ ?? {})[String(inst.Image)]
    if (typeof known === 'string' && /^lib\/[\w.-]+$/.test(known)) {
      s.backgroundImage = `url("${known}")`
      s.backgroundRepeat = 'no-repeat'
      s.backgroundPosition = 'center'
      const mode = inst.ScaleType?.Name
      s.backgroundSize = mode === 'Fit' ? 'contain' : mode === 'Crop' ? 'cover' : mode === 'Tile' ? 'auto' : '100% 100%'
      if (mode === 'Tile') s.backgroundRepeat = 'repeat'
    } else {
      s.backgroundImage = `repeating-linear-gradient(45deg, rgba(160,160,255,.22) 0 6px, rgba(255,255,255,.08) 6px 12px)`
    }
    s.backgroundBlendMode = 'normal'
    el.title = String(inst.Image)
    el.dataset.img = String(inst.Image)
    const it = inst.ImageTransparency ?? 0
    if (it) s.opacity = String(1 - it)
  }
  if (node.aspect) fitAspect(node)
}

// UIAspectRatioConstraint (FitWithinMaxSize par defaut) : le plus grand rectangle de ce ratio contenu dans Size.
// ScaleWithParentSize : le ratio est applique sur l'axe dominant.
function fitAspect(node: Node) {
  const a = node.aspect
  if (!a) return
  const { inst, el } = node
  const parent = el.parentElement
  if (!parent) { requestAnimationFrame(() => fitAspect(node)); return }
  const pw = parent.clientWidth
  const ph = parent.clientHeight
  const size = inst.Size
  const W = size.X.Scale * pw + size.X.Offset
  const H = size.Y.Scale * ph + size.Y.Offset
  const r = a.ratio || 1
  let w: number
  let h: number
  if (a.type === 'ScaleWithParentSize') { if (a.axis === 'Height') { h = H; w = h * r } else { w = W; h = w / r } }
  else { w = Math.min(W, H * r); h = w / r }
  if (!Number.isFinite(w) || !Number.isFinite(h)) return
  el.style.width = px(w)
  el.style.height = px(h)
  if (node.txt || node.cornerScale !== undefined) postLayout(node) // la taille vient de changer : re-ajuster texte et coins
  if (!node.aspectRO) node.aspectRO = new ResizeObserver(() => fitAspect(node))
  node.aspectRO.observe(parent)
}
const ya = undefined

// --- Entrees : souris / tactile -> evenements Roblox (Activated, MouseEnter, InputBegan...) -----------------------------------

// Coordonnees relatives a l'apercu (et non a la page), en tenant compte du zoom d'ajustement.
function relPos(el: HTMLElement, e: { clientX: number; clientY: number }): [number, number] {
  const v = el.closest('#viewport') as HTMLElement | null
  if (!v) return [e.clientX, e.clientY]
  const r = v.getBoundingClientRect()
  const k = r.width / (v.offsetWidth || 1) || 1
  return [(e.clientX - r.left) / k, (e.clientY - r.top) / k]
}

// Equivalent d'un InputObject Roblox (UserInputType, UserInputState, KeyCode, Position, Delta).
function inputObject(type: string, state: string, x: number, y: number) {
  return {
    UserInputType: Enum.UserInputType[type], UserInputState: Enum.UserInputState[state], KeyCode: Enum.KeyCode.Unknown,
    Position: new Vector3(x, y, 0), Delta: new Vector3(0, 0, 0), IsModifierKeyDown: () => false,
  }
}

function fire(inst: any, name: string, ...args: any[]) {
  if ((window as any).__logEv) console.log(`[trace] ev ${name} ${inst.ClassName}:${inst.Name}`)
  inst.getSignal(name).Fire(...args)
}

function wireEvents(node: Node) {
  const { inst, el } = node
  const btnOf = (e: PointerEvent) => (e.pointerType === 'touch' ? 'Touch' : e.button === 2 ? 'MouseButton2' : 'MouseButton1')

  el.addEventListener('pointerenter', (e) => { const [x, y] = relPos(el, e); fire(inst, 'MouseEnter', x, y) })
  el.addEventListener('pointerleave', (e) => { const [x, y] = relPos(el, e); fire(inst, 'MouseLeave', x, y) })
  el.addEventListener('pointermove', (e) => {
    const [x, y] = relPos(el, e)
    fire(inst, 'MouseMoved', x, y)
    fire(inst, 'InputChanged', inputObject('MouseMovement', 'Change', x, y))
  })
  // Un clic / appui ne remonte pas au-dela d'un element qui "avale" l'entree (bouton, cadre Active, zone defilable, TextBox).
  // Un cadre ordinaire qui ecoute seulement un evenement (effet de survol...) ne bloque rien : le bouton dessous recoit quand meme.
  const sinks = (i: any) => i.ClassName === 'TextButton' || i.ClassName === 'ImageButton' || i.ClassName === 'TextBox' || i.ClassName === 'ScrollingFrame' || i.Active === true
  const own = (e: Event) => {
    let cur = (e.target as HTMLElement | null)?.closest?.('.rbx') as HTMLElement | null | undefined
    while (cur && cur !== el) {
      const cn = BYEL.get(cur)
      if (cn && sinks(cn.inst)) return false
      cur = cur.parentElement?.closest?.('.rbx') as HTMLElement | null | undefined
    }
    return cur === el
  }
  el.addEventListener('pointerdown', (e) => {
    if (!own(e)) return
    const [x, y] = relPos(el, e)
    const b = btnOf(e)
    fire(inst, 'InputBegan', inputObject(b, 'Begin', x, y))
    if (b !== 'Touch') fire(inst, b + 'Down', x, y)
    else fire(inst, 'MouseButton1Down', x, y)
  })
  el.addEventListener('pointerup', (e) => {
    if (!own(e)) return
    const [x, y] = relPos(el, e)
    const b = btnOf(e)
    fire(inst, 'InputEnded', inputObject(b, 'End', x, y))
    if (b !== 'Touch') fire(inst, b + 'Up', x, y)
    else fire(inst, 'MouseButton1Up', x, y)
  })
  el.addEventListener('click', (e) => {
    if (!own(e)) return
    if (inst.ClassName !== 'TextButton' && inst.ClassName !== 'ImageButton') return // Activated n'existe que sur les boutons
    const [x, y] = relPos(el, e)
    fire(inst, 'Activated', inputObject('MouseButton1', 'End', x, y), 1)
    fire(inst, 'MouseButton1Click')
  })
  el.addEventListener('contextmenu', (e) => { e.preventDefault(); fire(inst, 'MouseButton2Click') })
  el.addEventListener('wheel', (e) => {
    const [x, y] = relPos(el, e)
    fire(inst, e.deltaY < 0 ? 'MouseWheelForward' : 'MouseWheelBackward', x, y)
    fire(inst, 'InputChanged', inputObject('MouseWheel', 'Change', x, y))
  }, { passive: true })

  // Defilement : la position reelle remonte dans CanvasPosition (sans re-appliquer le style).
  if (inst.ClassName === 'ScrollingFrame') {
    el.addEventListener('scroll', () => {
      const cp = inst.CanvasPosition
      if (Math.abs(cp.X - el.scrollLeft) > 0.5 || Math.abs(cp.Y - el.scrollTop) > 0.5) inst._setSilently('CanvasPosition', new Vector2(el.scrollLeft, el.scrollTop))
    })
  }
}

// --- UIDragDetector (curseurs, poignees) -----------------------------------------------------------------------------------
// Glisser le cadre qui le porte : TranslateLine (un axe, horizontal par defaut) ou Translate (libre). La position est ecrite en
// echelle (ResponseStyle.Scale, relative au parent) ou en pixels, et les evenements DragStart / DragContinue / DragEnd sont emis.
const DRAGWIRED = new WeakSet<object>()
function attachDrag(node: Node, det: any) {
  if (DRAGWIRED.has(det)) return
  DRAGWIRED.add(det)
  const { el, inst } = node
  let active = false
  const clamp = (v: number, a: number, b: number) => Math.min(Math.max(v, a), b)
  const move = (e: PointerEvent) => {
    const parent = el.parentElement as HTMLElement | null
    if (!parent) return
    const r = parent.getBoundingClientRect()
    const k = r.width / (parent.offsetWidth || 1) || 1
    const pw = parent.offsetWidth
    const ph = parent.offsetHeight
    const x = (e.clientX - r.left) / k
    const y = (e.clientY - r.top) / k
    const style: string = det.DragStyle?.Name ?? 'TranslateLine'
    const byScale = (det.ResponseStyle?.Name ?? 'Offset') === 'Scale'
    const axis = det.DragAxis ?? new Vector2(1, 0)
    const horizontal = style !== 'TranslateLine' || Math.abs(axis.X) >= Math.abs(axis.Y)
    const vertical = style !== 'TranslateLine' || Math.abs(axis.Y) > Math.abs(axis.X)
    const pos = inst.Position
    const nx = horizontal ? (byScale ? new UDim(clamp(x / pw, 0, 1), 0) : new UDim(0, clamp(x, 0, pw))) : pos.X
    const ny = vertical ? (byScale ? new UDim(clamp(y / ph, 0, 1), 0) : new UDim(0, clamp(y, 0, ph))) : pos.Y
    inst.Position = new UDim2(nx, ny)
    fire(det, 'DragContinue', det, new Vector2(x, y))
  }
  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return
    active = true
    el.setPointerCapture(e.pointerId)
    fire(det, 'DragStart', det, new Vector2(...relPos(el, e)))
  })
  el.addEventListener('pointermove', (e) => { if (active) move(e) })
  const end = (e: PointerEvent) => {
    if (!active) return
    active = false
    try { el.releasePointerCapture(e.pointerId) } catch { /* deja libere */ }
    fire(det, 'DragEnd', det, new Vector2(...relPos(el, e)))
  }
  el.addEventListener('pointerup', end)
  el.addEventListener('pointercancel', end)
}

export function mount(root: any, container: HTMLElement): () => void {
  const n = build(root)
  if (n) container.appendChild(n.el)
  return () => {
    if (n) { unmountNode(n); n.el.remove() }
  }
}
void ya
