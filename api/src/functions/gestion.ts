/**
 * Routes d'administration. Le préfixe « admin » est réservé par Azure Functions,
 * d'où « /api/gestion/... ». Elles sont protégées deux fois : par staticwebapp.config.json
 * (rôle « admin ») et ici, par la vérification du rôle transmis par Static Web Apps.
 */
import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { odata } from "@azure/data-tables";
import { ActionModeration, Champ, CHAMPS } from "../lib/consensus";
import { corpsJson, erreur, estAdmin, json, principal } from "../lib/http";
import {
  consensusDe, exportCsv, ligneExport, lirePhoto, listerPhotos, rafraichirResume, vuePhotoListe,
} from "../lib/photos";
import {
  CONTENEURS, conteneur, contributionsDe, EntitePhoto, journaliser, lire, listerTout, PK_PHOTO, PK_RETRAIT, table,
  TABLES, toutesContributions, urlEcriture, urlLecture,
} from "../lib/stockage";
import { borner01, nettoyer, ulid } from "../lib/util";

type Gestionnaire = (req: HttpRequest, ctx: InvocationContext, admin: string) => Promise<HttpResponseInit>;

function route(nom: string, methods: ("GET" | "POST" | "DELETE")[], chemin: string, fn: Gestionnaire) {
  app.http(nom, {
    methods,
    authLevel: "anonymous",
    route: `gestion/${chemin}`,
    handler: async (req, ctx) => {
      if (!estAdmin(req)) return erreur(403, "Réservé aux administrateurs.");
      try {
        return await fn(req, ctx, principal(req)!.userDetails || principal(req)!.userId);
      } catch (e) {
        ctx.error(e);
        return erreur(500, "Erreur interne.");
      }
    },
  });
}

const EXTENSIONS = new Set(["jpg", "jpeg", "png", "webp", "tif", "tiff", "heic", "gif"]);

function extension(nomFichier: string): string {
  const e = (nomFichier.split(".").pop() || "").toLowerCase();
  return EXTENSIONS.has(e) ? e : "bin";
}

// --- Photos ---------------------------------------------------------------------

route("gestionPhotos", ["GET"], "photos", async () => {
  const photos = (await listerPhotos()).sort((a, b) => b.rowKey.localeCompare(a.rowKey));
  return json(200, { photos: await Promise.all(photos.map(vuePhotoListe)) });
});

/** Étape 1 de l'envoi : réserve un identifiant et fournit des URL d'écriture directe dans Blob Storage. */
route("gestionTeleversement", ["POST"], "televersement", async (req) => {
  const corps = await corpsJson<{ fichiers?: { nomFichier?: string }[] }>(req);
  const fichiers = corps?.fichiers;
  if (!Array.isArray(fichiers) || !fichiers.length || fichiers.length > 50) {
    return erreur(400, "Entre 1 et 50 fichiers par lot.");
  }
  const res = await Promise.all(
    fichiers.map(async (f) => {
      const nomFichier = nettoyer(f.nomFichier, 200) || "photo.jpg";
      const id = ulid();
      const blobOriginal = `${id}.${extension(nomFichier)}`;
      const blobJpg = `${id}.jpg`;
      return {
        photoId: id,
        nomFichier,
        original: { blob: blobOriginal, url: await urlEcriture(CONTENEURS.originaux, blobOriginal) },
        affichage: { blob: blobJpg, url: await urlEcriture(CONTENEURS.affichage, blobJpg) },
        miniature: { blob: blobJpg, url: await urlEcriture(CONTENEURS.miniatures, blobJpg) },
      };
    }),
  );
  return json(200, { televersements: res });
});

/** Étape 2 : enregistre la photo une fois les trois fichiers envoyés. */
route("gestionPhotoCreer", ["POST"], "photos", async (req, _ctx, admin) => {
  const c = await corpsJson<{
    photoId?: string; nomFichier?: string; blobOriginal?: string; largeur?: number; hauteur?: number; lot?: string;
  }>(req);
  if (!c?.photoId || !/^[0-9A-Z]{26}$/.test(c.photoId)) return erreur(400, "Identifiant invalide.");
  const blobOriginal = nettoyer(c.blobOriginal, 60);
  if (!blobOriginal.startsWith(c.photoId + ".")) return erreur(400, "Fichier original invalide.");
  const blobJpg = `${c.photoId}.jpg`;
  const [o, a, m] = await Promise.all([
    conteneur(CONTENEURS.originaux).getBlobClient(blobOriginal).exists(),
    conteneur(CONTENEURS.affichage).getBlobClient(blobJpg).exists(),
    conteneur(CONTENEURS.miniatures).getBlobClient(blobJpg).exists(),
  ]);
  if (!o || !a || !m) return erreur(400, "Les fichiers n'ont pas tous été reçus.");
  const largeur = Math.round(Number(c.largeur) || 0);
  const hauteur = Math.round(Number(c.hauteur) || 0);
  const entite: EntitePhoto = {
    partitionKey: PK_PHOTO,
    rowKey: c.photoId,
    nomFichier: nettoyer(c.nomFichier, 200),
    blobOriginal,
    blobAffichage: blobJpg,
    blobMiniature: blobJpg,
    largeur,
    hauteur,
    lot: nettoyer(c.lot, 100),
    televerseeLe: new Date().toISOString(),
    televerseePar: admin,
    masquee: false,
    statut: "a_identifier",
    nbContributions: 0,
  };
  await table(TABLES.photos).upsertEntity(entite, "Replace");
  return json(201, { ok: true, id: c.photoId });
});

