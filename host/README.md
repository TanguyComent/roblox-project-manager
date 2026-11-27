# host

Site web du gestionnaire de projets Roblox. Premiere brique : **comptes** (inscription, connexion, authentification a deux facteurs, deconnexion).

## Lancer

```powershell
cd host
npm ci
npm start          # http://127.0.0.1:3000
npm test           # tests de bout en bout (base en memoire)
npm run typecheck
```

Node 24+ (TypeScript execute directement, base SQLite integree `node:sqlite`). Configuration : copier `.env.example` en `.env`.

## Fonctionnement

- **Premier compte** : `/register` n'est ouvert que tant qu'aucun compte n'existe (ou avec `ALLOW_SIGNUP=true`).
- **A2F obligatoire** (TOTP, compatible Google Authenticator / 1Password / Authy) : apres l'inscription, QR code + code de confirmation,
  puis 10 codes de secours a usage unique (affiches une seule fois, stockes haches).
- **Connexion** : e-mail + mot de passe, puis code A2F (ou code de secours). Un code TOTP ne peut servir qu'une fois (anti-rejeu).
- **Deconnexion** : detruit la session cote serveur ; « Deconnecter tous les autres appareils » sur l'accueil.

## Comptes Roblox

Chaque utilisateur connecte **un ou plusieurs comptes Roblox** depuis *Compte → Comptes Roblox*. Un compte = une **cle d'API Open Cloud** collee dans le site
(rien a configurer sur l'instance : pas d'application OAuth, pas de `.env`).

- **Pourquoi des cles d'API et pas OAuth** : une cle agit au nom de son proprietaire et couvre **toutes ses experiences, y compris celles creees
  plus tard** (si « Restrict by Experience » est desactive), alors qu'un jeton OAuth ne couvre que les experiences cochees une par une sur l'ecran
  d'autorisation. De plus la **publication d'un fichier de place** n'accepte que les cles d'API. Les cles servent aussi pour les game passes, produits
  developpeur, badges, data stores… (selon les permissions donnees a la cle).
- **Creer une cle** : <https://create.roblox.com/dashboard/credentials> → *Create API Key*, ajouter les permissions voulues (par ex. `universe-places`
  en ecriture), laisser « Restrict by Experience » desactive, eviter les restrictions d'adresse IP, copier la cle (Roblox ne l'affiche qu'une fois).
  Pour un groupe : cle generee par un compte membre du groupe (Roblox conseille un compte dedie).
- **Verification** : a la connexion, la cle est inspectee chez Roblox (`POST /api-keys/v1/introspect`) : valide, activee, non expiree ; on en tire le
  compte proprietaire, ses permissions et sa date d'expiration. Une cle desactivee, expiree ou inconnue est refusee. « Verifier » relit ces informations ;
  si Roblox ne reconnait plus la cle (supprimee, regeneree, inutilisee 60 jours), le compte passe en **« cle invalide »** et se remet en etat en collant une
  nouvelle cle (« Changer la cle », meme compte Roblox obligatoire). Une cle qui expire dans moins de 14 jours est signalee.
- **Securite** : la cle est **chiffree en base** (AES-256-GCM), jamais reaffichee ni journalisee ; seul son hash sert a detecter les doublons.
  Un compte utilise par un projet ne peut pas etre deconnecte (supprimer la cle chez Roblox reste a faire dans le Creator Dashboard).

## Projets

Un projet = un **compte Roblox** (obligatoire, choisi parmi ceux connectes), un **groupe Roblox** (facultatif, **verifie** : le proprietaire de la cle doit en
etre membre (`GET /cloud/v2/groups/-/memberships`) **et pouvoir y gerer des experiences** : le site lit la liste « groupes que tu peux gerer » de Roblox
(`GET /legacy-develop/v1/user/groups/canmanage`, qui demande la permission **`legacy-group:manage`** sur la cle — la seule permission « legacy » utile ici).
A defaut, il essaie de lire les permissions du role (`manageGroupUniverses`), mais Roblox ne les renvoie pas toujours (la reponse contient le nom du role et pas
ses permissions, meme avec `group:read`) ; si rien n'est lisible, le groupe est accepte « non verifie » avec un avertissement. Le nom du groupe est rempli
automatiquement. Les groupes sans droit de gestion sont **ecartes** des listes (page Compte : replies sous « N autres groupes » ; formulaire de projet et liste de
places : absents). La page Compte a un **« Diagnostic des groupes »** qui montre, groupe par groupe, ce que Roblox a repondu), un **depot GitHub** et des **experiences** :
une **Release**, un **Dev** (une seule de chaque) et autant de **Bench** (places jetables, nommees « Bench 1 », « Bench 2 »… par defaut).

