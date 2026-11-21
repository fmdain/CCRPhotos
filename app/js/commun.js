// Fonctions partagées par toutes les pages.

export class ErreurApi extends Error {
  constructor(message, status, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** Appel à l'API ; gère les redirections du mode privé. */
export async function api(chemin, { methode = "GET", corps, rediriger = true } = {}) {
  const opts = { method: methode, headers: {}, credentials: "same-origin" };
  if (corps !== undefined) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(corps);
  }
  const r = await fetch("/api/" + chemin, opts);
  let donnees = null;
  const type = r.headers.get("content-type") || "";
  if (type.includes("application/json")) donnees = await r.json().catch(() => null);
  if (!r.ok) {
    const code = donnees?.code;
    if (rediriger && r.status === 403 && code === "mot_de_passe_requis") {
      location.href = "/acces.html?retour=" + encodeURIComponent(location.pathname + location.search);
    } else if (rediriger && r.status === 403 && code === "connexion_requise") {
      location.href = "/.auth/login/aad?post_login_redirect_uri=" + encodeURIComponent(location.pathname + location.search);
    }
    throw new ErreurApi(donnees?.erreur || `Erreur ${r.status}`, r.status, code);
  }
  return donnees;
}

let configPromesse = null;
export function config() {
  if (!configPromesse) configPromesse = api("config");
  return configPromesse;
}

/** Construit un élément : el("a", { href: "#", class: "x" }, "texte", autreElement). */
export function el(tag, attrs = {}, ...enfants) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "class") e.className = v;
    else if (k.startsWith("on") && typeof v === "function") e.addEventListener(k.slice(2), v);
    else if (k === "dataset") Object.assign(e.dataset, v);
    else if (v === true) e.setAttribute(k, "");
    else e.setAttribute(k, v);
  }
  for (const enfant of enfants.flat()) {
    if (enfant === null || enfant === undefined || enfant === false) continue;
    e.append(enfant instanceof Node ? enfant : document.createTextNode(String(enfant)));
  }
  return e;
}

export const LIBELLES_STATUT = {
  a_identifier: "À identifier",
  partielle: "Partiellement identifiée",
  validee: "Validée",
};

export function badgeStatut(statut) {
  return el("span", { class: `badge ${statut}` }, LIBELLES_STATUT[statut] || statut);
}

export function message(conteneur, texte, type = "info") {
  conteneur.replaceChildren(el("div", { class: `message ${type}`, role: type === "erreur" ? "alert" : "status" }, texte));
}

export function pluriel(n, mot, motPluriel = mot + "s") {
  return `${n} ${n > 1 ? motPluriel : mot}`;
}

export function dateCourte(iso) {
  try {
    return new Date(iso).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" });
  } catch {
    return iso;
  }
}

// --- Identité du contributeur, mémorisée sur l'appareil s'il le souhaite ---------
const CLE_IDENTITE = "ccr-identite";
export function lireIdentite() {
  try {
    return JSON.parse(localStorage.getItem(CLE_IDENTITE) || "null");
  } catch {
    return null;
  }
}
export function memoriserIdentite(id) {
  try {
    if (id) localStorage.setItem(CLE_IDENTITE, JSON.stringify(id));
    else localStorage.removeItem(CLE_IDENTITE);
  } catch {
    /* stockage indisponible : sans importance */
  }
}

/** Ajoute le lien « Administration » dans l'en-tête pour les admins connectés. */
export async function preparerEntete() {
  try {
    const c = await config();
    const nav = document.querySelector(".entete nav");
    if (c.utilisateur?.admin && nav && !nav.querySelector('[data-admin], a[href="/admin/"]')) {
      nav.append(el("a", { href: "/admin/", "data-admin": "1" }, "Administration"));
    }
    const titre = document.querySelector(".entete .titre");
    if (titre && c.nomSite) titre.textContent = c.nomSite;
  } catch {
    /* page affichée même si l'API ne répond pas */
  }
}

let turnstileCharge = null;
/** Insère le widget Turnstile si activé ; renvoie une fonction qui lit le jeton. */
export async function preparerTurnstile(conteneur) {
  const c = await config();
  if (!c.turnstile?.cleSite) return () => undefined;
  if (!turnstileCharge) {
    turnstileCharge = new Promise((ok, ko) => {
      const s = document.createElement("script");
      s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
      s.async = true;
      s.onload = ok;
      s.onerror = ko;
      document.head.append(s);
    });
  }
  await turnstileCharge;
  const id = window.turnstile.render(conteneur, { sitekey: c.turnstile.cleSite, language: "fr" });
  return () => {
    const v = window.turnstile.getResponse(id);
    window.turnstile.reset(id);
    return v;
  };
}