route("gestionPhotoDetail", ["GET"], "photos/{id}", async (req) => {
  const photo = await lirePhoto(req.params.id);
  if (!photo) return erreur(404, "Photo introuvable.");
  const [c, contribs, journal] = await Promise.all([
    consensusDe(photo),
    contributionsDe(photo.rowKey),
    listerTout<Record<string, unknown>>(table(TABLES.moderation), odata`PartitionKey eq ${photo.rowKey}`),
  ]);
  return json(200, {
    photo: { ...(await vuePhotoListe(photo)), nomFichier: photo.nomFichier, image: await urlLecture(CONTENEURS.affichage, photo.blobAffichage) },
    consensus: c,
    contributions: contribs.sort((a, b) => b.rowKey.localeCompare(a.rowKey)),
    journal: journal
      .map((j) => ({ rowKey: j.rowKey, champ: j.champ, action: j.action, cle: j.cle, admin: j.admin, creeLe: j.creeLe }))
      .sort((a, b) => String(b.rowKey).localeCompare(String(a.rowKey))),
  });
});

/** Valider, rejeter ou annuler une décision sur une valeur. */
route("gestionDecision", ["POST"], "photos/{id}/decisions", async (req, _ctx, admin) => {
  const photo = await lirePhoto(req.params.id);
  if (!photo) return erreur(404, "Photo introuvable.");
  const c = await corpsJson<{ champ?: string; action?: string; cle?: string; x?: number; y?: number }>(req);
  if (!c || !CHAMPS.includes(c.champ as Champ)) return erreur(400, "Champ invalide.");
  if (!["valider", "rejeter", "annuler"].includes(c.action || "")) return erreur(400, "Action invalide.");
  if (typeof c.cle !== "string") return erreur(400, "Valeur manquante.");
  const x = borner01(c.x), y = borner01(c.y);
  if (c.champ === "personne" && (x === null || y === null)) return erreur(400, "Position du repère manquante.");
  await journaliser(photo.rowKey, {
    rowKey: ulid(),
    champ: c.champ!,
    action: c.action as ActionModeration,
    cle: c.cle.slice(0, 200),
    ...(c.champ === "personne" ? { x: x!, y: y! } : {}),
    admin,
    creeLe: new Date().toISOString(),
  });
  const consensus = await rafraichirResume(photo);
  return json(200, { ok: true, consensus });
});

route("gestionMasquer", ["POST"], "photos/{id}/masquer", async (req, _ctx, admin) => {
  const photo = await lirePhoto(req.params.id);
  if (!photo) return erreur(404, "Photo introuvable.");
  const c = await corpsJson<{ masquee?: boolean }>(req);
  const masquee = !!c?.masquee;
  await table(TABLES.photos).updateEntity({ partitionKey: PK_PHOTO, rowKey: photo.rowKey, masquee }, "Merge");
  await journaliser(photo.rowKey, {
    rowKey: ulid(), champ: "photo", action: masquee ? "masquer" : "afficher", cle: "", admin, creeLe: new Date().toISOString(),
  });
  return json(200, { ok: true, masquee });
});

/** Suppression définitive d'une photo (fichiers + contributions), par exemple suite à une demande de retrait. */
route("gestionPhotoSupprimer", ["DELETE"], "photos/{id}", async (req, _ctx, admin) => {
  const photo = await lirePhoto(req.params.id);
  if (!photo) return erreur(404, "Photo introuvable.");
  await Promise.all([
    conteneur(CONTENEURS.originaux).deleteBlob(photo.blobOriginal).catch(() => undefined),
    conteneur(CONTENEURS.affichage).deleteBlob(photo.blobAffichage).catch(() => undefined),
    conteneur(CONTENEURS.miniatures).deleteBlob(photo.blobMiniature).catch(() => undefined),
    conteneur(CONTENEURS.annotees).deleteBlob(photo.blobOriginal).catch(() => undefined),
  ]);
  const t = table(TABLES.contributions);
  for (const c of await contributionsDe(photo.rowKey)) await t.deleteEntity(photo.rowKey, c.rowKey);
  await table(TABLES.photos).deleteEntity(PK_PHOTO, photo.rowKey);
  await journaliser(photo.rowKey, {
    rowKey: ulid(), champ: "photo", action: "supprimer", cle: photo.nomFichier, admin, creeLe: new Date().toISOString(),
  });
  return json(200, { ok: true });
});

