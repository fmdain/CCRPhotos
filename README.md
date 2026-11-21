# Photos du CCR — site collaboratif d'identification

Site web pour identifier les anciennes photos du CCR (Clermont de l'Oise). Les membres, anciens membres et familles indiquent ce qu'ils savent (date, lieu, section, personnes, commentaire). Une information devient **validée** quand plusieurs personnes différentes la confirment, ou quand un administrateur la valide. Un script hors ligne écrit ensuite les informations validées dans les métadonnées des fichiers (ExifTool).

- **Front** : HTML/CSS/JS sans framework ni étape de build (`app/`), utilisable sur mobile.
- **API** : Azure Functions managées par Static Web Apps, Node.js 20 / TypeScript (`api/`).
- **Stockage** : Azure Blob Storage (photos) et Azure Table Storage (contributions).
- **Hébergement** : Azure Static Web Apps, plan gratuit, déployé par GitHub Actions.

---

## Sommaire

1. [Arborescence](#arborescence)
2. [Modèle de données](#modèle-de-données)
3. [Prérequis](#prérequis)
4. [Déploiement pas à pas](#déploiement-pas-à-pas)
5. [Attribuer le rôle admin](#attribuer-le-rôle-admin)
6. [Configuration](#configuration)
7. [Rendre le site non public](#rendre-le-site-non-public)
8. [Utilisation de l'administration](#utilisation-de-ladministration)
9. [Écrire les métadonnées avec ExifTool](#écrire-les-métadonnées-avec-exiftool)
10. [Développement local](#développement-local)
11. [Points d'attention](#points-dattention)

---

## Arborescence

```
.github/workflows/azure-static-web-apps.yml   tests + déploiement
app/                        front statique (servi tel quel)
  index.html                galerie et filtres
  photo.html                photo en grand, infos validées, propositions, formulaire
  mentions.html             mentions et données personnelles
  acces.html                saisie du mot de passe commun (mode privé)
  admin/index.html          téléversement, modération, demandes de retrait, export
  js/ css/                  scripts (modules ES) et styles
  staticwebapp.config.json  routes, rôle admin, en-têtes de sécurité
api/                        Azure Functions (modèle de programmation v4)
  site.config.json          sections, seuil de votes, anti-spam, mode d'accès, contact
  src/functions/            public.ts (galerie, contributions…) et gestion.ts (admin)
  src/lib/                  consensus, dates, stockage, anti-spam, accès
  test/                     tests unitaires (consensus, dates)
infra/main.bicep            compte de stockage, conteneurs, tables, Static Web App
infra/deploy.sh             script Azure CLI qui déploie le Bicep
outils/exif/                script d'écriture des métadonnées (ExifTool)
outils/config-swa.mjs       adapte les routes au mode d'accès (lancé par le workflow)
dev/seed.mjs, dev/photos-test/   données de test pour Azurite
```

## Modèle de données

### Blob Storage (conteneurs privés)

| Conteneur | Contenu |
|---|---|
| `originaux` | `{photoId}.{ext}` : fichier d'origine, jamais modifié |
| `affichage` | `{photoId}.jpg` : 1600 px, pour la vue en grand |
| `miniatures` | `{photoId}.jpg` : 480 px, pour la galerie |
| `annotees` | copies avec métadonnées, écrites par le script ExifTool (option `--destination blob`) |

Rien n'est public : l'API fournit des liens signés (SAS) en lecture valables environ 2 heures.

### Table Storage

| Table | PartitionKey | RowKey | Contenu |
|---|---|---|---|
| `Photos` | `photo` | photoId (ULID, triable par date) | fichiers, dimensions, lot, masquée, **résumé** du consensus (statut, section et date validées, nombre de contributions) |
| `Contributions` | photoId | ULID | **une ligne immuable par valeur** : champ (`date`, `lieu`, `section`, `personne`, `commentaire`), valeur (JSON), clé normalisée, id de l'envoi, prénom, nom, email facultatif, empreinte HMAC de l'IP, date, indicateur « supprimée » |
| `Moderation` | photoId | ULID | journal des décisions admin : valider / rejeter / annuler une valeur, masquer, supprimer |
| `Retraits` | `demande` | ULID | demandes de retrait d'une photo ou d'un nom, statut, note |
| `Lieux` | `lieu` | lieu normalisé | libellé et nombre d'usages, pour les suggestions |
| `Debit` | empreinte IP | fenêtre de temps | compteur pour la limitation de débit |

Les contributions ne sont jamais écrasées. « Je confirme » crée simplement une nouvelle contribution identique.

### Règles de consensus (`api/src/lib/consensus.ts`)

- Les valeurs sont comparées après normalisation : casse, accents et espaces sont ignorés, et les dates sont comparées sous leur forme normalisée (« juin 1985 » = « 06/1985 »).
- Une valeur est **validée** si au moins `votesMinimum` contributeurs **différents** (prénom + nom) la proposent et qu'elle est strictement en tête, ou si un admin la valide. La dernière décision admin l'emporte, et « annuler » rend la main aux votes.
- **Personnes** : les repères (points ou cadres) dont les centres sont à moins de `distancePersonnes` (en fraction du plus petit côté de la photo) sont regroupés. Le nom le plus fréquent du groupe est retenu selon la même règle. Les coordonnées sont stockées en valeurs 0–1.
- **Commentaires** : ils ne se votent pas. Ils sont publiés seulement après validation par un admin.
- **Statut d'une photo** : *à identifier* (aucune valeur validée), *partiellement identifiée* (au moins une), *validée* (date, lieu et section validés, et chaque visage repéré a un nom validé).

### Dates approximatives

Le texte saisi est conservé, avec une forme normalisée : précision `jour`, `mois`, `annee`, `decennie`, `intervalle` ou `inconnue`, valeur (`1985-06-12`, `1985-06`, `1985`, `198X`, `1984/1986`), indicateur « environ », bornes début/fin et libellé. Formats reconnus : `12/06/1985`, `12 juin 1985`, `juin 85`, `06/1985`, `1985`, `vers 1985`, `1985 ?`, `années 80`, `198X`, `fin des années 70`, `entre 1984 et 1986`…

---

## Prérequis

- Un abonnement Azure (le plan gratuit de Static Web Apps suffit ; le stockage coûte quelques centimes par mois pour quelques milliers de photos).
- [Azure CLI](https://learn.microsoft.com/cli/azure/install-azure-cli) 2.60 ou plus récent (Bicep est inclus).
- Le dépôt GitHub (ce dépôt) avec les droits d'administration pour créer un secret.
- Pour le développement local : Node.js 20+, [Azure Functions Core Tools v4](https://learn.microsoft.com/azure/azure-functions/functions-run-local).
- Pour écrire les métadonnées : [ExifTool](https://exiftool.org/install.html) 12.x ou plus récent.

## Déploiement pas à pas

1. **Personnaliser la configuration** dans `api/site.config.json` : liste des sections, contact RGPD, seuil de votes (voir [Configuration](#configuration)). Commitez sur `main`.

2. **Créer l'infrastructure** (stockage, conteneurs, tables, règles CORS, Static Web App, paramètres d'application) :

   ```bash
   az login
   ./infra/deploy.sh rg-ccr-photos francecentral
   ```

   Variables facultatives : `PREFIXE` (défaut `ccrphotos`), `MODE_ACCES` (`public`, `motdepasse` ou `connecte`), `MOT_DE_PASSE_ACCES`, `SECRET_TURNSTILE`. Les secrets de hachage d'IP et de cookie sont générés automatiquement.

   Le script affiche l'adresse du site et le **jeton de déploiement**.

3. **Relier GitHub** : dans le dépôt, *Settings → Secrets and variables → Actions → New repository secret*, créez `AZURE_STATIC_WEB_APPS_API_TOKEN` avec le jeton affiché.

4. **Déployer** : poussez sur `main` (ou relancez le workflow *Déploiement Azure Static Web Apps* dans l'onglet *Actions*). Le workflow lance les tests de l'API, adapte les routes au mode d'accès, puis publie le front et l'API.

5. **Vous donner le rôle admin** (section suivante), puis ouvrez `https://<votre-site>/admin/` et téléversez les premières photos.

> Les pull requests créent un environnement de prévisualisation (3 maximum sur le plan gratuit). Il utilise **le même stockage** que la production : évitez d'y faire des essais destructifs.

## Attribuer le rôle admin

Sur le plan gratuit, les rôles sont attribués **par invitation** :

1. Portail Azure → votre Static Web App → **Gestion des rôles** (*Role management*) → **Inviter**.
2. Fournisseur d'autorisation : **Microsoft Entra ID**. Indiquez l'adresse email du compte Microsoft de la personne (compte personnel Outlook/Hotmail ou compte professionnel).
3. Rôle : `admin`. Durée de validité de l'invitation : par exemple 24 h.
4. Envoyez le lien généré à la personne. Elle l'ouvre, se connecte, et accepte.

Elle accède ensuite à `/admin/`. Pour retirer le rôle : même écran, *Modifier* puis supprimer `admin`. Le plan gratuit permet 25 personnes avec un rôle personnalisé.

Équivalent en ligne de commande :

```bash
az staticwebapp users invite -n ccrphotos-site -g rg-ccr-photos \
  --authentication-provider AAD --user-details prenom.nom@example.com \
  --roles admin --domain <votre-site>.azurestaticapps.net --invitation-expiration-in-hours 24
```

## Configuration

### `api/site.config.json`

| Clé | Rôle |
|---|---|
| `nomSite` | titre affiché dans l'en-tête |
| `sections` | liste déroulante du formulaire (« Autre… » est ajouté automatiquement) |
| `consensus.votesMinimum` | nombre de contributeurs différents pour valider (défaut 2) |
| `consensus.distancePersonnes` | distance de regroupement des repères (défaut 0,05, soit 5 % du plus petit côté) |
| `consensus.tailleVisageParDefaut` | taille du cadre déduit d'un simple point, pour l'export MWG (défaut 0,08) |
| `antispam.limiteEnvois`, `antispam.fenetreMinutes` | limite d'envois par IP (défaut 10 envois par 10 minutes) |
| `antispam.turnstile.actif`, `cleSite` | active Cloudflare Turnstile (facultatif) |
| `acces.mode` | `public`, `motdepasse` ou `connecte` |
| `contact`, `conservation` | textes affichés sur la page « Mentions et données personnelles » |

### Paramètres d'application (portail Azure → Static Web App → *Variables d'environnement*)

| Nom | Rôle |
|---|---|
| `STORAGE_CONNECTION_STRING` | chaîne de connexion du compte de stockage (créée par le Bicep) |
| `IP_HASH_SECRET` | secret du hachage des IP |
| `ACCESS_COOKIE_SECRET` | secret de signature du cookie d'accès |
| `ACCESS_MODE` | remplace `acces.mode` du fichier de configuration |
| `ACCESS_PASSWORD` | mot de passe commun (mode `motdepasse`) |
| `TURNSTILE_SECRET`, `TURNSTILE_SITE_KEY`, `TURNSTILE_ENABLED` | Cloudflare Turnstile (facultatif) |
| `CONSENSUS_VOTES` | remplace `consensus.votesMinimum` |

### Anti-spam

- **Champ piège** (honeypot) invisible : s'il est rempli, l'API répond « OK » sans rien enregistrer.
- **Limitation de débit** par empreinte d'IP, stockée dans la table `Debit`.
- **Turnstile** (facultatif) : créez un widget sur Cloudflare, mettez la clé de site dans `site.config.json` (`turnstile.actif: true`, `cleSite`) et la clé secrète dans `TURNSTILE_SECRET`. Pour le désactiver, repassez `actif` à `false`.

## Rendre le site non public

Choisissez le mode dans `api/site.config.json` (`acces.mode`) ou avec le paramètre `ACCESS_MODE`. Si vous utilisez la variable, définissez aussi la variable de dépôt GitHub `ACCESS_MODE` (*Settings → Secrets and variables → Actions → Variables*) pour que le workflow adapte les routes.

- **`public`** (défaut) : tout le monde voit et contribue ; seule l'administration est protégée.
- **`motdepasse`** : un mot de passe commun (`ACCESS_PASSWORD`) est demandé une fois, puis mémorisé 30 jours par un cookie signé. Le plan gratuit ne permet pas d'attribuer un rôle personnalisé automatiquement (cela demande le plan Standard), donc la protection est assurée par l'API : sans le cookie, aucune donnée ni photo n'est fournie. Les pages HTML/JS restent techniquement téléchargeables, mais elles ne contiennent aucune information.
- **`connecte`** : toutes les pages exigent une connexion avec un compte Microsoft (rôle intégré `authenticated`), sauf la page des mentions. Le workflow ajoute la règle correspondante dans `staticwebapp.config.json` (`node outils/config-swa.mjs`).

## Utilisation de l'administration

`/admin/` (connexion Microsoft, rôle `admin` requis) :

- **Téléverser** : glissez-déposez des photos, en indiquant éventuellement un nom de lot. Le navigateur génère la miniature et la version d'affichage, puis envoie les trois fichiers directement dans le stockage. Les **TIFF ne sont pas lisibles par les navigateurs** : convertissez-les en JPEG avant (l'original TIFF peut être conservé à part et retrouvé par le script ExifTool avec `--originaux`).
- **Photos et modération** : pour chaque photo, les valeurs proposées avec leurs votes, les boutons *Valider*, *Rejeter* et *Annuler la décision*, la liste des contributions (*Supprimer* retire du consensus en gardant l'historique, *Effacer* supprime définitivement), *Masquer la photo* et *Supprimer définitivement*.
- **Dernières contributions** : flux des 7 jours, 30 jours ou 12 mois.
- **Demandes de retrait** : demandes envoyées depuis le lien présent sur chaque photo. Elles passent par les statuts nouvelle, en cours, traitée ou refusée, avec une note interne.
- **Export** : JSON (entrée du script ExifTool) ou CSV (séparateur `;`, s'ouvre dans Excel) des valeurs validées.

## Écrire les métadonnées avec ExifTool

Le script `outils/exif/ecrire-metadonnees.mjs` lit l'export JSON, récupère chaque original et écrit les métadonnées dans une **copie**. ExifTool lit la source et écrit un nouveau fichier (`-o`), donc l'original n'est jamais modifié.

```bash
cd outils/exif
npm install

# 1. Téléchargez l'export JSON depuis /admin/ → Export (les liens qu'il contient sont valables 24 h)
# 2. Vérifiez ce qui serait écrit, sans rien télécharger ni modifier :
node ecrire-metadonnees.mjs --export ~/Téléchargements/ccr-metadonnees-2026-11-21.json --dry-run

# 3. Écrire les copies annotées dans un dossier local :
node ecrire-metadonnees.mjs --export ccr-metadonnees.json --sortie ./sortie --pays-defaut France --mots-cles "CCR"

# Variante : utiliser des originaux locaux (par ex. les TIFF d'origine) au lieu de les télécharger
node ecrire-metadonnees.mjs --export ccr-metadonnees.json --originaux ~/Scans/CCR --sortie ./sortie

# Variante : renvoyer aussi les copies dans le conteneur « annotees »
export STORAGE_CONNECTION_STRING="$(az storage account show-connection-string -g rg-ccr-photos -n <compte> --query connectionString -o tsv)"
node ecrire-metadonnees.mjs --export ccr-metadonnees.json --destination blob
```

Options : `--photo <id>` (répétable) pour ne traiter que certaines photos, `--ecraser` pour refaire les fichiers déjà présents, `--ville-defaut`, `--exiftool <chemin>`, `--aide`.

### Correspondance des champs

| Donnée | Balises écrites |
|---|---|
| Date | `XMP-photoshop:DateCreated` (`1985`, `1985-06` ou `1985-06-12`). `EXIF:DateTimeOriginal` **seulement** pour une date complète et non approximative. Les décennies et intervalles, qui ne sont pas représentables, sont ajoutés à la description, tout comme la mention « vers ». |
| Lieu | `XMP-iptcCore:Location`, `XMP-photoshop:City`, `XMP-photoshop:Country` et les équivalents IPTC (`Sub-location`, `City`, `Country-PrimaryLocationName`). Le texte est découpé selon la convention « Lieu, Ville, Pays ». |
| Section | `XMP-dc:Subject` et `IPTC:Keywords`, fusionnés avec les mots-clés existants |
| Personnes | `XMP-mwg-rs:RegionInfo` (type `Face`, nom, zone normalisée centre + taille, `AppliedToDimensions`) et `XMP-iptcExt:PersonInImage` |
| Commentaires validés | `XMP-dc:Description` |

Conseil : invitez les contributeurs à saisir les lieux sous la forme « Stade municipal, Clermont, France » ; les suggestions du formulaire aident à garder des libellés homogènes.

## Développement local

Le mode local combine le SWA CLI (front, API et authentification simulée) et Azurite (émulateur de stockage).

```bash
npm install                                  # SWA CLI + Azurite
npm --prefix api install
cp api/local.settings.example.json api/local.settings.json

npm run stockage                             # terminal 1 : Azurite (données dans .azurite/)
npm run seed                                 # terminal 2 : conteneurs, tables, CORS, 5 photos et contributions de test
npm run dev                                  # terminal 2 : http://localhost:4280
```

- `npm run seed -- --reinitialiser` efface tout et recharge les données de test.
- **Se connecter en admin** : ouvrez `http://localhost:4280/.auth/login/aad`. Le SWA CLI affiche un formulaire d'authentification simulée : saisissez un nom et ajoutez le rôle `admin` dans *User's roles*.
- **Tests** : `npm test` (tests unitaires du consensus et de l'analyse des dates).
- Le SWA CLI a besoin des Azure Functions Core Tools v4 (`npm i -g azure-functions-core-tools@4`).

## Points d'attention

- **Orientation EXIF** : les repères sont placés sur l'image telle qu'affichée. Si un original est pivoté par une balise EXIF (cas rare pour des scans), le script ExifTool affiche un avertissement : vérifiez la position des visages dans votre logiciel.
- **Suppression** : la corbeille de 30 jours du stockage (*soft delete*) permet de récupérer un fichier supprimé par erreur.
- **Données personnelles** : les adresses IP ne sont jamais stockées en clair. Les emails ne sont visibles que des admins. Une demande de retrait peut être satisfaite en effaçant les contributions concernées (*Effacer*) ou la photo entière.
- **Volumétrie** : la galerie charge la liste complète en une requête, ce qui convient pour quelques milliers de photos.
