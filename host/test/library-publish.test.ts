import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createChat } from '../src/chats.ts'
import { config } from '../src/config.ts'
import { encryptSecret, sha256 } from '../src/crypto.ts'
import { getImage } from '../src/library.ts'
import { autoPublishOf, publishImages, publishTargets, syncPublishing, targetForProject } from '../src/library-publish.ts'
import { createProject } from '../src/projects.ts'
import { createRobloxClient, RobloxError, type AssetOperation, type ImageUpload } from '../src/roblox.ts'
import { createWorker, markJobRunning } from '../src/workers.ts'
import { ORIGIN, client, csrfOf, registerAndEnable } from './helpers.ts'

config.dataDir = mkdtempSync(join(tmpdir(), 'rpm-pub-data-'))

const PNG = (tag = 'a') => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(`png-${tag}`)])
const noWait = { sleep: async () => {}, delayMs: 0 }

/** Faux Roblox : enregistre les envois ; `script` decide de l'etat de chaque operation a chaque interrogation. */
function fakeAssets(script: (op: string, n: number) => AssetOperation | Error = () => ({ done: true, assetId: '777', moderation: 'approved', error: null })) {
  const uploads: { key: string; up: ImageUpload }[] = []
  const polls = new Map<string, number>()
  let failUpload: Error | null = null
  return {
    uploads, setFailUpload: (e: Error | null) => { failUpload = e },
    createImageAsset: async (key: string, up: ImageUpload) => { if (failUpload) throw failUpload; uploads.push({ key, up }); return { operationId: `op${uploads.length}` } },
    getAssetOperation: async (_key: string, op: string) => {
      const n = (polls.get(op) ?? 0) + 1
      polls.set(op, n)
      const r = script(op, n)
      if (r instanceof Error) throw r
      return r
    },
  }
}

async function setup(opts: { scopes?: unknown[]; group?: boolean } = {}) {
  const c = client()
  await registerAndEnable(c)
  const csrf = csrfOf((await c.call('GET', '/projects')).text)
  const userId = (c.db.prepare('SELECT id FROM users ORDER BY id LIMIT 1').get() as { id: number }).id
  const scopes = opts.scopes ?? [{ name: 'asset', operations: ['read', 'write'], userIds: [], groupIds: [], universeIds: [] }]
  const acc = c.db.prepare("INSERT INTO roblox_accounts (user_id, label, api_key_enc, key_hash, key_name, roblox_user_id, username, scopes_json, status, checked_at, created_at) VALUES (?, 'Perso', ?, ?, 'cle', '4242', 'tanguy', ?, 'ok', 1, 1)")
    .run(userId, encryptSecret('secret-key-value'), sha256('secret-key-value'), JSON.stringify(scopes))
  const accountId = Number(acc.lastInsertRowid)
  const project = createProject(c.db, userId, { name: 'Mon Jeu', groupId: opts.group ? 99 : null, groupName: opts.group ? 'Mon Groupe' : null, githubRepo: 'acme/jeu', robloxAccountId: accountId })
  const headers = (extra: Record<string, string> = {}) => ({ host: 'localhost:3000', origin: ORIGIN, cookie: c.getCookie(), ...extra })
  const add = async (name: string, over: Record<string, unknown> = {}, data = PNG(name)) => {
    const r = await c.app.request(`${ORIGIN}/library/upload`, { method: 'POST', headers: headers({ 'x-csrf': csrf, 'x-file-name': encodeURIComponent(name) }), body: new Uint8Array(data) })
    const id = ((await r.json()) as { id: string }).id
    const f = { status: 'sorted', scope: 'icon', folder: 'icon', title: name.replace(/\.\w+$/, ''), description: `Image ${name}`, ...over }
    c.db.prepare('UPDATE library_images SET status = ?, scope = ?, folder = ?, title = ?, description = ? WHERE id = ?').run(f.status, f.scope, f.folder, f.title, f.description, id)
    return id
  }
  const target = () => targetForProject(c.db, userId, project.id) as Exclude<ReturnType<typeof targetForProject>, { error: string }>
  return { c, csrf, userId, accountId, project, add, target, headers }
}

