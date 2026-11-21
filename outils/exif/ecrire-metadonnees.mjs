#!/usr/bin/env node
/**
 * Écrit les métadonnées validées (export JSON de l'administration) dans des COPIES des photos originales,
 * avec ExifTool. Les originaux ne sont jamais modifiés : ExifTool lit la source et écrit un nouveau fichier (-o).
 *
 * Exemples :
 *   node ecrire-metadonnees.mjs --export ccr-metadonnees.json --dry-run
 *   node ecrire-metadonnees.mjs --export ccr-metadonnees.json --sortie ./sortie
 *   node ecrire-metadonnees.mjs --export ccr-metadonnees.json --destination blob   (réenvoie dans le conteneur « annotees »)
 *   node ecrire-metadonnees.mjs --export ccr-metadonnees.json --originaux ~/Scans  (originaux locaux, sans téléchargement)
 */
import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import { parseArgs, promisify } from "node:util";

const exec = promisify(execFile);

const AIDE = `
Usage : node ecrire-metadonnees.mjs --export <fichier.json> [options]

Options :
  --export <fichier>       Export JSON téléchargé depuis l'administration (obligatoire)
  --dry-run                Affiche ce qui serait écrit, sans rien télécharger ni modifier
  --destination <mode>     « local » (défaut) : écrit dans --sortie ;
                           « blob » : écrit aussi dans --sortie puis envoie dans le conteneur « annotees »
                           (variable STORAGE_CONNECTION_STRING requise)
  --sortie <dossier>       Dossier des copies annotées (défaut : ./sortie)
  --originaux <dossier>    Utiliser des originaux locaux (recherchés par nom de fichier) au lieu de les télécharger
  --photo <id>             Ne traiter que cette photo (option répétable)
  --ville-defaut <ville>   Ville à utiliser quand le lieu n'en précise pas
  --pays-defaut <pays>     Pays à utiliser quand le lieu n'en précise pas (ex. France)
  --mots-cles <a,b>        Mots-clés ajoutés à toutes les photos (ex. "CCR,Clermont de l'Oise")
  --exiftool <chemin>      Chemin de l'exécutable ExifTool (défaut : exiftool)
  --ecraser                Remplacer les fichiers déjà présents dans --sortie
  --aide                   Afficher cette aide
`;

const { values: opt } = parseArgs({
  options: {
    export: { type: "string" },
    "dry-run": { type: "boolean", default: false },
    destination: { type: "string", default: "local" },
    sortie: { type: "string", default: "./sortie" },
    originaux: { type: "string" },
    photo: { type: "string", multiple: true },
    "ville-defaut": { type: "string", default: "" },
    "pays-defaut": { type: "string", default: "" },
    "mots-cles": { type: "string", default: "" },
    exiftool: { type: "string", default: "exiftool" },
    ecraser: { type: "boolean", default: false },
    aide: { type: "boolean", default: false },
  },
});

if (opt.aide || !opt.export) {
  console.log(AIDE);
  process.exit(opt.aide ? 0 : 1);
}
if (!["local", "blob"].includes(opt.destination)) {
  console.error("--destination doit valoir « local » ou « blob ».");
  process.exit(1);
}

// --- Correspondance des champs ----------------------------------------------------------

/** Sépare « Lieu, Ville, Pays ». */
export function decouperLieu(lieu, villeDefaut = "", paysDefaut = "") {
  const p = lieu.split(",").map((s) => s.trim()).filter(Boolean);
  if (p.length >= 3) return { lieu: p.slice(0, -2).join(", "), ville: p[p.length - 2], pays: p[p.length - 1] };
  if (p.length === 2) return { lieu: p[0], ville: p[1], pays: paysDefaut };
  return { lieu: lieu.trim(), ville: villeDefaut, pays: paysDefaut };
}

const unique = (l) => [...new Set(l.filter(Boolean))];
const liste = (v) => (v === undefined || v === null ? [] : Array.isArray(v) ? v.map(String) : [String(v)]);

/**
 * Construit les balises ExifTool pour une photo de l'export.
 * @param existant métadonnées déjà présentes dans le fichier (pour fusionner mots-clés, personnes, régions)
 */
