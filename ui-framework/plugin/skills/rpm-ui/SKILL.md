---
name: rpm-ui
description: Construire ou modifier une interface Roblox (React / roblox-ts, stories UI Labs) et la MONTRER a l'utilisateur dans le chat sous forme d'apercu interactif. A utiliser des que l'utilisateur demande de creer, modifier, montrer ou imaginer une UI, un ecran, un HUD, une fenetre, une maquette ou un concept d'interface.
---

# Construire une UI et la montrer dans le chat

L'utilisateur ne voit PAS ton code dans le chat : il voit ce que tu affiches. Pour montrer une interface, tu ecris une **story**, tu la commites, puis tu la designes dans un bloc `rpm-ui` a la fin de ta reponse. Le chat construit alors un apercu **interactif** (clics, survols, glisser, defilement, controles de la story).

## 1. Le format d'affichage : le bloc `rpm-ui`

Termine ta reponse par un bloc de code dont la langue est `rpm-ui`, contenant un objet JSON :

````
```rpm-ui
{"file": "src/client/UI/gui/shop/shop.story.tsx", "viewport": "Telephone", "title": "Boutique"}
```
````

| Champ | Obligatoire | Role |
|---|---|---|
| `file` | oui | Chemin de la story **depuis la racine du depot**, avec `/`. Doit se terminer par `.story.tsx` (ou `.story.ts`) et exister. |
| `viewport` | non | Format d'ecran : `UI Labs` (960×480, par defaut), `Desktop` (1280×720), `Tablette` (820×1180), `Telephone` (390×844). |
| `title` | non | Titre affiche au-dessus de l'apercu (80 caracteres). |

Regles :
- **Un bloc par apercu**, 6 au maximum par reponse. Plusieurs blocs = plusieurs ecrans ou plusieurs formats (par exemple la meme story en `Desktop` puis en `Telephone` pour comparer).
- Le bloc va **apres** ton texte, jamais a l'interieur d'un autre bloc de code. Pour *expliquer* le format sans l'utiliser, mets-le dans un bloc ```` ```markdown ```` : il n'est alors pas interprete.
- La story doit etre **dans le depot** et son contenu **deja ecrit** (sauvegarde sur le disque) quand tu repondras : l'apercu est construit apres ta reponse, a partir des fichiers.
- Ne decris pas l'apercu comme s'il etait deja visible avant d'avoir mis le bloc ; dis ce que l'utilisateur va voir et ce qu'il peut essayer (cliquer tel bouton, faire varier tel controle).
- Si l'apercu echoue, tu recevras un message « [Retour automatique] » avec l'erreur : corrige la story ou les composants, puis remets le bloc. Une seule passe de correction est faite : prends-la au serieux.

## 2. Construire l'interface

1. **Lis `src/client/UI/CLAUDE.md`** (consignes d'UI du depot : catalogue des composants prefaits, regles de mise en page, effets, gabarit de story). Il fait foi. Parcours aussi `src/client/UI/components/` : compose les composants existants (`Button`, `Wrapper`, `ScaledOffsetWrapper`, `BaseInterface`, effets de survol / clic...) plutot que de tout reecrire.
2. **Mise en page** : `uilistlayout` / `uigridlayout` dans un conteneur (`Wrapper`), jamais de positions calculees a la main pour une serie d'elements.
3. **Ecris la story** a cote de l'ecran (`<nom>.story.tsx`), au format UI Labs :

```tsx
import React from "@rbxts/react";
import ReactRoblox from "@rbxts/react-roblox";
import { Boolean, InferProps, Number } from "@rbxts/ui-labs";
import { EffectsProvider } from "client/UI/components/context/EffectsContext";
import { MyPanel } from "./components/MyPanel";

const controls = {
	count: Number(4, 0, 10, 1),
	soldOut: Boolean(false),
};

const story = {
	react: React,
	reactRoblox: ReactRoblox,
	controls: controls,
	story: (props: InferProps<typeof controls>) => (
		<EffectsProvider container={props.target}>
			<MyPanel count={props.controls.count} soldOut={props.controls.soldOut} onClose={() => {}} />
		</EffectsProvider>
	),
};

export = story;
```

   - Expose en `controls` ce qui change l'apparence (nombres, interrupteurs, etats « vide » / « epuise ») : l'utilisateur pourra les manipuler dans l'apercu.
   - Callbacks : fonctions vides `() => {}`. Enveloppe dans `<EffectsProvider container={props.target}>`, sinon les effets echouent.
4. **Donnees** : tout ce que l'ecran affiche vient de **props ou de controles avec de fausses valeurs plausibles** (noms, prix, listes, pourcentages). Ne cherche jamais de donnees de jeu reelles : un `Player`, un controleur Flamework ou un etat serveur n'existent pas dans l'apercu. Si l'ecran en depend, separe-le en un composant de presentation (props seulement) et un fin conteneur qui lit les donnees reelles ; la story montre le composant de presentation.
5. **Commite** (`git add` / `git commit`) : l'apercu est construit sur le depot de ce chat.

## 3. Deux situations

- **Modifier une UI existante du projet** : trouve sa story (`*.story.tsx`) ; s'il n'y en a pas, cree-en une comme ci-dessus. Modifie l'UI, puis montre la story avec un bloc `rpm-ui`. Pour un avant/apres, commite d'abord, montre, puis modifie : un bloc par etat n'est possible que si les deux versions existent en meme temps (deux stories).
- **Maquette / concept art** (chat « Maquette UI ») : le depot est un modele minimal (kit de composants, rien de reel). Imagine l'interface librement, remplis tout avec de fausses donnees et cree ta story dans le dossier des interfaces. Rien n'est pousse sur GitHub.

## 4. Ce que l'apercu sait faire (et ne sait pas)

L'apercu est rendu par un emulateur du moteur d'interface de Roblox (`UDim2`, ancres, `UIListLayout`, `UIGridLayout`, `UIAspectRatioConstraint`, `UIScale`, `UICorner`, `UIStroke`, `UIGradient`, `AutomaticSize`, `ScrollingFrame`, tweens, effets, souris), sans Studio.

- Les images `rbxassetid://` s'affichent en **blocs hachures** : c'est normal, ne « corrige » pas ca. Decris l'image attendue dans ton texte.
- Les polices sont des remplacements ; **pas de 3D** (`ViewportFrame`, modeles) ; **pas de clavier ni de `TextBox`** ; pas de manette.
- Les modules du jeu non pris en charge (reseau, services Roblox rares) sont remplaces par des modules « fantomes » : l'apercu s'affiche quand meme. Seules les **erreurs** (exception, apercu vide) declenchent une correction.
- L'apercu n'est pas le jeu : il montre l'interface, pas la logique serveur.

## 5. Ta reponse

Court et utile : ce que tu as construit (composants utilises, controles disponibles), ce que l'utilisateur peut essayer, puis le(s) bloc(s) `rpm-ui`. Pas de code recopie dans le chat (il est dans le depot, l'utilisateur peut le voir dans les modifications).