- **Formulaire en cascade** : *compte Roblox → groupe → places*. Le **groupe** se choisit dans un **menu** (les groupes ou le compte choisi peut gerer des experiences, ou
  « Aucun groupe (experiences personnelles) ») ; une saisie manuelle reste possible si la liste est indisponible. Les **places** proposees sont celles du compte **et du
  groupe choisis** (sans groupe : les experiences personnelles). Le filtrage en direct est fait par un petit script (`public/app.js`, servi par le site, CSP `script-src 'self'`,
  aucun script en ligne) ; sans JavaScript tout reste visible, et le **serveur verifie dans tous les cas** que le groupe appartient au compte et que l'experience appartient au
  groupe du projet (quand Roblox indique son proprietaire). Le nom du groupe est celui de Roblox (plus de champ a remplir).
- **Places** : a la creation, la Release et la Dev se choisissent dans la liste des **places connues** du compte, ou par identifiants saisis a la main ;
  elles sont **facultatives** (les places peuvent ne pas exister encore) et se renseignent ou se **changent** plus tard depuis la page du projet
  (« Changer la place »). Chaque place est **verifiee chez Roblox avec la cle du compte** (l'experience existe, la place en fait partie : « introuvable » est
  refuse ; « impossible a savoir », par exemple cle sans permission de lecture, est accepte). Une place ne peut servir qu'une fois par projet.
- **Places connues** (pour la liste deroulante) : les experiences nommees par la cle (restriction par experience) et les experiences **publiques** de son proprietaire et
  de ses groupes. L'API ne liste pas les experiences privees : elles se saisissent par identifiants, et sont verifiees avec la cle — **sans nouvelle autorisation**
  pour une experience creee plus tard. Cache de 5 minutes.
- **Pas de creation automatique** : l'API Open Cloud de Roblox ne permet **pas** de creer une experience ou une place (verifie dans sa specification
  OpenAPI). On les cree dans Roblox Studio, puis on les rattache ici par leurs identifiants d'univers et de place.
- **Depot GitHub** : lier un depot existant, ou en **creer un a partir d'un template** (`POST /repos/{template}/generate`) avec **le compte
  GitHub de l'utilisateur** : chacun colle son propre jeton dans *Compte → GitHub* (jeton « fine-grained » : Administration + Contents en
  ecriture ; verifie aupres de GitHub, chiffre en base, jamais reaffiche). Dans *Compte → GitHub → Template par defaut*, il choisit son
  **depot template** dans la liste de ses depots (les depots marques « template » en premier) puis la **branche** du template ; le
  proprietaire des nouveaux depots se regle au meme endroit. Ces valeurs preremplissent le formulaire de creation (modifiables par projet).
  Rien de GitHub dans le `.env` : la configuration est par utilisateur.
- **Branche du template** : GitHub ne copie que la branche par defaut d'un template. Pour une autre branche, le depot est genere avec toutes
  les branches, la branche choisie devient la branche principale du **nouveau** depot et les autres y sont supprimees (le template n'est jamais
  modifie). Si GitHub refuse (permission Administration manquante…), le projet est quand meme cree avec un avertissement.
- Chaque projet appartient a un utilisateur : les autres ne le voient ni ne le modifient (404).
- Supprimer un projet ne touche ni au depot GitHub ni aux experiences Roblox.

Pages : `/projects`, `/projects/new`, `/projects/:id`, `/account`.

## Securite

