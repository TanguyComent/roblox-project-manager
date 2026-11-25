import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createSession, createUser } from '../src/auth.ts'
import { checkGroupAccess, getAccount, listAuthorizedGroups, scopeLabels } from '../src/roblox-accounts.ts'
import { KEYS, fakeRoblox } from './fake-roblox.ts'
import { client, csrfOf, registerAndEnable } from './helpers.ts'
import { connectRoblox } from './roblox-helpers.ts'

async function setup() {
  const rb = fakeRoblox()
  const c = client({ roblox: rb.client })
  await registerAndEnable(c)
  const csrf = csrfOf((await c.call('GET', '/account')).text)
  return { c, csrf, rb }
}
const accounts = (c: ReturnType<typeof client>) => c.db.prepare('SELECT * FROM roblox_accounts ORDER BY id').all() as Record<string, unknown>[]

test('la page Compte propose de connecter une cle d\'API, avec le mode d\'emploi', async () => {
  const { c } = await setup()
  const page = (await c.call('GET', '/account')).text
  assert.match(page, /Aucun compte Roblox connecte/)
  assert.match(page, /type="password" name="apiKey"/)
  assert.match(page, /Comment creer une cle/)
  assert.match(page, /Restrict by Experience/)
  assert.doesNotMatch(page, /OAuth/i)
})

