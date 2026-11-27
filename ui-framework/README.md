# ui-framework

Premiere brique « UI » de la plateforme : **une IA construit une interface Roblox et te la montre, interactive, dans le chat.**

```
ui-framework/
  plugin/                      plugin Claude Code charge par le Worker (--plugin-dir) a chaque requete IA
    .claude-plugin/plugin.json
    skills/rpm-ui/SKILL.md     le skill : comment construire une UI avec les composants du depot, et comment l'afficher
```

Le skill ne duplique pas le catalogue de composants : il renvoie l'IA vers `src/client/UI/CLAUDE.md` du depot (consignes d'UI, composants prefaits, gabarit de story) et lui apprend le **format d'affichage**.

## Comment un chat travaille : atelier, projet, branche

Un chat est cree **sans branche ni depot**. Au premier message le Worker lui donne un **atelier** : un dossier libre, copie du depot de maquette choisi dans Compte > GitHub (sans lien vers GitHub : rien n'en part). C'est le dossier de travail de la conversation Claude (il ne change jamais, pour que `--resume` retrouve la conversation). Le projet (depot GitHub) est atteint **a la demande de l'IA**, par deux outils que le Worker lui fournit :

| Outil | Role |
|---|---|
| `ui_preview(file, root, viewport)` | **la « photo »** : rend la story et renvoie a l'IA une capture (image), les erreurs et les modules remplaces. Elle verifie ce qu'elle construit avant de repondre. |
| `project(action)` | `read` : copie en LECTURE SEULE de la branche principale (remise a zero apres chaque tour) ; `open_branch` : cree la branche de travail du chat et son dossier ; commit, diff et push sont alors automatiques. |

Ces outils sont un petit serveur MCP (HTTP, `127.0.0.1`, jeton secret par tache) dans le processus du Worker ; Claude est lance avec `--strict-mcp-config` : il n'a **que** ces outils (pas les connecteurs personnels de la machine).

L'IA decide (regles dans le contexte envoye a chaque requete et dans le skill `rpm-ui`) :
- **question, discussion** : elle repond, rien n'est cree ;
- **« code / modifie X »** : elle ouvre la branche immediatement, sans demander la permission, implemente, verifie, montre ;
- **concept, maquette, UI de zero** : elle le construit dans l'atelier avec de fausses donnees, le verifie par capture, le montre, puis **s'arrete et attend ta validation** avant d'integrer quoi que ce soit au projet ;
- **concept valide** : elle ouvre la branche, l'integre avec les vrais composants et les vraies donnees, verifie, montre.

## Le format : le bloc `rpm-ui`

A la fin de sa reponse, l'IA ecrit :

````
```rpm-ui
{"file": "src/client/UI/gui/shop/shop.story.tsx", "root": "sandbox", "viewport": "Telephone", "title": "Boutique (concept)"}
```
````

| Champ | Role |
|---|---|
| `file` (obligatoire) | story `*.story.tsx`, chemin depuis la racine du depot (de l'atelier ou du projet selon `root`) |
| `root` | `project` (defaut) ou `sandbox` (l'atelier : concept, fausses donnees) |
| `viewport` | `UI Labs` (defaut), `Desktop`, `Tablette`, `Telephone` |
| `title` | titre de la carte (80 caracteres) |

Six blocs au maximum par reponse. Seuls les blocs de code de **premier niveau** comptent : un exemple de bloc `rpm-ui` a l'interieur d'un autre bloc de code est du texte (meme regle cote Worker, `worker/src/preview.ts`, et cote Host, `host/src/markdown.ts`, pour que les deux numerotent les apercus de la meme facon).

## Le trajet d'un apercu

1. **IA** (Claude Code, sur le Worker) : construit, **verifie par capture** (`ui_preview`), termine sa reponse par le bloc.
2. **Worker** (`worker/src/preview.ts`) : lit les blocs, appelle `ui-emulator/tools/preview.mjs` par story : construction statique de l'emulateur (moins d'une seconde, ~90 Ko compresses), rendu dans un navigateur sans fenetre (Edge/Chrome) pour controler erreurs et modules manquants, vignette. Aucun fichier du projet n'est copie dans le paquet. Si une story echoue (ou s'affiche vide), **une passe de correction automatique** reprend la meme conversation avec l'erreur.
3. **Envoi** : `POST /api/worker/previews` (jeton du Worker) ; le Host verifie tout (chemins, extensions, tailles, la tache doit etre la tache en cours de ce Worker) et stocke le paquet (`DATA_DIR/previews/<id>/`).
4. **Chat** : le bloc est remplace par une carte avec l'apercu dans un `<iframe sandbox="allow-scripts">` (etiquete « Atelier » pour un concept). L'apercu est fige sur sa reponse : l'historique du chat garde ce que l'IA a montre a chaque etape.

Les modules du jeu non pris en charge (reseau, services Roblox rares) sont remplaces par des modules « fantomes » : l'apercu s'affiche quand meme. L'emulateur lit le depot **en place** (lecture seule, sans `node_modules`).

## Securite

Un apercu est du JavaScript ecrit par une IA, execute dans ton navigateur : cadre isole **sans** `allow-same-origin` (origine opaque : ni cookies, ni session, ni acces au site ou a ses API), politique CSP propre (`connect-src 'none'`, `sandbox allow-scripts`), adresse a 128 bits aleatoires (les requetes d'un cadre isole ne portent pas de cookie : l'adresse est la cle), quotas (6 Mo par fichier, 12 Mo par apercu, 500 Mo par utilisateur).

## Prerequis sur le Worker

`npm ci` dans `ui-emulator/` (le Worker annonce alors l'outil « Apercus UI » au Host) ; un Edge ou Chrome pour le controle automatique (facultatif : sans navigateur, l'apercu est livre sans controle ni vignette).
