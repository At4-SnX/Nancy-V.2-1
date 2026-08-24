# Nancy RP V.2 — Bot de modération

Bot Discord de modération complet, avec commandes `/` et préfixe `&`.

## Installation

1. Installez Node.js 20 ou plus récent.
2. Dans ce dossier, lancez `npm install`.
3. Copiez `.env.example` en `.env`, puis renseignez le token, `CLIENT_ID` et `GUILD_ID`.
4. Dans le portail développeur Discord, activez **Server Members Intent** et **Message Content Intent** dans *Bot > Privileged Gateway Intents*.
5. Invitez le bot avec les portées `bot` et `applications.commands`. Donnez-lui au minimum les permissions : gérer les salons, gérer les messages, expulser, bannir, modérer les membres, lire les journaux d'audit et gérer les rôles.
6. Lancez `npm install`, puis `npm run deploy`, puis `npm start`.

## Déploiement sur Railway

1. Créez un dépôt GitHub avec ces fichiers, sans le fichier `.env`, puis poussez-le sur GitHub.
2. Sur Railway, créez un projet puis **Deploy from GitHub Repo** et choisissez ce dépôt.
3. Dans **Variables**, ajoutez `DISCORD_TOKEN`, `CLIENT_ID`, `GUILD_ID`, `PREFIX` (valeur `&`), `BOT_OWNER_ID` (votre identifiant Discord), et si souhaité `LOG_CHANNEL_ID`. Ajoutez aussi `TICKET_CATEGORY_ID` ou les variables de catégorie détaillées dans `.env.example`.
4. Ajoutez un **Volume** Railway monté sur `/app/data`. Il conserve les réglages `antibot` et `antinuke` entre les redéploiements.
5. Railway installe les dépendances, enregistre les commandes slash, puis lance automatiquement le bot grâce à `railway.json`. Aucun domaine public n’est nécessaire : c’est un service bot permanent.

Si Railway met le service en veille, utilisez une offre incluant un service toujours actif : un bot Discord doit conserver sa connexion WebSocket ouverte.

Si une construction Railway échoue avec `EBUSY` sur `node_modules/.cache`, redéployez après avoir récupéré la dernière version de `railway.json`. Si le cache Railway reste verrouillé, ajoutez temporairement la variable Railway `NO_CACHE=1`, puis redéployez.

Les réglages `antibot` et `antinuke` sont enregistrés dans `data/settings.json`. N'ajoutez jamais `.env` à Git.

## Commandes

| Commande slash | Préfixe | Description |
|---|---|---|
| `/ping` | `&ping` | Latence du bot |
| `/kick membre raison` | `&kick <id/mention> [raison]` | Expulser |
| `/ban membre raison` | `&ban <id/mention> [raison]` | Bannir |
| `/mute membre durée raison` | `&mute <id/mention> <10m/2h/1d> [raison]` | Timeout Discord |
| `/unmute membre` | `&unmute <id/mention>` | Retirer le timeout |
| `/clear quantité` | `&clear [1-100]` | Supprimer des messages |
| `/lock`, `/unlock` | `&lock`, `&unlock` | Fermer/ouvrir le salon |
| `/slowmode secondes` | `&slowmode <secondes>` | Définir le mode lent (0–21600) |
| `/antibot état` | `&antibot on/off` | Bannir automatiquement les bots entrants |
| `/antinuke état seuil action` | `&antinuke on/off [seuil] [strip/kick/ban]` | Protection contre les actions de masse |
| `/antispam état messages secondes timeout` | `&antispam on/off [messages] [secondes] [timeout]` | Configurer l’antispam |
| `/rank [membre]` | `&rank [membre]` | Consulter un niveau et l’XP |
| `/leaderboard` | `&leaderboard` | Top 10 des niveaux |
| `/levelrole niveau rôle` | `&levelrole <niveau> <rôle>` | Configurer un rôle de récompense (admin) |
| `/levelroles` | `&levelroles` | Voir les huit rôles de niveau |
| `/ticketrole type rôle` | `&ticketrole <type> <rôle>` | Définir le rôle ayant accès par type de ticket (admin) |
| `/ticketcategory catégorie` | `&ticketcategory <catégorie>` | Définir la catégorie Discord des tickets (admin) |
| `/ticketpanel` | `&ticketpanel` | Publier le panneau Components V2 (admin) |
| `/ticketclose` | `&ticketclose` | Fermer un ticket |
| `/help` | `&help` | Aide |

