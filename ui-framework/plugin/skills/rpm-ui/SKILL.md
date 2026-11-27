---
name: rpm-ui
description: Imaginer, construire ou modifier une interface Roblox (React / roblox-ts, stories UI Labs), VERIFIER son rendu par une capture, et la MONTRER a l'utilisateur dans le chat sous forme d'apercu interactif. A utiliser des que l'utilisateur parle d'une UI, d'un ecran, d'un HUD, d'une fenetre, d'une maquette, d'un concept ou d'un visuel d'interface.
---

# Imaginer, verifier et montrer une UI

L'utilisateur ne voit PAS ton code dans le chat : il voit ce que tu **montres**. Et toi, tu peux **voir** ce que tu construis : tu as un outil de capture. Travaille toujours en boucle : construire → capturer → corriger → montrer.

## 1. Ou tu travailles

| Lieu | Ce que c'est | Quand |
|---|---|---|
| **L'atelier** (ton dossier de travail) | Espace libre, copie du kit de composants du studio. Jamais pousse sur GitHub. | Discussion, idees, concepts, maquettes avec de fausses donnees. |
| **Le projet, en lecture** | Copie en lecture seule de la branche principale (outil `project`, action `read`). | Comprendre l'UI et les composants existants. Ne la modifie jamais. |
| **Le projet, sur sa branche** | Branche de travail du chat (outil `project`, action `open_branch`). Commit et push sont automatiques. | Quand tu dois vraiment modifier le projet. |

## 2. Tes outils

Pas de shell general (seul `git` est autorise) : lis avec `Read` / `Glob` / `Grep`, ecris avec `Write` / `Edit` (`Write` cree les dossiers manquants : inutile de faire `mkdir` ou `ls`).

- **`ui_preview(file, root?, viewport?)`** — prend une **capture** (image) du rendu d'une story et te la renvoie avec les erreurs. Regarde-la vraiment : alignements, debordements, textes coupes, couleurs, espacements, hierarchie visuelle. **Appelle-le apres chaque modification d'UI** et corrige tant que le rendu n'est pas bon. `root` : `sandbox` (l'atelier) ou `project` (le projet) ; `viewport` : `UI Labs` (defaut), `Desktop`, `Tablette`, `Telephone`.
- **`project(action)`** — `read` : lire le projet ; `open_branch` : ouvrir la branche de travail et obtenir son dossier (chemins absolus pour y ecrire).

## 3. Quoi faire selon la demande

1. **Question, discussion, analyse** → reponds. Ne cree ni branche ni fichier du projet.
2. **« Code / ajoute / modifie / corrige X dans le projet »** → ouvre la branche **tout de suite**, sans demander la permission (ne dis jamais « puis-je creer une branche ? »), implemente, verifie avec `ui_preview` (root `project`) si c'est une interface, puis montre le resultat.
3. **« Imagine / propose / fais-moi un concept, une maquette, une UI de zero »** → c'est un **concept** : construis-le dans l'atelier avec de **fausses donnees**, verifie-le avec `ui_preview` (root `sandbox`), montre-le, puis **ARRETE-TOI** et demande a l'utilisateur de le valider (ou de demander des changements). **N'ouvre pas la branche et n'implemente rien dans le projet avant sa validation.**
4. **Concept valide** (« ok », « c'est bon, integre-le », etc.) → ouvre la branche, **integre** le concept dans le projet : vrais composants, vraies donnees, memes conventions que le code existant (lis-le d'abord avec `read` si besoin). Verifie (`ui_preview`, root `project`), puis montre.

Si l'utilisateur te demande d'integrer **sans** concept prealable, ou de modifier un element existant : pas de validation a demander, tu agis (regle 2).

## 4. Le format d'affichage : le bloc `rpm-ui`

Pour montrer une interface, termine ta reponse par un bloc de code dont la langue est `rpm-ui`, contenant un objet JSON :

````
```rpm-ui
{"file": "src/client/UI/gui/shop/shop.story.tsx", "root": "sandbox", "viewport": "Telephone", "title": "Boutique (concept)"}
```
````

