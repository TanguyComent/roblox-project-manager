// Executeurs de taches. Un executeur recoit le contenu de la tache, un signal d'annulation et une fonction pour emettre des evenements ;
// il renvoie le resultat (ou leve une erreur). Les vrais types de taches (agents, Studio, Blender...) viendront s'ajouter ici.
export interface JobContext {
  jobId: number
  payload: unknown
  /** Declenche quand le Host annule la tache ou que la connexion est perdue : l'executeur doit s'arreter vite. */
  signal: AbortSignal
  event(level: 'info' | 'warn' | 'error', text: string, kind?: 'info' | 'thinking' | 'tool' | 'text'): void
  /** Depose un paquet d'apercu (dossier) sur le Host, rattache a cette tache ; sans dossier, ne depose que les metadonnees. Renvoie l'identifiant de l'apercu. */
  uploadPreview?(dir: string | null, meta: import('./preview.ts').PreviewMeta): Promise<string>
}
export type JobHandler = (ctx: JobContext) => Promise<unknown>

export class JobCancelled extends Error {
  constructor() { super('Tache annulee.') }
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(new JobCancelled())
    const t = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve() }, ms)
    const onAbort = () => { clearTimeout(t); reject(new JobCancelled()) }
    signal.addEventListener('abort', onAbort, { once: true })
  })

export const defaultHandlers: Record<string, JobHandler> = {
  // Renvoie ce qu'on lui envoie : sert a verifier la chaine Host -> Worker -> Host.
  async echo({ payload, event }) {
    event('info', 'echo : tache recue')
    event('info', `echo : ${JSON.stringify(payload).slice(0, 200)}`)
    return { echo: payload }
  },

  // Attend un moment (annulable) : sert a tester la file d'attente et l'annulation.
  async sleep({ payload, signal, event }) {
    const raw = (payload as { ms?: unknown } | null)?.ms
    const ms = typeof raw === 'number' && Number.isFinite(raw) ? Math.min(Math.max(Math.trunc(raw), 0), 60_000) : 1000
    event('info', `sleep : ${ms} ms`)
    await sleep(ms, signal)
    return { sleptMs: ms }
  },
}
