# ui-framework

Premiere brique « UI » de la plateforme : **une IA construit une interface Roblox et te la montre, interactive, dans le chat.**

```
ui-framework/
  plugin/                      plugin Claude Code charge par le Worker (--plugin-dir) a chaque requete IA
    .claude-plugin/plugin.json
    skills/rpm-ui/SKILL.md     le skill : comment construire une UI avec les composants du depot, et comment l'afficher
```

Le skill ne duplique pas le catalogue de composants : il renvoie l'IA vers `src/client/UI/CLAUDE.md` du depot (consignes d'UI, composants prefaits, gabarit de story) et lui apprend le **format d'affichage**.

## Le format : le bloc `rpm-ui`

A la fin de sa reponse, l'IA ecrit :

````
```rpm-ui
{"file": "src/client/UI/gui/shop/shop.story.tsx", "viewport": "Telephone", "title": "Boutique"}
```
````

| Champ | Role |
|---|---|
| `file` (obligatoire) | story `*.story.tsx` du depot, chemin depuis sa racine |
| `viewport` | `UI Labs` (defaut), `Desktop`, `Tablette`, `Telephone` |
| `title` | titre de la carte (80 caracteres) |

Six blocs au maximum par reponse. Seuls les blocs de code de **premier niveau** comptent : un exemple de bloc `rpm-ui` a l'interieur d'un autre bloc de code est du texte (meme regle cote Worker, `worker/src/preview.ts`, et cote Host, `host/src/markdown.ts`, pour que les deux numerotent les apercus de la meme facon).

## Le trajet d'un apercu

1. **IA** (Claude Code, sur le Worker) : ecrit/modifie la story, la commite, termine sa reponse par le bloc.
2. **Worker** (`worker/src/preview.ts`) : lit les blocs, appelle `ui-emulator/tools/preview.mjs` par story : construction statique de l'emulateur sur la branche du chat (moins d'une seconde, ~90 Ko compresses), rendu dans un navigateur sans fenetre (Edge/Chrome) pour controler erreurs et modules manquants, vignette. Aucun fichier du projet n'est copie dans le paquet. Si une story echoue (ou s'affiche vide), **une passe de correction automatique** reprend la meme conversation avec l'erreur.
3. **Envoi** : `POST /api/worker/previews` (jeton du Worker) ; le Host verifie tout (chemins, extensions, tailles, la tache doit etre la tache en cours de ce Worker) et stocke le paquet (`DATA_DIR/previews/<id>/`).
4. **Chat** : le bloc est remplace par une carte avec l'apercu dans un `<iframe sandbox="allow-scripts">`. L'apercu est fige sur sa reponse : l'historique du chat garde ce que l'IA a montre a chaque etape.

## Deux situations

- **UI d'un projet** : le Worker a deja tout le depot dans le dossier de travail de la branche ; l'emulateur le lit **en place** (lecture seule, sans `node_modules`). Les modules du jeu non pris en charge (reseau, services Roblox rares) sont remplaces par des modules « fantomes » : l'apercu s'affiche quand meme.
- **Maquette (chat « Maquette UI »)** : le chat part du **depot de maquette que tu choisis dans Compte > GitHub** (depot et branche de ton compte GitHub connecte : un kit minimal de composants, sans le reste d'un jeu), clone dans un dossier propre au chat et **jamais pousse**. L'IA remplit tout avec de fausses donnees.

## Securite

Un apercu est du JavaScript ecrit par une IA, execute dans ton navigateur : cadre isole **sans** `allow-same-origin` (origine opaque : ni cookies, ni session, ni acces au site ou a ses API), politique CSP propre (`connect-src 'none'`, `sandbox allow-scripts`), adresse a 128 bits aleatoires (les requetes d'un cadre isole ne portent pas de cookie : l'adresse est la cle), quotas (6 Mo par fichier, 12 Mo par apercu, 500 Mo par utilisateur).

## Prerequis sur le Worker

`npm ci` dans `ui-emulator/` (le Worker annonce alors l'outil « Apercus UI » au Host) ; un Edge ou Chrome pour le controle automatique (facultatif : sans navigateur, l'apercu est livre sans controle ni vignette).
