import * as R from 'react'
import { Vector2 } from '../rbx/datatypes'
import { Workspace } from '../rbx/services'
import { createBinding, isBinding } from '../rbx/binding'

// Accepte un Binding OU une valeur simple (comme la vraie useBindingState).
export function useBindingState<T>(binding: any): T {
  const bound = isBinding(binding)
  const [v, set] = R.useState<T>(() => (bound ? binding.getValue() : binding))
  R.useEffect(() => {
    if (!isBinding(binding)) { set(binding); return }
    set(binding.getValue())
    return binding.subscribe(() => set(binding.getValue()))
  }, [binding])
  return bound ? v : binding
}

export function useCamera() {
  const [, force] = R.useReducer((x: number) => x + 1, 0)
  R.useEffect(() => {
    const cam = Workspace.CurrentCamera
    const c = cam.GetPropertyChangedSignal('ViewportSize').Connect(() => force())
    return () => c.Disconnect()
  }, [])
  return Workspace.CurrentCamera
}

export function useDebounceState<T>(initial: T, wait = 0.2): [T, (v: T) => void] {
  const [v, set] = R.useState<T>(initial)
  const t = R.useRef<any>()
  const setD = R.useCallback((nv: T) => { clearTimeout(t.current); t.current = setTimeout(() => set(nv), wait * 1000) }, [wait])
  R.useEffect(() => () => clearTimeout(t.current), [])
  return [v, setD]
}

export function useEventListener(signal: any, callback: (...a: any[]) => void, _o?: any) {
  const cb = R.useRef(callback)
  cb.current = callback
  R.useEffect(() => {
    if (!signal) return
    const c = signal.Connect((...a: any[]) => cb.current(...a))
    return () => c.Disconnect()
  }, [signal])
}

export function useMountEffect(cb: () => void) { R.useEffect(() => { cb() }, []) }
export function useUnmountEffect(cb: () => void) { const r = R.useRef(cb); r.current = cb; R.useEffect(() => () => r.current(), []) }

export function useMouse() {
  const [p, set] = R.useState(new Vector2(0, 0))
  R.useEffect(() => {
    const f = (e: PointerEvent) => set(new Vector2(e.clientX, e.clientY))
    window.addEventListener('pointermove', f)
    return () => window.removeEventListener('pointermove', f)
  }, [])
  return p
}

export function useTimeout(cb: () => void, ms: number) {
  R.useEffect(() => { const id = setTimeout(cb, ms); return () => clearTimeout(id) }, [ms])
}

// useTimer(depart) : `timer.value` est un Binding qui part de `depart` (secondes) et augmente avec le temps reel.
export function useTimer(start = 0) {
  const timer = R.useMemo(() => {
    const [value, setValue] = createBinding(start)
    return { value, setValue, t0: performance.now(), base: start }
  }, [])
  R.useEffect(() => {
    const id = setInterval(() => timer.setValue(timer.base + (performance.now() - timer.t0) / 1000), 250)
    return () => clearInterval(id)
  }, [timer])
  return { value: timer.value, complete: false, reset() { timer.t0 = performance.now(); timer.setValue(timer.base) } }
}
