# ui-emulator

Émulateur d'interface Roblox dans le navigateur : il exécute le code **React / roblox-ts** d'un projet (les stories, au format UI Labs)
et le rend avec les règles de mise en page de Roblox (`UDim2`, ancres, `UIListLayout`, `UIGridLayout`, `UIAspectRatioConstraint`,
`UIScale`, `UICorner`, `UIStroke`, `UIGradient`, `AutomaticSize`, `ScrollingFrame`…), sans ouvrir Studio.

Le projet émulé est **lu en lecture seule** : rien n'y est jamais écrit, et son `node_modules` n'est pas utilisé
(les paquets `@rbxts/*` sont du Luau ; l'outil les remplace par des doublures JavaScript dans `src/shims`).

## Installation

```powershell
cd ui-emulator
npm ci
```

Prérequis : Node récent. Un Chrome ou Edge est nécessaire seulement pour les captures automatiques (`tools/cdp.mjs`).

## Lancer l'émulateur sur un projet

Chaque projet est décrit par un **profil** dans `profiles/*.json` :

| Champ | Rôle |
|---|---|
| `project` | racine du projet (chemin absolu, ou relatif au dossier `ui-emulator`) |
| `tsconfig` | `tsconfig.json` d'où lire `baseUrl`, `paths` et `rootDirs` |
| `storiesRoots` | dossiers où chercher les `*.story.tsx` (`dir`, et un `label` optionnel) |
| `ignore` | noms de dossiers à ignorer |
| `viewport` / `background` | taille d'aperçu (`UI Labs` = 960×480) et fond (`dots` = fond sombre à points) |
| `overrides` | fichiers du projet à remplacer par une doublure de `src/shims/project` |

```powershell
$env:RBX_PROFILE = 'giant-tower'      # ou 'dont-fish'
npx vite --host 127.0.0.1 --port 5175
```

Puis ouvrir `http://127.0.0.1:5175/` (ou `?story=<nom>` pour une story précise). Après modification d'un profil, redémarrer le serveur.

## Captures et interactions automatiques

`tools/cdp.mjs` pilote un Chrome/Edge sans fenêtre (protocole CDP, aucune dépendance). Variables : `EMU_URL` (adresse du serveur),
`EDGE` (chemin du navigateur), `EMU_DPR` (résolution des captures), `EMU_QS` (paramètres d'URL).

```powershell
$env:EMU_URL = 'http://127.0.0.1:5175'
node tools/cdp.mjs run --shots shots                       # rend toutes les stories + captures + bilan
node tools/cdp.mjs shot <story> fichier.png                # une story
node tools/cdp.mjs act <story> "@tools/acts/hud-click.json"   # rejoue des gestes de souris réels
node tools/cdp.mjs eval <story> "<js>"                     # évalue du JS dans la page (diagnostic)
node tools/cdp.mjs perf                                    # temps de rendu par story
```

## Architecture

- `src/rbx/` : le moteur — types Roblox, faux modèle d'`Instance`, signaux, `TweenService`, services, globales Luau.
- `src/shims/` : doublures des bibliothèques (`charm`, `react-charm`, `pretty-react-hooks`, `Janitor`…) et rendu React → `Instance` (`reactRoblox.ts`).
- `src/view/dom.ts` : projection des `Instance` vers le DOM (mise en page, texte, contours, entrées souris, défilement, glisser).
- `vite.config.ts` : résolution des alias du `tsconfig` et transformations roblox-ts → JS (`export =`, `.size()`, `task.wait` → `await`,
  `setmetatable` avec `__call`, spreads qui ignorent `undefined`, imports « fantômes » pour les modules non doublés).
- `main.tsx` : page de l'application (liste des stories, contrôles, tailles d'écran).

Les modules non doublés ne plantent pas : ils sont signalés dans le bilan (`missing`) pour qu'on écrive la doublure manquante.

## Limites connues

- Les images `rbxassetid` s'affichent en blocs hachurés ; les polices sont des remplacements ; pas de 3D (`ViewportFrame`, modèles).
- Pas de clavier, manette ni saisie de texte (`TextBox`).
- Les projets en Luau pur ne sont pas supportés : il faut du TypeScript (roblox-ts).