- Mots de passe : scrypt (N=2^15) ; secrets A2F chiffres en AES-256-GCM (cle dans `DATA_DIR/secret.key` ou `HOST_SECRET_KEY`).
- Sessions : jeton aleatoire dans un cookie `HttpOnly`, `SameSite=Lax` (`Secure` + prefixe `__Host-` en HTTPS), seul son hash est en base ;
  la session change a chaque changement de niveau (pas de fixation). Etapes mot de passe / A2F limitees a 10 min.
- Limitation de debit : 5 echecs par e-mail et 30 tentatives par IP / 15 min ; 5 codes A2F faux detruisent la session.
- CSRF : controle de l'en-tete `Origin` sur toute requete qui modifie l'etat + jeton par session sur les formulaires authentifies.
- CSP stricte (aucun script), `X-Frame-Options: DENY`, `nosniff`. Derriere un reverse proxy : `TRUST_PROXY=true` et `PUBLIC_URL` en https.

## A venir

Worker (execution des agents, file de taches, routines), comptes IA, personnalisation du depot apres creation depuis le template
(nom, groupe, identifiants de places), partage d'un projet entre utilisateurs. Recuperation de compte (si le telephone et les codes de secours sont perdus : pour l'instant il faut passer par la base), changement de mot de passe,
envoi d'e-mails, gestion de plusieurs utilisateurs.

## Workers

Un **Worker** est une machine (ton PC, un Mac mini…) qui execute les taches pour le Host. Page **Workers** du site : creer un Worker (son jeton n'est
affiche qu'une fois, stocke uniquement hache), le ranger dans un **pool**, lui envoyer une tache d'essai, suivre et annuler les taches.

- **Connexion sortante** : le Worker ouvre lui-meme un WebSocket vers `/ws/worker` (rien a exposer sur sa machine). Premier message `hello` avec le jeton ;
  jeton invalide / revoque / Worker remplace → fermeture 4401 / 4403 / 4409 et le Worker ne reessaie pas.
- **Distribution** : file par utilisateur, dans l'ordre ; un Worker execute une tache a la fois ; une tache peut viser un Worker ou un pool (le premier libre la prend).
  Un Worker ne recoit **jamais** les taches d'un autre utilisateur. Deconnexion pendant une tache → tache en echec ; annulation d'une tache en attente ou en cours.
- Pour l'instant seules les taches d'essai `echo` et `sleep` existent (`src/worker-protocol.ts`).
- Derriere un reverse proxy, faire suivre les « Upgrade » WebSocket vers `/ws/worker`.

Voir [`../worker/README.md`](../worker/README.md) pour lancer un Worker.

## Chats IA

Chaque projet a ses **chats IA** (page *Projets > un projet > Chats IA*) : creer, ouvrir, renommer, supprimer. Un chat est cree **sans branche ni depot** : il travaille dans un **atelier** (dossier libre sur le Worker,
copie du depot de maquette choisi dans Compte > GitHub, jamais pousse) et l'IA ne touche au projet que **si elle doit le modifier** : elle ouvre alors elle-meme la branche du chat (`ai/chat-<n>-<titre>`) par un
outil du Worker. Envoyer un message cree une tache `ai.chat` pour un de tes Workers qui a **Git et Claude Code** (outils detectes, voir ci-dessus) ; le Worker lance `claude -p` dans l'atelier et renvoie la reponse,
les commits et le diff de la branche (s'il y en a une), que le Host **stocke** dans le chat. Les messages suivants retournent sur le meme Worker et reprennent la meme conversation ; si ce Worker est supprime,
un autre prend le relais (nouvelle conversation, meme branche : le travail pousse est retrouve). Details du fonctionnement et des outils de l'IA : [`../ui-framework/README.md`](../ui-framework/README.md).

- Un projet **sans depot GitHub** marche aussi (l'IA n'a que son atelier) ; sinon le depot est clone par le Worker avec l'authentification de la machine (gestionnaire d'identifiants git ou cle ssh), a la premiere demande de l'IA.
- Une reponse a la fois par chat ; elle peut etre annulee (le processus Claude est arrete). Supprimer un chat arrete sa reponse en cours ; sa branche (si elle a ete ouverte) reste sur GitHub, son atelier est nettoye sur le Worker apres 30 jours d'inactivite.
- Une tache peut exiger des outils (`requires`) : elle ne part que sur un Worker qui les a, et attend sinon (un outil detecte plus tard la debloque).
- Les reponses de l'IA sont rendues en Markdown **echappe** (jamais de HTML venant de l'IA) ; une page de chat ne contient aucun script en ligne (CSP stricte).
- **Interface** (dans l'esprit de Claude Code) : liste des chats a gauche avec une pastille par chat (en cours, en attente d'un Worker, reponse non lue, echec), conversation a droite avec
  l'**activite de l'IA** en direct (pensee quand le modele en produit une, lecture / ecriture de fichiers, commandes), choix du **modele** et de l'**effort** par chat, titre et branche deduits
  du premier message. La page se met a jour sans rechargement (interrogation de `/projects/:id/chats/:cid/live`, `public/chat.js`) ; Entree envoie, Maj+Entree passe a la ligne.