test('connexion : la cle est verifiee, chiffree en base et jamais reaffichee', async () => {
  const { c, rb } = await setup()
  const r = await connectRoblox(c, KEYS.tanguy)
  assert.equal(r.res.status, 303)
  assert.equal(r.res.headers.get('location'), '/account?r=connected')
  assert.ok(rb.calls.some((x) => x.path === '/api-keys/v1/introspect'))

  const [row] = accounts(c)
  assert.equal(row.label, 'steal-treasure key') // nom de la cle par defaut
  assert.equal(row.roblox_user_id, '1001')
  assert.equal(row.username, 'tanguy_dev')
  assert.equal(row.status, 'ok')
  assert.doesNotMatch(String(row.api_key_enc), /rbx-key/)
  assert.doesNotMatch(String(row.key_hash), /rbx-key/)

  for (const path of ['/account', '/account?r=connected', '/projects/new', '/projects']) {
    assert.doesNotMatch((await c.call('GET', path)).text, /rbx-key-tanguy/, path)
  }
  const page = (await c.call('GET', '/account?r=connected')).text
  assert.match(page, /Compte Roblox connecte/)
  assert.match(page, /@tanguy_dev/)
  assert.match(page, /Cle valide/)
  assert.match(page, /<code>universe-places:write<\/code>/)
  // groupes : seuls ceux ou le role permet de gerer des experiences sont mis en avant, les autres sont repliés
  assert.match(page, /Groupes ou gerer des experiences : Boilr \(Owner\) <code>123456<\/code><\/span>/)
  assert.match(page, /2 autres groupes \(role sans permission de gestion\)/)
  assert.match(page, /<details class="others">.*Studio <code>777<\/code>/s)
  assert.doesNotMatch(page, /legacy-group:manage<\/code> \(liste des groupes/) // la liste « peut gerer » est disponible : pas de conseil
})

test('connexion : nom personnalise, plusieurs comptes, meme cle refusee deux fois', async () => {
  const { c } = await setup()
  const a = await connectRoblox(c, KEYS.tanguy, 'Compte principal')
  const b = await connectRoblox(c, KEYS.alt)
  assert.notEqual(a.accountId, b.accountId)
  assert.deepEqual(accounts(c).map((x) => x.label), ['Compte principal', 'alt key'])
  const page = (await c.call('GET', '/account')).text
  assert.match(page, /Compte principal/)
  assert.match(page, /alt_account/)
  assert.match(page, /Autre groupe \(Dev\) <code>888<\/code>/)
  const dup = await connectRoblox(c, KEYS.tanguy)
  assert.equal(dup.res.status, 400)
  assert.match(dup.text, /deja connectee/)
  assert.equal(accounts(c).length, 2)
})

test('connexion : cles refusees (inconnue, expiree, desactivee, mal collee), rien n\'est enregistre', async () => {
  const { c } = await setup()
  const unknown = await connectRoblox(c, KEYS.unknown)
  assert.equal(unknown.res.status, 400)
  assert.match(unknown.text, /Roblox ne reconnait pas cette cle/)
  const expired = await connectRoblox(c, KEYS.expired)
  assert.equal(expired.res.status, 400)
  assert.match(expired.text, /expiree/)
  const disabled = await connectRoblox(c, KEYS.disabled)
  assert.equal(disabled.res.status, 400)
  assert.match(disabled.text, /desactivee/)
  assert.equal((await connectRoblox(c, 'trop court')).res.status, 400)
  assert.equal((await connectRoblox(c, `${KEYS.tanguy} avec espace`)).res.status, 400)
  assert.equal((await connectRoblox(c, KEYS.tanguy, 'x'.repeat(61))).res.status, 400)
  assert.equal(accounts(c).length, 0)
})

test('connexion : panne de Roblox -> 502, CSRF exige', async () => {
  const { c, rb } = await setup()
  rb.state.introspectStatus = 500
  const r = await connectRoblox(c, KEYS.tanguy)
  assert.equal(r.res.status, 502)
  assert.match(r.text, /Impossible de verifier la cle/)
  assert.equal(accounts(c).length, 0)
  assert.equal((await c.call('POST', '/account/roblox', { csrf: 'faux', apiKey: KEYS.tanguy })).res.status, 403)
})

test('connexion : une cle qui expire bientot est signalee', async () => {
  const { c, rb } = await setup()
  rb.setKey(KEYS.tanguy, { expirationTimeUtc: new Date(Date.now() + 3 * 24 * 3600_000).toISOString() })
  await connectRoblox(c, KEYS.tanguy)
  assert.match((await c.call('GET', '/account')).text, /Expire le/)
  const far = fakeRoblox()
  far.setKey(KEYS.tanguy, { expirationTimeUtc: new Date(Date.now() + 90 * 24 * 3600_000).toISOString() })
  const c2 = client({ roblox: far.client })
  await registerAndEnable(c2)
  await connectRoblox(c2, KEYS.tanguy)
  assert.doesNotMatch((await c2.call('GET', '/account')).text, /Expire le/)
})

test('les pages Roblox exigent une session complete', async () => {
  const c = client({ roblox: fakeRoblox().client })
  for (const path of ['/account/roblox', '/account/roblox/1/key', '/account/roblox/1/verify', '/account/roblox/1/disconnect']) {
    const r = await c.call('POST', path, { csrf: 'x', apiKey: 'x' })
    assert.equal(r.res.status, 302, path)
    assert.equal(r.res.headers.get('location'), '/login', path)
  }
})

// --- changer la cle -------------------------------------------------------------------------------------------------------------------
test('changer la cle : meme compte Roblox accepte, autre compte refuse', async () => {
  const { c, csrf } = await setup()
  const { accountId } = await connectRoblox(c, KEYS.tanguy)
  const before = (accounts(c)[0] as { key_hash: string }).key_hash

  const other = await c.call('POST', `/account/roblox/${accountId}/key`, { csrf, apiKey: KEYS.alt })
  assert.equal(other.res.status, 400)
  assert.match(other.text, /autre compte Roblox/)
  assert.equal((accounts(c)[0] as { key_hash: string }).key_hash, before)

  const same = await c.call('POST', `/account/roblox/${accountId}/key`, { csrf, apiKey: KEYS.tanguy2 })
  assert.equal(same.res.status, 303)
  assert.equal(same.res.headers.get('location'), '/account?r=updated')
  assert.notEqual((accounts(c)[0] as { key_hash: string }).key_hash, before)
  assert.equal(accounts(c).length, 1)
  assert.equal((await c.call('POST', `/account/roblox/${accountId}/key`, { csrf, apiKey: KEYS.unknown })).res.status, 400)
  assert.equal((await c.call('POST', `/account/roblox/${accountId}/key`, { csrf: 'faux', apiKey: KEYS.tanguy })).res.status, 403)
})

test('une cle invalide peut etre remplacee, et le compte redevient valide', async () => {
  const { c, csrf, rb } = await setup()
  const { accountId } = await connectRoblox(c, KEYS.tanguy)
  rb.setKey(KEYS.tanguy, null) // la cle est supprimee chez Roblox
  const verify = await c.call('POST', `/account/roblox/${accountId}/verify`, { csrf })
  assert.equal(verify.res.headers.get('location'), '/account?r=invalid')
  assert.equal(accounts(c)[0].status, 'invalid')
  assert.match((await c.call('GET', '/account')).text, /Cle invalide/)
  await c.call('POST', `/account/roblox/${accountId}/key`, { csrf, apiKey: KEYS.tanguy2 })
  assert.equal(accounts(c)[0].status, 'ok')
  assert.match((await c.call('GET', '/account')).text, /Cle valide/)
})

// --- verifier ---------------------------------------------------------------------------------------------------------------------
test('verifier : relit les permissions ; cle desactivee -> invalide ; panne -> rien ne change', async () => {
  const { c, csrf, rb } = await setup()
  const { accountId } = await connectRoblox(c, KEYS.tanguy)
  const ok = await c.call('POST', `/account/roblox/${accountId}/verify`, { csrf })
  assert.equal(ok.res.headers.get('location'), '/account?r=verified')
  assert.match((await c.call('GET', '/account?r=verified')).text, /Cle verifiee/)

  rb.setKey(KEYS.tanguy, { scopes: [{ name: 'game-pass', operations: ['write'] }] })
  await c.call('POST', `/account/roblox/${accountId}/verify`, { csrf })
  const userId = (c.db.prepare('SELECT user_id FROM roblox_accounts').get() as { user_id: number }).user_id
  assert.deepEqual(scopeLabels(getAccount(c.db, userId, accountId!)!.scopes), ['game-pass:write'])
  assert.match((await c.call('GET', '/account')).text, /pas la permission de publier/)

  rb.state.introspectStatus = 500
  const down = await c.call('POST', `/account/roblox/${accountId}/verify`, { csrf })
  assert.equal(down.res.status, 502)
  assert.equal(accounts(c)[0].status, 'ok')
  rb.state.introspectStatus = 200

  rb.setKey(KEYS.tanguy, { enabled: false })
  await c.call('POST', `/account/roblox/${accountId}/verify`, { csrf })
  assert.equal(accounts(c)[0].status, 'invalid')
  assert.match(String(accounts(c)[0].status_detail), /desactivee/)
})

// --- deconnexion ------------------------------------------------------------------------------------------------------------------
test('deconnexion : la cle est supprimee de la base ; CSRF exige', async () => {
  const { c, csrf } = await setup()
  const { accountId } = await connectRoblox(c)
  assert.equal((await c.call('POST', `/account/roblox/${accountId}/disconnect`, { csrf: 'faux' })).res.status, 403)
  assert.equal(accounts(c).length, 1)
  const r = await c.call('POST', `/account/roblox/${accountId}/disconnect`, { csrf })
  assert.equal(r.res.status, 303)
  assert.equal(accounts(c).length, 0)
})

test('deconnexion refusee tant qu\'un projet utilise le compte', async () => {
  const { c, csrf } = await setup()
  const { accountId } = await connectRoblox(c)
  await c.call('POST', '/projects', { csrf, name: 'Steal Treasure', robloxAccountId: String(accountId), repoMode: 'none' })
  const r = await c.call('POST', `/account/roblox/${accountId}/disconnect`, { csrf })
  assert.equal(r.res.status, 400)
  assert.match(r.text, /utilise par le projet : Steal Treasure/)
  assert.equal(accounts(c).length, 1)
})

test('un utilisateur ne voit ni ne modifie les comptes Roblox d\'un autre', async () => {
  const { c } = await setup()
  const { accountId } = await connectRoblox(c)
  const other = await createUser(c.db, 'benoit@example.com', 'another long password')
  const { token, session } = createSession(c.db, other.id, 'full')
  c.setCookie(`sid=${token}`)
  assert.doesNotMatch((await c.call('GET', '/account')).text, /tanguy_dev/)
  for (const action of ['disconnect', 'verify']) await c.call('POST', `/account/roblox/${accountId}/${action}`, { csrf: session.csrf })
  await c.call('POST', `/account/roblox/${accountId}/key`, { csrf: session.csrf, apiKey: KEYS.tanguy2 })
  assert.equal(accounts(c).length, 1)
  assert.equal((accounts(c)[0] as { status: string }).status, 'ok')
})

// --- groupes ------------------------------------------------------------------------------------------------------------------------
test('groupes du compte : membres uniquement, avec leur role et leur droit de gerer les experiences, mis en cache', async () => {
  const { c, rb } = await setup()
  const { accountId } = await connectRoblox(c)
  const userId = (c.db.prepare('SELECT user_id FROM roblox_accounts').get() as { user_id: number }).user_id
  const account = getAccount(c.db, userId, accountId!)!
  const groups = await listAuthorizedGroups(c.db, rb.client, account)
  assert.deepEqual(groups.map((g) => `${g.id}:${g.name}:${g.role}:${g.canManage}`), ['123456:Boilr:Owner:true', '999:Fan club:null:false', '777:Studio:null:false'])
  const n = rb.calls.length
  await listAuthorizedGroups(c.db, rb.client, account)
  assert.equal(rb.calls.length, n)
})

test('acces a un groupe : membre -> ok (nom rempli) ; non membre ou inexistant -> refuse ; lecture interdite -> non verifie', async () => {
  const { c, rb } = await setup()
  const { accountId } = await connectRoblox(c)
  const userId = (c.db.prepare('SELECT user_id FROM roblox_accounts').get() as { user_id: number }).user_id
  const account = getAccount(c.db, userId, accountId!)!
  assert.deepEqual(await checkGroupAccess(c.db, rb.client, account, 123456), { ok: true, name: 'Boilr', verified: true })

  const notMember = await checkGroupAccess(c.db, rb.client, account, 888)
  assert.equal(notMember.ok, false)
  assert.match((notMember as { error: string }).error, /n'est pas membre du groupe 888/)
  const missing = await checkGroupAccess(c.db, rb.client, account, 424242)
  assert.equal(missing.ok, false)
  assert.match((missing as { error: string }).error, /n'existe pas/)

  // membre, mais son role ne permet pas de gerer les experiences du groupe
  for (const id of [777, 999]) {
    const r = await checkGroupAccess(c.db, rb.client, account, id)
    assert.equal(r.ok, false, `groupe ${id}`)
    assert.match((r as { error: string }).error, /ne lui permet pas de gerer les experiences du groupe/)
  }

  rb.state.membershipsForbidden = true // la cle n'a pas le droit de lire les appartenances : on ne peut pas trancher
  assert.deepEqual(await checkGroupAccess(c.db, rb.client, account, 123456), { ok: true, name: 'Boilr', verified: false })
})

test('cle sans legacy-group:manage ni group:read : permissions des roles masquees -> groupes montres (benefice du doute) avec un conseil, acces « non verifie »', async () => {
  const { c, rb } = await setup()
  rb.state.hideRolePermissions = true
  rb.state.canManageStatus = 403
  const { accountId } = await connectRoblox(c)
  const userId = (c.db.prepare('SELECT user_id FROM roblox_accounts').get() as { user_id: number }).user_id
  const account = getAccount(c.db, userId, accountId!)!
  assert.deepEqual((await listAuthorizedGroups(c.db, rb.client, account)).map((g) => g.canManage), [null, null, null])
  const page = (await c.call('GET', '/account')).text
  assert.match(page, /Studio \(Membre\) <code>777<\/code>/)
  assert.match(page, /ajoute-lui la permission <code>legacy-group:manage<\/code>/)
  assert.deepEqual(await checkGroupAccess(c.db, rb.client, account, 777), { ok: true, name: 'Studio', verified: false })
})

// --- projets : compte Roblox obligatoire, groupe verifie via la cle ---------------------------------------------------------------------
const post = (c: ReturnType<typeof client>, csrf: string, fields: Record<string, string>) =>
  c.call('POST', '/projects', { csrf, name: 'Steal Treasure', repoMode: 'none', ...fields })
const projectCount = (c: ReturnType<typeof client>) => (c.db.prepare('SELECT COUNT(*) AS n FROM projects').get() as { n: number }).n

test('projet : sans compte Roblox connecte, la creation est refusee', async () => {
  const { c, csrf } = await setup()
  assert.match((await c.call('GET', '/projects/new')).text, /Aucun compte Roblox connecte/)
  const r = await post(c, csrf, {})
  assert.equal(r.res.status, 400)
  assert.match(r.text, /Connecte d(?:'|&#39;)abord un compte Roblox/)
  assert.equal(projectCount(c), 0)
})

test('projet : le compte se choisit dans la liste, les comptes a cle invalide sont desactives', async () => {
  const { c, csrf, rb } = await setup()
  const a = await connectRoblox(c, KEYS.tanguy, 'Principal')
  const b = await connectRoblox(c, KEYS.alt, 'Secondaire')
  let page = (await c.call('GET', '/projects/new')).text
  assert.match(page, /<select name="robloxAccountId" required>/)
  assert.match(page, />Principal</)
  assert.match(page, />Secondaire</)
  // menu des groupes : ceux de chaque compte ou l'on peut gerer des experiences (le script masque ceux des autres comptes)
  assert.match(page, /<select name="groupId">/)
  assert.match(page, new RegExp(`<option value="123456" data-account="${a.accountId}">Boilr \\(Owner\\) · 123456</option>`))
  assert.match(page, new RegExp(`<option value="888" data-account="${b.accountId}">Autre groupe \\(Dev\\) · 888</option>`))
  assert.doesNotMatch(page, /value="777"/) // role sans droit de gestion : non propose
  assert.doesNotMatch(page, /Fan club/)
  assert.doesNotMatch(page, /name="groupName"/) // le nom du groupe est rempli automatiquement

  assert.equal((await post(c, csrf, {})).res.status, 400) // pas de compte choisi
  const ok = await post(c, csrf, { robloxAccountId: String(b.accountId) })
  assert.equal(ok.res.status, 303)
  assert.equal((c.db.prepare('SELECT roblox_account_id AS a FROM projects').get() as { a: number }).a, b.accountId)
  assert.match((await c.call('GET', '/projects')).text, /Secondaire/)

  rb.setKey(KEYS.tanguy, null)
  await c.call('POST', `/account/roblox/${a.accountId}/verify`, { csrf })
  page = (await c.call('GET', '/projects/new')).text
  assert.match(page, /<option value="\d+" disabled>Principal \(cle invalide\)<\/option>/)
  const bad = await post(c, csrf, { robloxAccountId: String(a.accountId) })
  assert.equal(bad.res.status, 400)
  assert.match(bad.text, /n(?:'|&#39;)est plus valide/)
})

test('projet : un compte Roblox d\'un autre utilisateur est refuse', async () => {
  const { c } = await setup()
  const { accountId } = await connectRoblox(c)
  const other = await createUser(c.db, 'benoit@example.com', 'another long password')
  const { token, session } = createSession(c.db, other.id, 'full')
  c.setCookie(`sid=${token}`)
  assert.equal((await post(c, session.csrf, { robloxAccountId: String(accountId) })).res.status, 400)
  assert.equal(projectCount(c), 0)
})

test('projet : le groupe doit etre un groupe dont le compte est membre', async () => {
  const { c, csrf } = await setup()
  const a = await connectRoblox(c, KEYS.tanguy)
  const b = await connectRoblox(c, KEYS.alt)

  const ok = await post(c, csrf, { robloxAccountId: String(a.accountId), groupId: '123456' })
  assert.equal(ok.res.status, 303)
  const row = c.db.prepare('SELECT roblox_group_id, roblox_group_name FROM projects').get() as Record<string, unknown>
  assert.deepEqual({ ...row }, { roblox_group_id: 123456, roblox_group_name: 'Boilr' }) // nom rempli automatiquement

  const no = await post(c, csrf, { robloxAccountId: String(a.accountId), groupId: '888' })
  assert.equal(no.res.status, 400)
  assert.match(no.text, /n(?:'|&#39;)est pas membre du groupe 888/)
  assert.equal((await post(c, csrf, { robloxAccountId: String(b.accountId), groupId: '888' })).res.status, 303) // le bon compte
  assert.equal((await post(c, csrf, { robloxAccountId: String(a.accountId), groupId: '999999' })).res.status, 400)
  const noRight = await post(c, csrf, { robloxAccountId: String(a.accountId), groupId: '777' }) // membre, mais role sans droit de gestion
  assert.equal(noRight.res.status, 400)
  assert.match(noRight.text, /ne lui permet pas de gerer les experiences du groupe/)
  assert.equal(projectCount(c), 2)
})

test('projet : groupe non verifiable -> projet cree avec un avertissement', async () => {
  const { c, csrf, rb } = await setup()
  const { accountId } = await connectRoblox(c)
  rb.state.membershipsForbidden = true
  const r = await post(c, csrf, { robloxAccountId: String(accountId), groupId: '123456' })
  assert.equal(r.res.status, 303)
  const id = Number(/\/projects\/(\d+)/.exec(r.res.headers.get('location')!)![1])
  const first = (await c.call('GET', `/projects/${id}?n=created`)).text
  assert.match(first, /n(?:'|&#39;)a pas pu etre verifie/)
  assert.doesNotMatch((await c.call('GET', `/projects/${id}`)).text, /n(?:'|&#39;)a pas pu etre verifie/) // une seule fois
})

test('projet : le groupe est verifie AVANT de creer le depot GitHub', async () => {
  const { fakeGithub } = await import('./fake-github.ts')
  const rb = fakeRoblox()
  const gh = fakeGithub()
  const c = client({ roblox: rb.client, githubFor: gh.githubFor })
  await registerAndEnable(c)
  const csrf = csrfOf((await c.call('GET', '/account')).text)
  const { accountId } = await connectRoblox(c)
  await c.call('POST', '/account/github', { csrf, token: 'tok' })
  gh.calls.length = 0
  const r = await post(c, csrf, { robloxAccountId: String(accountId), groupId: '888', repoMode: 'template', template: 'acme/roblox-template' })
  assert.equal(r.res.status, 400)
  assert.ok(!gh.calls.some((x) => x.url.endsWith('/generate')))
  assert.equal(projectCount(c), 0)
})

test('projet : modifier le compte ou le groupe revalide l\'acces', async () => {
  const { c, csrf } = await setup()
  const a = await connectRoblox(c, KEYS.tanguy)
  const b = await connectRoblox(c, KEYS.alt)
  const id = Number(/\/projects\/(\d+)/.exec((await post(c, csrf, { robloxAccountId: String(a.accountId), groupId: '123456' })).res.headers.get('location')!)![1])

  const bad = await c.call('POST', `/projects/${id}`, { csrf, name: 'Steal Treasure', robloxAccountId: String(b.accountId), groupId: '123456' })
  assert.equal(bad.res.status, 400)
  assert.match(bad.text, /alt key/)
  assert.equal((c.db.prepare('SELECT roblox_account_id AS a FROM projects WHERE id = ?').get(id) as { a: number }).a, a.accountId)

  const ok = await c.call('POST', `/projects/${id}`, { csrf, name: 'Steal Treasure', robloxAccountId: String(b.accountId), groupId: '888' })
  assert.equal(ok.res.status, 303)
  const row = c.db.prepare('SELECT roblox_account_id AS a, roblox_group_id AS g, roblox_group_name AS n FROM projects WHERE id = ?').get(id) as Record<string, unknown>
  assert.deepEqual({ ...row }, { a: b.accountId, g: 888, n: 'Autre groupe' })
  assert.equal((await c.call('POST', `/projects/${id}`, { csrf, name: 'Steal Treasure', robloxAccountId: String(a.accountId) })).res.status, 303)
  assert.match((await c.call('GET', `/projects/${id}`)).text, /steal-treasure key/)
})

test('diagnostic des groupes : montre ce que Roblox repond pour chaque role', async () => {
  const { c, rb } = await setup()
  await connectRoblox(c)
  let page = (await c.call('GET', '/account')).text
  assert.match(page, /Diagnostic des groupes/)
  assert.match(page, /role 12345600 « Owner » : \d+ permissions lues, manageGroupUniverses = true/)
  assert.match(page, /liste « groupes que tu peux gerer » de Roblox : present/)
  assert.match(page, /liste « groupes que tu peux gerer » de Roblox : absent/) // Studio, Fan club
  assert.match(page, /gestion des experiences : oui/)

  const hidden = fakeRoblox()
  hidden.state.hideRolePermissions = true
  hidden.state.canManageStatus = 403
  const c2 = client({ roblox: hidden.client })
  await registerAndEnable(c2)
  await connectRoblox(c2)
  page = (await c2.call('GET', '/account')).text
  assert.match(page, /permissions absentes de la reponse \(champs recus : path, id, displayName, rank\)/)
  assert.match(page, /indisponible \(HTTP 403\) : ajoute la permission legacy-group:manage/)
  assert.match(page, /gestion des experiences : inconnue/)

  const forbidden = fakeRoblox()
  forbidden.state.membershipsForbidden = true
  const c3 = client({ roblox: forbidden.client })
  await registerAndEnable(c3)
  await connectRoblox(c3)
  page = (await c3.call('GET', '/account')).text
  assert.match(page, /Liste des groupes illisible/)
  assert.match(page, /HTTP 403/)
  void rb
})
