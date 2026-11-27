// Publication des images de la bibliotheque sur Roblox (API Assets d'Open Cloud, type Image : l'identifiant obtenu sert directement dans les proprietes d'image).
//
// Le HOST publie : la cle d'API Roblox ne quitte jamais le Host (le Worker demande, le Host appelle Roblox). Roblox examine l'image de facon asynchrone (moderation) :
// l'envoi renvoie une operation qu'on interroge jusqu'a son terme (publiee, refusee ou en erreur).
//
// Qui declenche : l'utilisateur (bouton) ou l'IA a l'integration d'un concept valide dans un vrai projet (voir attachment-routes.ts, qui en fixe les garde-fous).
import type { Db } from './db.ts'
import { getImage, readImage, cleanTitle, type LibraryImage } from './library.ts'
import { RobloxError, type RobloxClient } from './roblox.ts'
import { canUploadAssets, getAccount, usableKey } from './roblox-accounts.ts'

export interface PublishTarget { accountId: number; creator: { userId: string } | { groupId: string }; owner: string }
export interface PublishResult { id: string; status: 'published' | 'publishing' | 'failed'; reference: string | null; error: string | null }

export const FORMATS: Record<string, 'image/png' | 'image/jpeg'> = { 'image/png': 'image/png', 'image/jpeg': 'image/jpeg' }
export const referenceOfAsset = (assetId: string) => `rbxassetid://${assetId}`

type Client = Pick<RobloxClient, 'createImageAsset' | 'getAssetOperation'>
interface Opts { sleep?: (ms: number) => Promise<void>; attempts?: number; delayMs?: number }

// --- reglage : publication automatique a l'integration ------------------------------------------------------------------------------------

export const autoPublishOf = (db: Db, userId: number): boolean => {
  const r = db.prepare('SELECT auto_publish FROM library_settings WHERE user_id = ?').get(userId) as { auto_publish: number } | undefined
  return r ? r.auto_publish === 1 : true
}
export const setAutoPublish = (db: Db, userId: number, on: boolean) => {
  db.prepare('INSERT INTO library_settings (user_id, auto_publish) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET auto_publish = excluded.auto_publish').run(userId, on ? 1 : 0)
}

// --- ou publier -----------------------------------------------------------------------------------------------------------------------------

/** Compte et proprietaire des images pour un projet : le groupe du projet s'il en a un, sinon le compte Roblox lie. */
export function targetForProject(db: Db, userId: number, projectId: number): PublishTarget | { error: string } {
  const p = db.prepare('SELECT roblox_account_id, roblox_group_id FROM projects WHERE id = ? AND owner_id = ?').get(projectId, userId) as { roblox_account_id: number | null; roblox_group_id: number | null } | undefined
  if (!p) return { error: 'Projet introuvable.' }
  if (!p.roblox_account_id) return { error: "Ce projet n'a pas de compte Roblox lie : choisis-en un dans les reglages du projet." }
  const account = getAccount(db, userId, p.roblox_account_id)
  if (!account) return { error: 'Compte Roblox introuvable.' }
  return p.roblox_group_id
    ? { accountId: account.id, creator: { groupId: String(p.roblox_group_id) }, owner: `group:${p.roblox_group_id}` }
    : { accountId: account.id, creator: { userId: account.roblox_user_id }, owner: `user:${account.roblox_user_id}` }
}

/** Compte personnel (publication manuelle sur le compte lui-meme). */
export function targetForAccount(db: Db, userId: number, accountId: number): PublishTarget | { error: string } {
  const a = getAccount(db, userId, accountId)
  return a ? { accountId: a.id, creator: { userId: a.roblox_user_id }, owner: `user:${a.roblox_user_id}` } : { error: 'Compte Roblox introuvable.' }
}

// --- envoi ----------------------------------------------------------------------------------------------------------------------------------

