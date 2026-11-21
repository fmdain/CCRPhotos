#!/usr/bin/env node
/**
 * Prépare l'émulateur Azurite pour le développement local :
 * conteneurs, tables, règle CORS, 5 photos de test et quelques contributions d'exemple.
 *
 *   npm run stockage         (dans un autre terminal : lance Azurite)
 *   npm run seed             (ajoute les données de test)
 *   npm run seed -- --reinitialiser   (efface tout puis recommence)
 */
import { TableClient } from "@azure/data-tables";
import { BlobServiceClient } from "@azure/storage-blob";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ici = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
let lib;
try {
  lib = {
    ...require("../api/dist/src/lib/consensus.js"),
    ...require("../api/dist/src/lib/dates.js"),
    ...require("../api/dist/src/lib/util.js"),
  };
} catch {
  console.error("Compilez d'abord l'API : npm --prefix api run build");
  process.exit(1);
}

const CNX = process.env.STORAGE_CONNECTION_STRING || "UseDevelopmentStorage=true";
const reinit = process.argv.includes("--reinitialiser");
const CONTENEURS = ["originaux", "affichage", "miniatures", "annotees"];
const TABLES = ["Photos", "Contributions", "Moderation", "Retraits", "Lieux", "Debit"];
const PARAMS = { votesMinimum: 2, distancePersonnes: 0.05, tailleVisageParDefaut: 0.08 };

const blobs = BlobServiceClient.fromConnectionString(CNX);
const table = (nom) => TableClient.fromConnectionString(CNX, nom, { allowInsecureConnection: true });

async function preparer() {
  try {
    await blobs.getProperties();
  } catch {
    console.error("Azurite ne répond pas. Lancez-le d'abord : npm run stockage");
    process.exit(1);
  }
  // CORS : le navigateur de l'admin envoie les fichiers directement au stockage.
  await blobs.setProperties({
    cors: [{ allowedOrigins: "*", allowedMethods: "GET,HEAD,PUT,OPTIONS", allowedHeaders: "*", exposedHeaders: "*", maxAgeInSeconds: 3600 }],
  });
  for (const c of CONTENEURS) {
    const cc = blobs.getContainerClient(c);
    if (reinit) await cc.deleteIfExists();
    await cc.createIfNotExists().catch(async (e) => {
      // Juste après une suppression, Azurite peut refuser brièvement la recréation.
      if (e.statusCode !== 409) throw e;
      await new Promise((r) => setTimeout(r, 1500));
      await cc.createIfNotExists();
    });
  }
  for (const t of TABLES) {
    const tc = table(t);
    if (reinit) await tc.deleteTable().catch(() => {});
    await tc.createTable().catch(() => {});
  }
}

const PHOTOS = [
  { fichier: "equipe-football.jpg", largeur: 1600, hauteur: 1067, lot: "Carton 1" },
  { fichier: "remise-coupe.jpg", largeur: 1600, hauteur: 1100, lot: "Carton 1" },
  { fichier: "gymnase.jpg", largeur: 1200, hauteur: 1600, lot: "Carton 2" },
  { fichier: "piscine.jpg", largeur: 1600, hauteur: 1000, lot: "Carton 2" },
  { fichier: "bureau.jpg", largeur: 1600, hauteur: 1067, lot: "" },
];

let horloge = Date.now() - 3 * 86400_000;
function contribution(photoId, champ, valeur, qui) {
  const [prenom, nom] = qui.split(" ");
  let cle = "";
  if (champ === "date") {
    valeur = { texte: valeur, normalisee: lib.interpreterDate(valeur) };
    cle = lib.cleDate(valeur.normalisee, valeur.texte);
  } else if (champ === "personne") cle = lib.normaliser(valeur.nom);
  else if (champ !== "commentaire") cle = lib.normaliser(valeur.texte);
  horloge += 60_000;
  return {
    rowKey: lib.ulid(horloge), photoId, soumission: lib.ulid(horloge), champ, valeur, cle, prenom, nom,
    email: "", ipHash: "dev", creeLe: new Date(horloge).toISOString(),
  };
}

