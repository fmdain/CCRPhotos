import { createHmac, randomBytes } from "node:crypto";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** Identifiant de type ULID : 10 caractères d'horodatage + 16 aléatoires, triable par date. */
export function ulid(maintenant: number = Date.now()): string {
  let t = maintenant;
  let temps = "";
  for (let i = 0; i < 10; i++) {
    temps = CROCKFORD[t % 32] + temps;
    t = Math.floor(t / 32);
  }
  const alea = randomBytes(16);
  let suite = "";
  for (let i = 0; i < 16; i++) suite += CROCKFORD[alea[i] % 32];
  return temps + suite;
}

/** Minuscules, sans accents, espaces et ponctuation simplifiés : sert de clé de comparaison. */
export function normaliser(texte: string): string {
  return texte
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[’'`]/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/** Nettoie un texte saisi : supprime caractères de contrôle, espaces multiples, limite la longueur. */
export function nettoyer(valeur: unknown, max: number): string {
  if (typeof valeur !== "string") return "";
  return valeur
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/[ \t]+/g, " ")
    .trim()
    .slice(0, max);
}

/** Empreinte HMAC d'une adresse IP (jamais stockée en clair). */
export function hacherIp(ip: string, secretHmac: string): string {
  return createHmac("sha256", secretHmac).update(ip).digest("hex").slice(0, 32);
}

export function borner01(n: unknown): number | null {
  const v = typeof n === "number" ? n : typeof n === "string" ? parseFloat(n) : NaN;
  if (!Number.isFinite(v)) return null;
  return Math.min(1, Math.max(0, v));
}

export function arrondir(n: number, decimales = 4): number {
  const f = Math.pow(10, decimales);
  return Math.round(n * f) / f;
}

export function estEmailPlausible(e: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
}
