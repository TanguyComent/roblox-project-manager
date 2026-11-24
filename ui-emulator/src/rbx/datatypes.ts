import { Enum } from './enums'

const lerp = (a: number, b: number, t: number) => a + (b - a) * t

export class UDim {
  constructor(public Scale = 0, public Offset = 0) {}
  add(o: UDim) { return new UDim(this.Scale + o.Scale, this.Offset + o.Offset) }
  sub(o: UDim) { return new UDim(this.Scale - o.Scale, this.Offset - o.Offset) }
  Lerp(g: UDim, t: number) { return new UDim(lerp(this.Scale, g.Scale, t), lerp(this.Offset, g.Offset, t)) }
}

export class UDim2 {
  X: UDim
  Y: UDim
  constructor(xs: any = 0, xo: any = 0, ys: any = 0, yo: any = 0) {
    if (xs instanceof UDim) {
      this.X = xs
      this.Y = xo instanceof UDim ? xo : new UDim()
    } else {
      this.X = new UDim(xs, xo)
      this.Y = new UDim(ys, yo)
    }
  }
  get Width() { return this.X }
  get Height() { return this.Y }
  static fromScale(x: number, y: number) { return new UDim2(x, 0, y, 0) }
  static fromOffset(x: number, y: number) { return new UDim2(0, x, 0, y) }
  add(o: UDim2) { return new UDim2(this.X.add(o.X), this.Y.add(o.Y)) }
  sub(o: UDim2) { return new UDim2(this.X.sub(o.X), this.Y.sub(o.Y)) }
  Lerp(g: UDim2, t: number) { return new UDim2(this.X.Lerp(g.X, t), this.Y.Lerp(g.Y, t)) }
}

export class Vector2 {
  constructor(public X = 0, public Y = 0) {}
  static get zero() { return new Vector2(0, 0) }
  static get one() { return new Vector2(1, 1) }
  static get xAxis() { return new Vector2(1, 0) }
  static get yAxis() { return new Vector2(0, 1) }
  private o(v: any) { return typeof v === 'number' ? new Vector2(v, v) : v }
  add(v: any) { v = this.o(v); return new Vector2(this.X + v.X, this.Y + v.Y) }
  sub(v: any) { v = this.o(v); return new Vector2(this.X - v.X, this.Y - v.Y) }
  mul(v: any) { v = this.o(v); return new Vector2(this.X * v.X, this.Y * v.Y) }
  div(v: any) { v = this.o(v); return new Vector2(this.X / v.X, this.Y / v.Y) }
  get Magnitude() { return Math.hypot(this.X, this.Y) }
  get Unit() { const m = this.Magnitude || 1; return new Vector2(this.X / m, this.Y / m) }
  Dot(v: Vector2) { return this.X * v.X + this.Y * v.Y }
  Lerp(g: Vector2, t: number) { return new Vector2(lerp(this.X, g.X, t), lerp(this.Y, g.Y, t)) }
}

export class Vector3 {
  constructor(public X = 0, public Y = 0, public Z = 0) {}
  static get zero() { return new Vector3(0, 0, 0) }
  static get one() { return new Vector3(1, 1, 1) }
  private o(v: any) { return typeof v === 'number' ? new Vector3(v, v, v) : v }
  add(v: any) { v = this.o(v); return new Vector3(this.X + v.X, this.Y + v.Y, this.Z + v.Z) }
  sub(v: any) { v = this.o(v); return new Vector3(this.X - v.X, this.Y - v.Y, this.Z - v.Z) }
  mul(v: any) { v = this.o(v); return new Vector3(this.X * v.X, this.Y * v.Y, this.Z * v.Z) }
  div(v: any) { v = this.o(v); return new Vector3(this.X / v.X, this.Y / v.Y, this.Z / v.Z) }
  get Magnitude() { return Math.hypot(this.X, this.Y, this.Z) }
  Lerp(g: Vector3, t: number) { return new Vector3(lerp(this.X, g.X, t), lerp(this.Y, g.Y, t), lerp(this.Z, g.Z, t)) }
}

