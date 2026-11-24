// Doublure propre au projet : client/UI/hooks/usePx.ts utilise une metatable Luau (__call) pour que `px(100)` marche,
// ce qu'un objet JS ne peut pas faire. Meme calcul, mais avec une vraie fonction.
import { useMemo } from 'react'
import { useCamera, useDebounceState, useEventListener } from '../prettyReactHooks'

const BASE = { X: 2532, Y: 1173 }
const MIN_SCALE = 0.1
const DOMINANT_AXIS = 0.5

function calculateScale(vp: { X: number; Y: number }) {
  const w = Math.log2(vp.X / BASE.X)
  const h = Math.log2(vp.Y / BASE.Y)
  return Math.max(2 ** (w + (h - w) * DOMINANT_AXIS), MIN_SCALE)
}

export function usePx(): any {
  const camera: any = useCamera()
  const [scale, setScale] = useDebounceState(calculateScale(camera.ViewportSize), 0.2)
  useEventListener(camera.GetPropertyChangedSignal('ViewportSize'), () => setScale(calculateScale(camera.ViewportSize)))
  return useMemo(() => {
    const px: any = (v: number) => Math.round(v * scale)
    px.even = (v: number) => Math.round(v * scale * 0.5) * 2
    px.scale = (v: number) => v * scale
    px.floor = (v: number) => Math.floor(v * scale)
    px.ceil = (v: number) => Math.ceil(v * scale)
    return px
  }, [scale])
}