// --- Contributions ----------------------------------------------------------------

route("gestionContributions", ["GET"], "contributions", async (req) => {
  const jours = Math.min(365, Math.max(1, parseInt(req.query.get("jours") || "30", 10) || 30));
  const l = await toutesContributions(new Date(Date.now() - jours * 86400_000));
  l.sort((a, b) => b.rowKey.localeCompare(a.rowKey));
  return json(200, { contributions: l.slice(0, 500) });
});

/**
 * Supprime une contribution. Par défaut elle est seulement marquée « supprimée »
 * (exclue du consensus, conservée pour l'historique) ; ?definitif=1 l'efface (RGPD).
 */
route("gestionContributionSupprimer", ["DELETE"], "photos/{id}/contributions/{rk}", async (req, _ctx, admin) => {
  const photo = await lirePhoto(req.params.id);
  if (!photo) return erreur(404, "Photo introuvable.");
  const t = table(TABLES.contributions);
  const rk = req.params.rk;
  const e = await lire(t, photo.rowKey, rk);
  if (!e) return erreur(404, "Contribution introuvable.");
  const definitif = req.query.get("definitif") === "1";
  if (definitif) await t.deleteEntity(photo.rowKey, rk);
  else await t.updateEntity({ partitionKey: photo.rowKey, rowKey: rk, supprimee: true }, "Merge");
  await journaliser(photo.rowKey, {
    rowKey: ulid(), champ: "contribution", action: definitif ? "effacer" : "supprimer", cle: rk, admin, creeLe: new Date().toISOString(),
  });
  const consensus = await rafraichirResume(photo);
  return json(200, { ok: true, consensus });
});

// --- Demandes de retrait -----------------------------------------------------------

route("gestionRetraits", ["GET"], "retraits", async () => {
  const l = await listerTout<Record<string, unknown>>(table(TABLES.retraits));
  l.sort((a, b) => String(b.rowKey).localeCompare(String(a.rowKey)));
  return json(200, {
    demandes: l.map(({ partitionKey, etag, timestamp, ipHash, ...reste }) => reste),
  });
});

route("gestionRetraitStatut", ["POST"], "retraits/{rk}", async (req, _ctx, admin) => {
  const c = await corpsJson<{ statut?: string; note?: string }>(req);
  const statut = ["nouvelle", "en_cours", "traitee", "refusee"].includes(c?.statut || "") ? c!.statut! : null;
  if (!statut) return erreur(400, "Statut invalide.");
  const t = table(TABLES.retraits);
  const e = await lire(t, PK_RETRAIT, req.params.rk);
  if (!e) return erreur(404, "Demande introuvable.");
  await t.updateEntity(
    { partitionKey: PK_RETRAIT, rowKey: req.params.rk, statut, note: nettoyer(c?.note, 1000), traiteePar: admin, traiteeLe: new Date().toISOString() },
    "Merge",
  );
  return json(200, { ok: true });
});

// --- Export ---------------------------------------------------------------------------

route("gestionExport", ["GET"], "export", async (req) => {
  const format = req.query.get("format") === "csv" ? "csv" : "json";
  const inclureMasquees = req.query.get("masquees") === "1";
  const toutes = req.query.get("toutes") === "1";
  const photos = (await listerPhotos()).filter((p) => inclureMasquees || !p.masquee);
  const lignes = [];
  for (const p of photos) {
    const c = await consensusDe(p);
    const l = await ligneExport(p, c);
    if (toutes || l.date || l.lieu || l.section || l.personnes.length || l.commentaires.length) lignes.push(l);
  }
  const horodatage = new Date().toISOString().slice(0, 10);
  if (format === "csv") {
    return {
      status: 200,
      body: exportCsv(lignes),
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="ccr-metadonnees-${horodatage}.csv"`,
        "Cache-Control": "no-store",
      },
    };
  }
  return json(
    200,
    { genereLe: new Date().toISOString(), version: 1, photos: lignes },
    { "Content-Disposition": `attachment; filename="ccr-metadonnees-${horodatage}.json"` },
  );
});
