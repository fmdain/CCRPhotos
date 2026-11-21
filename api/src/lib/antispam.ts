import { lireConfig, secret } from "./config";
import { estIntrouvable, table, TABLES } from "./stockage";

/** Nom du champ piège : invisible pour les humains, souvent rempli par les robots. */
export const CHAMP_PIEGE = "site_web";

export function estRobot(corps: Record<string, unknown>): boolean {
  const v = corps[CHAMP_PIEGE];
  return typeof v === "string" && v.trim().length > 0;
}

/**
 * Limitation de débit par empreinte d'IP, sur une fenêtre fixe.
 * Renvoie true si l'envoi est accepté (et le compte), false s'il faut le refuser.
 */
export async function accepterEnvoi(ipHash: string, poids = 1): Promise<boolean> {
  const { limiteEnvois, fenetreMinutes } = lireConfig().antispam;
  if (limiteEnvois <= 0) return true;
  const fenetre = String(Math.floor(Date.now() / (fenetreMinutes * 60_000)));
  const t = table(TABLES.debit);
  for (let essai = 0; essai < 3; essai++) {
    try {
      const e = await t.getEntity<{ compte: number }>(ipHash, fenetre);
      if (e.compte + poids > limiteEnvois) return false;
      await t.updateEntity(
        { partitionKey: ipHash, rowKey: fenetre, compte: e.compte + poids },
        "Replace",
        { etag: e.etag },
      );
      return true;
    } catch (err) {
      if (estIntrouvable(err)) {
        try {
          await t.createEntity({ partitionKey: ipHash, rowKey: fenetre, compte: poids });
          return true;
        } catch {
          continue; // créée entre-temps par une autre requête : on réessaie
        }
      }
      const code = (err as { statusCode?: number }).statusCode;
      if (code === 412 || code === 409) continue; // conflit d'ETag
      throw err;
    }
  }
  return false;
}

/** Vérification Cloudflare Turnstile (si activée dans la configuration). */
export async function verifierTurnstile(jeton: unknown, ip: string): Promise<boolean> {
  const conf = lireConfig().antispam.turnstile;
  if (!conf.actif) return true;
  const cle = secret("TURNSTILE_SECRET", "");
  if (!cle) return true; // activé sans secret : on ne bloque pas les contributions
  if (typeof jeton !== "string" || !jeton) return false;
  const corps = new URLSearchParams({ secret: cle, response: jeton, remoteip: ip });
  try {
    const r = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      body: corps,
    });
    const d = (await r.json()) as { success?: boolean };
    return !!d.success;
  } catch {
    return false;
  }
}
