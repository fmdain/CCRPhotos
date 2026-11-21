import { lireConfig } from "./config";
import { calculerConsensus, Consensus, ValeurDate, ValeurPersonne } from "./consensus";
import {
  CONTENEURS, contributionsDe, decisionsDe, EntitePhoto, lire, listerTout, PK_PHOTO, table, TABLES, urlLecture,
} from "./stockage";

export async function lirePhoto(id: string): Promise<EntitePhoto | null> {
  if (!/^[0-9A-Z]{26}$/.test(id)) return null;
  return lire<EntitePhoto>(table(TABLES.photos), PK_PHOTO, id);
}

export async function listerPhotos(): Promise<EntitePhoto[]> {
  return listerTout<EntitePhoto>(table(TABLES.photos));
}

export function parametres(photo: Pick<EntitePhoto, "largeur" | "hauteur">) {
  const c = lireConfig().consensus;
  return { ...c, largeur: photo.largeur, hauteur: photo.hauteur };
}

export async function consensusDe(photo: EntitePhoto): Promise<Consensus> {
  const [contribs, decisions] = await Promise.all([contributionsDe(photo.rowKey), decisionsDe(photo.rowKey)]);
  return calculerConsensus(contribs, decisions, parametres(photo));
}

/** Recalcule le consensus et met à jour le résumé stocké sur la photo (utilisé par la galerie). */
export async function rafraichirResume(photo: EntitePhoto): Promise<Consensus> {
  const c = await consensusDe(photo);
  const date = c.date.validee?.valeur as ValeurDate | undefined;
  await table(TABLES.photos).updateEntity(
    {
      partitionKey: PK_PHOTO,
      rowKey: photo.rowKey,
      statut: c.statut,
      sectionValidee: c.section.validee?.libelle ?? "",
      dateValidee: date?.normalisee?.libelle ?? "",
      dateTri: date?.normalisee?.debut ?? "",
      nbContributions: c.nbContributions,
      majLe: new Date().toISOString(),
    },
    "Merge",
  );
  return c;
}

export async function vuePhotoListe(p: EntitePhoto) {
  return {
    id: p.rowKey,
    miniature: await urlLecture(CONTENEURS.miniatures, p.blobMiniature),
    largeur: p.largeur,
    hauteur: p.hauteur,
    statut: p.statut || "a_identifier",
    section: p.sectionValidee || "",
    date: p.dateValidee || "",
    dateTri: p.dateTri || "",
    nbContributions: p.nbContributions || 0,
    televerseeLe: p.televerseeLe,
    masquee: !!p.masquee,
    lot: p.lot || "",
  };
}

/** Sépare « Lieu, Ville, Pays » pour les champs IPTC. */
export function decouperLieu(lieu: string): { lieu: string; ville: string; pays: string } {
  const parties = lieu.split(",").map((s) => s.trim()).filter(Boolean);
  if (parties.length >= 3) return { lieu: parties.slice(0, -2).join(", "), ville: parties[parties.length - 2], pays: parties[parties.length - 1] };
  if (parties.length === 2) return { lieu: parties[0], ville: parties[1], pays: "" };
  return { lieu: lieu.trim(), ville: "", pays: "" };
}

export interface LigneExport {
  id: string;
  nomFichier: string;
  blobOriginal: string;
  urlOriginal: string;
  largeur: number;
  hauteur: number;
  statut: string;
  date: null | { texte: string; precision: string; valeur: string | null; environ: boolean; libelle: string };
  lieu: string;
  section: string;
  personnes: { nom: string; x: number; y: number; w: number; h: number; forme: string }[];
  commentaires: string[];
}

export async function ligneExport(p: EntitePhoto, c: Consensus): Promise<LigneExport> {
  const d = c.date.validee?.valeur as ValeurDate | undefined;
  return {
    id: p.rowKey,
    nomFichier: p.nomFichier,
    blobOriginal: p.blobOriginal,
    // Lien de téléchargement valable 24 h, utilisé par le script ExifTool.
    urlOriginal: await urlLecture(CONTENEURS.originaux, p.blobOriginal, 24),
    largeur: p.largeur,
    hauteur: p.hauteur,
    statut: c.statut,
    date: d
      ? {
          texte: d.texte,
          precision: d.normalisee.precision,
          valeur: d.normalisee.valeur,
          environ: d.normalisee.environ,
          libelle: d.normalisee.libelle || d.texte,
        }
      : null,
    lieu: c.lieu.validee?.libelle ?? "",
    section: c.section.validee?.libelle ?? "",
    personnes: c.personnes
      .filter((g) => g.nomValide)
      .map((g) => ({ nom: g.nomValide!, x: g.x, y: g.y, w: g.w, h: g.h, forme: g.forme })),
    commentaires: c.commentaires.filter((m) => m.statut === "validee").map((m) => m.texte),
  };
}

export function exportCsv(lignes: LigneExport[]): string {
  const echapper = (v: unknown) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const entetes = [
    "id", "nomFichier", "statut", "dateTexte", "datePrecision", "dateValeur", "dateEnviron",
    "lieu", "section", "personnes", "commentaires", "blobOriginal",
  ];
  const lignesCsv = lignes.map((l) =>
    [
      l.id, l.nomFichier, l.statut, l.date?.texte, l.date?.precision, l.date?.valeur, l.date ? (l.date.environ ? "oui" : "non") : "",
      l.lieu, l.section,
      l.personnes.map((p) => `${p.nom} (${p.x};${p.y};${p.w};${p.h})`).join(" | "),
      l.commentaires.join(" | "),
      l.blobOriginal,
    ].map(echapper).join(";"),
  );
  // BOM pour qu'Excel ouvre correctement les accents.
  return "﻿" + [entetes.join(";"), ...lignesCsv].join("\r\n") + "\r\n";
}

export type { ValeurPersonne };
