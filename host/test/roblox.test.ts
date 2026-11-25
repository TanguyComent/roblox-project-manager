import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createSession, createUser } from '../src/auth.ts'
import { getAccessToken, listAuthorizedGroups } from '../src/roblox-accounts.ts'
import { newPkce } from '../src/roblox.ts'
import { createHash } from 'node:crypto'
import { fakeGithub } from './fake-github.ts'
import { fakeRoblox } from './fake-roblox.ts'
import { client, csrfOf, registerAndEnable } from './helpers.ts'
import { connectRoblox } from './roblox-helpers.ts'

async function setup(o: Parameters<typeof fakeRoblox>[0] = {}) {
  const rb = fakeRoblox(o)
  const gh = fakeGithub()
  const c = client({ roblox: rb.client, githubFor: gh.githubFor })
  await registerAndEnable(c)
  const csrf = csrfOf((await c.call('GET', '/account')).text)
  return { c, csrf, rb, gh }
}
const accounts = (c: ReturnType<typeof client>) => c.db.prepare('SELECT * FROM roblox_accounts ORDER BY id').all() as Record<string, unknown>[]

test('PKCE : le defi est le SHA-256 base64url du verificateur', () => {
  const { verifier, challenge } = newPkce()
  assert.match(verifier, /^[A-Za-z0-9_-]{43,128}$/)
  assert.equal(challenge, createHash('sha256').update(verifier).digest('base64url'))
})

test('application OAuth non configuree : renvoie l\'admin vers les Reglages, connexion refusee', async () => {
  const { c } = await setup({ enabled: false })
  const page = (await c.call('GET', '/account')).text
  assert.match(page, /pas encore configuree/)
  assert.match(page, /href="\/settings"/)
  assert.doesNotMatch(page, /Connecter un compte Roblox/)
  assert.equal((await c.call('GET', '/account/roblox/connect')).res.status, 400)
})

test('connexion : redirection OAuth (PKCE), compte enregistre, jetons chiffres', async () => {
  const { c, rb } = await setup()
  const flow = await connectRoblox(c)
  const q = flow.authorize.searchParams
  assert.equal(q.get('client_id'), 'cid')
  assert.equal(q.get('redirect_uri'), 'http://localhost:3000/account/roblox/callback')
  assert.equal(q.get('response_type'), 'code')
  assert.equal(q.get('code_challenge_method'), 'S256')
  assert.ok(q.get('code_challenge'))
  assert.equal(q.get('scope'), 'openid profile group:read')
  assert.equal(q.get('prompt'), 'select_account')

  assert.equal(flow.back.res.status, 303)
  assert.equal(flow.back.res.headers.get('location'), '/account?r=connected')
  // le verificateur PKCE envoye a Roblox correspond bien au defi de l'URL d'autorisation
  const exchange = rb.calls.find((x) => x.body?.get('grant_type') === 'authorization_code')!
  assert.equal(createHash('sha256').update(exchange.body!.get('code_verifier')!).digest('base64url'), q.get('code_challenge'))

  const [row] = accounts(c)
  assert.equal(row.username, 'tanguy_dev')
  assert.equal(row.roblox_user_id, '1001')
  assert.equal(row.status, 'ok')
  assert.doesNotMatch(String(row.refresh_token_enc), /rt-1001/)
  assert.doesNotMatch(String(row.access_token_enc), /at-1001/)

  const page = (await c.call('GET', '/account?r=connected')).text
  assert.match(page, /Compte Roblox connecte/)
  assert.match(page, /Tanguy \(@tanguy_dev\)/)
  assert.match(page, /Boilr <code>123456<\/code>/) // groupes autorises
  assert.doesNotMatch(page, /rt-1001|at-1001/)
})

