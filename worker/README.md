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

`RPM_WORKSPACE_DIR` (dans `.env`, ou champ *Espace de travail* de la page locale) est le dossier ou les depots sont clones : **un depot = un sous-dossier direct**, designe par son nom.
Taches git disponibles : `git.clone`, `git.branch` (cree et s'y place), `git.checkout`, `git.pull` (fast-forward uniquement), `git.push` (jamais force), `git.status`.
Securite : aucun shell, chaque argument est valide (noms de dossier et de branche, URL https/ssh sans identifiants), aucun depot hors de l'espace de travail (liens symboliques compris).
Authentification : par defaut celle de la machine (gestionnaire d'identifiants git, cles ssh) ; le Host peut aussi fournir un `token` GitHub dans la tache : transmis par variables
d'environnement (jamais en argument ni dans `.git/config`), limite a github.com, et masque dans les journaux.

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