test('client Roblox : requete multipart (type Image, createur, cle en en-tete) et lecture des operations', async () => {
  const seen: { url: string; key: string | null; request: Record<string, unknown>; file: { type: string; size: number } }[] = []
  const fetchImpl = (async (url: string, init: RequestInit) => {
    if (init.method === 'POST') {
      const form = init.body as FormData
      const file = form.get('fileContent') as File
      seen.push({ url, key: new Headers(init.headers).get('x-api-key'), request: JSON.parse(String(form.get('request'))), file: { type: file.type, size: file.size } })
      return new Response(JSON.stringify({ path: 'operations/abc-123' }), { status: 200 })
    }
    const states: Record<string, unknown> = {
      'abc-123': { done: true, response: { assetId: '999', moderationResult: { moderationState: 'MODERATION_STATE_APPROVED' } } },
      rej: { done: true, response: { assetId: '5', moderationResult: { moderationState: 'Rejected' } } },
      rev: { done: true, response: { assetId: '6', moderationResult: { moderationState: 'Reviewing' } } },
      err: { done: true, error: { message: 'Asset invalide' } },
      wait: { done: false },
    }
    const id = /operations\/([\w-]+)/.exec(url)![1]
    return new Response(JSON.stringify(states[id]), { status: 200 })
  }) as unknown as typeof fetch
  const rb = createRobloxClient({ fetchImpl })
  const r = await rb.createImageAsset('KEY', { name: 'x'.repeat(80), description: 'desc', creator: { groupId: '99' }, data: PNG(), contentType: 'image/png' })
  assert.equal(r.operationId, 'abc-123')
  assert.equal(seen[0].url, 'https://apis.roblox.com/assets/v1/assets')
  assert.equal(seen[0].key, 'KEY')
  assert.deepEqual(seen[0].request, { assetType: 'Image', displayName: 'x'.repeat(50), description: 'desc', creationContext: { creator: { groupId: '99' } } })
  assert.equal(seen[0].file.type, 'image/png')
  const op = (id: string) => rb.getAssetOperation('KEY', id)
  assert.deepEqual(await op('abc-123'), { done: true, assetId: '999', moderation: 'approved', error: null })
  assert.equal((await op('rej')).moderation, 'rejected')
  assert.equal((await op('rev')).moderation, 'reviewing')
  assert.equal((await op('err')).error, 'Asset invalide')
  assert.equal((await op('wait')).done, false)
  await assert.rejects(rb.getAssetOperation('KEY', '../x'), RobloxError)
})

test('publication : succes, proprietaire (groupe du projet ou compte), cle jamais exposee, pas de renvoi', async () => {
  for (const group of [true, false]) {
    const t = await setup({ group })
    const roblox = fakeAssets()
    const id = await t.add('epee.png')
    const r = await publishImages(t.c.db, roblox, t.userId, [id], t.target(), 'chat 3', noWait)
    assert.deepEqual(r, [{ id, status: 'published', reference: 'rbxassetid://777', error: null }])
    const img = getImage(t.c.db, t.userId, id) as unknown as Record<string, unknown>
    assert.deepEqual([img.roblox_status, img.roblox_asset_id, img.roblox_owner, img.published_by, img.roblox_error], ['published', '777', group ? 'group:99' : 'user:4242', 'chat 3', null])
    assert.deepEqual(roblox.uploads[0].up.creator, group ? { groupId: '99' } : { userId: '4242' })
    assert.equal(roblox.uploads[0].key, 'secret-key-value')
    assert.equal(roblox.uploads[0].up.name, 'epee')
    assert.equal(roblox.uploads[0].up.contentType, 'image/png')
    // deja publiee : aucun nouvel envoi
    const again = await publishImages(t.c.db, roblox, t.userId, [id, id], t.target(), 'manuel', noWait)
    assert.deepEqual(again.map((x) => x.status), ['published'])
    assert.equal(roblox.uploads.length, 1)
  }
})