`antinuke` surveille les créations, suppressions et modifications de salons/rôles, ainsi que les bans et kicks. Dès que le seuil d'un même auteur est atteint dans une fenêtre de 10 secondes, il applique l'action choisie. `strip` retire les rôles dangereux ; `kick` ou `ban` agit directement contre l'auteur.

Seul le compte dont l’identifiant est défini dans la variable Railway `BOT_OWNER_ID` peut exécuter `antibot off` ou `antinuke off`, même si d’autres personnes possèdent le rôle Administrateur.

### Antispam

L’antispam est actif par défaut : **6 messages en 7 secondes** entraînent la suppression du message déclencheur et un timeout de **10 minutes**. Configurez-le avec `/antispam`, par exemple `/antispam etat:on messages:5 secondes:10 timeout:15m`. Les administrateurs ne sont pas sanctionnés par l’antispam. Comme pour les autres protections, seul `BOT_OWNER_ID` peut l’éteindre.

### Anti-lien

L’anti-lien est toujours actif : les messages contenant une invitation `discord.gg/` sont supprimés. Les autres liens, dont `https://`, restent autorisés. Une invitation contenant `tenor` reste autorisée.

## Système de niveaux

- Un message d’au moins 3 caractères rapporte **8 à 25 XP** selon sa longueur. Un délai de 20 secondes par membre évite le spam XP.
- Le vocal rapporte **4 XP toutes les 15 secondes** passées dans un salon vocal (16 XP/minute). Le crédit est actualisé toutes les 15 secondes.
- Le niveau est calculé sur l’XP totale et est plafonné au niveau **70**.
- Les paliers de rôle sont : **1, 10, 20, 30, 40, 50, 60 et 70**.

Configurez les huit rôles avec `/levelrole` (ou `&levelrole`) : par exemple `/levelrole niveau:10 role:@Citoyen confirmé`. Le rôle du bot doit être placé au-dessus de tous les rôles de niveau. Les membres peuvent consulter leur progression avec `/rank` et le classement avec `/leaderboard`.

Configurez aussi le salon réservé aux annonces avec `/levelchannel salon:#niveaux`. Lors d’un passage de niveau, le bot y publie un message **Discord Components V2** Nancy RP V.2, avec le GIF `A.gif` sous le texte.

## Accès aux commandes

Les contrôles reposent sur les noms de rôle exacts **Administrateur** et **Équipe Staff** (la casse et les accents ne posent pas de problème). Le rôle Administrateur peut utiliser toutes les commandes. Équipe Staff peut utiliser les commandes de modération courantes : `ping`, `help`, `rank`, `leaderboard`, `kick`, `mute`, `unmute`, `clear`, `lock`, `unlock` et `slowmode`. Les réglages sensibles, le bannissement et la configuration des niveaux sont réservés aux administrateurs.

## Système de tickets

Le panneau Components V2 propose : Ticket Fondation, Ticket Légal, Ticket Illégal, Ticket report Staff, Ticket Report Joueur, Ticket Question, Ticket Unban et Ticket Build. Chaque type possède son propre rôle d’accès, qui peut consulter et répondre dans le salon privé. Le bot n’envoie aucune mention ni notification automatique.

Configuration administrateur :

1. Créez les catégories Discord souhaitées et renseignez leurs IDs dans les variables Railway. Utilisez `TICKET_CATEGORY_ID` pour une catégorie commune, ou une variable par type (`TICKET_CATEGORY_LEGAL_ID`, `TICKET_CATEGORY_BUILD_ID`, etc.) pour les séparer. Les variables par type sont prioritaires.
2. Configurez un rôle différent pour **chacun** des huit types avec `/ticketrole`. Par exemple : `/ticketrole type:legal role:@Équipe Légale`.
3. Dans le salon où les joueurs doivent ouvrir leurs demandes, lancez `/ticketpanel`.

Un Ticket report Staff ouvre d’abord une sélection Components V2 permettant de choisir un ou plusieurs membres portant le rôle **Équipe Staff**. Les personnes signalées sont listées dans le ticket, sans être notifiées. Le panneau de tickets affiche le GIF `ticket.gif`, encadré par un texte d’introduction et un texte d’information professionnel.
