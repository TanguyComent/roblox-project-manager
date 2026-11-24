const clone = (v: any): any => {
  if (Array.isArray(v)) return v.map(clone)
  if (v instanceof Map) return new Map([...v].map(([k, x]) => [k, clone(x)]))
  if (v instanceof Set) return new Set([...v].map(clone))
  if (v && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clone(x)]))
  return v
}
export function produce<T>(base: T, recipe: (draft: T) => T | void): T {
  const draft = clone(base)
  const r = recipe(draft)
  return (r === undefined ? draft : r) as T
}
const Immut = { produce }
export default Immut
