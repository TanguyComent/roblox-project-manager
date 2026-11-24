// Installe les globales Roblox / roblox-ts avant tout import de story.
import * as dt from './datatypes'
import { Enum } from './enums'
import { Instance } from './instance'
import { game, Workspace } from './services'

const g = globalThis as any

// --- extensions roblox-ts sur les prototypes JS (les appels `.size()` sont reecrits en `.__size()` par le plugin Vite)
const def = (proto: any, name: string, fn: any) => {
  if (!Object.prototype.hasOwnProperty.call(proto, name)) Object.defineProperty(proto, name, { value: fn, writable: true, configurable: true, enumerable: false })
}
def(Array.prototype, '__size', function (this: any[]) { return this.length })
def(Array.prototype, 'isEmpty', function (this: any[]) { return this.length === 0 })
def(Array.prototype, 'mapFiltered', function (this: any[], f: any) { return this.map(f).filter((v) => v !== undefined) })
def(Array.prototype, 'filterUndefined', function (this: any[]) { return this.filter((v) => v !== undefined) })
def(Array.prototype, 'unorderedRemove', function (this: any[], i: number) { const v = this[i]; this[i] = this[this.length - 1]; this.pop(); return v })
// `.size()` est reecrit en `.__size()` dans le code du projet : classes du projet avec leur propre size() (methode ou propriete) incluses.
def(Object.prototype, '__size', function (this: any) {
  if (typeof this.size === 'function') return this.size()
  if (typeof this.size === 'number') return this.size
  if (typeof this.length === 'number') return this.length
  return Object.keys(this).length
})
def(Array.prototype, 'insert', function (this: any[], i: number, v: any) { this.splice(i, 0, v) })
def(Array.prototype, 'remove', function (this: any[], i: number) { return this.splice(i, 1)[0] })
def(Array.prototype, 'move', function (this: any[], a: number, b: number, t: number, dst?: any[]) { const d = dst ?? this; const part = this.slice(a, b + 1); part.forEach((v, k) => { d[t + k] = v }); return d })
def(String.prototype, '__size', function (this: string) { return this.length })
def(Map.prototype, '__size', function (this: Map<any, any>) { return this.size })
def(Set.prototype, '__size', function (this: Set<any>) { return this.size })
def(Map.prototype, 'isEmpty', function (this: Map<any, any>) { return this.size === 0 })
def(Set.prototype, 'isEmpty', function (this: Set<any>) { return this.size === 0 })

// roblox-ts : le comparateur de sort() renvoie un booleen "a < b".
const nativeSort = Array.prototype.sort
Object.defineProperty(Array.prototype, 'sort', {
  configurable: true, writable: true,
  value: function (this: any[], f?: (a: any, b: any) => any) {
    if (!f) return nativeSort.call(this)
    return nativeSort.call(this, (a: any, b: any) => {
      const r = f(a, b)
      if (typeof r === 'boolean') return r ? -1 : f(b, a) ? 1 : 0
      return r
    })
  },
})

