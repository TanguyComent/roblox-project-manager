import { Signal } from './signal'
import { stub } from './stub'
import { Enum } from './enums'
import { UDim, UDim2, Vector2, Vector3, CFrame, Color3, Rect, ColorSequence, NumberSequence, Font, valueEquals } from './datatypes'

export type Watcher = (inst: any, prop: string) => void

const GUI_TAIL = ['GuiObject', 'GuiBase2d', 'GuiBase']
const ANCESTORS: Record<string, string[]> = {
  Frame: GUI_TAIL,
  TextLabel: ['GuiLabel', ...GUI_TAIL],
  ImageLabel: ['GuiLabel', ...GUI_TAIL],
  TextButton: ['GuiButton', ...GUI_TAIL],
  ImageButton: ['GuiButton', ...GUI_TAIL],
  TextBox: GUI_TAIL,
  ScrollingFrame: GUI_TAIL,
  CanvasGroup: GUI_TAIL,
  ViewportFrame: GUI_TAIL,
  VideoFrame: GUI_TAIL,
  ScreenGui: ['LayerCollector', 'GuiBase2d', 'GuiBase'],
  BillboardGui: ['LayerCollector', 'GuiBase2d', 'GuiBase'],
  SurfaceGui: ['LayerCollector', 'GuiBase2d', 'GuiBase'],
  UICorner: ['UIComponent'],
  UIStroke: ['UIComponent'],
  UIGradient: ['UIComponent'],
  UIPadding: ['UIComponent'],
  UIScale: ['UIComponent'],
  UIFlexItem: ['UIComponent'],
  UIDragDetector: ['UIComponent'],
  UIListLayout: ['UIGridStyleLayout', 'UILayout', 'UIComponent'],
  UIGridLayout: ['UIGridStyleLayout', 'UILayout', 'UIComponent'],
  UITableLayout: ['UIGridStyleLayout', 'UILayout', 'UIComponent'],
  UIPageLayout: ['UIGridStyleLayout', 'UILayout', 'UIComponent'],
  UIAspectRatioConstraint: ['UIConstraint', 'UIComponent'],
  UISizeConstraint: ['UIConstraint', 'UIComponent'],
  UITextSizeConstraint: ['UIConstraint', 'UIComponent'],
}

