import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createAgent } from '../src/agent.ts'
import { readWorkspace } from '../src/config.ts'
import { createGit, gitHandlers } from '../src/git.ts'
import type { JobContext } from '../src/jobs.ts'

const DAY = 86_400_000
const tmp = () => mkdtempSync(join(tmpdir(), 'rpm-git-'))
const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env, encoding: 'utf8' }).trim()
const ctx = (payload: unknown, events: string[] = []): JobContext => ({ jobId: 1, payload, signal: new AbortController().signal, event: (_l, t) => { events.push(t) } })
const commit = (cwd: string, file: string, msg = 'c') => { writeFileSync(join(cwd, file), msg); git(cwd, 'add', '.'); git(cwd, 'commit', '-q', '-m', msg) }

// Depot « distant » local (un depot nu) avec un premier commit sur main.
function remote() {
  const seed = tmp()
  git(seed, 'init', '-q', '-b', 'main')
  commit(seed, 'a.txt', 'un')
  const bare = join(tmp(), 'remote.git')
  git(seed, 'clone', '-q', '--bare', '.', bare)
  return bare
}

// allowUrl permissif : les tests clonent depuis un dossier local. Le filtre par defaut est teste a part.
function setup(workspace: string | null = tmp()) {
  const clock = { t: 1_000_000_000_000 }
  const g = createGit({ workspace: () => workspace, allowUrl: () => true, now: () => clock.t })
  return { ws: workspace, g, h: g.handlers, clock, wt: (project: string, branch: string) => join(workspace!, project, 'branches', branch.replace(/\//g, '+')) }
}
const rejects = (p: Promise<unknown>, re: RegExp) => assert.rejects(p, (e: Error) => { assert.match(e.message, re); return true })
type Prepared = { project: string; path: string; cloned: boolean; created: boolean; newBranch: boolean; branch: string; head: string }

test('un depot clone une fois, un dossier de travail par branche, reutilise ensuite', async () => {
  const bare = remote()
  const { ws, h, wt } = setup()
  const events: string[] = []

  const a = await h['git.prepare'](ctx({ project: 'jeu', url: bare, branch: 'feature/ia' }, events)) as Prepared
  assert.deepEqual([a.cloned, a.created, a.newBranch], [true, true, true])
  assert.equal(a.path, 'jeu/branches/feature+ia')
  assert.equal(a.branch, 'feature/ia')
  assert.ok(existsSync(join(wt('jeu', 'feature/ia'), 'a.txt')))
  assert.equal(git(join(ws!, 'jeu', 'repo'), 'rev-parse', '--abbrev-ref', 'HEAD'), 'HEAD', 'clone principal en HEAD detache')

  commit(wt('jeu', 'feature/ia'), 'b.txt', 'deux')
  const pushed = await h['git.push'](ctx({ project: 'jeu', branch: 'feature/ia' })) as { pushed: string }
  assert.equal(pushed.pushed, 'feature/ia')
  assert.match(git(bare, 'branch', '--list'), /feature\/ia/)
  const st = await h['git.status'](ctx({ project: 'jeu', branch: 'feature/ia' })) as { ahead: number; dirtyFiles: number; behind: number }
  assert.deepEqual([st.ahead, st.behind, st.dirtyFiles], [0, 0, 0])

  // meme branche : on reutilise simplement le dossier (pas de nouveau clone ni de nouveau dossier)
  const again = await h['git.prepare'](ctx({ project: 'jeu', url: bare, branch: 'feature/ia' })) as Prepared
  assert.deepEqual([again.cloned, again.created, again.newBranch], [false, false, false])

  // autre branche : un 2e dossier, depuis le meme clone
  const other = await h['git.prepare'](ctx({ project: 'jeu', url: bare, branch: 'correctif' })) as Prepared
  assert.deepEqual([other.cloned, other.created, other.newBranch], [false, true, true])
  assert.ok(existsSync(wt('jeu', 'correctif')) && existsSync(wt('jeu', 'feature/ia')))
  assert.equal(git(join(ws!, 'jeu', 'repo'), 'worktree', 'list').split('\n').length, 3)
  assert.ok(!existsSync(join(wt('jeu', 'correctif'), 'b.txt')), 'chaque branche a son contenu')
  assert.ok(events.some((e) => e.startsWith('git clone')), 'la sortie de git est remontee en evenements')
})

test('branche deja sur le depot : suivie ; pull en fast-forward ; branche non poussee : rien a tirer', async () => {
  const bare = remote()
  const { g, h, wt } = setup()
  const other = tmp()
  git(other, 'clone', '-q', bare, 'x')
  const x = join(other, 'x')
  commit(x, 'dist.txt', 'distant'); git(x, 'push', '-q', 'origin', 'HEAD:dev')

  const d = await h['git.prepare'](ctx({ project: 'p', url: bare, branch: 'dev' })) as Prepared
  assert.deepEqual([d.created, d.newBranch], [true, false])
  assert.ok(existsSync(join(wt('p', 'dev'), 'dist.txt')))
  assert.equal(git(wt('p', 'dev'), 'rev-parse', '--abbrev-ref', '@{u}'), 'origin/dev')

  commit(x, 'dist2.txt', 'suite'); git(x, 'push', '-q', 'origin', 'HEAD:dev')
  await h['git.pull'](ctx({ project: 'p', branch: 'dev' }))
  assert.ok(existsSync(join(wt('p', 'dev'), 'dist2.txt')), 'le pull recupere les nouveaux commits')
  await h['git.prepare'](ctx({ project: 'p', url: bare, branch: 'nouvelle', base: 'dev' }))
  const pulled = await h['git.pull'](ctx({ project: 'p', branch: 'nouvelle' })) as { pulled: boolean }
  assert.equal(pulled.pulled, false)
  assert.ok(existsSync(join(wt('p', 'nouvelle'), 'dist.txt')), 'creee depuis la branche de depart demandee')
  assert.equal(g.registry()[0].branches.length, 2)
})

test('pull : fast-forward uniquement, aucun conflit laisse en plan', async () => {
  const bare = remote()
  const { h, wt } = setup()
  const other = tmp()
  git(other, 'clone', '-q', bare, 'x')
  const x = join(other, 'x')
  await h['git.prepare'](ctx({ project: 'r', url: bare, branch: 'feat' }))
  commit(wt('r', 'feat'), 'local.txt', 'l')
  await h['git.push'](ctx({ project: 'r', branch: 'feat' }))
  git(x, 'fetch', '-q'); git(x, 'checkout', '-q', 'feat'); commit(x, 'distant.txt', 'd'); git(x, 'push', '-q')
  commit(wt('r', 'feat'), 'local2.txt', 'l2') // divergence
  await rejects(h['git.pull'](ctx({ project: 'r', branch: 'feat' })), /git pull a echoue/)
  assert.equal(git(wt('r', 'feat'), 'status', '--porcelain'), '')
})

test('la branche principale est protegee ; un projet reste lie a son depot', async () => {
  const bare = remote()
  const { h } = setup()
  await rejects(h['git.prepare'](ctx({ project: 'p', url: bare, branch: 'main' })), /jamais directement/)
  await rejects(h['git.prepare'](ctx({ project: 'p2', url: bare, branch: 'master' })), /jamais directement/)
  await h['git.prepare'](ctx({ project: 'q', url: bare, branch: 'feat' }))
  await rejects(h['git.prepare'](ctx({ project: 'q', url: remote(), branch: 'feat2' })), /autre depot/)
  await rejects(h['git.prepare'](ctx({ project: 'q', url: bare, branch: 'x', base: 'inexistante' })), /depart introuvable/)
  await rejects(h['git.push'](ctx({ project: 'q', branch: 'main' })), /introuvable|refuse/)
  await rejects(h['git.status'](ctx({ project: 'q', branch: 'jamais-prepare' })), /git.prepare/)
  await rejects(h['git.prepare'](ctx({ project: 'z', url: join(tmp(), 'absent'), branch: 'b' })), /git clone a echoue/)
})

test('espace de travail : obligatoire, et jamais de sortie du dossier', async () => {
  const bare = remote()
  const none = setup(null)
  await rejects(none.h['git.prepare'](ctx({ project: 'a', url: bare, branch: 'b' })), /Espace de travail non configure/)

  const { ws, h } = setup()
  for (const project of ['../evil', 'a/b', '..', '.', '.hidden', 'a b', 'a\\b', '', 'x'.repeat(65), 'nom.', 'con', 'NUL.txt']) {
    await rejects(h['git.prepare'](ctx({ project, url: bare, branch: 'b' })), /Nom de projet invalide|manquant/)
    await rejects(h['git.status'](ctx({ project, branch: 'b' })), /Nom de projet invalide|manquant/)
  }
  assert.ok(!existsSync(join(ws!, '..', 'evil')))

  await h['git.prepare'](ctx({ project: 'ok', url: bare, branch: 'b' }))
  // un lien symbolique qui pointe hors de l'espace de travail est refuse (si le systeme autorise d'en creer)
  const outside = tmp(); git(outside, 'init', '-q')
  try {
    symlinkSync(outside, join(ws!, 'ok', 'branches', 'piege'), 'junction')
    await rejects(h['git.status'](ctx({ project: 'ok', branch: 'piege' })), /sort de l'espace|git.prepare/)
  } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EPERM') throw e }
})

test('arguments hostiles : URL, branches, jetons', async () => {
  const strict = gitHandlers({ workspace: () => tmp() }) // filtre d'URL par defaut
  const url = (u: string) => strict['git.prepare'](ctx({ project: 'a', url: u, branch: 'b' }))
  for (const u of ['--upload-pack=calc', '-oProxyCommand=x', 'ext::sh -c touch pwned', 'file:///etc/passwd', '/tmp/depot', 'C:/depot', 'http://github.com/a/b', 'https://user:pass@github.com/a/b', 'https://github.com/a b', 'git://github.com/a/b', 'ftp://x/y']) {
    await rejects(url(u), /Adresse de depot refusee/)
  }
  const { h, wt } = setup()
  const bare = remote()
  await h['git.prepare'](ctx({ project: 'r', url: bare, branch: 'ok' }))
  for (const name of ['--help', '-x', 'a..b', 'a//b', 'fin/', 'x.lock', 'a b', 'a@{1}', 'a;rm', '$(id)', '`id`', 'a+b', '.cache/x', 'x'.repeat(101), 'con', 'a/nul']) {
    await rejects(h['git.prepare'](ctx({ project: 'r', url: bare, branch: name })), /Nom de branche invalide/)
    await rejects(h['git.pull'](ctx({ project: 'r', branch: name })), /Nom de branche invalide/)
  }
  await rejects(h['git.prepare'](ctx({ project: 'r', url: bare, branch: 'ok2', base: '--orphan' })), /Nom de branche invalide/)
  await rejects(h['git.push'](ctx({ project: 'r', branch: '--force' })), /Nom de branche invalide/)
  await rejects(h['git.pull'](ctx({ project: 'r', branch: 'ok', token: 'court' })), /Jeton invalide/)
  await rejects(h['git.pull'](ctx({ project: 'r', branch: 'ok', token: 'abc def ghi jkl' })), /Jeton invalide/)
  await rejects(h['git.pull'](ctx({ project: 'r', branch: 'ok', token: 42 })), /invalide/)
  assert.equal(git(wt('r', 'ok'), 'rev-parse', '--abbrev-ref', 'HEAD'), 'ok', 'rien n\'a ete execute')
})

test('le jeton n\'apparait jamais dans les erreurs ni dans les evenements', async () => {
  const secret = 'ghp_SECRET1234567890abcdef'
  const ws = tmp()
  const h = gitHandlers({ workspace: () => ws }) // filtre par defaut : https
  const events: string[] = []
  try {
    await h['git.prepare'](ctx({ project: 'p', url: 'https://127.0.0.1:1/x/y', branch: 'b', token: secret }, events))
    assert.fail('doit echouer')
  } catch (e) {
    assert.ok(!(e as Error).message.includes(secret))
    assert.ok(!(e as Error).message.includes(Buffer.from(`x-access-token:${secret}`).toString('base64')))
  }
  assert.ok(!events.join('\n').includes(secret))
  const cfg = join(ws, 'p', 'repo', '.git', 'config')
  assert.ok(!existsSync(cfg) || !readFileSync(cfg, 'utf8').includes(secret))
})

test('annulation : la commande git est interrompue', async () => {
  const h = gitHandlers({ workspace: () => tmp(), allowUrl: () => true })
  const ac = new AbortController()
  ac.abort()
  await assert.rejects(h['git.prepare']({ jobId: 1, payload: { project: 'z', url: remote(), branch: 'b' }, signal: ac.signal, event: () => {} }), /annulee/)
})

test('nettoyage a 3 jours : supprime ce qui est propre et pousse, garde tout le reste', async () => {
  const bare = remote()
  const { ws, g, h, clock, wt } = setup()
  const T0 = clock.t
  for (const b of ['propre', 'modifie', 'nonpousse']) await h['git.prepare'](ctx({ project: 'jeu', url: bare, branch: b }))
  for (const b of ['propre', 'modifie', 'nonpousse']) { commit(wt('jeu', b), `${b}.txt`, b); await h['git.push'](ctx({ project: 'jeu', branch: b })) }
  writeFileSync(join(wt('jeu', 'modifie'), 'wip.txt'), 'travail en cours') // fichier non enregistre
  commit(wt('jeu', 'nonpousse'), 'encore.txt', 'local seulement') // commit non pousse
  assert.deepEqual((await g.sweep()), { removed: [], kept: [] }, 'rien d\'ancien : rien a faire')

  clock.t = T0 + 2 * DAY
  assert.deepEqual((await g.sweep()).removed, [], '2 jours : trop tot')

  clock.t = T0 + 4 * DAY
  const r = await g.sweep()
  assert.deepEqual(r.removed, ['jeu/propre'])
  assert.deepEqual(r.kept.map((k) => [k.item, k.reason]).sort(), [['jeu/modifie', 'modifications non enregistrees'], ['jeu/nonpousse', 'commits non pousses']])
  assert.ok(!existsSync(wt('jeu', 'propre')))
  assert.ok(existsSync(join(wt('jeu', 'modifie'), 'wip.txt')) && existsSync(wt('jeu', 'nonpousse')), 'rien n\'est perdu')
  assert.ok(existsSync(join(ws!, 'jeu', 'repo')), 'le clone principal reste tant qu\'il y a des dossiers de travail')

  // une fois le travail sauvegarde (commit + push), le nettoyage suivant peut tout retirer, clone principal compris
  git(wt('jeu', 'modifie'), 'add', '.'); git(wt('jeu', 'modifie'), 'commit', '-q', '-m', 'wip')
  await h['git.push'](ctx({ project: 'jeu', branch: 'modifie' }))
  await h['git.push'](ctx({ project: 'jeu', branch: 'nonpousse' }))
  clock.t = T0 + 8 * DAY
  const last = await g.sweep()
  assert.deepEqual(last.removed.sort(), ['jeu', 'jeu/modifie', 'jeu/nonpousse'])
  assert.ok(!existsSync(join(ws!, 'jeu')))
  assert.deepEqual(g.registry(), [])

  // et le tout se recree a la demande, avec le travail pousse
  const back = await h['git.prepare'](ctx({ project: 'jeu', url: bare, branch: 'nonpousse' })) as Prepared
  assert.deepEqual([back.cloned, back.created, back.newBranch], [true, true, false])
  assert.ok(existsSync(join(wt('jeu', 'nonpousse'), 'encore.txt')))
})

test('nettoyage : l\'usage repousse l\'echeance, un dossier supprime a la main est oublie, tache dediee', async () => {
  const bare = remote()
  const { g, h, clock, wt } = setup()
  const T0 = clock.t
  await h['git.prepare'](ctx({ project: 'a', url: bare, branch: 'actif' }))
  await h['git.prepare'](ctx({ project: 'a', url: bare, branch: 'oublie' }))
  clock.t = T0 + 2.5 * DAY
  await h['git.status'](ctx({ project: 'a', branch: 'actif' })) // utilise : l'echeance repart
  clock.t = T0 + 4 * DAY
  assert.deepEqual((await g.sweep()).removed, ['a/oublie'], 'seule la branche inutilisee part, le projet reste')
  assert.ok(existsSync(wt('a', 'actif')))

  const { rmSync } = await import('node:fs')
  rmSync(wt('a', 'actif'), { recursive: true, force: true })
  const viaJob = await h['git.cleanup'](ctx({ maxAgeDays: 0 })) as { removed: string[]; kept: unknown[] }
  assert.deepEqual(viaJob.removed, ['a'], 'plus aucun dossier : le clone principal part aussi')
  assert.deepEqual(g.registry(), [])
})

test('espace de travail : reglage depuis l\'agent, ecrit dans .env sans toucher au reste', () => {
  const dir = tmp()
  const envPath = join(dir, '.env')
  writeFileSync(envPath, 'RPM_HOST_URL=http://x\nRPM_WORKER_TOKEN=rpmw_' + 'a'.repeat(43) + '\n')
  const agent = createAgent({ envPath, version: 't', info: {} })
  assert.equal(agent.snapshot().workspace, null)
  assert.equal(agent.setWorkspace('relatif/dossier').ok, false)
  assert.equal(agent.setWorkspace('C:/').ok, false)
  assert.equal(agent.setWorkspace('/').ok, false)
  const target = join(dir, 'espace')
  assert.equal(agent.setWorkspace(target).ok, true)
  assert.ok(existsSync(target), 'le dossier est cree')
  assert.equal(readWorkspace(envPath), target)
  assert.equal(agent.snapshot().workspace, target)
  assert.match(readFileSync(envPath, 'utf8'), /RPM_HOST_URL=http:\/\/x/)
  assert.equal(readFileSync(envPath, 'utf8').match(/RPM_WORKSPACE_DIR/g)!.length, 1)
  assert.equal(agent.setWorkspace(join(dir, 'autre')).ok, true)
  assert.equal(readFileSync(envPath, 'utf8').match(/RPM_WORKSPACE_DIR/g)!.length, 1, 'remplace, ne duplique pas')
  assert.equal(agent.setWorkspace('').ok, true)
  assert.equal(readWorkspace(envPath), null)
})