### Apercus d'interface et maquettes

L'IA peut **montrer une interface** : elle termine sa reponse par un bloc ```rpm-ui (format et trajet complets dans [`../ui-framework/README.md`](../ui-framework/README.md)). Le Worker construit l'apercu de la story avec l'emulateur et l'envoie au Host (`POST /api/worker/previews`, jeton du Worker) ; le chat l'affiche, **interactif**, dans un `<iframe sandbox="allow-scripts">` sans `allow-same-origin` (voir `src/preview-routes.ts` pour le modele de securite). Les paquets sont stockes dans `DATA_DIR/previews/` et supprimes avec le chat ; quotas : 12 Mo par apercu, 500 Mo par utilisateur.

Les **concepts** (idees, maquettes, UI de zero) se font dans l'atelier du chat, avec de fausses donnees : l'IA les montre (carte etiquetee « Atelier »), puis **attend ta validation** avant de les integrer au projet. Si tu lui demandes directement de coder ou de modifier quelque chose, elle ouvre sa branche sans rien demander. Le **depot de maquette** se choisit dans Compte > GitHub > « Depot de maquette UI » (depot puis branche parmi ceux du compte connecte, comme le template des nouveaux projets) ; `UI_TEMPLATE_REPO` (facultatif, aucun par defaut) fournit un depot par defaut a l'echelle de l'instance. Sans depot de maquette l'atelier est vide. Le jeton GitHub n'est jamais envoye au Worker : il clone avec les identifiants git de sa machine.

