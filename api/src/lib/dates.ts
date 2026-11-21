import { normaliser } from "./util";

export type Precision = "jour" | "mois" | "annee" | "decennie" | "intervalle" | "inconnue";

export interface DateNormalisee {
  precision: Precision;
  /** "1985-06-12", "1985-06", "1985", "198X", "1984/1986", ou null si non reconnue. */
  valeur: string | null;
  /** Date approximative (« vers », « environ », « ? »…). */
  environ: boolean;
  /** Bornes de l'intervalle couvert, pour le tri et le filtrage. */
  debut: string | null;
  fin: string | null;
  /** Libellé lisible en français. */
  libelle: string;
}

const MOIS: Record<string, number> = {
  janvier: 1, janv: 1, jan: 1,
  fevrier: 2, fevr: 2, fev: 2,
  mars: 3,
  avril: 4, avr: 4,
  mai: 5,
  juin: 6,
  juillet: 7, juil: 7,
  aout: 8,
  septembre: 9, sept: 9, sep: 9,
  octobre: 10, oct: 10,
  novembre: 11, nov: 11,
  decembre: 12, dec: 12,
};

const NOMS_MOIS = [
  "", "janvier", "février", "mars", "avril", "mai", "juin",
  "juillet", "août", "septembre", "octobre", "novembre", "décembre",
];

function p2(n: number): string {
  return n < 10 ? "0" + n : String(n);
}

function joursDansMois(a: number, m: number): number {
  return new Date(Date.UTC(a, m, 0)).getUTCDate();
}

/** Années sur deux chiffres : « 85 » → 1985 ; « 05 » → 2005 si cela ne dépasse pas l'année en cours. */
function annee(brut: string, anneeCourante: number): number | null {
  let a = parseInt(brut, 10);
  if (!Number.isFinite(a)) return null;
  if (brut.length === 2) {
    const siecle = 2000 + a <= anneeCourante ? 2000 : 1900;
    a = siecle + a;
  }
  if (a < 1850 || a > anneeCourante) return null;
  return a;
}

function construire(
  precision: Precision,
  environ: boolean,
  a?: number,
  m?: number,
  j?: number,
  a2?: number,
): DateNormalisee {
  const prefixe = environ ? "vers " : "";
  switch (precision) {
    case "jour":
      return {
        precision, environ,
        valeur: `${a}-${p2(m!)}-${p2(j!)}`,
        debut: `${a}-${p2(m!)}-${p2(j!)}`,
        fin: `${a}-${p2(m!)}-${p2(j!)}`,
        libelle: `${prefixe}${j === 1 ? "1er" : j} ${NOMS_MOIS[m!]} ${a}`,
      };
    case "mois":
      return {
        precision, environ,
        valeur: `${a}-${p2(m!)}`,
        debut: `${a}-${p2(m!)}-01`,
        fin: `${a}-${p2(m!)}-${p2(joursDansMois(a!, m!))}`,
        libelle: `${prefixe}${NOMS_MOIS[m!]} ${a}`,
      };
    case "annee":
      return {
        precision, environ,
        valeur: `${a}`,
        debut: `${a}-01-01`,
        fin: `${a}-12-31`,
        libelle: `${prefixe}${a}`,
      };
    case "decennie": {
      const d = Math.floor(a! / 10) * 10;
      return {
        precision, environ,
        valeur: `${String(d).slice(0, 3)}X`,
        debut: `${d}-01-01`,
        fin: `${d + 9}-12-31`,
        libelle: `${environ ? "vers les" : "les"} années ${d}`,
      };
    }
    case "intervalle":
      return {
        precision, environ,
        valeur: `${a}/${a2}`,
        debut: `${a}-01-01`,
        fin: `${a2}-12-31`,
        libelle: `${prefixe}entre ${a} et ${a2}`,
      };
    default:
      return { precision: "inconnue", environ, valeur: null, debut: null, fin: null, libelle: "" };
  }
}

/**
 * Interprète une date saisie librement en français.
 * Exemples acceptés : « 12/06/1985 », « 12 juin 1985 », « juin 85 », « 06/1985 »,
 * « 1985 », « vers 1985 », « 1985 ? », « années 80 », « 198X », « entre 1984 et 1986 ».
 */
