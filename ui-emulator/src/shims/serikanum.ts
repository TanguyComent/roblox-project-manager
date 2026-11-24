// Doublure de @rbxts/serikanum (grands nombres "OnoeNum"). Pour l'apercu d'UI, un double JS suffit :
// les valeurs affichees restent dans la plage d'un nombre flottant, avec les suffixes K, M, B, T...
const SUFFIXES = ['', 'K', 'M', 'B', 'T', 'Qa', 'Qi', 'Sx', 'Sp', 'Oc', 'No', 'Dc']

type Num = number | OnoeNum | { Mantissa: number; Exponent: number } | { mantissa: number; exponent: number } | string

function toNumber(v: any): number {
  if (v === undefined || v === null) return 0
  if (typeof v === 'number') return v
  if (typeof v === 'string') return Number(v)
  if (v instanceof OnoeNum) return v.value
  const m = v.Mantissa ?? v.mantissa
  const e = v.Exponent ?? v.exponent
  if (m !== undefined && e !== undefined) return m * 10 ** e
  return Number(v)
}

export class OnoeNum {
  value: number
  constructor(v: Num = 0) { this.value = toNumber(v) }
  get Mantissa() { return this.value === 0 ? 0 : this.value / 10 ** Math.floor(Math.log10(Math.abs(this.value))) }
  get Exponent() { return this.value === 0 ? 0 : Math.floor(Math.log10(Math.abs(this.value))) }
  add(o: Num) { return new OnoeNum(this.value + toNumber(o)) }
  sub(o: Num) { return new OnoeNum(this.value - toNumber(o)) }
  mul(o: Num) { return new OnoeNum(this.value * toNumber(o)) }
  div(o: Num) { return new OnoeNum(this.value / toNumber(o)) }
  pow(o: Num) { return new OnoeNum(this.value ** toNumber(o)) }
  neg() { return new OnoeNum(-this.value) }
  abs() { return new OnoeNum(Math.abs(this.value)) }
  round() { return new OnoeNum(Math.round(this.value)) }
  floor() { return new OnoeNum(Math.floor(this.value)) }
  ceil() { return new OnoeNum(Math.ceil(this.value)) }
  max(o: Num) { return new OnoeNum(Math.max(this.value, toNumber(o))) }
  min(o: Num) { return new OnoeNum(Math.min(this.value, toNumber(o))) }
  lt(o: Num) { return this.value < toNumber(o) }
  le(o: Num) { return this.value <= toNumber(o) }
  gt(o: Num) { return this.value > toNumber(o) }
  ge(o: Num) { return this.value >= toNumber(o) }
  eq(o: Num) { return this.value === toNumber(o) }
  // alias de la vraie API
  plus(o: Num) { return this.add(o) }
  minus(o: Num) { return this.sub(o) }
  times(o: Num) { return this.mul(o) }
  divide(o: Num) { return this.div(o) }
  power(o: Num) { return this.pow(o) }
  lessThan(o: Num) { return this.lt(o) }
  lessThanOrEquals(o: Num) { return this.le(o) }
  lessThanOrEqualTo(o: Num) { return this.le(o) }
  greaterThan(o: Num) { return this.gt(o) }
  greaterThanOrEquals(o: Num) { return this.ge(o) }
  greaterThanOrEqualTo(o: Num) { return this.ge(o) }
  equals(o: Num) { return this.eq(o) }
  isZero() { return this.value === 0 }
  toNumber() { return this.value }
  toSuffix(decimals = 2) {
    const abs = Math.abs(this.value)
    if (abs < 1000) return String(Math.round(this.value * 100) / 100)
    const i = Math.min(Math.floor(Math.log10(abs) / 3), SUFFIXES.length - 1)
    const scaled = this.value / 1000 ** i
    return `${Number(scaled.toFixed(decimals))}${SUFFIXES[i]}`
  }
  toString() { return this.toSuffix() }
  toScientific() { return this.value.toExponential(2) }
  toLocale() { return this.value.toLocaleString('en-US') }
}

export type BaseOnoeNum = { Mantissa: number; Exponent: number } | number
export const BaseOnoeNum = undefined
export const Number_ = { isOnoe: (v: any) => v instanceof OnoeNum }
export { Number_ as Number }
export default OnoeNum
