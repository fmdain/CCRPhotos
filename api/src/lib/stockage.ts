import { TableClient, TableEntityResult, odata } from "@azure/data-tables";
import { BlobSASPermissions, BlobServiceClient, ContainerClient } from "@azure/storage-blob";
import { secret } from "./config";
import { Contribution, Decision } from "./consensus";

export const TABLES = {
  photos: "Photos",
  contributions: "Contributions",
  moderation: "Moderation",
  retraits: "Retraits",
  lieux: "Lieux",
  debit: "Debit",
} as const;

export const CONTENEURS = {
  originaux: "originaux",
  affichage: "affichage",
  miniatures: "miniatures",
  annotees: "annotees",
} as const;

export const PK_PHOTO = "photo";
export const PK_RETRAIT = "demande";
export const PK_LIEU = "lieu";

function connexion(): string {
  return secret("STORAGE_CONNECTION_STRING");
}

const tables = new Map<string, TableClient>();
export function table(nom: string): TableClient {
  let t = tables.get(nom);
  if (!t) {
    t = TableClient.fromConnectionString(connexion(), nom, { allowInsecureConnection: true });
    tables.set(nom, t);
  }
  return t;
}

let blobService: BlobServiceClient | null = null;
export function conteneur(nom: string): ContainerClient {
  if (!blobService) blobService = BlobServiceClient.fromConnectionString(connexion());
  return blobService.getContainerClient(nom);
}

/**
 * URL signée en lecture. L'expiration est arrondie à l'heure pour que l'URL reste
 * identique pendant un moment et profite du cache du navigateur.
 */
export async function urlLecture(nomConteneur: string, blob: string, heures = 2): Promise<string> {
  const h = 3600_000;
  const expire = new Date(Math.ceil(Date.now() / h) * h + heures * h);
  return conteneur(nomConteneur).getBlobClient(blob).generateSasUrl({
    permissions: BlobSASPermissions.parse("r"),
    expiresOn: expire,
  });
}

export async function urlEcriture(nomConteneur: string, blob: string, minutes = 60): Promise<string> {
  return conteneur(nomConteneur).getBlobClient(blob).generateSasUrl({
    permissions: BlobSASPermissions.parse("cw"),
    expiresOn: new Date(Date.now() + minutes * 60_000),
  });
}

export async function listerTout<T extends object>(t: TableClient, filtre?: string): Promise<TableEntityResult<T>[]> {
  const res: TableEntityResult<T>[] = [];
  const it = t.listEntities<T>(filtre ? { queryOptions: { filter: filtre } } : undefined);
  for await (const e of it) res.push(e);
  return res;
}

export function estIntrouvable(e: unknown): boolean {
  return (e as { statusCode?: number })?.statusCode === 404;
}

export async function lire<T extends object>(t: TableClient, pk: string, rk: string): Promise<TableEntityResult<T> | null> {
  try {
    return await t.getEntity<T>(pk, rk);
  } catch (e) {
    if (estIntrouvable(e)) return null;
    throw e;
  }
}

// --- Photos -----------------------------------------------------------------

export interface EntitePhoto {
  partitionKey: string;
  rowKey: string;
  nomFichier: string;
  blobOriginal: string;
  blobAffichage: string;
  blobMiniature: string;
  largeur: number;
  hauteur: number;
  lot?: string;
  televerseeLe: string;
  televerseePar: string;
  masquee: boolean;
  statut: string;
  sectionValidee?: string;
  dateValidee?: string;
  dateTri?: string;
  nbContributions: number;
  majLe?: string;
}

// --- Contributions ----------------------------------------------------------

type EntiteContribution = {
  partitionKey: string;
  rowKey: string;
  soumission: string;
  champ: string;
  valeur: string;
  cle: string;
  prenom: string;
  nom: string;
  email?: string;
  ipHash: string;
  creeLe: string;
  supprimee?: boolean;
};

export function versEntiteContribution(c: Contribution): EntiteContribution {
  return {
    partitionKey: c.photoId,
    rowKey: c.rowKey,
    soumission: c.soumission,
    champ: c.champ,
    valeur: JSON.stringify(c.valeur),
    cle: c.cle,
    prenom: c.prenom,
    nom: c.nom,
    email: c.email || undefined,
    ipHash: c.ipHash,
    creeLe: c.creeLe,
    supprimee: false,
  };
}

function depuisEntiteContribution(e: EntiteContribution): Contribution {
  return {
    rowKey: e.rowKey,
    photoId: e.partitionKey,
    soumission: e.soumission,
    champ: e.champ as Contribution["champ"],
    valeur: JSON.parse(e.valeur),
    cle: e.cle,
    prenom: e.prenom,
    nom: e.nom,
    email: e.email,
    ipHash: e.ipHash,
    creeLe: e.creeLe,
    supprimee: !!e.supprimee,
  };
}

export async function contributionsDe(photoId: string): Promise<Contribution[]> {
  const l = await listerTout<EntiteContribution>(table(TABLES.contributions), odata`PartitionKey eq ${photoId}`);
  return l.map(depuisEntiteContribution);
}

export async function toutesContributions(depuis?: Date): Promise<Contribution[]> {
  const filtre = depuis ? odata`creeLe ge ${depuis.toISOString()}` : undefined;
  const l = await listerTout<EntiteContribution>(table(TABLES.contributions), filtre);
  return l.map(depuisEntiteContribution);
}

// --- Décisions de modération -----------------------------------------------

interface EntiteDecision {
  partitionKey: string;
  rowKey: string;
  champ: string;
  action: string;
  cle: string;
  x?: number;
  y?: number;
  admin: string;
  creeLe: string;
}

export async function decisionsDe(photoId: string): Promise<Decision[]> {
  const l = await listerTout<EntiteDecision>(table(TABLES.moderation), odata`PartitionKey eq ${photoId}`);
  return l
    .filter((e) => ["date", "lieu", "section", "personne", "commentaire"].includes(e.champ))
    .map((e) => ({
      rowKey: e.rowKey,
      champ: e.champ as Decision["champ"],
      action: e.action as Decision["action"],
      cle: e.cle,
      x: typeof e.x === "number" ? e.x : undefined,
      y: typeof e.y === "number" ? e.y : undefined,
      admin: e.admin,
      creeLe: e.creeLe,
    }));
}

export async function journaliser(photoId: string, e: Omit<EntiteDecision, "partitionKey">): Promise<void> {
  await table(TABLES.moderation).createEntity({ partitionKey: photoId, ...e });
}