test('plusieurs comptes Roblox : listes, et se reconnecter ne cree pas de doublon', async () => {
  const { c } = await setup()
  const a = await connectRoblox(c, '1001')
  const b = await connectRoblox(c, '1002')
  assert.notEqual(a.accountId, b.accountId)
  assert.equal(accounts(c).length, 2)
  const page = (await c.call('GET', '/account')).text
  assert.match(page, /@tanguy_dev/)
  assert.match(page, /@alt_account/)
  assert.match(page, /Autre groupe <code>888<\/code>/)
  const again = await connectRoblox(c, '1001')
  assert.equal(again.accountId, a.accountId) // meme identifiant interne : les projets restent lies
  assert.equal(accounts(c).length, 2)
})

test('retour OAuth : etat inconnu, rejoue, expire, code absent, refus', async () => {
  const { c } = await setup()
  const start = await c.call('GET', '/account/roblox/connect')
  const state = new URL(start.res.headers.get('location')!).searchParams.get('state')!

  assert.equal((await c.call('GET', '/account/roblox/callback?code=code-1001&state=inconnu')).res.status, 400)
  assert.equal(accounts(c).length, 0)
  assert.equal((await c.call('GET', `/account/roblox/callback?code=&state=${state}`)).res.status, 400) // etat consomme meme sans code
  assert.equal((await c.call('GET', `/account/roblox/callback?code=code-1001&state=${state}`)).res.status, 400) // deja consomme
  assert.equal(accounts(c).length, 0)

  const s2 = new URL((await c.call('GET', '/account/roblox/connect')).res.headers.get('location')!).searchParams.get('state')!
  const denied = await c.call('GET', `/account/roblox/callback?error=access_denied&state=${s2}`)
  assert.equal(denied.res.status, 400)
  assert.match(denied.text, /Autorisation refusee/)

  const s3 = new URL((await c.call('GET', '/account/roblox/connect')).res.headers.get('location')!).searchParams.get('state')!
  c.db.prepare('UPDATE oauth_states SET expires_at = 1').run()
  assert.equal((await c.call('GET', `/account/roblox/callback?code=code-1001&state=${s3}`)).res.status, 400)
  assert.equal(accounts(c).length, 0)
})

test('retour OAuth : l\'etat ne vaut que pour la session et l\'utilisateur qui l\'ont demande', async () => {
  const { c } = await setup()
  const state = new URL((await c.call('GET', '/account/roblox/connect')).res.headers.get('location')!).searchParams.get('state')!
  // un autre utilisateur (autre session) tente d'utiliser l'etat
  const other = await createUser(c.db, 'benoit@example.com', 'another long password')
  const { token } = createSession(c.db, other.id, 'full')
  const mine = c.getCookie()
  c.setCookie(`sid=${token}`)
  assert.equal((await c.call('GET', `/account/roblox/callback?code=code-1001&state=${state}`)).res.status, 400)
  assert.equal(accounts(c).length, 0)
  c.setCookie(mine)
  // l'etat a ete consomme par la tentative : il faut recommencer
  assert.equal((await c.call('GET', `/account/roblox/callback?code=code-1001&state=${state}`)).res.status, 400)
})

test('les pages Roblox exigent une session complete', async () => {
  const c = client({ roblox: fakeRoblox().client })
  for (const path of ['/account/roblox/connect', '/account/roblox/callback?code=x&state=y']) {
    const r = await c.call('GET', path)
    assert.equal(r.res.status, 302, path)
    assert.equal(r.res.headers.get('location'), '/login', path)
  }
})