// --- bibliotheque string de Luau exposee en methodes par roblox-ts (s.upper(), s.gsub(...), ...)
const CLS: Record<string, string> = { a: 'A-Za-z', d: '0-9', l: 'a-z', u: 'A-Z', w: 'A-Za-z0-9', s: '\\s', x: 'A-Fa-f0-9', p: '!-/:-@\\[-`{-~', c: '\\x00-\\x1f' }
function luaToRegex(p: string): RegExp {
  let out = ''
  let i = 0
  while (i < p.length) {
    const c = p[i]
    if (c === '%') {
      const n = p[i + 1]
      i += 2
      const set = n ? CLS[n.toLowerCase()] : undefined
      if (set) out += n === n.toLowerCase() ? `[${set}]` : `[^${set}]`
      else out += n ? '\\' + n : ''
      continue
    }
    if (c === '[') {
      let j = i + 1
      let set = '['
      if (p[j] === '^') { set += '^'; j++ }
      while (j < p.length && p[j] !== ']') {
        if (p[j] === '%') { const n = p[j + 1]; set += (n && CLS[n.toLowerCase()]) || '\\' + n; j += 2 } else { set += p[j] === '\\' ? '\\\\' : p[j]; j++ }
      }
      out += set + ']'
      i = j + 1
      continue
    }
    if (c === '-') { out += '*?'; i++; continue }
    if ('{}|\\'.includes(c)) { out += '\\' + c; i++; continue }
    out += c
    i++
  }
  return new RegExp(out, 'g')
}
const defS = (name: string, fn: any) => Object.defineProperty(String.prototype, name, { value: fn, writable: true, configurable: true, enumerable: false })
defS('upper', function (this: string) { return this.toUpperCase() })
defS('lower', function (this: string) { return this.toLowerCase() })
defS('len', function (this: string) { return this.length })
defS('rep', function (this: string, n: number, sep = '') { return Array(Math.max(n, 0)).fill(String(this)).join(sep) })
defS('reverse', function (this: string) { return [...this].reverse().join('') })
defS('byte', function (this: string, i = 1, j = i) { const out: number[] = []; for (let k = i; k <= j; k++) out.push(this.charCodeAt(k - 1)); return out })
defS('format', function (this: string, ...a: any[]) { return fmt(String(this), ...a) })
defS('sub', function (this: string, i: number, j = -1) {
  const n = this.length
  const a = i < 0 ? Math.max(n + i + 1, 1) : Math.max(i, 1)
  const b = j < 0 ? n + j + 1 : Math.min(j, n)
  return a > b ? '' : this.slice(a - 1, b)
})
defS('find', function (this: string, pat: string, init = 1, plain = false) {
  const s = String(this).slice(Math.max(init - 1, 0))
  if (plain) { const k = s.indexOf(pat); return k < 0 ? undefined : [k + init, k + init + pat.length - 1] }
  const m = luaToRegex(pat).exec(s)
  return m ? [m.index + init, m.index + init + m[0].length - 1, ...m.slice(1)] : undefined
})
const nativeMatch = String.prototype.match
defS('match', function (this: string, pat: any, init = 1) {
  if (pat instanceof RegExp) return nativeMatch.call(this, pat)
  const m = luaToRegex(pat).exec(String(this).slice(Math.max(init - 1, 0)))
  if (!m) return undefined
  return m.length > 1 ? m.slice(1) : [m[0]]
})
defS('gmatch', function* (this: string, pat: string) {
  for (const m of String(this).matchAll(luaToRegex(pat))) yield m.length > 1 ? m.slice(1) : [m[0]]
})
defS('gsub', function (this: string, pat: string, repl: any, maxN?: number) {
  let count = 0
  const re = luaToRegex(pat)
  const out = String(this).replace(re, (...args: any[]) => {
    if (maxN !== undefined && count >= maxN) return args[0]
    count++
    const groups = args.slice(1, args.findIndex((a, i) => i > 0 && typeof a === 'number')).filter((x) => typeof x === 'string' || x === undefined)
    if (typeof repl === 'function') { const r = repl(...(groups.length ? groups : [args[0]])); return r === undefined || r === false ? args[0] : String(r) }
    if (typeof repl === 'object' && repl) { const r = repl[groups[0] ?? args[0]]; return r === undefined || r === false ? args[0] : String(r) }
    return String(repl).replace(/%(\d|%)/g, (_m, d) => (d === '%' ? '%' : d === '0' ? args[0] : groups[Number(d) - 1] ?? ''))
  })
  return [out, count]
})

