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

## Projets

Un projet = un **groupe Roblox** (identifiant + nom, facultatifs), un **depot GitHub** et des **experiences** :
une **Release**, un **Dev** (une seule de chaque) et autant de **Bench** (places jetables, nommees « Bench 1 », « Bench 2 »… par defaut).
Les experiences se creent a la main sur Roblox (l'Open Cloud ne permet pas de les creer) puis s'enregistrent ici (identifiants d'univers et de place).

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