export function construireBalises(photo, existant = {}, o = {}) {
  const b = {};
  const notes = [];
  let iptc = false;

  // Date → XMP-photoshop:DateCreated (dates partielles acceptées) ; EXIF DateTimeOriginal si date complète.
  const d = photo.date;
  if (d && d.valeur) {
    if (d.precision === "jour" || d.precision === "mois" || d.precision === "annee") {
      b["XMP-photoshop:DateCreated"] = d.valeur;
      if (d.precision === "jour" && !d.environ) {
        b["EXIF:DateTimeOriginal"] = d.valeur.replace(/-/g, ":") + " 00:00:00";
      }
      if (d.environ) notes.push(`Date approximative : ${d.libelle}.`);
    } else {
      // Décennie ou intervalle : pas de représentation XMP fiable, on l'indique dans la description.
      notes.push(`Date : ${d.libelle}.`);
    }
  } else if (d && d.texte) {
    notes.push(`Date (non normalisée) : ${d.texte}.`);
  }

  // Lieu → XMP-iptcCore:Location, XMP-photoshop:City/Country et équivalents IPTC.
  if (photo.lieu) {
    const l = decouperLieu(photo.lieu, o.villeDefaut, o.paysDefaut);
    b["XMP-iptcCore:Location"] = l.lieu;
    b["IPTC:Sub-location"] = l.lieu;
    if (l.ville) {
      b["XMP-photoshop:City"] = l.ville;
      b["IPTC:City"] = l.ville;
    }
    if (l.pays) {
      b["XMP-photoshop:Country"] = l.pays;
      b["IPTC:Country-PrimaryLocationName"] = l.pays;
    }
    iptc = true;
  }

  // Section (+ mots-clés communs) → XMP-dc:Subject et IPTC:Keywords, fusionnés avec l'existant.
  const motsCles = unique([...(o.motsCles || []), photo.section]);
  if (motsCles.length) {
    b["XMP-dc:Subject"] = unique([...liste(existant.Subject), ...motsCles]);
    b["IPTC:Keywords"] = unique([...liste(existant.Keywords), ...motsCles]);
    iptc = true;
  }

  // Personnes → régions MWG (centre + taille normalisés) et XMP-iptcExt:PersonInImage.
  if (photo.personnes?.length) {
    const noms = photo.personnes.map((p) => p.nom);
    const anciennes = (existant.RegionInfo?.RegionList || []).filter((r) => !noms.includes(r.Name));
    const arrondi = (n) => Math.round(n * 1e6) / 1e6;
    b["XMP-mwg-rs:RegionInfo"] = {
      AppliedToDimensions: { W: o.largeur || photo.largeur, H: o.hauteur || photo.hauteur, Unit: "pixel" },
      RegionList: [
        ...anciennes,
        ...photo.personnes.map((p) => ({
          Area: { X: arrondi(p.x + p.w / 2), Y: arrondi(p.y + p.h / 2), W: arrondi(p.w), H: arrondi(p.h), Unit: "normalized" },
          Name: p.nom,
          Type: "Face",
        })),
      ],
    };
    b["XMP-iptcExt:PersonInImage"] = unique([...liste(existant.PersonInImage), ...noms]);
  }

  // Commentaires validés (+ notes de date) → XMP-dc:Description.
  const description = [...(photo.commentaires || []), ...notes].join("\n\n");
  if (description) b["XMP-dc:Description"] = description;

  if (iptc) b["IPTC:CodedCharacterSet"] = "UTF8";
  return b;
}

// --- Fonctions utilitaires ------------------------------------------------------------------------

async function existe(chemin) {
  try {
    await stat(chemin);
    return true;
  } catch {
    return false;
  }
}

function nomSur(nom) {
  return nom.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_");
}

async function lireMetadonnees(fichier) {
  const { stdout } = await exec(opt.exiftool, [
    "-j", "-struct", "-n", "-Orientation", "-ImageWidth", "-ImageHeight",
    "-XMP-dc:Subject", "-IPTC:Keywords", "-XMP-iptcExt:PersonInImage", "-XMP-mwg-rs:RegionInfo", fichier,
  ], { maxBuffer: 20 * 1024 * 1024 });
  return JSON.parse(stdout)[0] || {};
}

async function telecharger(url, destination) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`téléchargement impossible (${r.status}) ; l'export a peut-être plus de 24 h, régénérez-le`);
  await writeFile(destination, Buffer.from(await r.arrayBuffer()));
}

let indexOriginaux = null;
async function trouverOriginalLocal(photo) {
  if (!indexOriginaux) {
    indexOriginaux = new Map();
    const parcourir = async (dossier) => {
      for (const e of await readdir(dossier, { withFileTypes: true })) {
        const c = join(dossier, e.name);
        if (e.isDirectory()) await parcourir(c);
        else indexOriginaux.set(e.name.toLowerCase(), c);
      }
    };
    await parcourir(resolve(opt.originaux));
  }
  return indexOriginaux.get(photo.blobOriginal.toLowerCase()) || indexOriginaux.get(photo.nomFichier.toLowerCase()) || null;
}

