import { DateNormalisee } from "./dates";
import { arrondir, normaliser } from "./util";

export type Champ = "date" | "lieu" | "section" | "personne" | "commentaire";
export const CHAMPS: Champ[] = ["date", "lieu", "section", "personne", "commentaire"];

export interface ValeurDate { texte: string; normalisee: DateNormalisee }
export interface ValeurTexte { texte: string }
export interface ValeurSection { texte: string; autre: boolean }
/** Repère : point (w = h = 0, x/y = centre) ou rectangle (x/y = coin haut gauche). Coordonnées 0–1. */
export interface ValeurPersonne { nom: string; x: number; y: number; w: number; h: number }

export interface Contribution {
  rowKey: string;
  photoId: string;
  soumission: string;
  champ: Champ;
  valeur: ValeurDate | ValeurTexte | ValeurSection | ValeurPersonne;
  cle: string;
  prenom: string;
  nom: string;
  email?: string;
  ipHash: string;
  creeLe: string;
  supprimee?: boolean;
}

export type ActionModeration = "valider" | "rejeter" | "annuler";

export interface Decision {
  rowKey: string;
  champ: Champ;
  action: ActionModeration;
  /** Clé de la valeur visée (nom normalisé pour une personne, rowKey pour un commentaire). */
  cle: string;
  /** Pour une personne : position du groupe visé (centre normalisé). */
  x?: number;
  y?: number;
  admin: string;
  creeLe: string;
}

export type StatutValeur = "validee" | "rejetee" | "en_attente";

export interface Proposition {
  cle: string;
  libelle: string;
  votes: number;
  statut: StatutValeur;
  parAdmin: boolean;
  /** Valeur représentative (la saisie la plus fréquente pour cette clé). */
  valeur: unknown;
}

export interface ChampConsensus {
  validee: Proposition | null;
  propositions: Proposition[];
}

export interface GroupePersonne {
  id: string;
  /** Centre du groupe. */
  cx: number;
  cy: number;
  /** Cadre (coin haut gauche + taille), déduit des rectangles ou d'une taille par défaut. */
  x: number;
  y: number;
  w: number;
  h: number;
  forme: "point" | "rect";
  nbReperes: number;
  noms: Proposition[];
  nomValide: string | null;
}

export interface Commentaire { cle: string; texte: string; auteur: string; creeLe: string; statut: StatutValeur }

export type StatutPhoto = "a_identifier" | "partielle" | "validee";

export interface Consensus {
  date: ChampConsensus;
  lieu: ChampConsensus;
  section: ChampConsensus;
  personnes: GroupePersonne[];
  commentaires: Commentaire[];
  statut: StatutPhoto;
  nbContributions: number;
}

export interface ParametresConsensus {
  votesMinimum: number;
  distancePersonnes: number;
  tailleVisageParDefaut: number;
  /** Dimensions de la photo, pour mesurer les distances sans déformation. */
  largeur?: number;
  hauteur?: number;
}

export function cleContributeur(c: { prenom: string; nom: string }): string {
  return normaliser(`${c.prenom} ${c.nom}`);
}

function libelle(champ: Champ, v: unknown): string {
  if (champ === "date") {
    const d = v as ValeurDate;
    return d.normalisee?.libelle || d.texte;
  }
  if (champ === "personne") return (v as ValeurPersonne).nom;
  return (v as ValeurTexte).texte;
}

/** Dernière décision (hors « annuler ») par clé. */
function decisionsParCle(decisions: Decision[]): Map<string, Decision> {
  const m = new Map<string, Decision>();
  for (const d of [...decisions].sort((a, b) => a.rowKey.localeCompare(b.rowKey))) {
    if (d.action === "annuler") m.delete(d.cle);
    else m.set(d.cle, d);
  }
  return m;
}