| Champ | Obligatoire | Role |
|---|---|---|
| `file` | oui | Chemin de la story depuis la racine du depot (**de l'atelier** si `root` est `sandbox`, du projet si `project`), avec `/`. Se termine par `.story.tsx` (ou `.story.ts`), le fichier doit exister. |
| `root` | non | `project` (defaut) ou `sandbox` (l'atelier). Un concept = `sandbox`. |
| `viewport` | non | `UI Labs` (960×480, defaut), `Desktop` (1280×720), `Tablette` (820×1180), `Telephone` (390×844). |
| `title` | non | Titre affiche au-dessus de l'apercu. |

Regles :
- **6 blocs au maximum** par reponse (un par ecran ou par format : la meme story en `Desktop` puis `Telephone`, par exemple).
- Le bloc va **apres** ton texte, jamais dans un autre bloc de code. Pour *expliquer* le format sans l'utiliser, mets-le dans un bloc ```` ```markdown ```` : il n'est alors pas interprete.
- La story doit **exister sur le disque** quand tu repondras (pas besoin de commit pour l'atelier).
- Montre l'apercu **apres** l'avoir verifie par capture. Dis ce que l'utilisateur voit et peut essayer (cliquer tel bouton, faire varier tel controle).
- Si un apercu echoue, tu recois « [Retour automatique] » avec l'erreur : corrige, verifie avec `ui_preview`, remets le bloc. Une seule passe de correction est faite.

## 5. Construire l'interface

1. **Lis `src/client/UI/CLAUDE.md`** (dans l'atelier si le kit en contient un, sinon dans le projet) : catalogue des composants prefaits, regles de mise en page, effets, gabarit de story. Il fait foi. Parcours `src/client/UI/components/` et compose l'existant (`Button`, `Wrapper`, `ScaledOffsetWrapper`, `BaseInterface`, effets de survol / clic...) plutot que de tout reecrire.
2. **Mise en page** : `uilistlayout` / `uigridlayout` dans un conteneur, jamais de positions calculees a la main pour une serie d'elements.
3. **Story** au format UI Labs, a cote de l'ecran (`<nom>.story.tsx`) :

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

   - Expose en `controls` ce qui change l'apparence (nombres, interrupteurs, etats « vide » / « epuise ») : l'utilisateur les manipule dans l'apercu.
   - Callbacks : fonctions vides `() => {}`. Enveloppe dans `<EffectsProvider container={props.target}>`.
4. **Donnees** : dans un concept (atelier), **tout est faux** : noms, prix, listes, pourcentages plausibles. Dans le projet, une story recoit ses donnees par props ou controles ; un `Player`, un controleur Flamework ou un etat serveur n'existent pas dans l'apercu : separe l'ecran en un composant de presentation (props seulement) et un fin conteneur qui lit les donnees reelles.
5. **Dans le projet**, commite avec `git -C "<dossier de la branche>" add -A` puis `git -C "<dossier de la branche>" commit -m "..."` (ou laisse le Worker le faire). **Ne fais jamais `git push`** : c'est automatique.

## 6. Ce que l'apercu sait faire (et ne sait pas)

Rendu par un emulateur du moteur d'interface de Roblox (`UDim2`, ancres, `UIListLayout`, `UIGridLayout`, `UIAspectRatioConstraint`, `UIScale`, `UICorner`, `UIStroke`, `UIGradient`, `AutomaticSize`, `ScrollingFrame`, tweens, effets, souris), sans Studio.

- Les images `rbxassetid://` s'affichent en **blocs hachures** : normal, ne « corrige » pas ca. Decris l'image attendue dans ton texte.
- Polices de remplacement ; **pas de 3D**, **pas de clavier ni de `TextBox`**, pas de manette.
- Les modules du jeu non pris en charge sont remplaces par des modules « fantomes » : l'apercu s'affiche quand meme. Seules les **erreurs** (exception, apercu vide) sont a corriger.

## 7. Ta reponse

Courte et utile : ce que tu as fait, ce que l'utilisateur peut essayer, le(s) bloc(s) `rpm-ui`, et, pour un concept, **la question de validation** (« Ce concept te convient ? Je l'integre dans le projet, ou tu veux d'abord changer quelque chose ? »). Pas de code recopie dans le chat.