// --- DateTime
class DateTimeImpl {
  UnixTimestamp: number
  UnixTimestampMillis: number
  constructor(ms: number) { this.UnixTimestampMillis = Math.round(ms); this.UnixTimestamp = Math.floor(ms / 1000) }
  static now() { return new DateTimeImpl(Date.now()) }
  static fromUnixTimestamp(s: number) { return new DateTimeImpl(s * 1000) }
  static fromUnixTimestampMillis(ms: number) { return new DateTimeImpl(ms) }
  static fromUniversalTime(y: number, mo = 1, d = 1, h = 0, mi = 0, s = 0, ms = 0) { return new DateTimeImpl(Date.UTC(y, mo - 1, d, h, mi, s, ms)) }
  static fromLocalTime(y: number, mo = 1, d = 1, h = 0, mi = 0, s = 0, ms = 0) { return new DateTimeImpl(new Date(y, mo - 1, d, h, mi, s, ms).getTime()) }
  static fromIsoDate(iso: string) { const t = Date.parse(iso); return Number.isNaN(t) ? undefined : new DateTimeImpl(t) }
  private parts(utc: boolean) {
    const d = new Date(this.UnixTimestampMillis)
    return utc
      ? { Year: d.getUTCFullYear(), Month: d.getUTCMonth() + 1, Day: d.getUTCDate(), Hour: d.getUTCHours(), Minute: d.getUTCMinutes(), Second: d.getUTCSeconds(), Millisecond: d.getUTCMilliseconds() }
      : { Year: d.getFullYear(), Month: d.getMonth() + 1, Day: d.getDate(), Hour: d.getHours(), Minute: d.getMinutes(), Second: d.getSeconds(), Millisecond: d.getMilliseconds() }
  }
  ToUniversalTime() { return this.parts(true) }
  ToLocalTime() { return this.parts(false) }
  ToIsoDate() { return new Date(this.UnixTimestampMillis).toISOString() }
  FormatUniversalTime(_fmt: string, locale = 'en-us') { return new Date(this.UnixTimestampMillis).toLocaleString(locale, { timeZone: 'UTC' }) }
  FormatLocalTime(_fmt: string, locale = 'en-us') { return new Date(this.UnixTimestampMillis).toLocaleString(locale) }
}

// --- Random, metatables, utf8
function mulberry32(a: number) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
class Random {
  private r: () => number
  constructor(seed?: number) { this.r = seed === undefined ? Math.random : mulberry32(seed) }
  NextNumber(a?: number, b?: number) { return a === undefined ? this.r() : a + (b! - a) * this.r() }
  NextInteger(a: number, b: number) { return Math.floor(a + (b - a + 1) * this.r()) }
  NextUnitVector() { const z = this.r() * 2 - 1, t = this.r() * Math.PI * 2, s = Math.sqrt(1 - z * z); return new dt.Vector3(s * Math.cos(t), s * Math.sin(t), z) }
  Shuffle(arr: any[]) { for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(this.r() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]] } }
  Clone() { return new Random() }
}
const setmetatable = (t: any, mt: any) => {
  if (mt && mt.__index && typeof mt.__index === 'object') Object.setPrototypeOf(t, mt.__index)
  else if (mt && typeof mt.__index === 'function') return new Proxy(t, { get: (o, k) => (k in o ? o[k] : mt.__index(o, k)) })
  Object.defineProperty(t, '__mt', { value: mt, enumerable: false, configurable: true })
  return t
}
// Cible de definedSpreads (plugin Vite) : copie d'un objet sans ses cles `undefined` (une cle nil n'existe pas en Luau).
function __defined(o: any) {
  if (o === null || typeof o !== 'object' || Array.isArray(o) || o.ClassName !== undefined) return o
  const out: any = {}
  for (const k of Object.keys(o)) if (o[k] !== undefined) out[k] = o[k]
  return out
}

