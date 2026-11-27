# worker

Agent qui tourne sur une machine et execute les taches envoyees par le Host. Il **se connecte au Host** (WebSocket sortant) : rien a ouvrir sur la machine.
Il se gere depuis une **page locale** (`http://127.0.0.1:4180`, accessible uniquement depuis cet ordinateur).

## Premier lancement

Node 24+ suffit (aucune installation de dependances necessaire pour l'executer).

1. **Lancer** : double-clic sur `start.vbs` (Windows, sans fenetre), `start.command` (macOS / Linux) ou `npm start`.
   `start.cmd` fait la meme chose avec une console visible (pratique pour voir une erreur).
   La page locale s'ouvre dans le navigateur ; relancer pendant qu'il tourne deja ne fait que rouvrir cette page.
2. **Jumeler** : sur le site, page **Workers** → *Creer le Worker* → copier le **code de jumelage** (`rpm1.…`) → le coller dans la page locale → *Jumeler*.
   Le code (adresse du Host + jeton) est ecrit dans `worker/.env` ; il n'est plus jamais reaffiche.
3. **Demarrage automatique** (facultatif) : bouton *Activer* dans la page locale. Le Worker se lancera tout seul, en arriere-plan, a l'ouverture de ta session
   (Windows : fichier dans le dossier « Demarrage » ; macOS : LaunchAgent ; Linux : entree autostart). Aucun droit administrateur. Si tu deplaces le dossier du
   projet, reactive l'option pour qu'elle pointe au bon endroit.

La page locale montre l'etat (connecte, Host injoignable, refuse…), le journal, permet d'arreter / demarrer, de rejumeler ou de supprimer le jumelage.

## Outils detectes

Au demarrage (puis toutes les 10 min, ou via *Re-detecter*), le Worker cherche ce a quoi la machine a acces : **Claude Code, Codex (OpenAI), Gemini CLI, Blender, Git, Roblox Studio**
(sur le PATH, puis aux emplacements d'installation habituels). Il envoie au Host **uniquement** le nom et la version (jamais de chemin ni de compte) ; la page *Workers* du site les affiche
sur chaque machine. Pour ajouter un outil : une ligne dans `TOOLS` (`src/capabilities.ts`). La detection verifie la **presence** de l'outil, pas qu'il est connecte a un compte.

## Espace de travail et git

`RPM_WORKSPACE_DIR` (dans `.env`, ou champ *Espace de travail* de la page locale) est le dossier ou le Worker range ses depots :

```
<espace>/<projet>/repo                  un seul clone du depot
<espace>/<projet>/branches/<branche>    un dossier de travail (git worktree) par branche ("/" devient "+")
<espace>/.rpm/registry.json             registre : ce que le Worker possede, et la derniere utilisation de chaque dossier
```

Taches git : `git.prepare` (clone le depot si besoin, sinon le met a jour ; cree le dossier de la branche s'il n'existe pas, sinon s'y place ; une branche inconnue est
creee depuis `base`, par defaut la branche principale), `git.pull` (fast-forward uniquement), `git.push` (jamais force), `git.status`, `git.cleanup`.
Les taches travaillent **toujours sur une branche dediee** : la branche principale est refusee (prepare comme push). Le merge se fait ailleurs (pull request).

**Nettoyage** : au demarrage puis toutes les 6 h (et via le bouton de la page locale), un dossier de branche inutilise depuis plus de 3 jours est supprime, ainsi que le clone du
projet quand il n'a plus aucun dossier et reste inutilise. Un dossier n'est supprime que s'il n'a **aucune modification en cours et que son travail est deja pousse** ;
sinon il est conserve (et signale dans le journal). Il est recree a la demande.

Securite : aucun shell, chaque argument est valide (noms de projet et de branche, URL https/ssh sans identifiants), rien hors de l'espace de travail (liens symboliques compris).
Authentification : par defaut celle de la machine (gestionnaire d'identifiants git, cles ssh) ; le Host peut aussi fournir un `token` GitHub dans la tache : transmis par variables
d'environnement (jamais en argument ni dans `.git/config`), limite a github.com, et masque dans les journaux.

## Requetes IA (`ai.chat`)

Prepare la branche (voir ci-dessus), lance le CLI **Claude Code** dessus (`claude -p --output-format stream-json --verbose`, conversation reprise avec `--resume`, `--model` / `--effort` selon le chat), commite ce que l'IA aurait oublie de commiter,
pousse la branche, et renvoie la reponse, les commits et le diff. Pendant l'execution, chaque etape de Claude (pensee, outil, texte) est transmise en direct au Host. Il faut que `claude` soit installe et connecte sur cette machine (`npm install -g @anthropic-ai/claude-code`, puis `claude` une fois).
Le prompt passe par l'entree standard ; les droits de l'IA sont limites par un fichier de reglages : lecture / edition de fichiers, recherche et `git` (sans `push` ni `remote`), pas de reseau,
et tout ce qui demanderait une autorisation est refuse (`--permission-prompts none`). Modifier `DEFAULT_ALLOW` / `DEFAULT_DENY` dans `src/ai.ts` pour changer ces droits.


## Apercus d'interface

Quand la reponse de l'IA contient un bloc ```rpm-ui, le Worker construit l'apercu de la story avec l'emulateur (`../ui-emulator`, `npm ci` une fois) et l'envoie au Host ; si la story echoue ou s'affiche vide, l'IA est relancee **une fois** avec l'erreur (`fixRounds`). Le plugin `../ui-framework/plugin` (skill `rpm-ui`) est charge a chaque requete (`--plugin-dir`). Le Worker annonce l'outil « Apercus UI » quand l'emulateur est installe. Details : [`../ui-framework/README.md`](../ui-framework/README.md).
## Configuration : `worker/.env`

Ecrit par le bouton *Jumeler* (voir `.env.example`), modifiable a la main :

```
RPM_HOST_URL=http://localhost:3000
RPM_WORKER_TOKEN=rpmw_...
RPM_UI_PORT=4180        # facultatif
RPM_WORKSPACE_DIR=C:/Users/toi/RPM-Workspace   # depots git (voir plus haut)
```

Le fichier contient le jeton : il est ignore par git, ne le partage pas. Le Worker se reconnecte seul (delai exponentiel) si la connexion tombe, et s'arrete si
le Host refuse son jeton (invalide, regenere, Worker supprime ou autre machine connectee avec le meme jeton).

## Securite de la page locale

Ecoute sur `127.0.0.1` uniquement ; refuse tout autre nom d'hote (anti « DNS rebinding »), toute autre origine et toute requete sans jeton CSRF ; le jeton du Worker
n'est jamais renvoye dans une page.

## Taches

Les gestionnaires sont dans `src/jobs.ts` : `echo` (renvoie sa charge) et `sleep` (attend `ms`, annulable). Le protocole (`src/protocol.ts`) est une copie de
`host/src/worker-protocol.ts` : le garder identique (c'est aussi la qu'est decode le code de jumelage). Tests : `npm test`.
