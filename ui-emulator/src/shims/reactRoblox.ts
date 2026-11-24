// Rendu React -> modele d'Instances Roblox (equivalent minimal de react-roblox).
import Reconciler from 'react-reconciler'
import { DefaultEventPriority } from 'react-reconciler/constants'
import { createInstance } from '../rbx/instance'
import { isBinding } from '../rbx/binding'
import { valueEquals } from '../rbx/datatypes'
import { trace } from '../view/dom'

const CLASSES: Record<string, string> = {
  frame: 'Frame', textlabel: 'TextLabel', textbutton: 'TextButton', textbox: 'TextBox', imagelabel: 'ImageLabel', imagebutton: 'ImageButton',
  scrollingframe: 'ScrollingFrame', canvasgroup: 'CanvasGroup', viewportframe: 'ViewportFrame', videoframe: 'VideoFrame',
  screengui: 'ScreenGui', billboardgui: 'BillboardGui', surfacegui: 'SurfaceGui', folder: 'Folder', camera: 'Camera', part: 'Part', model: 'Model',
  uicorner: 'UICorner', uistroke: 'UIStroke', uigradient: 'UIGradient', uipadding: 'UIPadding', uiscale: 'UIScale', uiflexitem: 'UIFlexItem',
  uilistlayout: 'UIListLayout', uigridlayout: 'UIGridLayout', uitablelayout: 'UITableLayout', uipagelayout: 'UIPageLayout',
  uiaspectratioconstraint: 'UIAspectRatioConstraint', uisizeconstraint: 'UISizeConstraint', uitextsizeconstraint: 'UITextSizeConstraint',
  sound: 'Sound', uidragdetector: 'UIDragDetector',
}
const SPECIAL = new Set(['children', 'key', 'ref', 'Event', 'Change', 'Tag'])

const cleanups = new WeakMap<object, Map<string, () => void>>()
function track(inst: object, key: string, off: (() => void) | undefined) {
  let m = cleanups.get(inst)
  if (!m) { m = new Map(); cleanups.set(inst, m) }
  m.get(key)?.()
  if (off) m.set(key, off)
  else m.delete(key)
}

function applyProps(inst: any, oldProps: any, newProps: any) {
  for (const key of new Set([...Object.keys(oldProps ?? {}), ...Object.keys(newProps ?? {})])) {
    if (key === 'children' || key === 'key' || key === 'ref' || key === 'Tag') continue
    const nv = newProps?.[key]
    const ov = oldProps?.[key]
    if (key === 'Event') {
      if (nv === ov) continue
      const offs: Array<() => void> = []
      for (const [ev, fn] of Object.entries<any>(nv ?? {})) {
        const c = inst.getSignal(ev).Connect((...a: any[]) => fn(inst, ...a)) // tout evenement : signal cree a la demande
        offs.push(() => c.Disconnect())
      }
      track(inst, 'Event', () => offs.forEach((o) => o()))
      continue
    }
    if (key === 'Change') {
      if (nv === ov) continue
      const offs: Array<() => void> = []
      for (const [p, fn] of Object.entries<any>(nv ?? {})) {
        const c = inst.GetPropertyChangedSignal(p).Connect(() => fn(inst))
        offs.push(() => c.Disconnect())
      }
      track(inst, 'Change', () => offs.forEach((o) => o()))
      continue
    }
    if (SPECIAL.has(key)) continue
    if (isBinding(nv)) {
      if (nv === ov) continue
      inst[key] = nv.getValue()
      track(inst, 'bind:' + key, nv.subscribe(() => { inst[key] = nv.getValue() }))
      continue
    }
    if (isBinding(ov)) track(inst, 'bind:' + key, undefined)
    if (!valueEquals(nv, ov)) { if (nv !== undefined) inst[key] = nv } // comparaison PAR VALEUR comme Roblox
  }
}

function destroyDeep(inst: any) {
  cleanups.get(inst)?.forEach((o) => o())
  cleanups.delete(inst)
  for (const c of inst.GetChildren?.() ?? []) destroyDeep(c)
}

const reconciler = (Reconciler as any)({
  supportsMutation: true, supportsPersistence: false, supportsHydration: false, isPrimaryRenderer: true, noTimeout: -1,
  scheduleTimeout: setTimeout, cancelTimeout: clearTimeout, supportsMicrotasks: true, scheduleMicrotask: queueMicrotask,
  getCurrentEventPriority: () => DefaultEventPriority,
  getRootHostContext: () => ({}), getChildHostContext: (p: any) => p,
  prepareForCommit: () => null, resetAfterCommit() {},
  createInstance(type: string, props: any) {
    trace('hostCreate', type)
    const inst = createInstance(CLASSES[type.toLowerCase()] ?? type)
    applyProps(inst, {}, props)
    return inst
  },
  createTextInstance() { throw new Error('Les textes doivent passer par la prop Text d\'un TextLabel') },
  appendInitialChild(parent: any, child: any) { child.Parent = parent },
  finalizeInitialChildren: () => false,
  shouldSetTextContent: () => false,
  prepareUpdate: () => true,
  commitUpdate(inst: any, _payload: any, type: string, oldProps: any, newProps: any) { trace('commitUpdate', type); applyProps(inst, oldProps, newProps) },
  appendChild(parent: any, child: any) { child.Parent = parent },
  appendChildToContainer(container: any, child: any) { child.Parent = container },
  insertBefore(parent: any, child: any, before: any) { parent._insertBefore(child, before) },
  insertInContainerBefore(container: any, child: any, before: any) { container._insertBefore(child, before) },
  removeChild(_p: any, child: any) { destroyDeep(child); child.Destroy() },
  removeChildFromContainer(_c: any, child: any) { destroyDeep(child); child.Destroy() },
  clearContainer(container: any) { for (const c of container.GetChildren()) { destroyDeep(c); c.Destroy() } },
  getPublicInstance: (i: any) => i,
  preparePortalMount() {}, detachDeletedInstance() {}, commitTextUpdate() {}, resetTextContent() {},
  hideInstance(i: any) { i.__wasVisible = i.Visible; i.Visible = false },
  unhideInstance(i: any) { i.Visible = i.__wasVisible ?? true },
  getInstanceFromNode: () => null, beforeActiveInstanceBlur() {}, afterActiveInstanceBlur() {},
  prepareScopeUpdate() {}, getInstanceFromScope: () => null,
})

export function createRoot(container: any) {
  const root = reconciler.createContainer(container, 1, null, false, null, '', (e: any) => console.error('[react]', e), null)
  return {
    render(element: any) { reconciler.updateContainer(element, root, null, null) },
    unmount() { reconciler.updateContainer(null, root, null, null) },
  }
}
export const createLegacyRoot = createRoot
export const createBlockingRoot = createRoot

export function createPortal(children: any, target: any, key?: string) {
  return { $$typeof: Symbol.for('react.portal'), key: key == null ? null : '' + key, children, containerInfo: target, implementation: null }
}

const ReactRoblox = { createRoot, createLegacyRoot, createBlockingRoot, createPortal }
export default ReactRoblox