// Cibles des reecritures generees par le plugin Vite (voir callableMetatables) : objet -> fonction appelable.
function __callable(obj: any) {
  const f: any = (...a: any[]) => f.__call?.(f, ...a)
  for (const k of Object.keys(obj)) { try { Object.defineProperty(f, k, { value: obj[k], writable: true, configurable: true, enumerable: true }) } catch { /* name/length */ } }
  return f
}
function __setCall(t: any, mt: any) {
  if (mt && typeof mt.__call === 'function') Object.defineProperty(t, '__call', { value: mt.__call, writable: true, configurable: true, enumerable: false })
  return setmetatable(t, mt)
}
const utf8 = {
  len: (s: string) => [[...s].length, undefined], char: (...c: number[]) => String.fromCodePoint(...c), charpattern: '[\u0000-\u007FÂ-ý][\u0080-¿]*',
  codepoint: (s: string, i = 1, j = i) => [...s].slice(i - 1, j).map((c) => c.codePointAt(0)), offset: (_s: string, n: number) => n,
  codes: function* (s: string) { let k = 1; for (const c of s) { yield [k, c.codePointAt(0)]; k += c.length } },
}

const math = {
  floor: Math.floor, ceil: Math.ceil, abs: Math.abs, sqrt: Math.sqrt, sin: Math.sin, cos: Math.cos, tan: Math.tan, atan2: Math.atan2, atan: Math.atan,
  max: Math.max, min: Math.min, pow: Math.pow, log: (x: number, b?: number) => (b ? Math.log(x) / Math.log(b) : Math.log(x)), exp: Math.exp,
  pi: Math.PI, huge: Infinity, rad: (d: number) => (d * Math.PI) / 180, deg: (r: number) => (r * 180) / Math.PI,
  clamp: (v: number, a: number, b: number) => Math.min(Math.max(v, a), b), sign: Math.sign,
  round: (v: number) => (v < 0 ? -Math.round(-v) : Math.round(v)), lerp: (a: number, b: number, t: number) => a + (b - a) * t,
  random: (a?: number, b?: number) => (a === undefined ? Math.random() : b === undefined ? Math.floor(Math.random() * a) + 1 : Math.floor(Math.random() * (b - a + 1)) + a),
  noise: () => 0, randomseed() {}, fmod: (a: number, b: number) => a % b, log10: Math.log10, trunc: Math.trunc,
}

const fmt = (f: string, ...a: any[]) => {
  let i = 0
  return f.replace(/%([-0 +]*)(\d+)?(?:\.(\d+))?([dsfxXgq%i])/g, (_m, fl: string, w: string, p: string, t: string) => {
    if (t === '%') return '%'
    const v = a[i++]
    let s: string
    if (t === 'd' || t === 'i') s = String(Math.trunc(Number(v)))
    else if (t === 'f') s = Number(v).toFixed(p === undefined ? 6 : Number(p))
    else if (t === 'x') s = Number(v).toString(16)
    else if (t === 'X') s = Number(v).toString(16).toUpperCase()
    else s = String(v)
    if (w) s = fl.includes('-') ? s.padEnd(+w) : s.padStart(+w, fl.includes('0') ? '0' : ' ')
    return s
  })
}
const string = {
  format: fmt, sub: (s: string, i: number, j = -1) => s.slice(i < 0 ? s.length + i : i - 1, j < 0 ? s.length + j + 1 : j),
  rep: (s: string, n: number) => s.repeat(n), upper: (s: string) => s.toUpperCase(), lower: (s: string) => s.toLowerCase(), len: (s: string) => s.length,
  byte: (s: string, i = 1) => s.charCodeAt(i - 1), char: (...c: number[]) => String.fromCharCode(...c), reverse: (s: string) => [...s].reverse().join(''),
  split: (s: string, sep: string) => s.split(sep),
}
const table = {
  insert: (t: any[], a: any, b?: any) => (b === undefined ? t.push(a) : t.splice(a - 1, 0, b)), remove: (t: any[], i?: number) => (i === undefined ? t.pop() : t.splice(i - 1, 1)[0]),
  concat: (t: any[], sep = '') => t.join(sep), clear: (t: any) => { if (Array.isArray(t)) t.length = 0 }, unpack: (t: any[]) => t, find: (t: any[], v: any) => { const i = t.indexOf(v); return i < 0 ? undefined : i + 1 },
}