test('publication : moderation en cours puis approuvee, refusee, erreur, suivi a l ouverture de la page', async () => {
  const t = await setup()
  // en cours au-dela des interrogations : reste « publishing », puis la page poursuit le suivi
  const slow = fakeAssets((op, n) => (n < 4 ? { done: true, assetId: '12', moderation: 'reviewing', error: null } : { done: true, assetId: '12', moderation: 'approved', error: null }))
  const a = await t.add('a.png')
  const r1 = await publishImages(t.c.db, slow, t.userId, [a], t.target(), 'manuel', { ...noWait, attempts: 2 })
  assert.equal(r1[0].status, 'publishing')
  assert.equal(getImage(t.c.db, t.userId, a)!.roblox_status, 'publishing')
  assert.equal(await syncPublishing(t.c.db, slow, t.userId), 1)
  const done = getImage(t.c.db, t.userId, a)!
  assert.deepEqual([done.roblox_status, done.roblox_asset_id], ['published', '12'])

  const rejected = fakeAssets(() => ({ done: true, assetId: '5', moderation: 'rejected', error: null }))
  const b = await t.add('b.png')
  const r2 = await publishImages(t.c.db, rejected, t.userId, [b], t.target(), 'manuel', noWait)
  assert.equal(r2[0].status, 'failed')
  assert.match(r2[0].error!, /moderation/)
  const bi = getImage(t.c.db, t.userId, b)!
  assert.deepEqual([bi.roblox_status, bi.roblox_asset_id], ['failed', null])
  assert.match(bi.roblox_error!, /moderation/)

  const broken = fakeAssets()
  broken.setFailUpload(new RobloxError('acces refuse par Roblox', 403))
  const c2 = await t.add('c.png')
  const r3 = await publishImages(t.c.db, broken, t.userId, [c2], t.target(), 'manuel', noWait)
  assert.match(r3[0].error!, /Envoi refuse : acces refuse/)
  assert.equal(getImage(t.c.db, t.userId, c2)!.roblox_status, 'failed')
  // une image en echec peut etre republiee
  const ok = fakeAssets()
  assert.equal((await publishImages(t.c.db, ok, t.userId, [c2], t.target(), 'manuel', noWait))[0].status, 'published')
})