test('deconnexion : jeton revoque chez Roblox puis supprime ; CSRF exige', async () => {
  const { c, csrf, rb } = await setup()
  const { accountId } = await connectRoblox(c)
  assert.equal((await c.call('POST', `/account/roblox/${accountId}/disconnect`, { csrf: 'faux' })).res.status, 403)
  assert.equal(accounts(c).length, 1)
  const r = await c.call('POST', `/account/roblox/${accountId}/disconnect`, { csrf })
  assert.equal(r.res.status, 303)
  assert.equal(accounts(c).length, 0)
  assert.equal(rb.state.revoked.length, 1)
  assert.match(rb.state.revoked[0], /^rt-1001/)
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

test('un utilisateur ne peut pas deconnecter le compte Roblox d\'un autre', async () => {
  const { c, csrf } = await setup()
  const { accountId } = await connectRoblox(c)
  const other = await createUser(c.db, 'benoit@example.com', 'another long password')
  const { token, session } = createSession(c.db, other.id, 'full')
  c.setCookie(`sid=${token}`)
  await c.call('POST', `/account/roblox/${accountId}/disconnect`, { csrf: session.csrf })
  assert.equal(accounts(c).length, 1)
  assert.doesNotMatch((await c.call('GET', '/account')).text, /tanguy_dev/)
  void csrf
})

// --- rafraichissement du jeton --------------------------------------------------------------------------------------------------
test('jeton expire : rafraichi, et le jeton de rafraichissement tourne (usage unique)', async () => {
  const { c, rb } = await setup()
  const { accountId } = await connectRoblox(c)
  const first = await getAccessToken(c.db, rb.client, accountId!)
  assert.match(first, /^at-1001/)
  assert.equal(await getAccessToken(c.db, rb.client, accountId!), first) // encore valide : pas de rafraichissement
  assert.equal(rb.calls.filter((x) => x.body?.get('grant_type') === 'refresh_token').length, 0)

  c.db.prepare('UPDATE roblox_accounts SET access_expires_at = 0').run()
  const second = await getAccessToken(c.db, rb.client, accountId!)
  assert.notEqual(second, first)
  assert.equal(rb.calls.filter((x) => x.body?.get('grant_type') === 'refresh_token').length, 1)
  // un 2e rafraichissement fonctionne aussi : le nouveau refresh token a bien ete enregistre
  c.db.prepare('UPDATE roblox_accounts SET access_expires_at = 0').run()
  assert.notEqual(await getAccessToken(c.db, rb.client, accountId!), second)
})

test('rafraichissements simultanes : une seule requete vers Roblox', async () => {
  const { c, rb } = await setup()
  const { accountId } = await connectRoblox(c)
  c.db.prepare('UPDATE roblox_accounts SET access_expires_at = 0').run()
  const tokens = await Promise.all([1, 2, 3, 4].map(() => getAccessToken(c.db, rb.client, accountId!)))
  assert.equal(new Set(tokens).size, 1)
  assert.equal(rb.calls.filter((x) => x.body?.get('grant_type') === 'refresh_token').length, 1)
})

test('autorisation revoquee : le compte passe en « a reconnecter », puis revient apres reconnexion', async () => {
  const { c, rb } = await setup()
  const { accountId } = await connectRoblox(c)
  rb.state.blockRefresh = true
  c.db.prepare('UPDATE roblox_accounts SET access_expires_at = 0').run()
  await assert.rejects(() => getAccessToken(c.db, rb.client, accountId!), /reconnecte/)
  assert.equal(accounts(c)[0].status, 'needs_reauth')
  assert.match((await c.call('GET', '/account')).text, /A reconnecter/)
  // tant qu'il n'est pas reconnecte, on ne retente pas Roblox
  const before = rb.calls.length
  await assert.rejects(() => getAccessToken(c.db, rb.client, accountId!), /reconnecte/)
  assert.equal(rb.calls.length, before)

  rb.state.blockRefresh = false
  const again = await connectRoblox(c)
  assert.equal(again.accountId, accountId)
  assert.equal(accounts(c)[0].status, 'ok')
  assert.match((await c.call('GET', '/account')).text, /Connecte/)
})

test('groupes autorises : lus avec leur nom, mis en cache', async () => {
  const { c, rb } = await setup()
  const { accountId } = await connectRoblox(c)
  const groups = await listAuthorizedGroups(c.db, rb.client, accountId!)
  assert.deepEqual(groups.map((g) => `${g.id}:${g.name}`).sort(), ['123456:Boilr', '777:Studio'])
  const calls = rb.calls.length
  await listAuthorizedGroups(c.db, rb.client, accountId!)
  assert.equal(rb.calls.length, calls) // cache
})

// --- projets : compte Roblox obligatoire, groupe verifie via le jeton ------------------------------------------------------------
const post = (c: ReturnType<typeof client>, csrf: string, fields: Record<string, string>) =>
  c.call('POST', '/projects', { csrf, name: 'Steal Treasure', repoMode: 'none', ...fields })
const projectCount = (c: ReturnType<typeof client>) => (c.db.prepare('SELECT COUNT(*) AS n FROM projects').get() as { n: number }).n

test('projet : sans compte Roblox connecte, la creation est refusee', async () => {
  const { c, csrf } = await setup()
  const page = (await c.call('GET', '/projects/new')).text
  assert.match(page, /Aucun compte Roblox connecte/)
  const r = await post(c, csrf, {})
  assert.equal(r.res.status, 400)
  assert.match(r.text, /Connecte d(?:'|&#39;)abord un compte Roblox/)
  assert.equal(projectCount(c), 0)
})

test('projet : le compte se choisit dans une liste des comptes connectes', async () => {
  const { c, csrf } = await setup()
  await connectRoblox(c, '1001')
  await connectRoblox(c, '1002')
  const page = (await c.call('GET', '/projects/new')).text
  assert.match(page, /<select name="robloxAccountId" required>/)
  assert.match(page, />@tanguy_dev</)
  assert.match(page, />@alt_account</)
  assert.match(page, /Groupes accessibles avec tes comptes/)
  assert.match(page, /Boilr <code>123456<\/code>/)

  assert.equal((await post(c, csrf, {})).res.status, 400) // pas de compte choisi
  const alt = (c.db.prepare(`SELECT id FROM roblox_accounts WHERE username = 'alt_account'`).get() as { id: number }).id
  const ok = await post(c, csrf, { robloxAccountId: String(alt) })
  assert.equal(ok.res.status, 303)
  const row = c.db.prepare('SELECT roblox_account_id FROM projects').get() as { roblox_account_id: number }
  assert.equal(row.roblox_account_id, alt)
  assert.match((await c.call('GET', '/projects')).text, /@alt_account/)
})

test('projet : un compte Roblox d\'un autre utilisateur est refuse', async () => {
  const { c, csrf } = await setup()
  const { accountId } = await connectRoblox(c)
  const other = await createUser(c.db, 'benoit@example.com', 'another long password')
  const { token, session } = createSession(c.db, other.id, 'full')
  c.setCookie(`sid=${token}`)
  const r = await post(c, session.csrf, { robloxAccountId: String(accountId) })
  assert.equal(r.res.status, 400)
  assert.equal(projectCount(c), 0)
  void csrf
})

test('projet : le groupe doit etre accessible via le jeton du compte choisi', async () => {
  const { c, csrf, gh } = await setup()
  const a = await connectRoblox(c, '1001') // groupes 123456 et 777
  const b = await connectRoblox(c, '1002') // groupe 888

  // groupe autorise : OK, et le nom est rempli automatiquement
  const ok = await post(c, csrf, { robloxAccountId: String(a.accountId), groupId: '123456' })
  assert.equal(ok.res.status, 303)
  const row = c.db.prepare('SELECT roblox_group_id, roblox_group_name FROM projects').get() as Record<string, unknown>
  assert.deepEqual({ ...row }, { roblox_group_id: 123456, roblox_group_name: 'Boilr' })

  // groupe d'un AUTRE compte : refuse, explicitement
  const no = await post(c, csrf, { robloxAccountId: String(a.accountId), groupId: '888' })
  assert.equal(no.res.status, 400)
  assert.match(no.text, /compte Roblox « tanguy_dev » n(?:'|&#39;)a pas acces au groupe 888/)
  // le meme groupe passe avec le bon compte
  assert.equal((await post(c, csrf, { robloxAccountId: String(b.accountId), groupId: '888' })).res.status, 303)
  // groupe inconnu
  assert.equal((await post(c, csrf, { robloxAccountId: String(a.accountId), groupId: '999999' })).res.status, 400)
  assert.equal(projectCount(c), 2)
  void gh
})

test('projet : le groupe est verifie AVANT de creer le depot GitHub', async () => {
  const { c, csrf, gh } = await setup()
  const { accountId } = await connectRoblox(c)
  await c.call('POST', '/account/github', { csrf, token: 'tok' })
  gh.calls.length = 0
  const r = await post(c, csrf, { robloxAccountId: String(accountId), groupId: '888', repoMode: 'template', template: 'acme/roblox-template' })
  assert.equal(r.res.status, 400)
  assert.ok(!gh.calls.some((x) => x.url.endsWith('/generate')), 'aucun depot ne doit etre cree')
  assert.equal(projectCount(c), 0)
})

test('projet : nom du groupe saisi conserve ; compte a reconnecter refuse', async () => {
  const { c, csrf } = await setup()
  const { accountId } = await connectRoblox(c)
  const named = await post(c, csrf, { robloxAccountId: String(accountId), groupId: '777', groupName: 'Mon nom' })
  assert.equal(named.res.status, 303)
  assert.equal((c.db.prepare('SELECT roblox_group_name AS n FROM projects').get() as { n: string }).n, 'Mon nom')

  c.db.prepare(`UPDATE roblox_accounts SET status = 'needs_reauth'`).run()
  const reauth = await post(c, csrf, { robloxAccountId: String(accountId) })
  assert.equal(reauth.res.status, 400)
  assert.match(reauth.text, /doit etre reconnecte/)
  assert.match((await c.call('GET', '/projects/new')).text, /a reconnecter/)
  assert.equal(projectCount(c), 1)
})

test('projet : Roblox en panne pendant la verification du groupe -> 502, rien de cree', async () => {
  const { c, csrf } = await setup({ resourcesStatus: 500 })
  const { accountId } = await connectRoblox(c)
  const r = await post(c, csrf, { robloxAccountId: String(accountId), groupId: '777' })
  assert.equal(r.res.status, 502)
  assert.match(r.text, /Impossible de verifier l(?:'|&#39;)acces au groupe/)
  assert.equal(projectCount(c), 0)
  // sans groupe, la creation ne depend pas de cet appel
  assert.equal((await post(c, csrf, { robloxAccountId: String(accountId) })).res.status, 303)
})

test('projet : modifier le compte ou le groupe revalide l\'acces', async () => {
  const { c, csrf } = await setup()
  const a = await connectRoblox(c, '1001')
  const b = await connectRoblox(c, '1002')
  const id = Number(/\/projects\/(\d+)/.exec((await post(c, csrf, { robloxAccountId: String(a.accountId), groupId: '777' })).res.headers.get('location')!)![1])

  // on change de compte en gardant un groupe que le nouveau compte n'a pas autorise : refuse
  const bad = await c.call('POST', `/projects/${id}`, { csrf, name: 'Steal Treasure', robloxAccountId: String(b.accountId), groupId: '777' })
  assert.equal(bad.res.status, 400)
  assert.match(bad.text, /alt_account/)
  assert.equal((c.db.prepare('SELECT roblox_account_id AS a FROM projects WHERE id = ?').get(id) as { a: number }).a, a.accountId)

  // avec le groupe du nouveau compte : accepte
  const ok = await c.call('POST', `/projects/${id}`, { csrf, name: 'Steal Treasure', robloxAccountId: String(b.accountId), groupId: '888' })
  assert.equal(ok.res.status, 303)
  const row = c.db.prepare('SELECT roblox_account_id AS a, roblox_group_id AS g, roblox_group_name AS n FROM projects WHERE id = ?').get(id) as Record<string, unknown>
  assert.deepEqual({ ...row }, { a: b.accountId, g: 888, n: 'Autre groupe' })

  // sans groupe : accepte
  assert.equal((await c.call('POST', `/projects/${id}`, { csrf, name: 'Steal Treasure', robloxAccountId: String(a.accountId) })).res.status, 303)
  // page detail : compte affiche
  assert.match((await c.call('GET', `/projects/${id}`)).text, /@tanguy_dev/)
})
