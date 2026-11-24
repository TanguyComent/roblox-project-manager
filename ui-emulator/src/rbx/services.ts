import { Signal } from './signal'
import { createInstance } from './instance'
import { TweenServiceImpl } from './tween'
import { Vector2 } from './datatypes'

// Tout acces non implemente est enregistre : c'est le rapport "doublures manquantes".
export const MISSING = new Set<string>()
const record = (p: string) => { if (!MISSING.has(p)) { MISSING.add(p); console.warn('[emulator] non implemente:', p) } }

export function ghost(path: string): any {
  const f: any = function () {}
  return new Proxy(f, {
    get(_t, p) {
      if (p === 'Connect' || p === 'Once') return () => ({ Connected: true, Disconnect() {} })
      if (p === 'Wait') return () => []
      if (p === Symbol.toPrimitive) return () => 0
      if (p === 'then' || typeof p === 'symbol') return undefined
      record(`${path}.${p}`)
      return ghost(`${path}.${p}`)
    },
    apply() { record(`${path}()`); return ghost(`${path}()`) },
    set() { return true },
  })
}

function withGhost<T extends object>(obj: T, path: string): T {
  return new Proxy(obj, {
    get(t, p) {
      if (typeof p === 'symbol' || p in t) return (t as any)[p]
      if (p === 'then') return undefined
      return ghost(`${path}.${String(p)}`)
    },
    set(t, p, v) { (t as any)[p] = v; return true },
  })
}

export const viewport = { w: 1280, h: 720 }

const camera = createInstance('Camera')
camera.ViewportSize = new Vector2(viewport.w, viewport.h)
camera.FieldOfView = 70
export function setViewportSize(w: number, h: number) {
  viewport.w = w; viewport.h = h
  camera.ViewportSize = new Vector2(w, h)
}

let mouse = new Vector2(0, 0)
if (typeof window !== 'undefined') window.addEventListener('pointermove', (e) => { mouse = new Vector2(e.clientX, e.clientY) })

const heartbeat = new Signal<[number]>()
const renderStepped = new Signal<[number]>()
let last = performance.now()
const loop = (now: number) => {
  const dt = Math.min((now - last) / 1000, 0.1)
  last = now
  renderStepped.Fire(dt)
  heartbeat.Fire(dt)
  requestAnimationFrame(loop)
}
if (typeof requestAnimationFrame !== 'undefined' && !new URLSearchParams(location.search).get('nohb')) requestAnimationFrame(loop)

const playerGui = createInstance('Folder')
playerGui.Name = 'PlayerGui'
const localPlayer = withGhost(
  {
    Name: 'Player', DisplayName: 'Player', UserId: 1, AccountAge: 100, PlayerGui: playerGui,
    Character: undefined as any, CharacterAdded: new Signal(), CharacterRemoving: new Signal(),
    GetPropertyChangedSignal: () => new Signal(), GetAttribute: () => undefined, SetAttribute() {},
    GetAttributeChangedSignal: () => new Signal(), IsA: () => false,
  },
  'Players.LocalPlayer',
)

export const Players = withGhost(
  { LocalPlayer: localPlayer, GetPlayers: () => [localPlayer], PlayerAdded: new Signal(), PlayerRemoving: new Signal(), GetPlayerByUserId: () => localPlayer },
  'Players',
)

export const RunService = withGhost(
  {
    Heartbeat: heartbeat, RenderStepped: renderStepped, Stepped: heartbeat, PreRender: renderStepped, PostSimulation: heartbeat,
    IsStudio: () => true, IsClient: () => true, IsServer: () => false, IsRunning: () => true, IsRunMode: () => false,
    BindToRenderStep() {}, UnbindFromRenderStep() {},
  },
  'RunService',
)

export const TweenService = withGhost(TweenServiceImpl, 'TweenService')

export const UserInputService = withGhost(
  {
    InputBegan: new Signal(), InputEnded: new Signal(), InputChanged: new Signal(), TouchTap: new Signal(), LastInputTypeChanged: new Signal(),
    TouchEnabled: false, KeyboardEnabled: true, MouseEnabled: true, GamepadEnabled: false, MouseIconEnabled: true,
    GetMouseLocation: () => mouse, GetLastInputType: () => ({ Name: 'MouseButton1' }), GetFocusedTextBox: () => undefined,
    IsKeyDown: () => false, GetGamepadConnected: () => false, GetConnectedGamepads: () => [],
  },
  'UserInputService',
)

export const Workspace = withGhost(
  { CurrentCamera: camera, Name: 'Workspace', Gravity: 196.2, GetServerTimeNow: () => Date.now() / 1000, FindFirstChild: () => undefined, WaitForChild: () => undefined, GetPropertyChangedSignal: () => new Signal() },
  'Workspace',
)

export const GuiService = withGhost(
  { GetGuiInset: () => [new Vector2(0, 58), new Vector2(0, 0)], MenuOpened: new Signal(), MenuClosed: new Signal(), SelectedObject: undefined, IsTenFootInterface: () => false },
  'GuiService',
)

export const HttpService = withGhost(
  { GenerateGUID: () => crypto.randomUUID(), JSONEncode: (v: any) => JSON.stringify(v), JSONDecode: (s: string) => JSON.parse(s), UrlEncode: (s: string) => encodeURIComponent(s) },
  'HttpService',
)

const canvas = typeof document !== 'undefined' ? document.createElement('canvas') : (null as any)
export const TextService = withGhost(
  {
    GetTextSize(text: string, size: number, _font: any, frame: Vector2) {
      const ctx = canvas.getContext('2d')
      ctx.font = `${size}px sans-serif`
      const lines = String(text).split('\n')
      const w = Math.max(...lines.map((l) => ctx.measureText(l).width))
      return new Vector2(Math.min(w, frame?.X ?? w), size * 1.2 * lines.length)
    },
  },
  'TextService',
)

export const Debris = withGhost({ AddItem(i: any, t = 10) { setTimeout(() => i?.Destroy?.(), t * 1000) } }, 'Debris')
export const Lighting = withGhost({ ClockTime: 12, Brightness: 2 }, 'Lighting')
export const ReplicatedStorage = createInstance('Folder')
export const ServerStorage = createInstance('Folder')

const registry: Record<string, any> = {
  Players, RunService, TweenService, UserInputService, Workspace, GuiService, HttpService, TextService, Debris, Lighting, ReplicatedStorage, ServerStorage,
}
export function getService(name: string) {
  return registry[name] ?? (registry[name] = ghost(`game:GetService("${name}")`))
}

export const game: any = withGhost(
  { GetService: getService, Players, Workspace, workspace: Workspace, ReplicatedStorage, PlaceId: 0, GameId: 0, JobId: 'emulator', IsLoaded: () => true, BindToClose() {}, GetPropertyChangedSignal: () => new Signal() },
  'game',
)
