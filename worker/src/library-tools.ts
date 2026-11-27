// Outils « bibliotheque d'images » donnes a l'IA d'un chat (voir tools.ts) :
//   library_search  chercher dans les images triees de l'utilisateur (icones, fonds...) ;
//   library_get     recuperer une image : elle est deposee dans l'atelier (`_library/`), l'IA la VOIT, et reçoit la reference a mettre dans l'interface.
//
// Reference d'une image dans le code d'une interface : `rbxassetid://<id>` si elle est deja publiee sur Roblox, sinon `rbxlib://<id de la bibliotheque>` (provisoire :
// l'emulateur sait l'afficher grace a `_library/index.json`, qui lie chaque reference a son fichier ; elle sera publiee et remplacee a l'integration dans le projet).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import type { JobContext } from './jobs.ts'
import { text, type ToolDef, type ToolResult } from './tools.ts'

export const LIBRARY_DIR = '_library'
const EXT: Record<string, string> = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif' }

export interface LibraryEntry {
  id: string; folder: string; title: string; description: string; tags: string[]; mime: string; size: number; sha256: string
  roblox_status: string; roblox_asset_id: string | null
}

export interface LibraryToolsState {
  ctx: Pick<JobContext, 'signal' | 'event' | 'searchLibrary' | 'downloadLibraryImage'>
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
    out.push({
      id: e.id, folder: String(e.folder ?? '').slice(0, 100), title: String(e.title ?? '').slice(0, 60), description: String(e.description ?? '').slice(0, 300),
      tags: Array.isArray(e.tags) ? e.tags.filter((t): t is string => typeof t === 'string').slice(0, 8) : [], mime: e.mime, size: e.size, sha256: e.sha256,
      roblox_status: String(e.roblox_status ?? 'unpublished'), roblox_asset_id: asset,
    })
  }
  return out
}

/** La reference a ecrire dans la propriete Image. */
export const referenceOf = (e: Pick<LibraryEntry, 'id' | 'roblox_asset_id'>) => (e.roblox_asset_id ? `rbxassetid://${e.roblox_asset_id}` : `rbxlib://${e.id}`)

const line = (e: LibraryEntry) => `- ${e.folder}/${e.title} [id ${e.id}] : ${e.description} (mots-cles : ${e.tags.join(', ') || '-'}) → ${e.roblox_asset_id ? `publiee : ${referenceOf(e)}` : 'pas encore publiee sur Roblox'}`

/** Associe a chaque image deposee dans l'atelier sa (ou ses) reference(s) ; lu par l'emulateur (preview.mjs --images). */
function remember(dir: string, e: LibraryEntry, file: string) {
  const f = join(dir, 'index.json')
  let index: Record<string, string> = {}
  try { const j = JSON.parse(readFileSync(f, 'utf8')); if (isObj(j)) for (const [k, v] of Object.entries(j)) if (typeof v === 'string') index[k] = v } catch { index = {} }
  index[`rbxlib://${e.id}`] = file
  if (e.roblox_asset_id) index[`rbxassetid://${e.roblox_asset_id}`] = file
  writeFileSync(f, JSON.stringify(index, null, 1))
}

export function libraryTools(s: LibraryToolsState): ToolDef[] {
  const cache = new Map<string, LibraryEntry>()
  const unavailable = () => text("La bibliotheque d'images n'est pas disponible sur ce Worker.", true)

  const search: ToolDef = {
    name: 'library_search',
    description: "Cherche dans la bibliotheque d'images de l'utilisateur (images deja decrites et rangees par dossier : icones, fonds, personnages...). "
      + "A utiliser AVANT d'inventer un visuel ou de laisser un emplacement d'image vide, des qu'une interface a besoin d'une icone ou d'une illustration. "
      + "`query` : quelques mots (nom, theme, couleur, usage) ; `folder` : restreint a un dossier. Sans `query`, liste les images (du dossier). Renvoie l'id de chaque image : passe-le a library_get pour la recuperer.",
    inputSchema: { type: 'object', properties: { query: { type: 'string' }, folder: { type: 'string', description: 'Dossier du vault (ex. icons/armes).' } } },
    async run(args): Promise<ToolResult> {
      if (!s.ctx.searchLibrary) return unavailable()
      const query = typeof args.query === 'string' ? args.query.slice(0, 200) : ''
      const folder = typeof args.folder === 'string' ? args.folder.slice(0, 100) : ''
      let hits: LibraryEntry[]
      try { hits = parseEntries(await s.ctx.searchLibrary({ query, folder })) } catch (e) { return text(`Recherche impossible : ${e instanceof Error ? e.message.slice(0, 160) : 'erreur'}`, true) }
      for (const h of hits) cache.set(h.id, h)
      if (!hits.length) return text(`Aucune image trouvee${query ? ` pour « ${query} »` : ''}. La bibliotheque contient peut-etre autre chose : essaie d'autres mots, ou liste sans query. Sinon, dessine l'element avec des composants de l'interface.`)
      return text(`${hits.length} image(s) :\n${hits.map(line).join('\n')}\n\nPour en utiliser une, appelle library_get avec son id.`)
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
        return {
          content: [
            { type: 'text', text: `${e.folder}/${e.title} : ${e.description}\nReference a utiliser dans Image : ${ref}${e.roblox_asset_id ? '' : "\n(Image pas encore publiee sur Roblox : l'apercu l'affiche, elle sera publiee quand le concept sera integre au projet.)"}\nFichier copie dans l'atelier : ${LIBRARY_DIR}/${file}` },
            { type: 'image', data: data.toString('base64'), mimeType: e.mime },
          ],
        }
      } catch (err) { return text(`Recuperation impossible : ${err instanceof Error ? err.message.slice(0, 160) : 'erreur'}`, true) }
    },
  }
  return [search, get]
}