let syncWaits = 0
let waitCalls = 0
const task = {
  spawn: (f: any, ...a: any[]) => { if (new URLSearchParams(location.search).get('notask')) return; if (typeof f === 'function') queueMicrotask(() => f(...a)) },
  defer: (f: any, ...a: any[]) => { queueMicrotask(() => f(...a)) },
  delay: (s: number, f: any, ...a: any[]) => { const id = setTimeout(() => f(...a), s * 1000); return id },
  // Protection : une boucle qui appelle task.wait sans jamais ceder la main (fonction non convertie en async) est coupee
  // au lieu de figer la page. Le compteur est remis a zero des que la pile se vide (microtache).
  wait: (s = 0) => {
    waitCalls++
    if (waitCalls % 300 === 0) console.log(`[trace] task.wait #${waitCalls} s=${s} (${typeof s})`)
    if (++syncWaits > 5000) throw new Error('task.wait appele en boucle sans suspension (fonction non convertie en async)')
    queueMicrotask(() => { syncWaits = 0 })
    return new Promise<number>((r) => setTimeout(() => r(s), s * 1000))
  },
  cancel: (id: any) => clearTimeout(id),
}
const t0 = performance.now()
const typeOfFn = (v: any) =>
  v === undefined || v === null ? 'nil' : typeof v === 'object' ? (v.ClassName ? 'Instance' : v.constructor?.name ?? 'table') : typeof v
const typeIs = (v: any, t: string) => {
  const k = typeOfFn(v)
  return k === t || (t === 'table' && typeof v === 'object' && !v.ClassName) || (t === 'Instance' && !!v?.ClassName)
}

Object.assign(g, {
  UDim: dt.UDim, UDim2: dt.UDim2, Vector2: dt.Vector2, Vector3: dt.Vector3, CFrame: dt.CFrame, Color3: dt.Color3, Rect: dt.Rect,
  NumberRange: dt.NumberRange, NumberSequence: dt.NumberSequence, NumberSequenceKeypoint: dt.NumberSequenceKeypoint,
  ColorSequence: dt.ColorSequence, ColorSequenceKeypoint: dt.ColorSequenceKeypoint, TweenInfo: dt.TweenInfo, Font: dt.Font,
  Enum, Instance, game, workspace: Workspace, math, string, table, task,
  os: { clock: () => (performance.now() - t0) / 1000, time: () => Math.floor(Date.now() / 1000), date: () => new Date().toISOString() },
  tick: () => Date.now() / 1000, time: () => (performance.now() - t0) / 1000, wait: (s = 0) => task.wait(s),
  typeOf: typeOfFn, typeIs, tostring: (v: any) => String(v), tonumber: (v: any) => { const n = Number(v); return Number.isNaN(n) ? undefined : n },
  print: (...a: any[]) => console.log('[print]', ...a), warn: (...a: any[]) => console.warn('[warn]', ...a),
  assert: (c: any, m?: string) => { if (!c) throw new Error(m ?? 'assertion failed') },
  script: undefined, shared: {}, _G: {}, Random, setmetatable, utf8, DateTime: DateTimeImpl, __callable, __setCall, __defined,
  // macro roblox-ts : for (const i of $range(a, b, step))
  $range: function* (a: number, b: number, step = 1) { if (step > 0) for (let i = a; i <= b; i += step) yield i; else for (let i = a; i >= b; i += step) yield i },
  getmetatable: (t: any) => t?.__mt, rawget: (t: any, k: any) => t[k], rawset: (t: any, k: any, v: any) => { t[k] = v; return t }, rawequal: (a: any, b: any) => a === b,
  next: (t: any) => { const k = Object.keys(t)[0]; return k === undefined ? undefined : [k, t[k]] }, select: (n: any, ...a: any[]) => (n === '#' ? a.length : a.slice(n - 1)),
  unpack: (t: any[]) => t, pcall: (f: any, ...a: any[]) => { try { return [true, f(...a)] } catch (e) { return [false, e] } },
})

export {}
