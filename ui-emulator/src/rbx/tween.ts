import { Signal } from './signal'
import { Enum } from './enums'

const bounceOut = (t: number) => {
  const n = 7.5625, d = 2.75
  if (t < 1 / d) return n * t * t
  if (t < 2 / d) return n * (t -= 1.5 / d) * t + 0.75
  if (t < 2.5 / d) return n * (t -= 2.25 / d) * t + 0.9375
  return n * (t -= 2.625 / d) * t + 0.984375
}
const IN: Record<string, (t: number) => number> = {
  Linear: (t) => t,
  Sine: (t) => 1 - Math.cos((t * Math.PI) / 2),
  Quad: (t) => t * t,
  Cubic: (t) => t ** 3,
  Quart: (t) => t ** 4,
  Quint: (t) => t ** 5,
  Exponential: (t) => (t === 0 ? 0 : 2 ** (10 * (t - 1))),
  Circular: (t) => 1 - Math.sqrt(1 - t * t),
  Back: (t) => t * t * (2.70158 * t - 1.70158),
  Elastic: (t) => (t === 0 || t === 1 ? t : -(2 ** (10 * (t - 1))) * Math.sin((t - 1.1) * 5 * Math.PI)),
  Bounce: (t) => 1 - bounceOut(1 - t),
}

export function ease(style: string, dir: string, t: number): number {
  const f = IN[style] ?? IN.Quad
  if (dir === 'In') return f(t)
  if (dir === 'Out') return 1 - f(1 - t)
  return t < 0.5 ? f(t * 2) / 2 : 1 - f((1 - t) * 2) / 2
}

function mix(a: any, b: any, t: number): any {
  if (typeof a === 'number' && typeof b === 'number') return a + (b - a) * t
  if (a && typeof a.Lerp === 'function') return a.Lerp(b, t)
  return t >= 1 ? b : a
}

class Tween {
  Completed = new Signal()
  PlaybackState: any = Enum.PlaybackState.Begin
  private raf = 0
  private t0 = 0
  private from: Record<string, any> = {}
  constructor(private inst: any, private info: any, private goals: Record<string, any>) {}

  Play() {
    cancelAnimationFrame(this.raf)
    this.from = {}
    for (const k of Object.keys(this.goals)) this.from[k] = this.inst[k]
    this.t0 = performance.now() + (this.info.DelayTime ?? 0) * 1000
    this.PlaybackState = Enum.PlaybackState.Playing
    const dur = Math.max(this.info.Time, 0.0001) * 1000
    const step = (now: number) => {
      let p = Math.min(Math.max((now - this.t0) / dur, 0), 1)
      const e = ease(this.info.EasingStyle?.Name ?? 'Quad', this.info.EasingDirection?.Name ?? 'Out', p)
      for (const k of Object.keys(this.goals)) this.inst[k] = mix(this.from[k], this.goals[k], e)
      if (p >= 1) {
        this.PlaybackState = Enum.PlaybackState.Completed
        this.Completed.Fire(this.PlaybackState)
      } else this.raf = requestAnimationFrame(step)
    }
    this.raf = requestAnimationFrame(step)
  }
  Pause() { cancelAnimationFrame(this.raf); this.PlaybackState = Enum.PlaybackState.Paused }
  Cancel() { cancelAnimationFrame(this.raf); this.PlaybackState = Enum.PlaybackState.Cancelled; this.Completed.Fire(this.PlaybackState) }
  Destroy() { cancelAnimationFrame(this.raf) }
}

export const TweenServiceImpl = {
  Create(inst: any, info: any, goals: Record<string, any>) { return new Tween(inst, info, goals) },
  GetValue(alpha: number, style: any, dir: any) { return ease(style?.Name ?? 'Quad', dir?.Name ?? 'Out', alpha) },
}