test('publication : refus clairs (permission, format, image non triee), image identique reutilisee', async () => {
  const noScope = await setup({ scopes: [{ name: 'universe-places', operations: ['write'], userIds: [], groupIds: [], universeIds: [] }] })
  const x = await noScope.add('x.png')
  const rx = fakeAssets()
  const r0 = await publishImages(noScope.c.db, rx, noScope.userId, [x], noScope.target(), 'manuel', noWait)
  assert.match(r0[0].error!, /asset:write/)
  assert.equal(rx.uploads.length, 0)

  const t = await setup()
  const roblox = fakeAssets()
  const webp = await t.add('w.png')
  t.c.db.prepare("UPDATE library_images SET mime = 'image/webp' WHERE id = ?").run(webp)
  const pending = await t.add('p.png', { status: 'pending' })
  const r = await publishImages(t.c.db, roblox, t.userId, [webp, pending, 'f'.repeat(32)], t.target(), 'manuel', noWait)
  assert.match(r[0].error!, /n'accepte pas le format WEBP/)
  assert.match(r[1].error!, /pas encore triee/)
  assert.match(r[2].error!, /introuvable/)
  assert.equal(roblox.uploads.length, 0)

  // meme contenu : un seul envoi
  const one = await t.add('un.png', {}, PNG('same'))
  const two = await t.add('deux.png', {}, PNG('same'))
  const rr = await publishImages(t.c.db, roblox, t.userId, [one, two], t.target(), 'manuel', noWait)
  assert.deepEqual(rr.map((x) => [x.status, x.reference]), [['published', 'rbxassetid://777'], ['published', 'rbxassetid://777']])
  assert.equal(roblox.uploads.length, 1, 'meme empreinte : pas de second envoi')
})

test('cibles : projet sans compte Roblox, choix de la publication manuelle', async () => {
  const t = await setup({ group: true })
  const bare = createProject(t.c.db, t.userId, { name: 'Sans compte', groupId: null, groupName: null, githubRepo: null, robloxAccountId: null })
  assert.match((targetForProject(t.c.db, t.userId, bare.id) as { error: string }).error, /compte Roblox lie/)
  assert.match((targetForProject(t.c.db, t.userId, 9999) as { error: string }).error, /introuvable/)
  assert.deepEqual(publishTargets(t.c.db, t.userId).map((o) => o.value), [`project:${t.project.id}`, `account:${t.accountId}`])
  assert.match(publishTargets(t.c.db, t.userId)[0].label, /groupe Mon Groupe/)
})

test('routes de la page : publication manuelle, reglage, affichage', async () => {
  const t = await setup()
  const id = await t.add('epee.png')
  const roblox = fakeAssets()
  // la page utilise le client Roblox de l'application : on verifie surtout la mise en forme et les refus (sans Roblox joignable, l'envoi echoue proprement)
  const page = (await t.c.call('GET', '/library')).text
  assert.match(page, new RegExp(`action="/library/${id}/publish"`))
  assert.match(page, /Publier sur Roblox/)
  assert.match(page, /Publier automatiquement sur Roblox/)
  assert.match(page, /checked/, 'publication automatique activee par defaut')
  assert.equal(autoPublishOf(t.c.db, t.userId), true)
  assert.equal((await t.c.call('POST', '/library/settings', { csrf: t.csrf }, { accept: 'application/json' })).res.status, 303)
  assert.equal(autoPublishOf(t.c.db, t.userId), false, 'case decochee = desactive')
  assert.equal((await t.c.call('POST', '/library/settings', { csrf: t.csrf, auto_publish: '1' }, { accept: 'application/json' })).res.status, 303)
  assert.equal(autoPublishOf(t.c.db, t.userId), true)
  assert.equal((await t.c.call('POST', '/library/settings', { csrf: 'faux', auto_publish: '1' }, { accept: 'application/json' })).res.status, 403)
  assert.equal((await t.c.call('POST', `/library/${id}/publish`, { csrf: t.csrf, target: 'n-importe-quoi' }, { accept: 'application/json' })).res.status, 400)
  assert.equal((await t.c.call('POST', `/library/${id}/publish`, { csrf: 'faux', target: `account:${t.accountId}` }, { accept: 'application/json' })).res.status, 403)
  assert.ok(roblox.uploads.length === 0)
})

test('route Worker de publication : chat en cours, reglage, images generees, remplacement des references par le Worker', async () => {
  const t = await setup()
  const chat = createChat(t.c.db, t.project.id, 'Test')
  const w = createWorker(t.c.db, t.userId, 'PC', null)
  assert.ok(w.ok)
  const a = await t.add('a.png')
  const gen = await t.add('g.png')
  t.c.db.prepare("UPDATE library_images SET source = 'generated' WHERE id = ?").run(gen)
  const call = (ids: unknown, token = w.token) => t.c.app.request(`${ORIGIN}/api/worker/library-publish`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ ids }) })
  assert.equal((await call([a])).status, 403, 'aucun chat en cours')
  const job = t.c.hub.enqueue(t.userId, 'ai.chat', { chatId: chat.id }, { requires: [] })
  markJobRunning(t.c.db, job, w.id)
  assert.equal((await call([a], 'rpmw_' + 'x'.repeat(43))).status, 403)
  assert.equal((await call([])).status, 400)
  assert.equal((await call(['pas-un-id'])).status, 400)
  // sans Roblox joignable dans ce test, une image eligible echoue proprement ; on verifie surtout les cas « a confirmer »
  const r = (await (await call([gen])).json()) as { results: { id: string; status: string }[] }
  assert.deepEqual(r.results, [{ id: gen, status: 'needs-confirmation', reference: null, error: null }])
  t.c.db.prepare('INSERT INTO library_settings (user_id, auto_publish) VALUES (?, 0) ON CONFLICT(user_id) DO UPDATE SET auto_publish = 0').run(t.userId)
  const off = (await (await call([a])).json()) as { results: { status: string }[] }
  assert.equal(off.results[0].status, 'needs-confirmation', 'reglage desactive : confirmation par l utilisateur')
  const unknown = (await (await call(['e'.repeat(32)])).json()) as { results: { status: string; error: string }[] }
  assert.equal(unknown.results[0].status, 'failed')

  // projet sans compte Roblox : refus explicite
  t.c.db.prepare('UPDATE projects SET roblox_account_id = NULL WHERE id = ?').run(t.project.id)
  const res = await call([a])
  assert.equal(res.status, 409)
  assert.match(((await res.json()) as { error: string }).error, /compte Roblox/)
})