export function interpreterDate(texte: string, anneeCourante = new Date().getFullYear()): DateNormalisee {
  const inconnue = (): DateNormalisee => ({
    precision: "inconnue", environ: false, valeur: null, debut: null, fin: null, libelle: texte.trim(),
  });
  if (!texte || !texte.trim()) return inconnue();

  let t = texte.trim().toLowerCase();
  let environ = false;
  // Marqueurs d'approximation.
  const approx = /^(vers|env\.?|environ|circa|ca\.?|c\.|~|±|aux alentours de|autour de)\s*/;
  if (approx.test(t)) {
    environ = true;
    t = t.replace(approx, "");
  }
  if (/\s*(\?+|env\.?|environ|\(\?\)|approx\.?)\s*$/.test(t)) {
    environ = true;
    t = t.replace(/\s*(\?+|env\.?|environ|\(\?\)|approx\.?)\s*$/, "");
  }
  const n = normaliser(t);
  let r: RegExpMatchArray | null;

  // AAAA-MM-JJ
  if ((r = t.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/))) {
    const a = annee(r[1], anneeCourante), m = +r[2], j = +r[3];
    if (a && m >= 1 && m <= 12 && j >= 1 && j <= joursDansMois(a, m)) return construire("jour", environ, a, m, j);
    return inconnue();
  }
  // JJ/MM/AAAA ou JJ/MM/AA
  if ((r = t.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})$/))) {
    const a = annee(r[3], anneeCourante), m = +r[2], j = +r[1];
    if (a && m >= 1 && m <= 12 && j >= 1 && j <= joursDansMois(a, m)) return construire("jour", environ, a, m, j);
    return inconnue();
  }
  // AAAA-MM
  if ((r = t.match(/^(\d{4})[-/.](\d{1,2})$/))) {
    const a = annee(r[1], anneeCourante), m = +r[2];
    if (a && m >= 1 && m <= 12) return construire("mois", environ, a, m);
    return inconnue();
  }
  // MM/AAAA
  if ((r = t.match(/^(\d{1,2})[-/.](\d{4})$/))) {
    const a = annee(r[2], anneeCourante), m = +r[1];
    if (a && m >= 1 && m <= 12) return construire("mois", environ, a, m);
    return inconnue();
  }
  // « 12 juin 1985 », « 1er juin 85 », « juin 1985 »
  if ((r = n.match(/^(?:(\d{1,2})(?: ?er)? )?([a-z]+) (\d{2}|\d{4})$/))) {
    const m = MOIS[r[2]];
    const a = annee(r[3], anneeCourante);
    if (m && a) {
      if (r[1]) {
        const j = +r[1];
        if (j >= 1 && j <= joursDansMois(a, m)) return construire("jour", environ, a, m, j);
        return inconnue();
      }
      return construire("mois", environ, a, m);
    }
  }
  // « entre 1984 et 1986 », « 1984-1986 », « 1984 / 1986 »
  if ((r = n.match(/^(?:entre )?(\d{4})(?: et | a | )(\d{4})$/)) || (r = t.match(/^(\d{4})\s*[-/–]\s*(\d{4})$/))) {
    const a1 = annee(r[1], anneeCourante), a2 = annee(r[2], anneeCourante);
    if (a1 && a2 && a2 > a1) return construire("intervalle", environ, a1, undefined, undefined, a2);
    return inconnue();
  }
  // Année seule
  if ((r = t.match(/^(\d{4})$/))) {
    const a = annee(r[1], anneeCourante);
    return a ? construire("annee", environ, a) : inconnue();
  }
  // Décennie : « 198X », « 198x », « 1980s », « années 80 », « les années 1980 », « début des années 80 »
  if ((r = t.match(/^(\d{3})[x?]$/))) {
    const a = annee(r[1] + "0", anneeCourante);
    return a ? construire("decennie", environ, a) : inconnue();
  }
  if ((r = n.match(/^(?:(debut|milieu|fin) )?(?:des |les )?annees (\d{2}|\d{4})$/)) || (r = n.match(/^()(\d{4}) ?s$/))) {
    const brut = r[2];
    let a: number | null;
    if (brut.length === 2) {
      a = +brut + (2000 + +brut <= anneeCourante ? 2000 : 1900);
    } else a = +brut;
    if (a % 10 !== 0 || a < 1850 || a > anneeCourante) return inconnue();
    // « début / fin des années » reste une décennie mais devient approximative.
    return construire("decennie", environ || !!r[1], a);
  }
  return inconnue();
}

/** Clé de comparaison pour le consensus : deux saisies équivalentes donnent la même clé. */
export function cleDate(d: DateNormalisee, texte: string): string {
  if (d.precision === "inconnue" || !d.valeur) return "texte:" + normaliser(texte);
  return `${d.precision}:${d.valeur}${d.environ ? "~" : ""}`;
}