const E = Enum
const BLACKISH = new Color3(27 / 255, 42 / 255, 53 / 255)
const GUIOBJ = {
  Position: new UDim2(), AnchorPoint: new Vector2(), BackgroundColor3: new Color3(163 / 255, 162 / 255, 165 / 255),
  BackgroundTransparency: 0, BorderColor3: BLACKISH, BorderSizePixel: 1, BorderMode: E.BorderMode.Outline,
  Visible: true, ZIndex: 1, LayoutOrder: 0, Rotation: 0, ClipsDescendants: false, Active: false, Selectable: false,
  Interactable: true, AutomaticSize: E.AutomaticSize.None, SizeConstraint: E.SizeConstraint.RelativeXY, Name: '',
}
const TEXTISH = {
  Text: '', TextColor3: BLACKISH, TextSize: 14, Font: E.Font.Legacy, TextTransparency: 0, TextStrokeTransparency: 1,
  TextStrokeColor3: new Color3(0, 0, 0), TextXAlignment: E.TextXAlignment.Center, TextYAlignment: E.TextYAlignment.Center,
  TextWrapped: false, TextScaled: false, RichText: false, LineHeight: 1, TextTruncate: E.TextTruncate.None, MaxVisibleGraphemes: -1,
  FontFace: undefined as any,
}
const IMAGEISH = {
  Image: '', ImageColor3: new Color3(1, 1, 1), ImageTransparency: 0, ScaleType: E.ScaleType.Stretch,
  ImageRectOffset: new Vector2(), ImageRectSize: new Vector2(), SliceCenter: new Rect(), SliceScale: 1, ResampleMode: E.ResamplerMode.Default,
}
const DEFAULTS: Record<string, Record<string, any>> = {
  Frame: { ...GUIOBJ, Size: UDim2.fromOffset(100, 100), Style: E.FrameStyle.Custom },
  TextLabel: { ...GUIOBJ, ...TEXTISH, Size: UDim2.fromOffset(200, 50), Text: 'Label' },
  TextButton: { ...GUIOBJ, ...TEXTISH, Size: UDim2.fromOffset(200, 50), Text: 'Button', AutoButtonColor: true, Modal: false },
  TextBox: { ...GUIOBJ, ...TEXTISH, Size: UDim2.fromOffset(200, 50), Text: '', PlaceholderText: '', ClearTextOnFocus: true, MultiLine: false },
  ImageLabel: { ...GUIOBJ, ...IMAGEISH, Size: UDim2.fromOffset(100, 100) },
  ImageButton: { ...GUIOBJ, ...IMAGEISH, Size: UDim2.fromOffset(100, 100), AutoButtonColor: true },
  ScrollingFrame: { ...GUIOBJ, Size: UDim2.fromOffset(400, 400), CanvasSize: new UDim2(0, 0, 2, 0), CanvasPosition: new Vector2(), ScrollBarThickness: 12, ScrollingEnabled: true, AutomaticCanvasSize: E.AutomaticSize.None },
  CanvasGroup: { ...GUIOBJ, Size: UDim2.fromOffset(100, 100), GroupTransparency: 0, GroupColor3: new Color3(1, 1, 1) },
  ViewportFrame: { ...GUIOBJ, Size: UDim2.fromOffset(100, 100) },
  ScreenGui: { Enabled: true, IgnoreGuiInset: false, DisplayOrder: 0, ResetOnSpawn: true, ZIndexBehavior: E.ZIndexBehavior.Sibling },
  UICorner: { CornerRadius: new UDim(0, 8) },
  UIStroke: { Color: new Color3(0, 0, 0), Thickness: 1, Transparency: 0, ApplyStrokeMode: E.ApplyStrokeMode.Contextual, LineJoinMode: E.LineJoinMode.Round, Enabled: true },
  UIGradient: { Color: new ColorSequence(new Color3(1, 1, 1)), Transparency: new NumberSequence(0), Rotation: 0, Offset: new Vector2(), Enabled: true },
  UIPadding: { PaddingTop: new UDim(), PaddingBottom: new UDim(), PaddingLeft: new UDim(), PaddingRight: new UDim() },
  UIScale: { Scale: 1 },
  UIListLayout: { FillDirection: E.FillDirection.Vertical, HorizontalAlignment: E.HorizontalAlignment.Left, VerticalAlignment: E.VerticalAlignment.Top, SortOrder: E.SortOrder.LayoutOrder, Padding: new UDim(), Wraps: false, HorizontalFlex: E.UIFlexAlignment.None, VerticalFlex: E.UIFlexAlignment.None },
  UIGridLayout: { FillDirection: E.FillDirection.Horizontal, HorizontalAlignment: E.HorizontalAlignment.Left, VerticalAlignment: E.VerticalAlignment.Top, SortOrder: E.SortOrder.LayoutOrder, CellSize: UDim2.fromOffset(100, 100), CellPadding: UDim2.fromOffset(5, 5), StartCorner: E.StartCorner.TopLeft },
  UIAspectRatioConstraint: { AspectRatio: 1, AspectType: E.AspectType.FitWithinMaxSize, DominantAxis: E.DominantAxis.Width },
  UISizeConstraint: { MinSize: new Vector2(0, 0), MaxSize: new Vector2(Infinity, Infinity) },
  UITextSizeConstraint: { MinTextSize: 1, MaxTextSize: 100 },
}
void Font

// Evenements d'entree : quand quelqu'un s'y abonne, la vue rend l'element "cliquable" (pointer-events).
export const INPUT_EVENTS = new Set([
  'MouseEnter', 'MouseLeave', 'MouseMoved', 'MouseButton1Click', 'MouseButton1Down', 'MouseButton1Up', 'MouseButton2Click',
  'MouseButton2Down', 'MouseButton2Up', 'Activated', 'InputBegan', 'InputEnded', 'InputChanged', 'TouchTap', 'MouseWheelForward', 'MouseWheelBackward',
])

const EVENT_NAMES = new Set([
  'Activated', 'MouseButton1Click', 'MouseButton1Down', 'MouseButton1Up', 'MouseButton2Click', 'MouseButton2Down', 'MouseButton2Up',
  'MouseEnter', 'MouseLeave', 'MouseMoved', 'MouseWheelForward', 'MouseWheelBackward', 'InputBegan', 'InputEnded', 'InputChanged',
  'TouchTap', 'TouchLongPress', 'SelectionGained', 'SelectionLost', 'Focused', 'FocusLost', 'ReturnPressedFromOnScreenKeyboard',
])

