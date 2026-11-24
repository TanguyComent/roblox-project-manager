// Implementation JS de l'API de @rbxts/charm (atom, computed, subscribe, effect, peek).
type Tracker = { deps: Set<any> }
let current: Tracker | null = null

function runTracked<T>(fn: () => T): { value: T; deps: Set<any> } {
  const prev = current
  const t: Tracker = { deps: new Set() }
  current = t
  try { return { value: fn(), deps: t.deps } } finally { current = prev }
}

export function atom<T>(initial: T): any {
  let state = initial
  const subs = new Set<(s: T, p: T) => void>()
  const a: any = function (...args: any[]) {
    if (args.length === 0) {
      if (current) current.deps.add(a)
      return state
    }
    const next = typeof args[0] === 'function' ? args[0](state) : args[0]
    if (next === state) return
    const prev = state
    state = next
    for (const s of [...subs]) s(state, prev)
  }
  a.__subs = subs
  a.__peek = () => state
  a.__atom = true
  return a
}

export function computed<T>(fn: () => T): any {
  let value!: T
  let deps = new Set<any>()
  let dirty = true
  const subs = new Set<(s: T, p: T) => void>()
  const offs: Array<() => void> = []
  const recompute = () => {
    offs.splice(0).forEach((o) => o())
    const r = runTracked(fn)
    value = r.value
    deps = r.deps
    dirty = false
    for (const d of deps) {
      const cb = () => { const prev = value; dirty = true; const nv = read(); if (nv !== prev) for (const s of [...subs]) s(nv, prev) }
      d.__subs.add(cb)
      offs.push(() => d.__subs.delete(cb))
    }
  }
  const read = () => { if (dirty) recompute(); return value }
  const c: any = () => { if (current) current.deps.add(c); return read() }
  c.__subs = subs
  c.__peek = () => read()
  c.__atom = true
  return c
}

export function subscribe<T>(a: any, cb: (s: T, p: T) => void) {
  a.__peek?.()
  a.__subs.add(cb)
  return () => a.__subs.delete(cb)
}

export function peek<T>(a: any): T {
  return a.__atom ? a.__peek() : a()
}

export function effect(fn: () => any) {
  let cleanup: any
  let offs: Array<() => void> = []
  const run = () => {
    offs.splice(0).forEach((o) => o())
    cleanup?.()
    const r = runTracked(fn)
    cleanup = r.value
    for (const d of r.deps) { const cb = () => run(); d.__subs.add(cb); offs.push(() => d.__subs.delete(cb)) }
  }
  run()
  return () => { offs.splice(0).forEach((o) => o()); cleanup?.() }
}

export function observe() { return () => {} }
export function mapped(a: any, f: (v: any) => any) { return computed(() => f(a())) }
export function sync() { return {} }
export const Atom = undefined