async function principal() {
  await preparer();
  const tPhotos = table("Photos");
  const existantes = [];
  for await (const e of tPhotos.listEntities()) existantes.push(e);
  if (existantes.length && !reinit) {
    console.log(`Des photos existent déjà (${existantes.length}). Utilisez --reinitialiser pour repartir de zéro.`);
    return;
  }

  const ids = [];
  for (const [i, p] of PHOTOS.entries()) {
    const id = lib.ulid(Date.now() - (PHOTOS.length - i) * 1000);
    ids.push(id);
    const original = await readFile(join(ici, "photos-test", p.fichier));
    const miniature = await readFile(join(ici, "photos-test", "miniatures", p.fichier));
    const type = { blobHTTPHeaders: { blobContentType: "image/jpeg" } };
    // Les photos de test font déjà 1600 px : l'original sert aussi de version d'affichage.
    await blobs.getContainerClient("originaux").getBlockBlobClient(`${id}.jpg`).uploadData(original, type);
    await blobs.getContainerClient("affichage").getBlockBlobClient(`${id}.jpg`).uploadData(original, type);
    await blobs.getContainerClient("miniatures").getBlockBlobClient(`${id}.jpg`).uploadData(miniature, type);
    await tPhotos.upsertEntity({
      partitionKey: "photo", rowKey: id, nomFichier: p.fichier, blobOriginal: `${id}.jpg`, blobAffichage: `${id}.jpg`,
      blobMiniature: `${id}.jpg`, largeur: p.largeur, hauteur: p.hauteur, lot: p.lot, televerseeLe: new Date().toISOString(),
      televerseePar: "seed", masquee: false, statut: "a_identifier", nbContributions: 0,
    });
  }

  // Contributions d'exemple
  const [equipe, coupe] = ids;
  const C = [
    // Photo 1 : lieu validé (2 votes), date en débat, personnes partiellement identifiées.
    contribution(equipe, "lieu", { texte: "Stade Pierre de Coubertin, Clermont, France" }, "Jean Dupont"),
    contribution(equipe, "lieu", { texte: "stade Pierre de Coubertin, Clermont, France" }, "Marie Durand"),
    contribution(equipe, "date", "vers 1985", "Jean Dupont"),
    contribution(equipe, "date", "1986", "Paul Martin"),
    contribution(equipe, "section", { texte: "Football", autre: false }, "Marie Durand"),
    contribution(equipe, "personne", { nom: "Michel Leroy", x: 0.1875, y: 0.4686, w: 0, h: 0 }, "Jean Dupont"),
    contribution(equipe, "personne", { nom: "Michel Leroy", x: 0.19, y: 0.47, w: 0, h: 0 }, "Paul Martin"),
    contribution(equipe, "personne", { nom: "Alain Bernard", x: 0.3125, y: 0.45, w: 0, h: 0 }, "Marie Durand"),
    contribution(equipe, "commentaire", { texte: "Je crois que c'est la montée en division d'honneur." }, "Paul Martin"),
    // Photo 2 : entièrement validée.
    contribution(coupe, "date", "juin 1992", "Jean Dupont"),
    contribution(coupe, "date", "06/1992", "Marie Durand"),
    contribution(coupe, "lieu", { texte: "Gymnase municipal, Clermont, France" }, "Jean Dupont"),
    contribution(coupe, "lieu", { texte: "Gymnase municipal, Clermont, France" }, "Marie Durand"),
    contribution(coupe, "section", { texte: "Judo", autre: false }, "Jean Dupont"),
    contribution(coupe, "section", { texte: "Judo", autre: false }, "Marie Durand"),
    contribution(coupe, "personne", { nom: "Sophie Laurent", x: 0.33, y: 0.35, w: 0.09, h: 0.13 }, "Jean Dupont"),
    contribution(coupe, "personne", { nom: "Sophie Laurent", x: 0.335, y: 0.355, w: 0.085, h: 0.12 }, "Marie Durand"),
    contribution(coupe, "personne", { nom: "Gérard Petit", x: 0.6, y: 0.36, w: 0.085, h: 0.125 }, "Jean Dupont"),
    contribution(coupe, "personne", { nom: "Gérard Petit", x: 0.6, y: 0.36, w: 0.08, h: 0.12 }, "Paul Martin"),
  ];
  const tContrib = table("Contributions");
  for (const c of C) {
    await tContrib.createEntity({
      partitionKey: c.photoId, rowKey: c.rowKey, soumission: c.soumission, champ: c.champ, valeur: JSON.stringify(c.valeur),
      cle: c.cle, prenom: c.prenom, nom: c.nom, email: c.email, ipHash: c.ipHash, creeLe: c.creeLe, supprimee: false,
    });
  }
  // Lieux pour les suggestions.
  const tLieux = table("Lieux");
  for (const l of ["Stade Pierre de Coubertin, Clermont, France", "Gymnase municipal, Clermont, France", "Piscine de Clermont, Clermont, France"]) {
    await tLieux.upsertEntity({ partitionKey: "lieu", rowKey: lib.normaliser(l), libelle: l, usages: 1 });
  }
  // Résumés de consensus.
  for (const [i, id] of ids.entries()) {
    const c = lib.calculerConsensus(C.filter((x) => x.photoId === id), [], { ...PARAMS, largeur: PHOTOS[i].largeur, hauteur: PHOTOS[i].hauteur });
    await tPhotos.updateEntity({
      partitionKey: "photo", rowKey: id, statut: c.statut, sectionValidee: c.section.validee?.libelle ?? "",
      dateValidee: c.date.validee?.valeur?.normalisee?.libelle ?? "", dateTri: c.date.validee?.valeur?.normalisee?.debut ?? "",
      nbContributions: c.nbContributions,
    }, "Merge");
  }
  // Une demande de retrait d'exemple.
  await table("Retraits").createEntity({
    partitionKey: "demande", rowKey: lib.ulid(), photoId: ids[4], type: "nom", nomConcerne: "Exemple Personne",
    message: "Demande de test générée par le script de données.", prenom: "Claire", nom: "Exemple",
    email: "claire@example.org", ipHash: "dev", statut: "nouvelle", creeLe: new Date().toISOString(),
  });
  console.log(`✓ ${ids.length} photos et ${C.length} contributions de test ajoutées.`);
}

principal().catch((e) => {
  console.error(e);
  process.exit(1);
});
