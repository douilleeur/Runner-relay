# Serveur relais du jeu Runner

Un tout petit serveur (Cloudflare Workers + Durable Objects) qui fait suivre les messages entre les joueurs.
Il remplace la connexion directe entre téléphones, qui échoue souvent (box, 4G, Safari…).
Il ne contient aucune logique de jeu et ne stocke rien.

**Coût : gratuit** pour des parties entre amis (100 000 requêtes par jour sur l'offre gratuite ; les messages
reçus comptent 20 pour 1, soit environ 2 millions de messages par jour). Si la limite est atteinte, le
multijoueur s'arrête jusqu'à minuit UTC. Le plan payant (≈ 5 $/mois) lève la limite.

---

## Mise en ligne, méthode 1 : depuis GitHub (sans rien installer)

1. Mets ce dossier `runner-relay` dans ton dépôt GitHub du jeu (à côté de `index.html`), puis envoie-le (commit + push).
   *(Ou crée un dépôt séparé juste pour lui, c'est encore plus propre.)*
2. Va sur <https://dash.cloudflare.com> (crée un compte gratuit si besoin).
3. Menu **Workers & Pages** → **Create** → **Import a repository** → choisis ton dépôt.
4. Réglages :
   - **Project name** : `runner-relay` (le même nom que dans `wrangler.jsonc`)
   - **Root directory** : `runner-relay` (si le dossier est dans le dépôt du jeu ; sinon laisse vide)
   - **Deploy command** : `npx wrangler deploy` (valeur par défaut)
5. Clique **Save and Deploy**. Au bout d'une minute, Cloudflare affiche l'adresse du serveur :
   `https://runner-relay.TON-COMPTE.workers.dev`
6. Vérifie : ouvre cette adresse dans le navigateur, tu dois voir **Runner relay : OK**.
   Avec `/ip` à la fin, tu dois voir `{"k":"…"}`.

## Mise en ligne, méthode 2 : depuis un ordinateur

```
cd runner-relay
npm install
npx wrangler login
npx wrangler deploy
```

`wrangler deploy` affiche l'adresse du serveur à la fin.

---

## Brancher le jeu

**Essai sans rien modifier** : sur les deux téléphones, ouvre le jeu avec l'adresse du serveur à la fin du lien :

```
https://TON-JEU.vercel.app/?relay=https://runner-relay.TON-COMPTE.workers.dev
```

L'adresse est mémorisée sur l'appareil. Pour l'annuler : `https://TON-JEU.vercel.app/?relay=off`.

**Définitif** : dans `index.html`, trouve la ligne

```js
const RELAY_URL='';
```

et mets l'adresse entre les guillemets, puis envoie le changement sur GitHub (Vercel redéploie tout seul).
Tant que cette ligne est vide, le jeu utilise l'ancien mode (connexion directe).

---

## Réglages (facultatif)

- **Limiter aux origines autorisées** : dans `wrangler.jsonc`, mets l'adresse de ton jeu dans `ALLOWED_ORIGINS`
  (ex. `"https://mon-jeu.vercel.app"`, plusieurs adresses séparées par des virgules), puis redéploie.
  Attention : si tu utilises aussi la version dans Claude, ne limite pas, ou ajoute aussi son origine.
- **Voir la consommation** : tableau de bord Cloudflare → Workers & Pages → `runner-relay` → Metrics.
- **Taille des salles / débit** : constantes en haut de `src/index.js` (`MAX_PEERS`, `RATE`, `BURST`).

## Comment ça marche

- `GET /ws?room=NOM` : connexion WebSocket à la salle `NOM`. Chaque salle est un Durable Object.
  Le serveur donne un identifiant à chaque joueur, prévient les autres des arrivées et départs, et fait suivre
  chaque message (à tous, ou à un joueur précis).
- `GET /ip` : renvoie une empreinte de l'adresse publique du téléphone. Les appareils d'un même Wi‑Fi ont la
  même empreinte : c'est ce qui remplit la liste « Wi‑Fi local ». Si deux téléphones du même Wi‑Fi ne se voient pas
  (l'un passe en IPv4, l'autre en IPv6), il reste le mode « Partie en ligne ».

## Test local (sans compte)

```
npm test
```

Vérifie le relais avec un faux environnement Cloudflare : arrivées, départs, messages ciblés, limite de débit,
salle pleine, routes `/ws` et `/ip`.