// --- recherche par description (library.find) ---------------------------------------------------------------------------------------------------

import { findResult, startFind } from '../src/library.ts'
import { finishJob as finishJobFind, getJob as getJobFind } from '../src/workers.ts'

test('recherche par description : validation, une seule a la fois, uniquement des images triees', async () => {
  const t = await setup()
  const post = (query: string, csrf = t.csrf) => t.c.call('POST', '/library/find', { csrf, query }, { accept: 'application/json' })
  assert.equal((await post('epee rouge')).res.status, 409, 'aucune image triee')
  const a = await t.add('a.png')
  await t.add('p.png', { status: 'pending' })
  assert.equal((await post('')).res.status, 400)
  assert.equal((await post('ab')).res.status, 400)
  assert.equal((await post('epee', 'faux')).res.status, 403)
  const ok = await post('Une epee rouge, style cartoon')
  assert.equal(ok.res.status, 200)
  const { jobId } = JSON.parse(ok.text) as { jobId: number }
  const job = getJobFind(t.c.db, t.userId, jobId)!
  assert.equal(job.kind, 'library.find')
  assert.deepEqual(job.requires, ['claude'])
  assert.deepEqual(job.payload, { query: 'Une epee rouge, style cartoon', limit: 12 })
  assert.equal((await post('autre chose')).res.status, 409, 'une recherche est deja en cours')
  assert.ok(a)
  // le Worker : recherche autorisee pendant une recherche, jamais les images en attente
  const w = createWorker(t.c.db, t.userId, 'PC', null)
  assert.ok(w.ok)
  markJobRunning(t.c.db, jobId, w.id)
  const call = (path: string) => t.c.app.request(`${ORIGIN}${path}`, { headers: { authorization: `Bearer ${w.token}` } })
  assert.equal((await call('/api/worker/library-search')).status, 200)
  assert.equal((await call(`/api/worker/library/${a}`)).status, 200)
  const pending = (t.c.db.prepare("SELECT id FROM library_images WHERE status = 'pending'").get() as { id: string }).id
  assert.equal((await call(`/api/worker/library/${pending}`)).status, 404)
})