export class RbxInstance {
  ClassName: string
  _name: string
  _parent: any = undefined
  _children: any[] = []
  _props = new Map<string, any>()
  _signals = new Map<string, Signal>()
  _attrs = new Map<string, any>()
  _watchers = new Set<Watcher>()
  _measure: undefined | (() => { w: number; h: number; x: number; y: number })
  _contentMeasure: undefined | (() => { w: number; h: number })
  _self: any
  _destroyed = false
  _defaults: Record<string, any>
  Destroying = new Signal()
  ChildAdded = new Signal()
  ChildRemoved = new Signal()
  DescendantAdded = new Signal()
  AncestryChanged = new Signal()
  Changed = new Signal()

  constructor(className: string) {
    this.ClassName = className
    this._name = className
    this._defaults = DEFAULTS[className] ?? {}
  }

  get Name() { return this._name }
  set Name(v: string) { if (v !== this._name) { this._name = v; this._fire('Name') } }
  get Parent() { return this._parent }
  set Parent(p: any) { this._setParent(p, undefined) }

  _notify(prop: string) {
    for (const w of [...this._watchers]) w(this._self, prop)
  }
  // Ecriture venant de la vue elle-meme (ex. position de defilement) : signaux declenches, mais pas de re-application du style.
  _setSilently(name: string, v: any) {
    if (this._props.get(name) === v) return
    this._props.set(name, v)
    this.Changed.Fire(name)
    this._signals.get('prop:' + name)?.Fire()
  }
  _fire(prop: string) {
    this.Changed.Fire(prop)
    this._signals.get('prop:' + prop)?.Fire()
    this._notify(prop)
  }

  _setParent(p: any, before?: any) {
    if (this._destroyed) return
    const old = this._parent
    if (old === p && before === undefined) return
    if (old) {
      const i = old._children.indexOf(this._self)
      if (i >= 0) old._children.splice(i, 1)
      old.ChildRemoved.Fire(this._self)
      old._notify('children')
    }
    this._parent = p
    if (p) {
      const j = before ? p._children.indexOf(before) : -1
      if (j >= 0) p._children.splice(j, 0, this._self)
      else p._children.push(this._self)
      p.ChildAdded.Fire(this._self)
      p._notify('children')
    }
    this.AncestryChanged.Fire(this._self, p)
    this._notify('parent')
  }

  getSignal(name: string) {
    let s = this._signals.get(name)
    if (!s) {
      s = new Signal()
      this._signals.set(name, s)
      // quelqu'un ecoute un changement de taille : la vue doit observer l'element (ResizeObserver)
      if (name === 'prop:AbsoluteSize' || name === 'prop:AbsolutePosition') this._notify('observeSize')
      else if (name === 'prop:AbsoluteContentSize') this._notify('observeContent')
      else if (INPUT_EVENTS.has(name)) this._notify('observeInput')
    }
    return s
  }

  // UIDragDetector : position (UDim2) de l'instance de reference, ou du parent. Les props `ref` arrivent en objets { current }.
  GetReferencePosition() {
    const r = this._props.get('ReferenceUIInstance')
    const target = r && typeof r === 'object' && 'current' in r ? r.current : r
    return (target ?? this._parent)?.Position ?? new UDim2()
  }

  getProp(name: string) {
    if (this._props.has(name)) return this._props.get(name)
    if (name === 'AbsoluteSize' || name === 'AbsolutePosition') {
      const m = this._measure?.()
      return name === 'AbsoluteSize' ? new Vector2(m?.w ?? 0, m?.h ?? 0) : new Vector2(m?.x ?? 0, m?.y ?? 0)
    }
    if (name === 'AbsoluteContentSize') {
      // taille de l'ensemble des enfants du parent (liste / grille)
      const m = this._parent?._contentMeasure?.()
      return new Vector2(m?.w ?? 0, m?.h ?? 0)
    }
    if (name === 'AbsoluteCanvasSize') { const m = this._contentMeasure?.(); return new Vector2(m?.w ?? 0, m?.h ?? 0) }
    if (name === 'AbsoluteWindowSize') { const m = this._measure?.(); return new Vector2(m?.w ?? 0, m?.h ?? 0) }
    if (name === 'AbsoluteRotation') return this._props.get('Rotation') ?? 0
    if (EVENT_NAMES.has(name)) return this.getSignal(name)
    return this._defaults[name]
  }

  setProp(name: string, v: any) {
    if (valueEquals(this._props.get(name), v)) return
    this._props.set(name, v)
    this._fire(name)
  }

