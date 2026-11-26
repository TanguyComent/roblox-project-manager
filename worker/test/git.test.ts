import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createAgent } from '../src/agent.ts'
import { readWorkspace } from '../src/config.ts'
import { gitHandlers } from '../src/git.ts'
import type { JobContext } from '../src/jobs.ts'

const tmp = () => mkdtempSync(join(tmpdir(), 'rpm-git-'))
const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env, encoding: 'utf8' }).trim()
const ctx = (payload: unknown, events: string[] = []): JobContext => ({ jobId: 1, payload, signal: new AbortController().signal, event: (_l, t) => { events.push(t) } })

// Depot « distant » local (un depot nu) avec un premier commit sur main.
function remote() {
  const seed = tmp()
  git(seed, 'init', '-q', '-b', 'main')
  writeFileSync(join(seed, 'a.txt'), 'un\n')
  git(seed, 'add', '.'); git(seed, 'commit', '-q', '-m', 'init')
  const bare = join(tmp(), 'remote.git')
  git(seed, 'clone', '-q', '--bare', '.', bare)
  return bare
}

// allowUrl permissif : les tests clonent depuis un dossier local. Le filtre par defaut est teste a part.
const setup = (workspace: string | null = tmp()) => ({ ws: workspace, h: gitHandlers({ workspace: () => workspace, allowUrl: () => true }) })
const rejects = (p: Promise<unknown>, re: RegExp) => assert.rejects(p, (e: Error) => { assert.match(e.message, re); return true })

test('cycle complet : clone, branche, commit, push, checkout, pull', async () => {
  const bare = remote()
  const { ws, h } = setup()
  const events: string[] = []

  const cloned = await h['git.clone'](ctx({ url: bare, dir: 'jeu' }, events)) as { dir: string; branch: string; head: string }
  assert.equal(cloned.dir, 'jeu'); assert.equal(cloned.branch, 'main'); assert.match(cloned.head, /^[0-9a-f]{7,}$/)
  assert.ok(existsSync(join(ws!, 'jeu', 'a.txt')))

  const b = await h['git.branch'](ctx({ dir: 'jeu', name: 'feature/ia' })) as { branch: string }
  assert.equal(b.branch, 'feature/ia')
  writeFileSync(join(ws!, 'jeu', 'b.txt'), 'deux\n')
  let st = await h['git.status'](ctx({ dir: 'jeu' })) as { dirtyFiles: number; ahead: number | null }
  assert.equal(st.dirtyFiles, 1)
  assert.equal(st.ahead, null, 'pas encore de branche distante')
  git(join(ws!, 'jeu'), 'add', '.'); git(join(ws!, 'jeu'), 'commit', '-q', '-m', 'ajout b')

  const pushed = await h['git.push'](ctx({ dir: 'jeu' })) as { pushed: string }
  assert.equal(pushed.pushed, 'feature/ia')
  assert.match(git(bare, 'branch', '--list'), /feature\/ia/)
  st = await h['git.status'](ctx({ dir: 'jeu' })) as typeof st
  assert.equal(st.ahead, 0); assert.equal(st.dirtyFiles, 0)

  const back = await h['git.checkout'](ctx({ dir: 'jeu', branch: 'main' })) as { branch: string }
  assert.equal(back.branch, 'main')
  assert.ok(!existsSync(join(ws!, 'jeu', 'b.txt')))

  // quelqu'un d'autre pousse sur main : le pull (fast-forward) le recupere
  const other = tmp()
  git(other, 'clone', '-q', bare, 'x')
  writeFileSync(join(other, 'x', 'c.txt'), 'trois\n')
  git(join(other, 'x'), 'add', '.'); git(join(other, 'x'), 'commit', '-q', '-m', 'ajout c'); git(join(other, 'x'), 'push', '-q')
  await h['git.pull'](ctx({ dir: 'jeu' }))
  assert.ok(existsSync(join(ws!, 'jeu', 'c.txt')))
  assert.ok(events.some((e) => e.startsWith('git clone')), 'la sortie de git est remontee en evenements')
})

test('clone d\'une branche precise, et erreurs claires', async () => {
  const bare = remote()
  git(bare, 'branch', 'dev', 'main')
  const { ws, h } = setup()
  assert.equal(((await h['git.clone'](ctx({ url: bare, dir: 'a', branch: 'dev' }))) as { branch: string }).branch, 'dev')
  await rejects(h['git.clone'](ctx({ url: bare, dir: 'a' })), /existe deja/)
  await rejects(h['git.clone'](ctx({ url: join(ws!, 'inexistant'), dir: 'b' })), /git clone a echoue/)
  await rejects(h['git.checkout'](ctx({ dir: 'a', branch: 'nope' })), /git switch a echoue/)
  await rejects(h['git.branch'](ctx({ dir: 'a', name: 'dev' })), /git switch a echoue/)
  await rejects(h['git.status'](ctx({ dir: 'absent' })), /introuvable/)
  mkdirSync(join(ws!, 'pasgit'))
  await rejects(h['git.status'](ctx({ dir: 'pasgit' })), /pas un depot/)
})