test('recherche par description : resultats revalides (images triees de l utilisateur, sans doublon, 12 au plus), etats et page', async () => {
  const t = await setup()
  const ids: string[] = []
  for (let i = 0; i < 15; i++) ids.push(await t.add(`i${i}.png`))
  const pending = await t.add('wait.png', { status: 'pending' })
  const start = () => {
    const post = startFind(t.c.db, t.c.hub, t.userId, 'description')
    return post
  }
  const j = start()
  assert.deepEqual(findResult(t.c.db, t.userId, j), { state: 'running' })
  finishJobFind(t.c.db, j, 'succeeded', { matches: [
    { id: ids[3], why: '<b>proche</b>' }, { id: ids[3], why: 'doublon' }, { id: 'f'.repeat(32), why: 'inconnue' }, { id: pending, why: 'en attente : refusee' },
    '../../x', null, { id: 5 }, ...ids.map((id) => ({ id, why: 'ok' })),
  ] })
  const r = findResult(t.c.db, t.userId, j)
  assert.equal(r!.state, 'done')
  const matches = (r as { matches: { image: { id: string }; why: string }[] }).matches
  assert.equal(matches.length, 12, '12 au plus')
  assert.equal(matches[0].image.id, ids[3], 'ordre de l agent conserve')
  assert.ok(!matches.some((m) => m.image.id === pending), 'jamais une image en attente')
  assert.equal(new Set(matches.map((m) => m.image.id)).size, 12)
  // la route renvoie un fragment HTML echappe
  const res = JSON.parse((await t.c.call('GET', `/library/find/${j}`, undefined, { accept: 'application/json' })).text) as { state: string; html: string }
  assert.equal(res.state, 'done')
  assert.equal((res.html.match(/lib-card find/g) ?? []).length, 12)
  assert.doesNotMatch(res.html, /<b>proche<\/b>/)
  assert.match(res.html, /&lt;b&gt;proche&lt;\/b&gt;/)
  assert.match(res.html, /1\. i3/)
  // echec, annulation, tache d'un autre type ou inconnue
  const j2 = start()
  finishJobFind(t.c.db, j2, 'failed', undefined, 'Claude indisponible')
  assert.deepEqual(findResult(t.c.db, t.userId, j2), { state: 'failed', error: 'La recherche a echoue : Claude indisponible' })
  assert.equal(findResult(t.c.db, t.userId, 99999), null)
  const other = t.c.hub.enqueue(t.userId, 'ai.chat', {}, { requires: [] })
  assert.equal(findResult(t.c.db, t.userId, other), null, 'seulement les taches library.find')
  assert.equal((await t.c.call('GET', `/library/find/${other}`, undefined, { accept: 'application/json' })).res.status, 404)
  const empty = start()
  finishJobFind(t.c.db, empty, 'succeeded', { matches: [] })
  const none = JSON.parse((await t.c.call('GET', `/library/find/${empty}`, undefined, { accept: 'application/json' })).text) as { html: string }
  assert.match(none.html, /Aucune image triee ne correspond/)
  assert.equal((await t.c.app.request(`${ORIGIN}/library/find/${j}`)).status, 302, 'sans session')
  // la page propose la recherche dans la vue des images triees seulement
  assert.match((await t.c.call('GET', '/library')).text, /Retrouver une image par description/)
  assert.doesNotMatch((await t.c.call('GET', '/library?view=pending')).text, /Retrouver une image par description/)
})

test('vues de la page : triees / en attente, formulaires qui reviennent a la bonne vue', async () => {
  const t = await setup()
  const sorted = await t.add('s.png')
  const wait = await t.add('w.png', { status: 'pending' })
  const s = (await t.c.call('GET', '/library?view=sorted')).text
  const p = (await t.c.call('GET', '/library?view=pending')).text
  assert.match(s, new RegExp(`id="i${sorted}"`))
  assert.doesNotMatch(s, new RegExp(`id="i${wait}"`))
  assert.match(p, new RegExp(`id="i${wait}"`))
  assert.doesNotMatch(p, new RegExp(`id="i${sorted}"`))
  assert.match(p, /name="view" value="pending"/)
  assert.match(s, /name="view" value="sorted"/)
  const edit = await t.c.call('POST', `/library/${wait}/edit`, { csrf: t.csrf, view: 'pending', description: 'x' })
  assert.equal(edit.res.headers.get('location'), '/library?view=pending')
  const bad = await t.c.call('POST', `/library/${sorted}/edit`, { csrf: t.csrf, view: 'https://evil.example', description: 'x' })
  assert.equal(bad.res.headers.get('location'), '/library?view=sorted', 'jamais une adresse libre')
  assert.equal((await t.c.call('POST', '/library/sort', { csrf: t.csrf, count: '1' })).res.headers.get('location'), '/library?view=pending')
  // par defaut : « En attente » s'il n'y a encore rien de trie
  const empty = await setup()
  await empty.add('w.png', { status: 'pending' })
  assert.match((await empty.c.call('GET', '/library')).text, /data-view="pending"/)
})
