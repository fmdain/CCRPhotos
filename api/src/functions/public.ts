import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { accepterEnvoi, CHAMP_PIEGE, estRobot, verifierTurnstile } from "../lib/antispam";
import { lireConfig, secret } from "../lib/config";
import { Champ, cleContributeur, consensusPublic, Contribution } from "../lib/consensus";
import { cleDate, interpreterDate } from "../lib/dates";
import {
  COOKIE_ACCES, comparerSecret, controlerAcces, corpsJson, erreur, estAdmin, ipClient, jetonAcces, jetonValide, json, principal,
} from "../lib/http";
import { consensusDe, lirePhoto, listerPhotos, rafraichirResume, vuePhotoListe } from "../lib/photos";
import {
  CONTENEURS, listerTout, lire, PK_LIEU, PK_RETRAIT, table, TABLES, urlLecture, versEntiteContribution,
} from "../lib/stockage";
import { borner01, arrondir, estEmailPlausible, hacherIp, nettoyer, normaliser, ulid } from "../lib/util";

const VALEUR_AUTRE = "__autre__";

function empreinteIp(req: HttpRequest): string {
  return hacherIp(ipClient(req), secret("IP_HASH_SECRET", "dev"));
}

// --- Configuration publique -------------------------------------------------

app.http("config", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "config",
  handler: async (req) => {
    const c = lireConfig();
    const p = principal(req);
    return json(200, {
      nomSite: c.nomSite,
      sections: c.sections,
      valeurAutre: VALEUR_AUTRE,
      votesMinimum: c.consensus.votesMinimum,
      turnstile: c.antispam.turnstile.actif ? { cleSite: c.antispam.turnstile.cleSite } : null,
      champPiege: CHAMP_PIEGE,
      acces: {
        mode: c.acces.mode,
        autorise: controlerAcces(req) === null,
      },
      utilisateur: p ? { nom: p.userDetails, admin: p.userRoles.includes("admin") } : null,
      contact: c.contact,
      conservation: c.conservation,
    });
  },
});

// --- Accès par mot de passe commun -----------------------------------------