/** Regroupe des contributions par clé et compte les contributeurs distincts. */
function propositions(champ: Champ, contribs: Contribution[]): Proposition[] {
  const groupes = new Map<string, { votants: Set<string>; formes: Map<string, { n: number; v: unknown }> }>();
  for (const c of contribs) {
    let g = groupes.get(c.cle);
    if (!g) {
      g = { votants: new Set(), formes: new Map() };
      groupes.set(c.cle, g);
    }
    g.votants.add(cleContributeur(c));
    const forme = libelle(champ, c.valeur);
    const f = g.formes.get(forme);
    if (f) f.n++;
    else g.formes.set(forme, { n: 1, v: c.valeur });
  }
  const res: Proposition[] = [];
  for (const [cle, g] of groupes) {
    let meilleure: { n: number; v: unknown; l: string } | null = null;
    for (const [l, f] of g.formes) if (!meilleure || f.n > meilleure.n) meilleure = { ...f, l };
    res.push({ cle, libelle: meilleure!.l, votes: g.votants.size, statut: "en_attente", parAdmin: false, valeur: meilleure!.v });
  }
  return res.sort((a, b) => b.votes - a.votes || a.libelle.localeCompare(b.libelle));
}

/** Applique décisions admin et seuil de votes à une liste de propositions. */
function resoudre(props: Proposition[], decisions: Decision[], votesMinimum: number): ChampConsensus {
  const dec = decisionsParCle(decisions);
  let valideeAdmin: { p: Proposition; d: Decision } | null = null;
  for (const p of props) {
    const d = dec.get(p.cle);
    if (!d) continue;
    if (d.action === "rejeter") p.statut = "rejetee";
    if (d.action === "valider" && (!valideeAdmin || d.rowKey > valideeAdmin.d.rowKey)) valideeAdmin = { p, d };
  }
  let validee: Proposition | null = null;
  if (valideeAdmin) {
    validee = valideeAdmin.p;
    validee.parAdmin = true;
  } else {
    const candidates = props.filter((p) => p.statut !== "rejetee");
    const [premier, second] = candidates;
    if (premier && premier.votes >= votesMinimum && (!second || second.votes < premier.votes)) validee = premier;
  }
  if (validee) validee.statut = "validee";
  return { validee, propositions: props };
}

function centre(v: ValeurPersonne): { cx: number; cy: number } {
  if (v.w > 0 && v.h > 0) return { cx: v.x + v.w / 2, cy: v.y + v.h / 2 };
  return { cx: v.x, cy: v.y };
}

/** Regroupe les repères proches, puis calcule le nom retenu pour chaque groupe. */
export function grouperPersonnes(
  contribs: Contribution[],
  decisions: Decision[],
  p: ParametresConsensus,
): GroupePersonne[] {
  const W = p.largeur && p.largeur > 0 ? p.largeur : 1;
  const H = p.hauteur && p.hauteur > 0 ? p.hauteur : 1;
  const min = Math.min(W, H);
  const distance = (ax: number, ay: number, bx: number, by: number) =>
    Math.hypot((ax - bx) * W, (ay - by) * H) / min;

  interface G { id: string; membres: Contribution[]; cx: number; cy: number }
  const groupes: G[] = [];
  const tries = [...contribs].sort((a, b) => a.rowKey.localeCompare(b.rowKey));
  for (const c of tries) {
    const { cx, cy } = centre(c.valeur as ValeurPersonne);
    let meilleur: G | null = null;
    let dMin = Infinity;
    for (const g of groupes) {
      const d = distance(cx, cy, g.cx, g.cy);
      if (d <= p.distancePersonnes && d < dMin) {
        meilleur = g;
        dMin = d;
      }
    }
    if (meilleur) {
      meilleur.membres.push(c);
      const n = meilleur.membres.length;
      meilleur.cx += (cx - meilleur.cx) / n;
      meilleur.cy += (cy - meilleur.cy) / n;
    } else {
      groupes.push({ id: c.rowKey, membres: [c], cx, cy });
    }
  }

  // Rattache chaque décision admin au groupe le plus proche de la position mémorisée.
  const decisionsParGroupe = new Map<string, Decision[]>();
  for (const d of decisions) {
    if (d.x === undefined || d.y === undefined) continue;
    let meilleur: G | null = null;
    let dMin = Infinity;
    for (const g of groupes) {
      const dist = distance(d.x, d.y, g.cx, g.cy);
      if (dist <= p.distancePersonnes && dist < dMin) {
        meilleur = g;
        dMin = dist;
      }
    }
    if (meilleur) {
      const l = decisionsParGroupe.get(meilleur.id) ?? [];
      l.push(d);
      decisionsParGroupe.set(meilleur.id, l);
    }
  }

  return groupes.map((g) => {
    const rects = g.membres.map((m) => m.valeur as ValeurPersonne).filter((v) => v.w > 0 && v.h > 0);
    let x: number, y: number, w: number, h: number;
    if (rects.length) {
      x = rects.reduce((s, r) => s + r.x, 0) / rects.length;
      y = rects.reduce((s, r) => s + r.y, 0) / rects.length;
      w = rects.reduce((s, r) => s + r.w, 0) / rects.length;
      h = rects.reduce((s, r) => s + r.h, 0) / rects.length;
    } else {
      w = (p.tailleVisageParDefaut * min) / W;
      h = (p.tailleVisageParDefaut * min) / H;
      x = Math.max(0, Math.min(1 - w, g.cx - w / 2));
      y = Math.max(0, Math.min(1 - h, g.cy - h / 2));
    }
    const { validee, propositions: noms } = resoudre(
      propositions("personne", g.membres),
      decisionsParGroupe.get(g.id) ?? [],
      p.votesMinimum,
    );
    return {
      id: g.id,
      cx: arrondir(g.cx), cy: arrondir(g.cy),
      x: arrondir(x), y: arrondir(y), w: arrondir(w), h: arrondir(h),
      forme: rects.length ? "rect" : "point",
      nbReperes: g.membres.length,
      noms,
      nomValide: validee ? validee.libelle : null,
    } satisfies GroupePersonne;
  });
}

