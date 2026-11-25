// Choix d'une place Roblox pour un projet : dans la liste des places connues du compte, ou par identifiants saisis a la main.
import type { Db } from './db.ts'
import { listKnownPlaces, type RobloxAccount } from './roblox-accounts.ts'
import { RobloxError, type RobloxClient } from './roblox.ts'
import { parseRobloxId } from './projects.ts'

export interface PlaceInput { known: string; universeId: string; placeId: string }
export interface PlaceSelection { universeId: number; placeId: number; /** true : la place figure parmi celles que le compte peut atteindre */ verified: boolean }
export type PlaceResult = { ok: true; place: PlaceSelection | null } | { ok: false; error: string; status: 400 | 502 }

// Liste (« univers:place ») ou identifiants manuels. Une place choisie dans la liste est RE-VERIFIEE ici : la valeur vient du navigateur.
// Aucune place saisie = pas de place (null) : elles peuvent ne pas exister encore.
export async function resolvePlace(
  db: Db, roblox: RobloxClient, account: Pick<RobloxAccount, 'id' | 'username'> | undefined, input: PlaceInput, what: string,
): Promise<PlaceResult> {
  const known = input.known.trim()
  if (known) {
    const m = /^(\d{1,16}):(\d{1,16})$/.exec(known)
    if (!m) return { ok: false, status: 400, error: `${what} : place invalide.` }
    if (!account) return { ok: false, status: 400, error: `${what} : choisis d'abord un compte Roblox.` }
    try {
      let list = await listKnownPlaces(db, roblox, account.id)
      let found = list.find((p) => p.universeId === m[1] && p.placeId === m[2])
      if (!found) { // la liste en cache est peut-etre perimee : une relecture avant de refuser
        list = await listKnownPlaces(db, roblox, account.id, { fresh: true })
        found = list.find((p) => p.universeId === m[1] && p.placeId === m[2])
      }
      if (!found) {
        return { ok: false, status: 400, error: `${what} : cette place n'est pas accessible avec le compte Roblox « ${account.username} » (choisis un autre compte, ou autorise cette experience en le reconnectant).` }
      }
      return { ok: true, place: { universeId: Number(m[1]), placeId: Number(m[2]), verified: true } }
    } catch (e) {
      if (e instanceof RobloxError && e.code === 'needs_reauth') return { ok: false, status: 400, error: `${e.message} (page Compte).` }
      return { ok: false, status: 502, error: `${what} : impossible de lire les places du compte (${e instanceof RobloxError ? e.message : 'Roblox ne repond pas'}).` }
    }
  }
  const u = input.universeId.trim()
  const p = input.placeId.trim()
  if (!u && !p) return { ok: true, place: null }
  if (!u || !p) return { ok: false, status: 400, error: `${what} : renseigne l'identifiant d'univers ET celui de place.` }
  const universeId = parseRobloxId(u)
  const placeId = parseRobloxId(p)
  if (universeId === null || placeId === null) return { ok: false, status: 400, error: `${what} : les identifiants doivent etre des nombres.` }
  return { ok: true, place: { universeId, placeId, verified: false } }
}
