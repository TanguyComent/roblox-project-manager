// Envoi d'un paquet d'apercu au Host (POST /api/worker/previews, authentifie par le jeton du Worker). Le Host verifie tout (chemins, extensions, tailles).
import { listFiles, readBase64, type PreviewMeta } from './preview.ts'

export const MAX_FILES = 300
export const MAX_BYTES = 12 * 1024 * 1024

export async function uploadPreview(hostUrl: string, token: string, jobId: number, dir: string | null, meta: PreviewMeta, fetchImpl: typeof fetch = fetch): Promise<string> {
  let files: { path: string; data: string }[] = []
  if (dir) {
    const list = listFiles(dir)
    const total = list.reduce((n, f) => n + f.size, 0)
    if (list.length > MAX_FILES || total > MAX_BYTES) throw new Error(`paquet trop gros (${list.length} fichiers, ${Math.round(total / 1024)} Ko)`)
    files = list.map((f) => ({ path: f.path, data: readBase64(f.abs) }))
  }
  const url = new URL('/api/worker/previews', hostUrl)
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ jobId, ...meta, files }),
    signal: AbortSignal.timeout(120_000),
  })
  const body = (await res.json().catch(() => ({}))) as { id?: unknown; error?: unknown }
  if (!res.ok || typeof body.id !== 'string') throw new Error(typeof body.error === 'string' ? body.error : `refuse par le Host (${res.status})`)
  return body.id
}