test('pull : refuse les fusions (fast-forward uniquement) et ne laisse pas de conflit', async () => {
  const bare = remote()
  const { ws, h } = setup()
  await h['git.clone'](ctx({ url: bare, dir: 'r' }))
  const other = tmp()
  git(other, 'clone', '-q', bare, 'x')
  writeFileSync(join(other, 'x', 'distant.txt'), '1'); git(join(other, 'x'), 'add', '.'); git(join(other, 'x'), 'commit', '-q', '-m', 'd'); git(join(other, 'x'), 'push', '-q')
  writeFileSync(join(ws!, 'r', 'local.txt'), '1'); git(join(ws!, 'r'), 'add', '.'); git(join(ws!, 'r'), 'commit', '-q', '-m', 'l')
  await rejects(h['git.pull'](ctx({ dir: 'r' })), /git pull a echoue/)
  assert.equal(git(join(ws!, 'r'), 'status', '--porcelain'), '')
})

test('espace de travail : obligatoire, et jamais de sortie du dossier', async () => {
  const bare = remote()
  const none = setup(null)
  await rejects(none.h['git.clone'](ctx({ url: bare, dir: 'a' })), /Espace de travail non configure/)

  const { ws, h } = setup()
  for (const dir of ['../evil', 'a/b', '..', '.', '.hidden', 'a b', 'a\\b', '', 'x'.repeat(65), 'nom.']) {
    await rejects(h['git.clone'](ctx({ url: bare, dir })), /Nom de dossier invalide|manquant/)
    await rejects(h['git.status'](ctx({ dir })), /Nom de dossier invalide|manquant/)
  }
  assert.ok(!existsSync(join(ws!, '..', 'evil')))

  // un lien symbolique qui pointe hors de l'espace de travail est refuse (si le systeme autorise d'en creer)
  const outside = tmp(); git(outside, 'init', '-q')
  try {
    symlinkSync(outside, join(ws!, 'lien'), 'junction')
    await rejects(h['git.status'](ctx({ dir: 'lien' })), /sort de l'espace/)
  } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EPERM') throw e }
})

test('arguments hostiles : URL, branches, jetons', async () => {
  const strict = gitHandlers({ workspace: () => tmp() }) // filtre d'URL par defaut
  const url = (u: string) => strict['git.clone'](ctx({ url: u, dir: 'a' }))
  for (const u of ['--upload-pack=calc', '-oProxyCommand=x', 'ext::sh -c touch pwned', 'file:///etc/passwd', '/tmp/depot', 'C:/depot', 'http://github.com/a/b', 'https://user:pass@github.com/a/b', 'https://github.com/a b', 'git://github.com/a/b', 'ftp://x/y']) {
    await rejects(url(u), /Adresse de depot refusee/)
  }
  const { ws, h } = setup()
  await h['git.clone'](ctx({ url: remote(), dir: 'r' }))
  for (const name of ['--help', '-x', 'a..b', 'a//b', 'fin/', 'x.lock', 'a b', 'a@{1}', 'a;rm', '$(id)', '`id`', 'x'.repeat(101)]) {
    await rejects(h['git.branch'](ctx({ dir: 'r', name })), /Nom de branche invalide/)
    await rejects(h['git.checkout'](ctx({ dir: 'r', branch: name })), /Nom de branche invalide/)
  }
  await rejects(h['git.branch'](ctx({ dir: 'r', name: 'ok', from: '--orphan' })), /Nom de branche invalide/)
  await rejects(h['git.push'](ctx({ dir: 'r', branch: '--force' })), /Nom de branche invalide/)
  await rejects(h['git.pull'](ctx({ dir: 'r', token: 'court' })), /Jeton invalide/)
  await rejects(h['git.pull'](ctx({ dir: 'r', token: 'abc def ghi jkl' })), /Jeton invalide/)
  await rejects(h['git.pull'](ctx({ dir: 'r', token: 42 })), /invalide/)
  assert.equal(git(join(ws!, 'r'), 'rev-parse', '--abbrev-ref', 'HEAD'), 'main', 'rien n\'a ete execute')
})

test('le jeton n\'apparait jamais dans les erreurs ni dans la configuration du depot', async () => {
  const secret = 'ghp_SECRET1234567890abcdef'
  const ws = tmp()
  const h = gitHandlers({ workspace: () => ws }) // filtre par defaut : https
  const events: string[] = []
  try {
    await h['git.clone'](ctx({ url: 'https://127.0.0.1:1/x/y', dir: 'p', token: secret }, events))
    assert.fail('doit echouer')
  } catch (e) {
    assert.ok(!(e as Error).message.includes(secret))
    assert.ok(!(e as Error).message.includes(Buffer.from(`x-access-token:${secret}`).toString('base64')))
  }
  assert.ok(!events.join('\n').includes(secret))
  assert.ok(!existsSync(join(ws, 'p', '.git', 'config')) || !readFileSync(join(ws, 'p', '.git', 'config'), 'utf8').includes(secret))
})

test('annulation : la commande git est interrompue', async () => {
  const ws = tmp()
  const h = gitHandlers({ workspace: () => ws, allowUrl: () => true })
  const ac = new AbortController()
  ac.abort()
  await assert.rejects(h['git.clone']({ jobId: 1, payload: { url: remote(), dir: 'z' }, signal: ac.signal, event: () => {} }), /annulee/)
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