**Fichiers joints** : le trombone du composeur (ou glisser-deposer, ou Ctrl+V pour une capture d'ecran) joint images, PDF, CSV, texte, etc. a un message. Chaque fichier est televerse avant l'envoi (progression, retrait par la croix), puis le Worker le telecharge dans le dossier `_uploads` de l'atelier et l'IA le lit avec `Read` (images vues directement, PDF compris). Le type est deduit des **octets** (jamais du nom) ; executables et scripts (`.exe`, `.bat`, `.sh`, `.ps1`, binaires ELF/PE/Mach-O, `#!`...) sont refuses ; seules les images PNG/JPEG/WebP/GIF verifiees s'affichent en ligne (SVG et le reste : telechargement, sous CSP `sandbox`). Les fichiers n'appartiennent qu'a leur proprietaire ; un Worker ne peut telecharger que ceux cites par sa tache en cours. Limites (variables `ATTACH_MAX_FILE_MB`=20, `ATTACH_MAX_PER_MESSAGE`=10, `ATTACH_MAX_MESSAGE_MB`=50, `ATTACH_USER_QUOTA_MB`=1024) ; stockes dans `DATA_DIR/attachments`, supprimes avec le chat, et ceux jamais envoyes sont purges apres 24 h. L'IA ne peut pas copier un fichier binaire dans le projet (pas de shell).

**Bibliotheque d'images** (menu « Bibliotheque ») : chaque utilisateur a sa bibliotheque ; le **Host en est la source de verite** (fichiers dans `DATA_DIR/library`, metadonnees en base). Une image ajoutee (bouton, glisser-deposer ou Ctrl+V ; PNG, JPEG, WebP, GIF verifies par leurs octets, pas de SVG) est **« en attente »** : visible, pas rangee. Le bouton **Trier** envoie toutes les images en attente (40 au plus par tache) a un agent Claude sur un Worker (tache `library.sort`) : pour chacune il choisit un dossier du vault, un nom, une courte description et des mots-cles, en reutilisant l'organisation existante. Le Worker reconstruit un petit vault Obsidian (`vault/<dossier>/<nom>.md`) pour que l'agent voie l'existant, lui donne des droits minimaux (lire / ecrire des fichiers, ni shell, ni reseau, ni outil MCP) et renvoie son `result.json` ; le Host **revalide tout** (dossiers, noms, descriptions, mots-cles) avant d'enregistrer. Une image sans description valable reste en attente ; un echec ou une annulation remettent les images en attente. Nom, dossier, description et mots-cles se corrigent a la main (« Modifier »). Limites : `LIBRARY_MAX_FILE_MB`=10, `LIBRARY_MAX_IMAGES`=2000, `LIBRARY_QUOTA_MB`=500. **Packs (archives ZIP)** : « Ajouter des images ou un pack (.zip) » accepte une archive entiere (`LIBRARY_MAX_ZIP_MB`=300 Mo, `LIBRARY_MAX_ZIP_ENTRIES`=20000 fichiers). Le **Host** la lit lui-meme (lecteur ZIP sans dependance, l'archive reste sur le disque et chaque fichier est lu a la demande) : tout ce qui n'est pas une image PNG / JPEG / WebP / GIF (textes, PSD, SVG, programmes, dossiers...) est **ignore et jamais conserve** ; chaque image est verifiee par ses octets comme un ajout normal, un doublon exact d'une image deja presente est ecarte, et un bilan s'affiche (ajoutees, doublons, ignores, refusees). Les noms d'entrees ne servent jamais de chemin de fichier (pas de « zip slip ») ; la decompression est bornee a la taille declaree, le CRC est verifie, les archives chiffrees ou ZIP64 sont refusees. Le nom de l'archive devient la **provenance** des images et leur dossier interne un **indice de classement** pour l'agent. Le bouton **Trier** a cote d'un champ **nombre d'images** (par defaut 80 ; vide = toutes) traite ensuite ce nombre d'images en attente, **par lots de 40** enchaines automatiquement (le champ affiche une estimation du cout ; il reste des images en attente pour un autre tri plus tard) (un lot sans progres arrete la chaine ; « Annuler le tri » arrete tout) : un gros pack represente donc beaucoup d'appels a Claude (compte environ 0,15 $ par lot).