// CFrame minimal : seule la position est suivie (pas de 3D dans l'emulateur), le reste renvoie des valeurs neutres.
export class CFrame {
  Position: Vector3
  constructor(x: any = 0, y: any = 0, z = 0) {
    this.Position = x instanceof Vector3 ? x : new Vector3(typeof x === 'number' ? x : 0, typeof y === 'number' ? y : 0, z)
  }
  get X() { return this.Position.X }
  get Y() { return this.Position.Y }
  get Z() { return this.Position.Z }
  get LookVector() { return new Vector3(0, 0, -1) }
  get RightVector() { return new Vector3(1, 0, 0) }
  get UpVector() { return new Vector3(0, 1, 0) }
  get Rotation() { return new CFrame() }
  static get identity() { return new CFrame() }
  static Angles(..._a: number[]) { return new CFrame() }
  static fromEulerAnglesXYZ(..._a: number[]) { return new CFrame() }
  static fromEulerAnglesYXZ(..._a: number[]) { return new CFrame() }
  static fromOrientation(..._a: number[]) { return new CFrame() }
  static fromAxisAngle(..._a: any[]) { return new CFrame() }
  static lookAt(at: Vector3, _look?: Vector3, _up?: Vector3) { return new CFrame(at) }
  mul(o: any): any {
    if (o instanceof CFrame) return new CFrame(this.Position.add(o.Position))
    if (o instanceof Vector3) return this.Position.add(o)
    return this
  }
  Inverse() { return new CFrame(this.Position.mul(-1)) }
  ToObjectSpace(o: CFrame) { return new CFrame(o.Position.sub(this.Position)) }
  ToWorldSpace(o: CFrame) { return new CFrame(this.Position.add(o.Position)) }
  PointToWorldSpace(v: Vector3) { return this.Position.add(v) }
  PointToObjectSpace(v: Vector3) { return v.sub(this.Position) }
  VectorToWorldSpace(v: Vector3) { return v }
  Lerp(g: CFrame, t: number) { return new CFrame(this.Position.Lerp(g.Position, t)) }
  ToEulerAnglesXYZ(): [number, number, number] { return [0, 0, 0] }
  ToOrientation(): [number, number, number] { return [0, 0, 0] }
}

export class Color3 {
  constructor(public R = 0, public G = 0, public B = 0) {}
  static fromRGB(r = 0, g = 0, b = 0) { return new Color3(r / 255, g / 255, b / 255) }
  static fromHex(h: string) {
    const s = h.replace('#', '')
    return Color3.fromRGB(parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16))
  }
  static fromHSV(h: number, s: number, v: number) {
    const i = Math.floor(h * 6), f = h * 6 - i, p = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s)
    const m = [[v, t, p], [q, v, p], [p, v, t], [p, q, v], [t, p, v], [v, p, q]][((i % 6) + 6) % 6]
    return new Color3(m[0], m[1], m[2])
  }
  Lerp(g: Color3, t: number) { return new Color3(lerp(this.R, g.R, t), lerp(this.G, g.G, t), lerp(this.B, g.B, t)) }
  ToHSV(): [number, number, number] {
    const { R: r, G: g, B: b } = this
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn
    let h = 0
    if (d) h = mx === r ? ((g - b) / d + 6) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4
    return [h / 6, mx ? d / mx : 0, mx]
  }
  ToHex() {
    const x = (n: number) => Math.round(n * 255).toString(16).padStart(2, '0')
    return x(this.R) + x(this.G) + x(this.B)
  }
}

export class Rect {
  Min: Vector2
  Max: Vector2
  constructor(a: any = 0, b: any = 0, c?: number, d?: number) {
    if (a instanceof Vector2) { this.Min = a; this.Max = b } else { this.Min = new Vector2(a, b); this.Max = new Vector2(c ?? 0, d ?? 0) }
  }
}

