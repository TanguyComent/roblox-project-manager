export const keys = (o: any) => Object.keys(o)
export const values = (o: any) => Object.values(o)
export const entries = (o: any) => Object.entries(o)
export const copy = (o: any) => (Array.isArray(o) ? [...o] : { ...o })
export const deepCopy = <T>(o: T): T => {
  if (Array.isArray(o)) return o.map(deepCopy) as any
  if (o instanceof Map) return new Map([...o].map(([k, v]) => [k, deepCopy(v)])) as any
  if (o && typeof o === 'object' && Object.getPrototypeOf(o) === Object.prototype) return Object.fromEntries(Object.entries(o as any).map(([k, v]) => [k, deepCopy(v)])) as any
  return o
}
export const assign = Object.assign
export const fromEntries = Object.fromEntries
export const isEmpty = (o: any) => Object.keys(o).length === 0
const Obj = { keys, values, entries, copy, deepCopy, assign, fromEntries, isEmpty }
export default Obj