let conteneurAnnotees = null;
async function envoyerBlob(fichier, nomBlob) {
  if (!conteneurAnnotees) {
    const cnx = process.env.STORAGE_CONNECTION_STRING;
    if (!cnx) throw new Error("STORAGE_CONNECTION_STRING n'est pas défini");
    const { BlobServiceClient } = await import("@azure/storage-blob");
    conteneurAnnotees = BlobServiceClient.fromConnectionString(cnx).getContainerClient("annotees");
    await conteneurAnnotees.createIfNotExists();
  }
  const types = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".tif": "image/tiff", ".tiff": "image/tiff", ".webp": "image/webp" };
  await conteneurAnnotees.getBlockBlobClient(nomBlob).uploadFile(fichier, {
    blobHTTPHeaders: { blobContentType: types[extname(fichier).toLowerCase()] || "application/octet-stream" },
  });
}

// --- Programme principal ----------------------------------------------------------------------------

async function principal() {
  const donnees = JSON.parse(await readFile(opt.export, "utf8"));
  let photos = donnees.photos || [];
  if (opt.photo?.length) photos = photos.filter((p) => opt.photo.includes(p.id));
  if (!photos.length) {
    console.log("Aucune photo à traiter.");
    return;
  }
  const options = {
    villeDefaut: opt["ville-defaut"],
    paysDefaut: opt["pays-defaut"],
    motsCles: opt["mots-cles"].split(",").map((s) => s.trim()).filter(Boolean),
  };

  if (opt["dry-run"]) {
    console.log(`Mode --dry-run : ${photos.length} photo(s), rien n'est téléchargé ni modifié.\n`);
    for (const p of photos) {
      console.log(`■ ${p.nomFichier} (${p.id})`);
      const b = construireBalises(p, {}, options);
      if (!Object.keys(b).length) console.log("   (aucune valeur validée)");
      for (const [k, v] of Object.entries(b)) console.log(`   ${k.padEnd(34)} ${typeof v === "string" ? v : JSON.stringify(v)}`);
      console.log();
    }
    return;
  }

  try {
    await exec(opt.exiftool, ["-ver"]);
  } catch {
    console.error(`ExifTool introuvable (« ${opt.exiftool} »). Installez-le : https://exiftool.org/install.html`);
    process.exit(1);
  }

  const sortie = resolve(opt.sortie);
  const travail = join(sortie, ".travail");
  await mkdir(travail, { recursive: true });
  let ok = 0, erreurs = 0, ignorees = 0;

  for (const p of photos) {
    const nom = nomSur(p.nomFichier || p.blobOriginal);
    const ext = extname(p.blobOriginal) || extname(nom);
    const cible = join(sortie, `${basename(nom, extname(nom))}_${p.id}${ext}`);
    try {
      if ((await existe(cible)) && !opt.ecraser) {
        console.log(`– ${nom} : déjà présent dans la sortie (utilisez --ecraser pour le refaire)`);
        ignorees++;
        continue;
      }
      // 1. Source : original local (lu seulement) ou copie téléchargée.
      let source;
      if (opt.originaux) {
        source = await trouverOriginalLocal(p);
        if (!source) throw new Error(`original introuvable dans ${opt.originaux}`);
      } else {
        source = join(travail, `${p.id}${ext}`);
        await telecharger(p.urlOriginal, source);
      }
      // 2. Balises, fusionnées avec les métadonnées existantes.
      const existant = await lireMetadonnees(source);
      if (existant.Orientation && existant.Orientation >= 5) {
        console.warn(`  ⚠ ${nom} : image pivotée par EXIF (Orientation=${existant.Orientation}) ; vérifiez la position des visages.`);
      }
      const balises = construireBalises(p, existant, { ...options, largeur: existant.ImageWidth, hauteur: existant.ImageHeight });
      if (!Object.keys(balises).length) {
        console.log(`– ${nom} : aucune valeur validée, ignorée`);
        ignorees++;
        continue;
      }
      const fichierJson = join(travail, `${p.id}.json`);
      await writeFile(fichierJson, JSON.stringify([{ SourceFile: "*", ...balises }]));
      // 3. ExifTool écrit un NOUVEAU fichier (-o) : la source n'est jamais modifiée.
      if (await existe(cible)) await rm(cible);
      await exec(opt.exiftool, ["-m", "-q", "-charset", "iptc=utf8", `-j=${fichierJson}`, "-o", cible, source]);
      if (opt.destination === "blob") await envoyerBlob(cible, p.blobOriginal);
      console.log(`✓ ${nom} → ${cible}${opt.destination === "blob" ? " (+ annotees/" + p.blobOriginal + ")" : ""}`);
      ok++;
    } catch (e) {
      console.error(`✗ ${nom} : ${e.stderr?.toString().trim() || e.message}`);
      erreurs++;
    }
  }
  await rm(travail, { recursive: true, force: true });
  console.log(`\nTerminé : ${ok} écrite(s), ${ignorees} ignorée(s), ${erreurs} erreur(s).`);
  if (erreurs) process.exitCode = 1;
}

principal().catch((e) => {
  console.error(e);
  process.exit(1);
});