const fail = (db: Db, id: string, error: string): PublishResult => {
  db.prepare("UPDATE library_images SET roblox_status = 'failed', roblox_error = ?, roblox_op = NULL WHERE id = ?").run(error.slice(0, 300), id)
  return { id, status: 'failed', reference: null, error }
}
const done = (db: Db, img: LibraryImage, assetId: string): PublishResult => {
  db.prepare("UPDATE library_images SET roblox_status = 'published', roblox_asset_id = ?, roblox_error = NULL, roblox_op = NULL, published_at = COALESCE(published_at, ?) WHERE id = ?").run(assetId, Date.now(), img.id)
  return { id: img.id, status: 'published', reference: referenceOfAsset(assetId), error: null }
}
const keyOf = (db: Db, userId: number, accountId: number) => {
  const account = getAccount(db, userId, accountId)
  if (!account) throw new RobloxError('Compte Roblox introuvable.', 404)
  return { account, key: usableKey(db, account) }
}

/** Interroge l'operation d'une image en cours de publication. */
async function pollOne(db: Db, client: Client, userId: number, img: LibraryImage & { roblox_op: string | null; roblox_account_id: number | null }): Promise<PublishResult> {
  if (!img.roblox_op || !img.roblox_account_id) return fail(db, img.id, 'Publication interrompue : relance-la.')
  try {
    const { key } = keyOf(db, userId, img.roblox_account_id)
    const op = await client.getAssetOperation(key, img.roblox_op)
    if (op.error) return fail(db, img.id, `Refusee par Roblox : ${op.error}`)
    if (!op.done) return { id: img.id, status: 'publishing', reference: null, error: null }
    if (op.moderation === 'rejected') return fail(db, img.id, 'Image refusee par la moderation de Roblox.')
    if (op.moderation === 'reviewing' || !op.assetId) return { id: img.id, status: 'publishing', reference: null, error: null }
    return done(db, img, op.assetId)
  } catch (e) { return e instanceof RobloxError && e.status >= 500 ? { id: img.id, status: 'publishing', reference: null, error: null } : fail(db, img.id, e instanceof Error ? e.message : 'erreur Roblox') }
}

type Row = LibraryImage & { roblox_op: string | null; roblox_account_id: number | null }
const rowOf = (db: Db, userId: number, id: string) => getImage(db, userId, id) as Row | undefined

/** Publie ces images (deja triees) pour la cible donnee. Une image deja publiee n'est jamais renvoyee ; deux images identiques (meme empreinte) partagent le meme asset. */
export async function publishImages(db: Db, client: Client, userId: number, ids: string[], target: PublishTarget, by: string, opts: Opts = {}): Promise<PublishResult[]> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const results: PublishResult[] = []
  let creds: ReturnType<typeof keyOf> | null = null
  let credError = ''
  try {
    creds = keyOf(db, userId, target.accountId)
    if (!canUploadAssets(creds.account.scopes)) credError = "La cle de ce compte Roblox n'a pas la permission asset:write : regenere-la avec cette permission (page Compte)."
  } catch (e) { credError = e instanceof Error ? e.message : 'compte Roblox indisponible' }

  const pending: string[] = []
  for (const id of [...new Set(ids)]) {
    const img = rowOf(db, userId, id)
    if (!img) { results.push({ id, status: 'failed', reference: null, error: 'Image introuvable.' }); continue }
    if (img.status !== 'sorted') { results.push({ id, status: 'failed', reference: null, error: "L'image n'est pas encore triee." }); continue }
    if (img.roblox_status === 'published' && img.roblox_asset_id) { results.push({ id, status: 'published', reference: referenceOfAsset(img.roblox_asset_id), error: null }); continue }
    if (img.roblox_status === 'publishing') { results.push(await pollOne(db, client, userId, img)); if (results.at(-1)!.status === 'publishing') pending.push(id); continue }
    const contentType = FORMATS[img.mime]
    if (!contentType) { results.push(fail(db, id, `Roblox n'accepte pas le format ${img.mime.replace('image/', '').toUpperCase()} : seules les images PNG et JPEG se publient.`)); continue }
    // meme contenu deja publie (par cet utilisateur) : on reutilise l'asset
    const twin = db.prepare("SELECT roblox_asset_id FROM library_images WHERE user_id = ? AND sha256 = ? AND roblox_status = 'published' AND roblox_asset_id IS NOT NULL AND id != ? LIMIT 1").get(userId, img.sha256, id) as { roblox_asset_id: string } | undefined
    if (twin) { results.push(done(db, img, twin.roblox_asset_id)); continue }
    if (credError || !creds) { results.push(fail(db, id, credError)); continue }
    const data = readImage(id)
    if (!data) { results.push(fail(db, id, "Le fichier de l'image est introuvable sur le Host.")); continue }
    // reservation : une seule publication a la fois par image
    const r = db.prepare("UPDATE library_images SET roblox_status = 'publishing', roblox_error = NULL, roblox_owner = ?, roblox_account_id = ?, published_by = ? WHERE id = ? AND roblox_status IN ('unpublished', 'failed')").run(target.owner, target.accountId, by, id)
    if (Number(r.changes) !== 1) { results.push({ id, status: 'publishing', reference: null, error: null }); continue }
    try {
      const { operationId } = await client.createImageAsset(creds.key, { name: cleanTitle(img.title, img.file_name), description: img.description || img.title, creator: target.creator, data, contentType })
      db.prepare('UPDATE library_images SET roblox_op = ? WHERE id = ?').run(operationId, id)
      const first = await pollOne(db, client, userId, rowOf(db, userId, id)!)
      results.push(first)
      if (first.status === 'publishing') pending.push(id)
    } catch (e) { results.push(fail(db, id, e instanceof Error ? `Envoi refuse : ${e.message}` : "Envoi impossible.")) }
  }

  // la moderation prend parfois quelques secondes : quelques interrogations, puis on rend la main (la page poursuit le suivi)
  for (let n = 0; n < (opts.attempts ?? 6) && pending.length; n++) {
    await sleep(opts.delayMs ?? 1500)
    for (const id of [...pending]) {
      const r = await pollOne(db, client, userId, rowOf(db, userId, id)!)
      if (r.status !== 'publishing') { pending.splice(pending.indexOf(id), 1); results[results.findIndex((x) => x.id === id)] = r }
    }
  }
  return results
}

