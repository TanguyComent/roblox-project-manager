// Choix d'une place Roblox pour un projet : dans la liste des places connues du compte, ou par identifiants saisis a la main.
// Dans les deux cas la place est verifiee aupres de Roblox avec la cle du compte.
import type { Db } from './db.ts'
import { verifyPlace, type RobloxAccount } from './roblox-accounts.ts'
import type { RobloxClient } from './roblox.ts'
import { parseRobloxId } from './projects.ts'

export interface PlaceInput { known: string; universeId: string; placeId: string }
export interface PlaceSelection { universeId: number; placeId: number; /** true : Roblox a confirme que la cle du compte y accede */ verified: boolean }
export type PlaceResult = { ok: true; place: PlaceSelection | null } | { ok: false; error: string; status: 400 | 502 }

// Aucune place saisie = pas de place (null) : elles peuvent ne pas exister encore.
export async function resolvePlace(
  db: Db, roblox: RobloxClient, account: RobloxAccount | undefined, input: PlaceInput, what: string,
): Promise<PlaceResult> {
  let u = input.universeId.trim()
  let p = input.placeId.trim()
  const known = input.known.trim()
  if (known) { // valeur « univers:place » de la liste (elle vient du navigateur : on la re-verifie comme une saisie)
    const m = /^(\d{1,16}):(\d{1,16})$/.exec(known)
    if (!m) return { ok: false, status: 400, error: `${what} : place invalide.` }
    u = m[1]
    p = m[2]
  }
  if (!u && !p) return { ok: true, place: null }
  if (!u || !p) return { ok: false, status: 400, error: `${what} : renseigne l'identifiant d'univers ET celui de place.` }
  const universeId = parseRobloxId(u)
  const placeId = parseRobloxId(p)
  if (universeId === null || placeId === null) return { ok: false, status: 400, error: `${what} : les identifiants doivent etre des nombres.` }
  if (!account) return { ok: true, place: { universeId, placeId, verified: false } } // projet sans compte Roblox rattache : rien a verifier
  const check = await verifyPlace(db, roblox, account, universeId, placeId)
  if (!check.ok) return { ok: false, status: check.status, error: `${what} : ${check.error}` }
  return { ok: true, place: { universeId, placeId, verified: check.verified } }
}