app.http("acces", {
  methods: ["POST", "DELETE"],
  authLevel: "anonymous",
  route: "acces",
  handler: async (req) => {
    const effacer = `${COOKIE_ACCES}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
    if (req.method === "DELETE") return json(200, { ok: true }, { "Set-Cookie": effacer });
    if (lireConfig().acces.mode !== "motdepasse") return erreur(400, "Le site n'est pas protégé par mot de passe.");
    if (!(await accepterEnvoi(empreinteIp(req)))) return erreur(429, "Trop d'essais, réessayez dans quelques minutes.");
    const corps = await corpsJson<{ motDePasse?: string }>(req);
    const attendu = secret("ACCESS_PASSWORD", "");
    if (!attendu) return erreur(500, "Mot de passe non configuré (ACCESS_PASSWORD).");
    if (!corps?.motDePasse || !comparerSecret(corps.motDePasse, attendu)) return erreur(403, "Mot de passe incorrect.");
    const j = jetonAcces();
    return json(200, { ok: true }, {
      "Set-Cookie": `${COOKIE_ACCES}=${encodeURIComponent(j.valeur)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${j.maxAge}`,
    });
  },
});

app.http("accesStatut", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "acces/statut",
  handler: async (req) => json(200, { autorise: controlerAcces(req) === null, jeton: jetonValide(req) }),
});

// --- Galerie ------------------------------------------------------------------

app.http("photosListe", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "photos",
  handler: async (req) => {
    const refus = controlerAcces(req);
    if (refus) return refus;
    const statut = req.query.get("statut") || "";
    const section = req.query.get("section") || "";
    const photos = (await listerPhotos())
      .filter((p) => !p.masquee)
      .filter((p) => !statut || (p.statut || "a_identifier") === statut)
      .filter((p) => !section || normaliser(p.sectionValidee || "") === normaliser(section))
      .sort((a, b) => b.rowKey.localeCompare(a.rowKey));
    const vues = await Promise.all(photos.map(vuePhotoListe));
    return json(200, { photos: vues.map(({ masquee, ...v }) => v) });
  },
});

app.http("photoDetail", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "photos/{id}",
  handler: async (req) => {
    const refus = controlerAcces(req);
    if (refus) return refus;
    const photo = await lirePhoto(req.params.id);
    if (!photo || (photo.masquee && !estAdmin(req))) return erreur(404, "Photo introuvable.");
    const c = await consensusDe(photo);
    return json(200, {
      id: photo.rowKey,
      image: await urlLecture(CONTENEURS.affichage, photo.blobAffichage),
      largeur: photo.largeur,
      hauteur: photo.hauteur,
      consensus: consensusPublic(c),
    });
  },
});

// --- Interprétation des dates (aperçu dans le formulaire) ------------------

app.http("datesInterpreter", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "dates/interpreter",
  handler: async (req) => {
    const texte = nettoyer(req.query.get("texte"), 100);
    return json(200, interpreterDate(texte));
  },
});

// --- Suggestions de lieux -----------------------------------------------------

app.http("lieux", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "lieux",
  handler: async (req) => {
    const refus = controlerAcces(req);
    if (refus) return refus;
    const lieux = await listerTout<{ libelle: string; usages: number }>(table(TABLES.lieux));
    lieux.sort((a, b) => (b.usages || 0) - (a.usages || 0));
    return json(200, { lieux: lieux.slice(0, 300).map((l) => l.libelle) }, { "Cache-Control": "private, max-age=60" });
  },
});

async function compterLieu(libelle: string): Promise<void> {
  const cle = normaliser(libelle).slice(0, 200);
  if (!cle) return;
  const t = table(TABLES.lieux);
  const e = await lire<{ libelle: string; usages: number }>(t, PK_LIEU, cle);
  await t.upsertEntity({ partitionKey: PK_LIEU, rowKey: cle, libelle: e?.libelle || libelle, usages: (e?.usages || 0) + 1 }, "Replace");
}

// --- Contributions ------------------------------------------------------------

interface CorpsContribution {
  prenom?: string;
  nom?: string;
  email?: string;
  date?: string;
  lieu?: string;
  section?: string;
  sectionAutre?: string;
  personnes?: { x?: number; y?: number; w?: number; h?: number; nom?: string }[];
  commentaire?: string;
  turnstile?: string;
  [cle: string]: unknown;
}

app.http("contribuer", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "photos/{id}/contributions",
  handler: async (req: HttpRequest, ctx: InvocationContext): Promise<HttpResponseInit> => {
    const refus = controlerAcces(req);
    if (refus) return refus;
    const corps = await corpsJson<CorpsContribution>(req);
    if (!corps) return erreur(400, "Requête invalide.");
    const photo = await lirePhoto(req.params.id);
    if (!photo || photo.masquee) return erreur(404, "Photo introuvable.");

    // Robot : on fait semblant d'accepter, sans rien enregistrer.
    if (estRobot(corps)) return json(200, { ok: true, enregistrees: 0 });

    const prenom = nettoyer(corps.prenom, 60);
    const nom = nettoyer(corps.nom, 60);
    const email = nettoyer(corps.email, 120);
    if (!prenom || !nom) return erreur(400, "Merci d'indiquer votre prénom et votre nom.");
    if (email && !estEmailPlausible(email)) return erreur(400, "L'adresse email semble invalide.");

    const ip = ipClient(req);
    if (!(await verifierTurnstile(corps.turnstile, ip))) return erreur(400, "La vérification anti-robot a échoué.");
    const ipHash = empreinteIp(req);
    if (!(await accepterEnvoi(ipHash))) {
      return erreur(429, "Vous avez envoyé beaucoup de contributions. Merci de patienter quelques minutes.");
    }

    const conf = lireConfig();
    const soumission = ulid();
    const maintenant = Date.now();
    const creeLe = new Date(maintenant).toISOString();
    const lignes: Contribution[] = [];
    const ajouter = (champ: Champ, valeur: Contribution["valeur"], cle: string) =>
      lignes.push({
        rowKey: ulid(maintenant + lignes.length), // ordre stable au sein d'un envoi
        photoId: photo.rowKey, soumission, champ, valeur, cle, prenom, nom, email, ipHash, creeLe,
      });

    const texteDate = nettoyer(corps.date, 100);
    if (texteDate) {
      const normalisee = interpreterDate(texteDate);
      ajouter("date", { texte: texteDate, normalisee }, cleDate(normalisee, texteDate));
    }
    const lieu = nettoyer(corps.lieu, 200);
    if (lieu) ajouter("lieu", { texte: lieu }, normaliser(lieu));

    if (corps.section) {
      if (corps.section === VALEUR_AUTRE) {
        const autre = nettoyer(corps.sectionAutre, 80);
        if (autre) ajouter("section", { texte: autre, autre: true }, normaliser(autre));
      } else {
        const s = conf.sections.find((x) => x === corps.section);
        if (!s) return erreur(400, "Section inconnue.");
        ajouter("section", { texte: s, autre: false }, normaliser(s));
      }
    }

    const personnes = Array.isArray(corps.personnes) ? corps.personnes.slice(0, 40) : [];
    for (const p of personnes) {
      const n = nettoyer(p?.nom, 100);
      let x = borner01(p?.x), y = borner01(p?.y);
      let w = borner01(p?.w) ?? 0, h = borner01(p?.h) ?? 0;
      if (!n || x === null || y === null) continue;
      if (w > 0 && h > 0) {
        w = Math.min(w, 1 - x);
        h = Math.min(h, 1 - y);
      } else {
        w = 0;
        h = 0;
      }
      ajouter("personne", { nom: n, x: arrondir(x), y: arrondir(y), w: arrondir(w), h: arrondir(h) }, normaliser(n));
    }

    const commentaire = nettoyer(corps.commentaire, 2000);
    if (commentaire) ajouter("commentaire", { texte: commentaire }, "");

    if (!lignes.length) return erreur(400, "Renseignez au moins une information.");

    const t = table(TABLES.contributions);
    // Toutes les lignes d'un envoi partagent la même partition : une transaction suffit.
    await t.submitTransaction(lignes.map((l) => ["create", versEntiteContribution(l)]));
    if (lieu) await compterLieu(lieu).catch((e) => ctx.warn("Lieux", e));

    const c = await rafraichirResume(photo);
    ctx.log(`Contribution ${soumission} : ${lignes.length} valeur(s) pour ${photo.rowKey} (${cleContributeur({ prenom, nom })})`);
    return json(201, { ok: true, enregistrees: lignes.length, consensus: consensusPublic(c) });
  },
});

// --- Demandes de retrait (RGPD) ---------------------------------------------

app.http("retrait", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "photos/{id}/retrait",
  handler: async (req) => {
    const corps = await corpsJson<Record<string, unknown>>(req);
    if (!corps) return erreur(400, "Requête invalide.");
    const photo = await lirePhoto(req.params.id);
    if (!photo) return erreur(404, "Photo introuvable.");
    if (estRobot(corps)) return json(200, { ok: true });
    const prenom = nettoyer(corps.prenom, 60);
    const nom = nettoyer(corps.nom, 60);
    const email = nettoyer(corps.email, 120);
    const type = corps.type === "nom" ? "nom" : "photo";
    const nomConcerne = nettoyer(corps.nomConcerne, 100);
    const message = nettoyer(corps.message, 2000);
    if (!prenom || !nom) return erreur(400, "Merci d'indiquer votre prénom et votre nom.");
    if (!email || !estEmailPlausible(email)) return erreur(400, "Une adresse email est nécessaire pour vous répondre.");
    if (type === "nom" && !nomConcerne) return erreur(400, "Indiquez le nom à retirer.");
    const ipHash = empreinteIp(req);
    if (!(await accepterEnvoi(ipHash))) return erreur(429, "Merci de patienter quelques minutes.");
    await table(TABLES.retraits).createEntity({
      partitionKey: PK_RETRAIT,
      rowKey: ulid(),
      photoId: photo.rowKey,
      type,
      nomConcerne,
      message,
      prenom,
      nom,
      email,
      ipHash,
      statut: "nouvelle",
      creeLe: new Date().toISOString(),
    });
    return json(201, { ok: true });
  },
});
