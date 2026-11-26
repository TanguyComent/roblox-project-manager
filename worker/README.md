# worker

Agent qui tourne sur une machine et execute les taches envoyees par le Host. Il **se connecte au Host** (WebSocket sortant) : rien a ouvrir sur la machine.

## Lancer

1. Sur le site, page **Workers** → *Creer le Worker* : le jeton (`rpmw_…`) et les commandes toutes pretes s'affichent une seule fois.
2. Sur la machine du Worker (Node 24+) :

```powershell
cd worker
npm install
$env:RPM_HOST_URL = 'http://localhost:3000'
$env:RPM_WORKER_TOKEN = 'rpmw_...'
npm start
```

Le Worker se reconnecte seul (delai exponentiel) si la connexion tombe ; il s'arrete si le Host refuse son jeton (invalide, revoque, Worker supprime ou remplace).

## Taches

Les gestionnaires sont dans `src/jobs.ts` : `echo` (renvoie sa charge) et `sleep` (attend `ms`, annulable). Le protocole (`src/protocol.ts`) est une copie de `host/src/worker-protocol.ts` : le garder identique.