export function calculerConsensus(
  toutes: Contribution[],
  decisions: Decision[],
  p: ParametresConsensus,
): Consensus {
  const actives = toutes.filter((c) => !c.supprimee);
  const par = (champ: Champ) => actives.filter((c) => c.champ === champ);
  const dec = (champ: Champ) => decisions.filter((d) => d.champ === champ);

  const champ = (c: "date" | "lieu" | "section") => resoudre(propositions(c, par(c)), dec(c), p.votesMinimum);
  const date = champ("date");
  const lieu = champ("lieu");
  const section = champ("section");
  const personnes = grouperPersonnes(par("personne"), dec("personne"), p);

  const decCom = decisionsParCle(dec("commentaire"));
  const commentaires: Commentaire[] = par("commentaire").map((c) => {
    const d = decCom.get(c.rowKey);
    return {
      cle: c.rowKey,
      texte: (c.valeur as ValeurTexte).texte,
      auteur: `${c.prenom} ${c.nom.charAt(0).toUpperCase()}.`,
      creeLe: c.creeLe,
      statut: d?.action === "valider" ? "validee" : d?.action === "rejeter" ? "rejetee" : "en_attente",
    };
  });

  const groupesVisibles = personnes.filter((g) => g.noms.some((n) => n.statut !== "rejetee"));
  const nbValidees =
    (date.validee ? 1 : 0) + (lieu.validee ? 1 : 0) + (section.validee ? 1 : 0) +
    groupesVisibles.filter((g) => g.nomValide).length +
    commentaires.filter((c) => c.statut === "validee").length;

  let statut: StatutPhoto = "a_identifier";
  if (nbValidees > 0) statut = "partielle";
  if (date.validee && lieu.validee && section.validee && groupesVisibles.every((g) => g.nomValide)) statut = "validee";

  return { date, lieu, section, personnes, commentaires, statut, nbContributions: actives.length };
}

/** Version publique : sans valeurs rejetées ni commentaires non validés. */
export function consensusPublic(c: Consensus): Consensus {
  const filtrer = (ch: ChampConsensus): ChampConsensus => ({
    validee: ch.validee,
    propositions: ch.propositions.filter((p) => p.statut !== "rejetee"),
  });
  return {
    ...c,
    date: filtrer(c.date),
    lieu: filtrer(c.lieu),
    section: filtrer(c.section),
    personnes: c.personnes
      .map((g) => ({ ...g, noms: g.noms.filter((n) => n.statut !== "rejetee") }))
      .filter((g) => g.noms.length > 0),
    commentaires: c.commentaires.filter((m) => m.statut === "validee"),
  };
}
