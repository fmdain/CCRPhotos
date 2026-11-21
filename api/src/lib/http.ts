import { HttpRequest, HttpResponseInit } from "@azure/functions";
import { createHmac, timingSafeEqual } from "node:crypto";
import { lireConfig, secret } from "./config";

export interface Principal {
  identityProvider: string;
  userId: string;
  userDetails: string;
  userRoles: string[];
}

/** Lit l'utilisateur transmis par Static Web Apps (en-tête x-ms-client-principal). */
export function principal(req: HttpRequest): Principal | null {
  const h = req.headers.get("x-ms-client-principal");
  if (!h) return null;
  try {
    const p = JSON.parse(Buffer.from(h, "base64").toString("utf8")) as Principal;
    if (!p || !p.userId) return null;
    p.userRoles = p.userRoles ?? [];
    return p;
  } catch {
    return null;
  }
}

export function estAdmin(req: HttpRequest): boolean {
  return !!principal(req)?.userRoles.includes("admin");
}

export function json(status: number, corps: unknown, entetes: Record<string, string> = {}): HttpResponseInit {
  return {
    status,
    jsonBody: corps,
    headers: { "Cache-Control": "no-store", ...entetes },
  };
}

export const erreur = (status: number, message: string, code?: string): HttpResponseInit =>
  json(status, { erreur: message, code });

/** Adresse IP du client (premier élément de x-forwarded-for, sans le port). */
export function ipClient(req: HttpRequest): string {
  const brut = req.headers.get("x-forwarded-for") || req.headers.get("x-client-ip") || "inconnue";
  let ip = brut.split(",")[0].trim();
  // IPv4 avec port « 1.2.3.4:5678 » ; IPv6 entre crochets « [::1]:5678 ».
  const v6 = ip.match(/^\[([^\]]+)\]/);
  if (v6) ip = v6[1];
  else if (/^\d+\.\d+\.\d+\.\d+:\d+$/.test(ip)) ip = ip.split(":")[0];
  return ip;
}

export async function corpsJson<T>(req: HttpRequest): Promise<T | null> {
  const type = req.headers.get("content-type") || "";
  // Exiger du JSON protège contre les formulaires envoyés depuis un autre site (CSRF).
  if (!type.includes("application/json")) return null;
  try {
    return (await req.json()) as T;
  } catch {
    return null;
  }
}

// --- Accès au site (mode privé) ---------------------------------------------

export const COOKIE_ACCES = "ccr_acces";
const DUREE_COOKIE_JOURS = 30;

function signer(valeur: string): string {
  return createHmac("sha256", secret("ACCESS_COOKIE_SECRET", "dev")).update(valeur).digest("base64url");
}

export function jetonAcces(): { valeur: string; maxAge: number } {
  const expire = Date.now() + DUREE_COOKIE_JOURS * 86400_000;
  const charge = `v1.${expire}`;
  return { valeur: `${charge}.${signer(charge)}`, maxAge: DUREE_COOKIE_JOURS * 86400 };
}

function lireCookie(req: HttpRequest, nom: string): string | null {
  const c = req.headers.get("cookie");
  if (!c) return null;
  for (const morceau of c.split(";")) {
    const [k, ...v] = morceau.trim().split("=");
    if (k === nom) return decodeURIComponent(v.join("="));
  }
  return null;
}

export function jetonValide(req: HttpRequest): boolean {
  const j = lireCookie(req, COOKIE_ACCES);
  if (!j) return false;
  const i = j.lastIndexOf(".");
  if (i < 0) return false;
  const charge = j.slice(0, i);
  const sig = Buffer.from(j.slice(i + 1));
  const attendu = Buffer.from(signer(charge));
  if (sig.length !== attendu.length || !timingSafeEqual(sig, attendu)) return false;
  const expire = parseInt(charge.split(".")[1], 10);
  return Number.isFinite(expire) && expire > Date.now();
}

/**
 * Vérifie que la requête a le droit de lire ou contribuer selon le mode d'accès configuré.
 * Renvoie une réponse d'erreur, ou null si l'accès est autorisé.
 * On répond 403 (et non 401) pour ne pas déclencher la redirection de connexion de SWA.
 */
export function controlerAcces(req: HttpRequest): HttpResponseInit | null {
  const mode = lireConfig().acces.mode;
  if (mode === "public" || estAdmin(req)) return null;
  if (mode === "connecte") {
    return principal(req) ? null : erreur(403, "Connexion requise.", "connexion_requise");
  }
  return jetonValide(req) ? null : erreur(403, "Mot de passe requis.", "mot_de_passe_requis");
}

export function comparerSecret(a: string, b: string): boolean {
  const ha = createHmac("sha256", "cmp").update(a).digest();
  const hb = createHmac("sha256", "cmp").update(b).digest();
  return timingSafeEqual(ha, hb);
}
