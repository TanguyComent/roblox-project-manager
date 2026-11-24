import * as R from 'react'
import { computed, subscribe, peek } from './charm'

export function useAtom<T>(source: any, deps?: any[]): T {
  const c = R.useMemo(() => (source.__atom ? source : computed(source)), deps ?? [source])
  return R.useSyncExternalStore(
    (cb) => subscribe(c, cb),
    () => peek<T>(c),
  )
}
