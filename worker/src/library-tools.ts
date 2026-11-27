// Outils « bibliotheque d'images » donnes a l'IA d'un chat (voir tools.ts) :
//   library_search  chercher dans les images triees de l'utilisateur (icones, fonds...) ;
//   library_get     recuperer une image : elle est deposee dans l'atelier (`_library/`), l'IA la VOIT, et reçoit la reference a mettre dans l'interface.
//
// Reference d'une image dans le code d'une interface : `rbxassetid://<id>` si elle est deja publiee sur Roblox, sinon `rbxlib://<id de la bibliotheque>` (provisoire :
// l'emulateur sait l'afficher grace a `_library/index.json`, qui lie chaque reference a son fichier ; elle sera publiee et remplacee a l'integration dans le projet).
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, sep } from 'node:path'
import { createHash } from 'node:crypto'
import type { JobContext } from './jobs.ts'
import { text, type ToolDef, type ToolResult } from './tools.ts'

export const LIBRARY_DIR = '_library'
const EXT: Record<string, string> = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif' }

export interface LibraryEntry {
  id: string; scope: string; title: string; description: string; tags: string[]; style: string; traits: string[]; subject: string; colors: string[]
  width: number; height: number; ratio: string; mime: string; size: number; sha256: string
  roblox_status: string; roblox_asset_id: string | null
}

export interface LibraryToolsState {
  ctx: Pick<JobContext, 'signal' | 'event' | 'searchLibrary' | 'downloadLibraryImage' | 'publishLibrary'>
  /** Le projet du chat : la branche de travail est-elle ouverte (integration) et ou ? */
  project?: () => { open: boolean; dir: string | null }
  /** Dossier de l'atelier de ce chat. */
  atelier: string
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null

/** Lit la reponse du Host : tout ce qui est mal forme est ignore (le Host est de confiance, pas les valeurs qu'il relaie). */
export function parseEntries(raw: unknown): LibraryEntry[] {
  const list = isObj(raw) && Array.isArray(raw.images) ? raw.images : []
  const out: LibraryEntry[] = []
  for (const e of list.slice(0, 50)) {
    if (!isObj(e) || typeof e.id !== 'string' || !/^[0-9a-f]{32}$/.test(e.id) || typeof e.mime !== 'string' || !EXT[e.mime]) continue
    if (typeof e.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(e.sha256) || typeof e.size !== 'number') continue
    const asset = typeof e.roblox_asset_id === 'string' && /^\d{1,20}$/.test(e.roblox_asset_id) && e.roblox_status === 'published' ? e.roblox_asset_id : null
    const strs = (v: unknown, n: number) => (Array.isArray(v) ? v.filter((t): t is string => typeof t === 'string').slice(0, n).map((t) => t.slice(0, 40)) : [])
    out.push({
      id: e.id, scope: String(e.scope ?? '').slice(0, 40), title: String(e.title ?? '').slice(0, 60), description: String(e.description ?? '').slice(0, 300),
      tags: strs(e.tags, 8), style: String(e.style ?? '').slice(0, 40), traits: strs(e.traits, 6), subject: String(e.subject ?? '').slice(0, 40), colors: strs(e.colors, 4),
      width: Number.isInteger(e.width) ? (e.width as number) : 0, height: Number.isInteger(e.height) ? (e.height as number) : 0, ratio: String(e.ratio ?? '').slice(0, 12),
      mime: e.mime, size: e.size, sha256: e.sha256, roblox_status: String(e.roblox_status ?? 'unpublished'), roblox_asset_id: asset,
    })
  }
  return out
}

/** La reference a ecrire dans la propriete Image. */
export const referenceOf = (e: Pick<LibraryEntry, 'id' | 'roblox_asset_id'>) => (e.roblox_asset_id ? `rbxassetid://${e.roblox_asset_id}` : `rbxlib://${e.id}`)

const line = (e: LibraryEntry) => `- ${e.scope}/${e.title} [id ${e.id}] : ${e.description}\n    sujet : ${e.subject || '-'} · style : ${e.style || '-'}${e.traits.length ? ` (${e.traits.join(', ')})` : ''} · couleurs : ${e.colors.join(', ') || '-'} · ${e.width ? `${e.width}x${e.height} ${e.ratio}` : 'taille inconnue'} → ${e.roblox_asset_id ? `publiee : ${referenceOf(e)}` : 'pas encore publiee sur Roblox'}`

/** Associe a chaque image deposee dans l'atelier sa (ou ses) reference(s) ; lu par l'emulateur (preview.mjs --images). */
function remember(dir: string, e: LibraryEntry, file: string) {
  const f = join(dir, 'index.json')
  let index: Record<string, string> = {}
  try { const j = JSON.parse(readFileSync(f, 'utf8')); if (isObj(j)) for (const [k, v] of Object.entries(j)) if (typeof v === 'string') index[k] = v } catch { index = {} }
  index[`rbxlib://${e.id}`] = file
  if (e.roblox_asset_id) index[`rbxassetid://${e.roblox_asset_id}`] = file
  writeFileSync(f, JSON.stringify(index, null, 1))
}

const CODE = /\.(tsx?|jsx?|luau?|json)$/i
const SKIP = new Set(['.git', 'node_modules', 'out', 'dist', 'include', 'Packages'])
const REF = /rbxlib:\/\/([0-9a-f]{32})/g

/** Fichiers de code du projet (bornes : nombre et taille). */
function codeFiles(dir: string): string[] {
  const out: string[] = []
  const walk = (d: string) => {
    if (out.length >= 3000) return
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isSymbolicLink()) continue
      const p = join(d, e.name)
      if (e.isDirectory()) { if (!SKIP.has(e.name)) walk(p) } else if (e.isFile() && CODE.test(e.name) && statSync(p).size <= 1_000_000) out.push(p)
    }
  }
  walk(dir)
  return out
}