export class NumberRange {
  Min: number
  Max: number
  constructor(a: number, b?: number) { this.Min = a; this.Max = b ?? a }
}

export class NumberSequenceKeypoint {
  constructor(public Time: number, public Value: number, public Envelope = 0) {}
}
export class NumberSequence {
  Keypoints: NumberSequenceKeypoint[]
  constructor(a: any, b?: any) {
    if (Array.isArray(a)) this.Keypoints = a
    else this.Keypoints = [new NumberSequenceKeypoint(0, a), new NumberSequenceKeypoint(1, b ?? a)]
  }
}

export class ColorSequenceKeypoint {
  constructor(public Time: number, public Value: Color3) {}
}
export class ColorSequence {
  Keypoints: ColorSequenceKeypoint[]
  constructor(a: any, b?: any) {
    if (Array.isArray(a)) this.Keypoints = a
    else this.Keypoints = [new ColorSequenceKeypoint(0, a), new ColorSequenceKeypoint(1, b ?? a)]
  }
}

export class TweenInfo {
  constructor(
    public Time = 1,
    public EasingStyle: any = Enum.EasingStyle.Quad,
    public EasingDirection: any = Enum.EasingDirection.Out,
    public RepeatCount = 0,
    public Reverses = false,
    public DelayTime = 0,
  ) {}
}

export class Font {
  constructor(public Family = 'rbxasset://fonts/families/SourceSansPro.json', public Weight: any = Enum.FontWeight.Regular, public Style: any = Enum.FontStyle.Normal) {}
  static fromEnum(f: any) { return new Font('enum:' + f?.Name) }
  static fromName(name: string, weight?: any, style?: any) { return new Font(`rbxasset://fonts/families/${name}.json`, weight ?? Enum.FontWeight.Regular, style ?? Enum.FontStyle.Normal) }
  static fromId(id: number, weight?: any, style?: any) { return new Font(`rbxassetid://${id}`, weight ?? Enum.FontWeight.Regular, style ?? Enum.FontStyle.Normal) }
  get Bold() { return this.Weight?.Name === 'Bold' }
}

// Les types Roblox (UDim2, Color3, Vector2...) se comparent PAR VALEUR. En JS deux objets identiques sont "differents" :
// sans cette comparaison, un nouveau rendu React ecraserait a tort une propriete modifiee entre-temps (ex. la poignee d'un curseur).
export function valueEquals(a: any, b: any): boolean {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (a.ClassName !== undefined || b.ClassName !== undefined) return false // Instances : identite
  if (a.constructor !== b.constructor) return false
  if (typeof a.Connect === 'function' || typeof a.getValue === 'function' || typeof a.then === 'function') return false // signaux, bindings, promesses
  if (Array.isArray(a)) return a.length === b.length && a.every((v, i) => valueEquals(v, b[i]))
  const ka = Object.keys(a)
  const kb = Object.keys(b)
  if (ka.length !== kb.length) return false
  const proto = Object.getPrototypeOf(a)
  if (proto !== Object.prototype && !(a instanceof UDim || a instanceof UDim2 || a instanceof Vector2 || a instanceof Vector3 || a instanceof Color3 || a instanceof CFrame || a instanceof Rect || a instanceof NumberRange || a instanceof NumberSequence || a instanceof NumberSequenceKeypoint || a instanceof ColorSequence || a instanceof ColorSequenceKeypoint || a instanceof TweenInfo || a instanceof Font)) return false
  return ka.every((k) => valueEquals(a[k], b[k]))
}

export const toCssColor =(c: Color3, alpha = 1) =>
  `rgba(${Math.round(c.R * 255)},${Math.round(c.G * 255)},${Math.round(c.B * 255)},${alpha})`