  GetPropertyChangedSignal(prop: string) { return this.getSignal('prop:' + prop) }
  GetChildren() { return [...this._children] }
  GetDescendants(): any[] {
    const out: any[] = []
    const walk = (i: any) => { for (const c of i._children) { out.push(c); walk(c) } }
    walk(this)
    return out
  }
  IsA(cls: string) { return cls === 'Instance' || cls === this.ClassName || !!ANCESTORS[this.ClassName]?.includes(cls) }
  FindFirstChild(name: string, recursive = false): any {
    for (const c of this._children) if (c.Name === name) return c
    if (recursive) for (const c of this._children) { const r = c.FindFirstChild(name, true); if (r) return r }
    return undefined
  }
  FindFirstChildOfClass(cls: string) { return this._children.find((c) => c.ClassName === cls) }
  FindFirstChildWhichIsA(cls: string) { return this._children.find((c) => c.IsA(cls)) }
  FindFirstAncestor(name: string) { let p = this._parent; while (p) { if (p.Name === name) return p; p = p.Parent } return undefined }
  FindFirstAncestorOfClass(cls: string) { let p = this._parent; while (p) { if (p.ClassName === cls) return p; p = p.Parent } return undefined }
  FindFirstAncestorWhichIsA(cls: string) { let p = this._parent; while (p) { if (p.IsA(cls)) return p; p = p.Parent } return undefined }
  // Roblox : WaitForChild ne renvoie jamais nil. Les enfants absents (3D, paquets) sont ignores via un objet tolerant.
  WaitForChild(name: string) {
    return this.FindFirstChild(name) ?? stub(`${this.Name}.${name}`)
  }
  IsDescendantOf(a: any) { let p = this._parent; while (p) { if (p === a) return true; p = p.Parent } return false }
  IsAncestorOf(d: any) { return d.IsDescendantOf(this._self) }
  GetFullName() { return (this._parent ? this._parent.GetFullName() + '.' : '') + this._name }
  SetAttribute(k: string, v: any) { this._attrs.set(k, v); this.getSignal('attr:' + k).Fire() }
  GetAttribute(k: string) { return this._attrs.get(k) }
  GetAttributeChangedSignal(k: string) { return this.getSignal('attr:' + k) }
  GetAttributes() { return Object.fromEntries(this._attrs) }
  // Model / BasePart : pas de 3D dans l'emulateur, on repond avec des valeurs neutres pour que le code continue.
  GetScale() { return this._props.get('__scale') ?? 1 }
  ScaleTo(s: number) { this._props.set('__scale', s) }
  PivotTo(_cf: any) {}
  GetPivot() { return new CFrame() }
  GetBoundingBox() { return [new CFrame(), new Vector3(4, 4, 4)] }
  GetExtentsSize() { return new Vector3(4, 4, 4) }
  MoveTo(_p: any) {}
  TranslateBy(_p: any) {}
  AddTag(_t: string) {}
  RemoveTag(_t: string) {}
  HasTag(_t: string) { return false }
  GetTags() { return [] as string[] }
  ClearAllChildren() { for (const c of [...this._children]) c.Destroy() }
  Clone() {
    const c = createInstance(this.ClassName)
    c.Name = this._name
    for (const [k, v] of this._props) c.setProp(k, v)
    for (const ch of this._children) ch.Clone().Parent = c
    return c
  }
  Destroy() {
    if (this._destroyed) return
    this.Destroying.Fire()
    for (const c of [...this._children]) c.Destroy()
    this._setParent(undefined)
    this._destroyed = true
    this._notify('destroyed')
    this._signals.forEach((s) => s.DisconnectAll())
    this._watchers.clear()
  }
  _insertBefore(child: any, before: any) { child._setParent(this._self, before) }
}

const handler: ProxyHandler<RbxInstance> = {
  get(t, p) {
    if (typeof p === 'symbol') return (t as any)[p]
    if (p in t) {
      const v = (t as any)[p]
      return typeof v === 'function' ? v.bind(t) : v
    }
    return t.getProp(p)
  },
  set(t, p, v) {
    if (typeof p === 'symbol' || p in t) { ;(t as any)[p] = v; return true }
    t.setProp(p, v)
    return true
  },
  has(t, p) { return p in t || t._props.has(p as string) },
}

export function createInstance(className: string, parent?: any): any {
  const impl = new RbxInstance(className)
  const proxy = new Proxy(impl, handler)
  impl._self = proxy
  if (parent) proxy.Parent = parent
  return proxy
}

// roblox-ts compile `new Instance("X")` en TS : l'objet doit etre construisible ET exposer `Instance.new`.
export const Instance: any = function (className: string, parent?: any) {
  return createInstance(className, parent)
}
Instance.new = createInstance
