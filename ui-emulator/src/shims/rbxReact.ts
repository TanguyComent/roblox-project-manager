// @rbxts/react = React + bindings (createBinding / useBinding / joinBindings).
import * as R from 'react'
import { createBinding, joinBindings, isBinding } from '../rbx/binding'

// React est du CommonJS : on reexporte explicitement chaque nom (export * ne suffit pas).
export const Children = R.Children
export const Component = R.Component
export const Fragment = R.Fragment
export const Profiler = R.Profiler
export const PureComponent = R.PureComponent
export const StrictMode = R.StrictMode
export const Suspense = R.Suspense
export const cloneElement = R.cloneElement
export const createContext = R.createContext
export const createElement = R.createElement
export const createRef = R.createRef
export const forwardRef = R.forwardRef
export const isValidElement = R.isValidElement
export const lazy = R.lazy
export const memo = R.memo
export const startTransition = R.startTransition
export const useCallback = R.useCallback
export const useContext = R.useContext
export const useDebugValue = R.useDebugValue
export const useDeferredValue = R.useDeferredValue
export const useEffect = R.useEffect
export const useId = R.useId
export const useImperativeHandle = R.useImperativeHandle
export const useInsertionEffect = R.useInsertionEffect
export const useLayoutEffect = R.useLayoutEffect
export const useMemo = R.useMemo
export const useReducer = R.useReducer
export const useRef = R.useRef
export const useState = R.useState
export const useSyncExternalStore = R.useSyncExternalStore
export const useTransition = R.useTransition
export { createBinding, joinBindings, isBinding }

export function useBinding<T>(initial: T) {
  return R.useState(() => createBinding(initial))[0]
}

const React: any = { ...(R as any).default ?? R, createBinding, joinBindings, isBinding, useBinding }
export default React