**Deux vues** : la page se divise en **Triees** (regroupees par scope, style ou sujet ; recherche IA, reglage de publication, publication manuelle) et **En attente** (images pas encore decrites ; bouton Trier et champ du nombre d'images). Les formulaires reviennent a la vue d'ou ils viennent ; sans image triee, la page s'ouvre sur « En attente ».

**Vue de base** : la grille ne montre que les images (vignettes serrees, le nom en infobulle) ; toute la gestion se fait dans la fenetre d'une image. **Fenetre d'une image** (s'ouvre avec un leger zoom, desactive si le systeme demande moins d'animations) : un clic sur une miniature (grille ou resultats de la recherche IA) ouvre une fenetre avec l'image en grand et toutes ses informations (scope, style et traits, sujet, couleurs, mots-cles, dimensions et ratio, format, provenance, dossier d'origine, dates). Si l'image n'est pas encore sur Roblox, un bouton **Uploader sur Roblox** (avec le choix du compte ou du groupe) l'envoie sans recharger la page ; une fois publiee, l'identifiant `rbxassetid://` s'affiche avec un bouton Copier, et un envoi en moderation ou en echec est explique. Elle permet aussi de **modifier** toutes les informations et de **supprimer** l'image (avec confirmation). Ctrl+clic ouvre toujours l'image dans un nouvel onglet. **Recherche par description** (vue Triees uniquement) : tu decris l'image que tu cherches en une phrase (« une petite icone d'epee rouge, style cartoon ») ; une IA (tache `library.find`, Claude sur un Worker) parcourt tes images **triees** avec les outils `library_search` (plusieurs essais : synonymes, francais et anglais, filtres) et `library_get` (elle regarde les meilleurs candidats), puis renvoie les images les plus proches avec la raison. Le Host **revalide** les resultats (seulement tes images triees, sans doublon, 12 au plus). Elle n'a d'autres droits que ces deux outils et l'ecriture de son fichier resultat (ni shell, ni reseau, ni publication) ; une seule recherche a la fois ; compte quelques dizaines de secondes et environ 0,15 $ par recherche. La recherche « Filtrer par mots » reste, elle, instantanee et sans IA.

**Affichage** : la page ne charge qu'**une page de 48 images** a la fois (pagination), avec une recherche (nom, sujet, style, couleur, mot-cle, provenance) ; les fichiers sont servis avec un cache navigateur long. Pas de miniatures reduites pour l'instant : le Host n'a pas de decodeur d'images (l'ajouter demanderait une bibliotheque comme `sharp`). **Facettes** : l'agent decrit chaque image par **scope** (dans quelle situation on s'en sert : icon, decoration, background, button... ; il donne aussi le dossier du vault), **style** (un nom reutilise d'une image a l'autre, defini une seule fois, plus des **traits** pris dans un petit vocabulaire : cartoon, contours-epais, saturee...), **sujet** (ce que l'image represente, normalise : pendule, poubelle), **couleurs**, **mini-description** et **mots-cles** (francais et anglais). Le ratio et les dimensions sont lus dans les octets du fichier (carre, large, haut, bandeau). Il n'y a pas de series : des images de packs ou generees par IA se rejoignent par le style (traits communs), pas par une etiquette de pack (la provenance reste une simple information). La page se regroupe **par scope, par style ou par sujet** (trois visions de la meme bibliotheque) et permet de renommer ou fusionner un scope, un style ou un sujet sur toutes les images. **Utilisation par les agents d'UI** : deux outils (`library_search`, `library_get`) leur permettent de chercher une image par quelques mots, puis de la recuperer dans l'atelier ; ils recoivent la reference a ecrire dans `Image` (`rbxassetid://<id>` si l'image est publiee sur Roblox, sinon `rbxlib://<id>`, provisoire). L'emulateur d'UI affiche alors la vraie image dans les apercus (`ui-emulator/tools/preview.mjs --images`). Un Worker ne peut lire que le catalogue trie de son utilisateur, et seulement pendant qu'il execute un chat. **Publication sur Roblox** : le **Host** publie (API Assets d'Open Cloud, asset de type Image, dont l'identifiant sert directement dans les proprietes d'image) ; la cle d'API ne quitte jamais le Host et doit avoir la permission `asset:write`. Roblox examine l'image de facon asynchrone : etats non publiee, en cours (moderation), publiee (`rbxassetid://<id>`) ou en echec (refusee par la moderation, format, permission...). Seuls PNG et JPEG se publient (limite Roblox : 20 Mo, moins de 8000x8000 px) ; pas de quota mensuel annonce par Roblox pour les images (les quotas de la doc concernent l'audio et la video). Deux images de meme contenu partagent le meme asset. Le proprietaire est le **groupe du projet** s'il en a un, sinon le compte Roblox lie au projet. Qui declenche : (1) **l'IA, a l'integration d'un concept valide** dans le projet (outil `library_publish` : le Worker verifie que la branche est ouverte et que l'image est referencee dans le code, le Host que le chat tourne, que le projet a un compte, et que le reglage « Publier automatiquement » est actif ; il remplace lui-meme les `rbxlib://` par les `rbxassetid://` dans le code) ; (2) **toi**, avec le bouton « Publier sur Roblox » de chaque image (compte ou groupe au choix). Les images generees par IA et le reglage desactive passent toujours par ta confirmation (bouton). Chaque image publiee garde qui l'a publiee (chat ou manuel). A venir : entree des images generees validees.
