// Bindings facon react-lua : createBinding / useBinding / joinBindings / binding.map
export class Binding<T = any> {
  readonly __binding = true
  constructor(private _get: () => T, private _sub: (cb: () => void) => () => void) {}
  getValue(): T { return this._get() }
  subscribe(cb: () => void) { return this._sub(cb) }
  map<U>(fn: (v: T) => U): Binding<U> {
    return new Binding<U>(() => fn(this._get()), (cb) => this._sub(cb))
  }
}

export function isBinding(v: any): v is Binding {
  return !!v && v.__binding === true
}

export function createBinding<T>(initial: T): [Binding<T>, (v: T | ((p: T) => T)) => void] {
  let value = initial
  const subs = new Set<() => void>()
  const b = new Binding<T>(
    () => value,
    (cb) => {
      subs.add(cb)
      return () => subs.delete(cb)
    },
  )
  const set = (v: T | ((p: T) => T)) => {
    const nv = typeof v === 'function' ? (v as any)(value) : v
    if (nv === value) return
    value = nv
    for (const s of [...subs]) s()
  }
  return [b, set]
}

export function joinBindings(bs: any): Binding {
  const keys = Object.keys(bs)
  const isArr = Array.isArray(bs)
  const get = () => {
    const out: any = isArr ? [] : {}
    for (const k of keys) out[k] = bs[k].getValue()
    return out
  }
  return new Binding(get, (cb) => {
    const offs = keys.map((k) => bs[k].subscribe(cb))
    return () => offs.forEach((o) => o())
  })
}
