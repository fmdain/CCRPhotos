import { api, badgeStatut, config, el, message, pluriel, preparerEntete } from "./commun.js";

const grille = document.getElementById("grille");
const etat = document.getElementById("etat");
const compteur = document.getElementById("compteur");
const selectSection = document.getElementById("filtre-section");
const puces = [...document.querySelectorAll("#filtre-statut .puce")];

const params = new URLSearchParams(location.search);
let filtre = { statut: params.get("statut") || "", section: params.get("section") || "" };
let photos = [];

function normaliser(t) {
  return (t || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
}

function majUrl() {
  const p = new URLSearchParams();
  if (filtre.statut) p.set("statut", filtre.statut);
  if (filtre.section) p.set("section", filtre.section);
  history.replaceState(null, "", p.toString() ? "?" + p : location.pathname);
}

function afficher() {
  puces.forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.statut === filtre.statut)));
  selectSection.value = filtre.section;
  const liste = photos.filter(
    (p) => (!filtre.statut || p.statut === filtre.statut) && (!filtre.section || normaliser(p.section) === normaliser(filtre.section)),
  );
  compteur.textContent = pluriel(liste.length, "photo");
  if (!liste.length) {
    grille.replaceChildren();
    message(etat, photos.length ? "Aucune photo ne correspond à ces filtres." : "Aucune photo pour le moment.", "info");
    return;
  }
  etat.replaceChildren();
  grille.replaceChildren(
    ...liste.map((p) =>
      el("a", { class: "vignette", href: `/photo.html?id=${encodeURIComponent(p.id)}` },
        el("img", { src: p.miniature, alt: p.date || p.section ? `Photo ${[p.section, p.date].filter(Boolean).join(", ")}` : "Photo à identifier", loading: "lazy", width: 400, height: 300 }),
        badgeStatut(p.statut),
        el("div", { class: "legende" },
          el("span", {}, p.date || "Date inconnue"),
          el("span", {}, p.section || (p.nbContributions ? pluriel(p.nbContributions, "contribution") : "Aucune information")),
        ),
      ),
    ),
  );
}

async function demarrer() {
  preparerEntete();
  message(etat, "Chargement…");
  try {
    const [c, r] = await Promise.all([config(), api("photos")]);
    photos = r.photos;
    const sections = new Set(c.sections);
    for (const p of photos) if (p.section) sections.add(p.section);
    for (const s of sections) selectSection.append(el("option", { value: s }, s));
    afficher();
  } catch (e) {
    message(etat, "Impossible de charger les photos : " + e.message, "erreur");
  }
}

puces.forEach((b) =>
  b.addEventListener("click", () => {
    filtre.statut = b.dataset.statut;
    majUrl();
    afficher();
  }),
);
selectSection.addEventListener("change", () => {
  filtre.section = selectSection.value;
  majUrl();
  afficher();
});

demarrer();
