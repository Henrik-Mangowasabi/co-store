# MM Store Connexion

**Lance et supervise `shopify theme dev` en un clic depuis VS Code — sans jamais ouvrir de terminal.**

---

## Pourquoi cette extension ?

Quand tu développes un thème Shopify, tu dois taper cette commande à chaque session :

```
shopify theme dev -s ton-store.myshopify.com
```

Puis copier-coller manuellement les 3 liens générés (local, aperçu, éditeur) à chaque fois.

**MM Store Connexion automatise tout ça.** L'URL de ta boutique est mémorisée par projet. Un clic pour démarrer, un clic pour arrêter, les liens s'affichent automatiquement dans la sidebar.

---

## Fonctionnalités

- **▶ Démarrage en un clic** — lance `shopify theme dev` directement depuis la sidebar
- **⏹ Arrêt propre** — stoppe le serveur sans laisser de processus zombie sur le port 9292
- **3 liens cliquables** — Local, Share (aperçu public) et Admin (éditeur de thème) s'affichent automatiquement dès que Shopify CLI les génère
- **URL mémorisée** — l'URL de ta boutique est sauvegardée par workspace, tu n'as jamais à la retaper
- **Logs intégrés** — tout l'output de la CLI est accessible via le panneau Output, avec alerte visuelle ⚠ si une erreur est détectée
- **Auth automatique** — si Shopify CLI demande une authentification, le navigateur s'ouvre automatiquement

---

## Aperçu

```
MM Store Connexion
  ✏  Boutique: ton-store.myshopify.com
  🟢 Statut: Connecté
  🔗 Liens
       ↗ Local
       ↗ Share (aperçu public)
       ↗ Admin (éditeur de thème)
  📄 Voir les logs
```

---

## Utilisation

1. Ouvre ton projet de thème Shopify dans VS Code
2. Clique sur **"Boutique: ..."** dans la sidebar pour saisir l'URL de ta boutique (`mon-store.myshopify.com`)
3. Clique sur **▶** dans l'en-tête du panneau pour lancer le serveur
4. Les liens **Local**, **Share** et **Admin** apparaissent automatiquement — clique pour ouvrir dans le navigateur
5. Clique sur **⏹** pour arrêter

---

## Prérequis

- [Shopify CLI](https://shopify.dev/docs/themes/tools/cli) installé (`shopify` accessible dans le PATH)
- Windows
- Être authentifié au moins une fois via `shopify auth login`

---

## Par Moon Moon

Fait avec ❤️ pour les développeurs Shopify qui veulent rester dans leur éditeur.