/** Remplace des references dans les fichiers du projet ; renvoie les fichiers modifies (chemins relatifs). */
export function replaceReferences(dir: string, map: Map<string, string>): string[] {
  const changed: string[] = []
  for (const f of codeFiles(dir)) {
    const src = readFileSync(f, 'utf8')
    const next = src.replace(REF, (m, id: string) => map.get(id) ?? m)
    if (next !== src) { writeFileSync(f, next); changed.push(f.slice(dir.length + 1).split(sep).join('/')) }
  }
  return changed
}

/** Identifiants des images de la bibliotheque referencees (rbxlib://) dans le projet. */
export function referencedIds(dir: string): Set<string> {
  const ids = new Set<string>()
  for (const f of codeFiles(dir)) for (const m of readFileSync(f, 'utf8').matchAll(REF)) ids.add(m[1])
  return ids
}

export function libraryTools(s: LibraryToolsState): ToolDef[] {
  const cache = new Map<string, LibraryEntry>()
  const unavailable = () => text("La bibliotheque d'images n'est pas disponible sur ce Worker.", true)

  const search: ToolDef = {
    name: 'library_search',
    description: "Cherche dans la bibliotheque d'images de l'utilisateur (images deja decrites : scope, style, sujet, couleurs). "
      + "A utiliser AVANT d'inventer un visuel ou de laisser un emplacement d'image vide, des qu'une interface a besoin d'une icone ou d'une illustration. "
      + "`query` : quelques mots (sujet, theme, usage) ; filtres exacts facultatifs : `scope` (icon, decoration, background...), `style` (nom d'un style : pour garder un ECRAN COHERENT, choisis un style et ne pioche que dedans), `subject` (pendule, poubelle...), `color`, `ratio` (carre, large, haut, bandeau). "
      + "Sans rien, liste les images. Renvoie l'id de chaque image : passe-le a library_get pour la recuperer.",
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' }, scope: { type: 'string' }, style: { type: 'string' }, subject: { type: 'string' }, color: { type: 'string' },
        ratio: { type: 'string', enum: ['carre', 'large', 'haut', 'bandeau'] },
      },
    },
    async run(args): Promise<ToolResult> {
      if (!s.ctx.searchLibrary) return unavailable()
      const str = (v: unknown, n = 100) => (typeof v === 'string' ? v.slice(0, n) : '')
      const q = { query: str(args.query, 200), scope: str(args.scope), style: str(args.style), subject: str(args.subject), color: str(args.color), ratio: str(args.ratio, 12) }
      let hits: LibraryEntry[]
      try { hits = parseEntries(await s.ctx.searchLibrary(q)) } catch (e) { return text(`Recherche impossible : ${e instanceof Error ? e.message.slice(0, 160) : 'erreur'}`, true) }
      for (const h of hits) cache.set(h.id, h)
      if (!hits.length) return text(`Aucune image trouvee${q.query ? ` pour « ${q.query} »` : ''}. Essaie d'autres mots, retire un filtre, ou liste sans rien. Sinon, dessine l'element avec des composants de l'interface.`)
      return text(`${hits.length} image(s) :\n${hits.map(line).join('\n')}\n\nPour en utiliser une, appelle library_get avec son id.`)
    },
  }

  const publish: ToolDef = {
    name: 'library_publish',
    description: "Publie sur Roblox les images de la bibliotheque utilisees dans le PROJET (references rbxlib://...), puis remplace ces references par les vrais rbxassetid://... dans le code. "
      + "A appeler a l'INTEGRATION d'un concept valide, une fois la branche du projet ouverte et le code ecrit, AVANT de montrer le resultat final. Sans argument, publie toutes les images referencees dans le projet. "
      + "Si une image est en cours de moderation, refusee, ou demande la confirmation de l'utilisateur (reglage ou image generee), la reference rbxlib:// reste : dis-le clairement dans ta reponse.",
    inputSchema: { type: 'object', properties: { ids: { type: 'array', items: { type: 'string' }, description: 'Identifiants des images (facultatif : par defaut toutes celles referencees dans le projet).' } } },
    async run(args): Promise<ToolResult> {
      if (!s.ctx.publishLibrary) return unavailable()
      const p = s.project?.()
      if (!p?.open || !p.dir) return text("La publication sur Roblox ne se fait qu'a l'integration dans le projet : ouvre d'abord la branche de travail (outil project, action open_branch) et ecris le code qui utilise l'image.", true)
      const used = referencedIds(p.dir)
      const wanted = Array.isArray(args.ids) ? args.ids.filter((x): x is string => typeof x === 'string').map((x) => x.trim().toLowerCase()) : [...used]
      const ids = [...new Set(wanted)].filter((id) => /^[0-9a-f]{32}$/.test(id))
      const notUsed = ids.filter((id) => !used.has(id))
      if (notUsed.length) return text(`Ces images ne sont referencees (rbxlib://) nulle part dans le projet : ${notUsed.join(', ')}. N'en publie que celles que le code utilise.`, true)
      if (!ids.length) return text('Aucune reference rbxlib:// dans le projet : rien a publier.')
      let results: { id: string; status: string; reference: string | null; error: string | null }[]
      try {
        const body = await s.ctx.publishLibrary(ids) as { results?: unknown }
        results = (Array.isArray(body.results) ? body.results : []).flatMap((r) => (isObj(r) && typeof r.id === 'string' ? [{ id: r.id, status: String(r.status), reference: typeof r.reference === 'string' && /^rbxassetid:\/\/\d{1,20}$/.test(r.reference) ? r.reference : null, error: typeof r.error === 'string' ? r.error.slice(0, 200) : null }] : []))
      } catch (e) { return text(`Publication impossible : ${e instanceof Error ? e.message.slice(0, 200) : 'erreur'}`, true) }
      const map = new Map(results.filter((r) => r.status === 'published' && r.reference).map((r) => [r.id, r.reference!]))
      const changed = map.size ? replaceReferences(p.dir, map) : []
      const lines = results.map((r) => `- ${r.id} : ${r.status === 'published' ? `publiee → ${r.reference}` : r.status === 'publishing' ? 'en cours de moderation chez Roblox (reference rbxlib:// conservee ; rappelle library_publish plus tard)' : r.status === 'needs-confirmation' ? "a confirmer par l'utilisateur dans la bibliotheque (reference rbxlib:// conservee)" : `ECHEC : ${r.error ?? 'erreur'} (reference rbxlib:// conservee : propose une autre image)`}`)
      return text(`${map.size} image(s) publiee(s) sur ${results.length}.\n${lines.join('\n')}${changed.length ? `\nReferences remplacees dans : ${changed.slice(0, 20).join(', ')}` : ''}\nIndique a l'utilisateur ce qui a ete publie et ce qui reste a faire.`)
    },
  }

  const get: ToolDef = {
    name: 'library_get',
    description: "Recupere une image de la bibliotheque : elle est copiee dans l'atelier (dossier _library/), tu la VOIS, et tu recois la reference exacte a ecrire dans la propriete Image de ton interface "
      + "(rbxassetid://... si elle est publiee sur Roblox, sinon une reference provisoire que l'apercu sait afficher). Ne modifie jamais cette reference a la main.",
    inputSchema: { type: 'object', properties: { id: { type: 'string', description: "Identifiant renvoye par library_search." } }, required: ['id'] },
    async run(args, signal): Promise<ToolResult> {
      if (!s.ctx.searchLibrary || !s.ctx.downloadLibraryImage) return unavailable()
      const id = typeof args.id === 'string' ? args.id.trim().toLowerCase() : ''
      if (!/^[0-9a-f]{32}$/.test(id)) return text('Identifiant invalide : utilise celui renvoye par library_search.', true)
      try {
        let e = cache.get(id)
        if (!e) { e = parseEntries(await s.ctx.searchLibrary({ id }))[0]; if (e) cache.set(id, e) }
        if (!e) return text('Image introuvable dans la bibliotheque (seules les images triees sont disponibles).', true)
        const data = await s.ctx.downloadLibraryImage(id)
        if (signal.aborted) return text('Annule.', true)
        if (data.length !== e.size || createHash('sha256').update(data).digest('hex') !== e.sha256) return text("Image corrompue pendant le telechargement : reessaie.", true)
        const dir = join(s.atelier, LIBRARY_DIR)
        mkdirSync(dir, { recursive: true })
        const file = `${id.slice(0, 8)}-${e.title.replace(/[^a-z0-9-]/g, '-') || 'image'}${EXT[e.mime]}`
        writeFileSync(join(dir, file), data)
        remember(dir, e, file)
        const ref = referenceOf(e)
        let similar = ''
        try {
          const near = parseEntries(await s.ctx.searchLibrary({ similar: id })).slice(0, 5)
          if (near.length) similar = `\nImages de style proche (pour un ecran coherent) :\n${near.map(line).join('\n')}`
        } catch { /* suggestions facultatives */ }
        return {
          content: [
            { type: 'text', text: `${e.scope}/${e.title} : ${e.description}\nStyle : ${e.style || '-'}${e.traits.length ? ` (${e.traits.join(', ')})` : ''}\nReference a utiliser dans Image : ${ref}${e.roblox_asset_id ? '' : "\n(Image pas encore publiee sur Roblox : l'apercu l'affiche, elle sera publiee quand le concept sera integre au projet.)"}\nFichier copie dans l'atelier : ${LIBRARY_DIR}/${file}${similar}` },
            { type: 'image', data: data.toString('base64'), mimeType: e.mime },
          ],
        }
      } catch (err) { return text(`Recuperation impossible : ${err instanceof Error ? err.message.slice(0, 160) : 'erreur'}`, true) }
    },
  }
  return [search, get, publish]
}