/** Poursuit le suivi des publications restees « en cours » (appelee a l'ouverture de la page Bibliotheque). */
export async function syncPublishing(db: Db, client: Client, userId: number): Promise<number> {
  const rows = db.prepare("SELECT id FROM library_images WHERE user_id = ? AND roblox_status = 'publishing' AND roblox_op IS NOT NULL LIMIT 40").all(userId) as unknown as { id: string }[]
  for (const r of rows) await pollOne(db, client, userId, rowOf(db, userId, r.id)!)
  return rows.length
}

export interface TargetOption { value: string; label: string }
/** Les choix de la publication manuelle : le groupe (ou le compte) de chaque projet, puis chaque compte Roblox pour publier a titre personnel. */
export function publishTargets(db: Db, userId: number): TargetOption[] {
  const out: TargetOption[] = []
  const projects = db.prepare('SELECT id, name, roblox_group_id, roblox_group_name, roblox_account_id FROM projects WHERE owner_id = ? AND roblox_account_id IS NOT NULL ORDER BY name').all(userId) as unknown as { id: number; name: string; roblox_group_id: number | null; roblox_group_name: string | null }[]
  for (const p of projects) out.push({ value: `project:${p.id}`, label: `Projet « ${p.name} » — ${p.roblox_group_id ? `groupe ${p.roblox_group_name ?? p.roblox_group_id}` : 'compte personnel'}` })
  const accounts = db.prepare("SELECT id, label, username FROM roblox_accounts WHERE user_id = ? AND status = 'ok' ORDER BY id").all(userId) as unknown as { id: number; label: string; username: string | null }[]
  for (const a of accounts) out.push({ value: `account:${a.id}`, label: `Compte ${a.label || a.username || a.id} (personnel)` })
  return out
}

/** Resout le choix du formulaire (« project:3 » ou « account:2 ») en cible de publication. */
export function resolveTarget(db: Db, userId: number, value: string): PublishTarget | { error: string } {
  const m = /^(project|account):(\d{1,12})$/.exec(value)
  if (!m) return { error: 'Choisis ou publier.' }
  return m[1] === 'project' ? targetForProject(db, userId, Number(m[2])) : targetForAccount(db, userId, Number(m[2]))
}
