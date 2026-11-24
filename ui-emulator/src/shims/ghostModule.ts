import { ghost, MISSING } from '../rbx/services'

// Module non double : tout est un proxy qui enregistre son usage (voir window.__report.missing).
export default function ghostModule(name: string) {
  MISSING.add('import ' + name)
  return ghost('import:' + name)
}
