// Les outils donnes a l'IA d'un chat (voir tools.ts) :
//   ui_preview  prendre une « photo » du rendu d'une story (l'IA VOIT l'image, les erreurs et les modules remplaces) ;
//   project     lire le projet (copie en lecture seule) ou ouvrir la branche de travail pour le modifier.
// Rien de tout cela n'existe au debut d'un chat : l'atelier (dossier libre) suffit pour discuter ou imaginer une interface ; le projet n'est clone que
// si l'IA en a besoin, et la branche n'est creee que quand elle doit vraiment modifier le projet.
import { join } from 'node:path'
import type { Git } from './git.ts'
import { JobCancelled, type JobContext } from './jobs.ts'
import { VIEWPORTS, fileProblem, renderStory, type UiRoot } from './preview.ts'
import { text, type ToolDef, type ToolResult } from './tools.ts'

export interface ChatToolsState {
  git: Git
  ctx: Pick<JobContext, 'signal' | 'event'>
  /** Dossier de l'atelier de ce chat (dossier de travail de l'IA). */
  atelier: string
  /** Le projet du chat (depot GitHub) ; null : pas de depot, l'IA ne dispose que de l'atelier. */
  project: { slug: string; url: string; branch: string; base?: string | null } | null
  emulatorDir?: string
  /** Etat modifie par les outils : la branche de travail est-elle ouverte ? et d'ou part le travail de ce tour. */
  branchOpen: boolean
  startHead: string | null
  /** La copie en lecture seule existe-t-elle ? */
  referenceReady: boolean
  token?: string | null
}

const rootsOf = (s: ChatToolsState): Record<UiRoot, string | null> => {
  const paths = s.project ? s.git.projectPaths(s.project.slug, s.project.branch) : null
  return { sandbox: s.atelier, project: paths ? (s.branchOpen ? paths.worktree : s.referenceReady ? paths.repo : null) : null }
}

