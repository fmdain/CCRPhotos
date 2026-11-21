import * as fs from "node:fs";
import * as path from "node:path";

export type ModeAcces = "public" | "motdepasse" | "connecte";

export interface SiteConfig {
  nomSite: string;
  sections: string[];
  consensus: {
    /** Nombre de contributeurs distincts concordants pour valider une valeur. */
    votesMinimum: number;
    /** Distance maximale (coordonnées normalisées 0–1) pour regrouper deux repères. */
    distancePersonnes: number;
    /** Taille (normalisée) du cadre déduit d'un simple point, pour l'export. */
    tailleVisageParDefaut: number;
  };
  antispam: {
    limiteEnvois: number;
    fenetreMinutes: number;
    turnstile: { actif: boolean; cleSite: string };
  };
  acces: { mode: ModeAcces };
  contact: { responsable: string; email: string };
  conservation: string;
}

let cache: SiteConfig | null = null;

/** Chemin du fichier site.config.json (à la racine du dossier api). */
export function cheminConfig(): string {
  // dist/src/lib -> racine api
  return path.resolve(__dirname, "..", "..", "..", "site.config.json");
}

export function lireConfig(): SiteConfig {
  if (cache) return cache;
  const brut = JSON.parse(fs.readFileSync(cheminConfig(), "utf8")) as SiteConfig;
  // Surcharges possibles par variables d'environnement (paramètres de l'application).
  const env = process.env;
  if (env.ACCESS_MODE && ["public", "motdepasse", "connecte"].includes(env.ACCESS_MODE)) {
    brut.acces.mode = env.ACCESS_MODE as ModeAcces;
  }
  if (env.CONSENSUS_VOTES) brut.consensus.votesMinimum = Math.max(1, parseInt(env.CONSENSUS_VOTES, 10) || 2);
  if (env.TURNSTILE_SITE_KEY) {
    brut.antispam.turnstile.cleSite = env.TURNSTILE_SITE_KEY;
    brut.antispam.turnstile.actif = env.TURNSTILE_ENABLED !== "false";
  }
  if (env.TURNSTILE_ENABLED === "false") brut.antispam.turnstile.actif = false;
  cache = brut;
  return brut;
}

/** Pour les tests : injecter une configuration. */
export function definirConfig(c: SiteConfig): void {
  cache = c;
}

export function secret(nom: string, defaut?: string): string {
  const v = process.env[nom];
  if (v && v.length > 0) return v;
  if (defaut !== undefined) return defaut;
  throw new Error(`Paramètre d'application manquant : ${nom}`);
}