export function chatTools(s: ChatToolsState): ToolDef[] {
  // Une capture a la fois : chacune construit l'emulateur et lance un navigateur.
  let chain: Promise<unknown> = Promise.resolve()
  const serial = <T>(fn: () => Promise<T>): Promise<T> => { const p = chain.then(fn, fn); chain = p.catch(() => {}); return p }

  const uiPreview: ToolDef = {
    name: 'ui_preview',
    description: "Prend une capture (image) du rendu d'une story d'interface, comme l'utilisateur la verra, et la renvoie avec les erreurs eventuelles. "
      + "A utiliser apres CHAQUE modification d'interface pour verifier le resultat, et corriger tant que le rendu n'est pas bon. "
      + "`file` : chemin de la story (*.story.tsx) depuis la racine du depot ; `root` : « sandbox » (l'atelier, par defaut dans un chat sans branche) ou « project » (le projet : branche de travail si elle est ouverte, sinon copie en lecture seule) ; `viewport` : UI Labs (defaut), Desktop, Tablette ou Telephone.",
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'Chemin de la story depuis la racine du depot, avec /.' },
        root: { type: 'string', enum: ['sandbox', 'project'] },
        viewport: { type: 'string', enum: [...VIEWPORTS] },
      },
      required: ['file'],
    },
    run: (args, signal) => serial(async (): Promise<ToolResult> => {
      const file = typeof args.file === 'string' ? args.file.replace(/\\/g, '/').replace(/^\.\//, '') : ''
      const problem = fileProblem(file)
      if (problem) return text(`Story refusee : ${problem}`, true)
      const root = args.root === undefined ? (s.branchOpen ? 'project' : 'sandbox') : args.root
      if (root !== 'sandbox' && root !== 'project') return text('Racine inconnue : « sandbox » ou « project ».', true)
      const viewport = args.viewport === undefined ? 'UI Labs' : args.viewport
      if (typeof viewport !== 'string' || !(VIEWPORTS as readonly string[]).includes(viewport)) return text(`Format inconnu (attendu : ${VIEWPORTS.join(', ')}).`, true)
      const dir = rootsOf(s)[root]
      if (!dir) return text(s.project ? "Le projet n'est pas encore disponible : appelle d'abord l'outil project (action « read » pour le lire, « open_branch » pour le modifier)." : "Ce chat n'a pas de projet : utilise root « sandbox ».", true)
      const r = await renderStory({ emulatorDir: s.emulatorDir, images: join(s.atelier, '_library'), project: dir, file, viewport, signal })
      if (signal.aborted) throw new JobCancelled()
      const notes = [
        `${r.nodes} element${r.nodes > 1 ? 's' : ''} affiche${r.nodes > 1 ? 's' : ''}`,
        r.errors.length ? `ERREURS : ${r.errors.slice(0, 3).join(' | ')}` : 'aucune erreur',
        r.missing.length ? `${r.missing.length} module(s) du jeu remplace(s) par l'emulateur (normal)` : '',
      ].filter(Boolean).join(' · ')
      if (!r.ok || !r.png) return text(`Capture impossible : ${r.error ?? 'erreur inconnue'}${r.errors.length ? ` (${r.errors.slice(0, 2).join(' | ')})` : ''}`, true)
      return {
        content: [
          { type: 'text', text: `Capture de ${file} (${root}, ${viewport}) : ${notes}. Les images « rbxassetid » apparaissent en blocs hachures : c'est normal.${r.nodes <= 1 ? ' ATTENTION : l\'apercu semble vide.' : ''}` },
          { type: 'image', data: r.png.toString('base64'), mimeType: 'image/png' },
        ],
      }
    }),
  }

  const project: ToolDef = {
    name: 'project',
    description: "Acces au projet (depot GitHub) de ce chat. action « read » : prepare une copie en LECTURE SEULE de la branche principale (tu y lis le code et l'UI existants ; ne la modifie jamais, elle est restauree apres ton tour). "
      + "action « open_branch » : cree la branche de travail de ce chat et son dossier, ou ouvre celle qui existe deja ; c'est la qu'on modifie le vrai projet (commit et push automatiques). A appeler SANS demander la permission des que l'utilisateur te demande de coder ou de modifier quelque chose dans le projet.",
    inputSchema: { type: 'object', properties: { action: { type: 'string', enum: ['read', 'open_branch'] } }, required: ['action'] },
    async run(args): Promise<ToolResult> {
      if (!s.project) return text("Ce projet n'a pas de depot GitHub : tu ne disposes que de l'atelier.", true)
      const { slug, url, branch, base } = s.project
      if (args.action === 'read') {
        const ref = await s.git.reference(slug, url, s.ctx, s.token ?? null)
        s.referenceReady = true
        return text(`Projet pret en lecture seule (branche principale « ${ref.defaultBranch} » a jour) : ${ref.path}\nLis le code et les composants existants ici ; pour MODIFIER le projet, appelle project avec l'action « open_branch ».`)
      }
      if (args.action === 'open_branch') {
        const first = !s.branchOpen
        const prep = await s.git.handlers['git.prepare']({ ...s.ctx, jobId: 0, payload: { project: slug, url, branch, ...(base ? { base } : {}) } }) as { created: boolean; newBranch: boolean }
        s.branchOpen = true
        s.referenceReady = true // (le clone principal existe maintenant)
        if (first) s.startHead = (await s.git.exec(slug, branch, ['rev-parse', 'HEAD'], s.ctx)).trim()
        const paths = s.git.projectPaths(slug, branch)
        return text(`Branche de travail « ${branch} » ${prep.created ? 'creee' : 'ouverte'} : ${paths.worktree}\nModifie les fichiers du projet DANS ce dossier (chemins absolus). Les commits et le push sont faits automatiquement a la fin ; pour commiter toi-meme : git -C "${paths.worktree}" add -A puis git -C "${paths.worktree}" commit -m "...". Ne fais jamais de git push.`)
      }
      return text('Action inconnue : « read » ou « open_branch ».', true)
    },
  }

  return [uiPreview, project]
}
