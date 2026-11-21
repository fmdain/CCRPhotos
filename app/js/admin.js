import { barreOutils, Visionneuse } from "./annotateur.js";
import { api, badgeStatut, dateCourte, el, message, pluriel, preparerEntete } from "./commun.js";

const $ = (id) => document.getElementById(id);
const etat = $("etat");
let photos = [];

// --- Onglets ---------------------------------------------------------------------------

const onglets = [...document.querySelectorAll("[data-onglet]")];
const chargeurs = { photos: chargerPhotos, contributions: chargerContributions, retraits: chargerRetraits };
function ouvrirOnglet(nom) {
  for (const b of onglets) b.setAttribute("aria-selected", String(b.dataset.onglet === nom));
  for (const p of document.querySelectorAll("[data-panneau]")) p.hidden = p.dataset.panneau !== nom;
  etat.replaceChildren();
  chargeurs[nom]?.();
}
onglets.forEach((b) => b.addEventListener("click", () => ouvrirOnglet(b.dataset.onglet)));

function erreur(e) {
  message(etat, e.message || String(e), "erreur");
  etat.scrollIntoView({ behavior: "smooth", block: "center" });
}

function texteValeur(champ, v) {
  switch (champ) {
    case "date": return v.normalisee?.libelle && v.normalisee.libelle !== v.texte ? `${v.texte} (${v.normalisee.libelle})` : v.texte;
    case "personne": return `${v.nom} ${v.w > 0 ? "[cadre]" : "[point]"}`;
    case "section": return v.autre ? `${v.texte} (autre)` : v.texte;
    default: return v.texte;
  }
}

// --- Liste des photos --------------------------------------------------------------------

async function chargerPhotos() {
  try {
    photos = (await api("gestion/photos")).photos;
    afficherListe();
  } catch (e) {
    erreur(e);
  }
}

function afficherListe() {
  const statut = $("a-filtre-statut").value;
  const q = $("a-recherche").value.trim().toLowerCase();
  const liste = photos.filter((p) => {
    if (statut === "masquee" && !p.masquee) return false;
    if (statut === "contribuees" && !p.nbContributions) return false;
    if (["a_identifier", "partielle", "validee"].includes(statut) && p.statut !== statut) return false;
    return !q || `${p.id} ${p.lot} ${p.section} ${p.date}`.toLowerCase().includes(q);
  });
  $("a-compteur").textContent = pluriel(liste.length, "photo");
  $("a-grille").replaceChildren(
    ...liste.map((p) =>
      el("a", { class: "vignette", href: `#${p.id}`, onclick: (e) => { e.preventDefault(); ouvrirModeration(p.id); } },
        el("img", { src: p.miniature, alt: "", loading: "lazy" }),
        p.masquee ? el("span", { class: "badge masquee" }, "Masquée") : badgeStatut(p.statut),
        el("div", { class: "legende" },
          el("span", {}, `${pluriel(p.nbContributions, "contribution")}`),
          el("span", {}, p.lot || p.date || p.section || dateCourte(p.televerseeLe)),
        ),
      ),
    ),
  );
}
$("a-filtre-statut").addEventListener("change", afficherListe);
$("a-recherche").addEventListener("input", afficherListe);

// --- Modération d'une photo -----------------------------------------------------------------

async function decider(photoId, corps) {
  try {
    await api(`gestion/photos/${photoId}/decisions`, { methode: "POST", corps });
    await ouvrirModeration(photoId, true);
  } catch (e) {
    erreur(e);
  }
}

function boutonsDecision(photoId, champ, p, extra = {}) {
  const b = (libelle, action, classe = "secondaire") =>
    el("button", { type: "button", class: `petit ${classe}`, onclick: () => decider(photoId, { champ, action, cle: p.cle, ...extra }) }, libelle);
  return el("span", { class: "actions" },
    p.statut !== "validee" || !p.parAdmin ? b("Valider", "valider") : null,
    p.statut !== "rejetee" ? b("Rejeter", "rejeter", "secondaire") : null,
    p.parAdmin || p.statut === "rejetee" ? b("Annuler la décision", "annuler") : null,
  );
}

function statutTexte(p) {
  if (p.statut === "validee") return el("span", { class: "statut-validee" }, p.parAdmin ? "validée (admin)" : "validée (votes)");
  if (p.statut === "rejetee") return el("span", { class: "statut-rejetee" }, "rejetée");
  return el("span", { class: "votes" }, "en attente");
}

function blocChamp(photoId, titre, champ, ch) {
  if (!ch.propositions.length) return null;
  return el("div", {},
    el("h3", {}, titre),
    el("ul", { class: "propositions" },
      ...ch.propositions.map((p) =>
        el("li", {},
          el("span", { class: "valeur" }, p.libelle),
          el("span", { class: "votes" }, pluriel(p.votes, "vote")),
          statutTexte(p),
          boutonsDecision(photoId, champ, p),
        ),
      ),
    ),
  );
}

let visionneuse = null;

async function ouvrirModeration(photoId, conserverDefilement = false) {
  const zone = $("moderation");
  const y = window.scrollY;
  let d;
  try {
    d = await api(`gestion/photos/${photoId}`);
  } catch (e) {
    return erreur(e);
  }
  $("liste-photos-bloc").hidden = true;
  zone.hidden = false;
  history.replaceState(null, "", `#${photoId}`);
  const c = d.consensus;
  const p = d.photo;

  const cadreImage = el("div");
  const blocs = [
    el("div", { class: "boutons-ligne", style: "margin-top:0" },
      el("button", { type: "button", class: "secondaire", onclick: fermerModeration }, "← Toutes les photos"),
      el("a", { class: "bouton secondaire", href: `/photo.html?id=${p.id}`, target: "_blank" }, "Voir la page publique"),
      el("button", {
        type: "button", class: "secondaire",
        onclick: async () => {
          try {
            await api(`gestion/photos/${p.id}/masquer`, { methode: "POST", corps: { masquee: !p.masquee } });
            ouvrirModeration(p.id, true);
          } catch (e) { erreur(e); }
        },
      }, p.masquee ? "Afficher la photo" : "Masquer la photo"),
      el("button", {
        type: "button", class: "danger",
        onclick: async () => {
          if (!confirm("Supprimer définitivement cette photo, ses fichiers et toutes ses contributions ?")) return;
          try {
            await api(`gestion/photos/${p.id}`, { methode: "DELETE" });
            fermerModeration();
            chargerPhotos();
          } catch (e) { erreur(e); }
        },
      }, "Supprimer définitivement"),
    ),
    el("p", {}, badgeStatut(c.statut), " ", p.masquee ? el("span", { class: "badge masquee" }, "Masquée") : null, " ",
      el("span", { class: "aide" }, `${p.nomFichier} · ${p.largeur}×${p.hauteur} · ${p.id}${p.lot ? " · lot « " + p.lot + " »" : ""}`)),
  ];

  const panneau = el("div", {},
    blocChamp(p.id, "Date", "date", c.date),
    blocChamp(p.id, "Lieu", "lieu", c.lieu),
    blocChamp(p.id, "Section", "section", c.section),
  );
  if (c.personnes.length) {
    panneau.append(el("h3", {}, "Personnes"));
    c.personnes.forEach((g, i) => {
      panneau.append(
        el("div", { dataset: { groupe: g.id } },
          el("div", { class: "aide" }, `Repère n° ${i + 1} · ${pluriel(g.nbReperes, "repère")} · ${g.forme === "rect" ? "cadre" : "point"}`),
          el("ul", { class: "propositions" },
            ...g.noms.map((n) =>
              el("li", {},
                el("span", { class: "valeur" }, n.libelle),
                el("span", { class: "votes" }, pluriel(n.votes, "vote")),
                statutTexte(n),
                boutonsDecision(p.id, "personne", n, { x: g.cx, y: g.cy }),
              ),
            ),
          ),
        ),
      );
    });
  }
  if (c.commentaires.length) {
    panneau.append(el("h3", {}, "Commentaires"));
    panneau.append(
      el("ul", { class: "propositions" },
        ...c.commentaires.map((m) =>
          el("li", {},
            el("span", { class: "valeur" }, m.texte, el("br"), el("span", { class: "aide" }, `${m.auteur} · ${dateCourte(m.creeLe)}`)),
            statutTexte({ ...m, parAdmin: m.statut !== "en_attente" }),
            boutonsDecision(p.id, "commentaire", { ...m, parAdmin: m.statut !== "en_attente" }),
          ),
        ),
      ),
    );
  }
  if (!panneau.childElementCount) panneau.append(el("p", { class: "vide" }, "Aucune contribution pour l'instant."));

  const tableContribs = tableauContributions(d.contributions, p.id);
  const journal = d.journal.length
    ? el("details", {}, el("summary", {}, `Journal de modération (${d.journal.length})`),
        el("ul", {}, ...d.journal.map((j) => el("li", { class: "aide" }, `${dateCourte(j.creeLe)} · ${j.admin} · ${j.action} ${j.champ} ${j.cle || ""}`))))
    : null;

  zone.replaceChildren(
    ...blocs,
    el("div", { class: "photo-page" },
      el("section", { class: "visionneuse" }, el("div", { id: "m-barre" }), cadreImage),
      el("section", { class: "carte" }, el("h2", { style: "margin-top:0" }, "Valeurs proposées"), panneau),
    ),
    el("h2", {}, `Contributions (${d.contributions.length})`),
    tableContribs,
    ...(journal ? [journal] : []),
  );

  visionneuse = new Visionneuse(cadreImage, {
    src: p.image, largeur: p.largeur, hauteur: p.hauteur,
    onClicGroupe: (g) => {
      visionneuse.surligner(g.id);
      zone.querySelector(`[data-groupe="${CSS.escape(g.id)}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" });
    },
  });
  $("m-barre").replaceChildren(barreOutils(visionneuse));
  visionneuse.afficher(
    c.personnes.map((g, i) => ({ ...g, valide: !!g.nomValide, libelle: g.nomValide || `${i + 1}. ${g.noms[0]?.libelle || "?"} ?` })),
    [],
  );
  if (conserverDefilement) window.scrollTo(0, y);
  else window.scrollTo(0, 0);
}

function fermerModeration() {
  $("moderation").hidden = true;
  $("liste-photos-bloc").hidden = false;
  history.replaceState(null, "", location.pathname);
  chargerPhotos();
}

function tableauContributions(contributions, photoId) {
  if (!contributions.length) return el("p", { class: "vide" }, "Aucune contribution.");
  return el("div", { class: "tableau" },
    el("table", {},
      el("thead", {}, el("tr", {}, ...["Date", "Champ", "Valeur", "Contributeur", "IP (empreinte)", ""].map((t) => el("th", {}, t)))),
      el("tbody", {},
        ...contributions.map((c) =>
          el("tr", { style: c.supprimee ? "opacity:.5" : "" },
            el("td", {}, dateCourte(c.creeLe)),
            el("td", {}, c.champ),
            el("td", {}, texteValeur(c.champ, c.valeur), c.supprimee ? el("span", { class: "statut-rejetee" }, " (supprimée)") : null),
            el("td", {}, `${c.prenom} ${c.nom}`, c.email ? el("br") : null, c.email ? el("a", { href: `mailto:${c.email}` }, c.email) : null),
            el("td", { class: "aide" }, c.ipHash.slice(0, 8)),
            el("td", {},
              el("span", { class: "actions" },
                photoId ? null : el("button", { type: "button", class: "petit secondaire", onclick: () => { ouvrirOnglet("photos"); ouvrirModeration(c.photoId); } }, "Voir la photo"),
                c.supprimee ? null : el("button", { type: "button", class: "petit secondaire", onclick: () => supprimerContribution(c, false) }, "Supprimer"),
                el("button", { type: "button", class: "petit danger", onclick: () => supprimerContribution(c, true) }, "Effacer"),
              ),
            ),
          ),
        ),
      ),
    ),
  );
}

async function supprimerContribution(c, definitif) {
  const texte = definitif
    ? "Effacer définitivement cette contribution (données personnelles comprises) ?"
    : "Supprimer cette contribution ? Elle ne comptera plus dans le consensus mais restera dans l'historique.";
  if (!confirm(texte)) return;
  try {
    await api(`gestion/photos/${c.photoId}/contributions/${c.rowKey}${definitif ? "?definitif=1" : ""}`, { methode: "DELETE" });
    if (!$("moderation").hidden) ouvrirModeration(c.photoId, true);
    else chargerContributions();
  } catch (e) {
    erreur(e);
  }
}

// --- Dernières contributions --------------------------------------------------------------------

async function chargerContributions() {
  try {
    const r = await api(`gestion/contributions?jours=${$("jours").value}`);
    $("table-contributions").replaceChildren(tableauContributions(r.contributions, null));
  } catch (e) {
    erreur(e);
  }
}
$("jours").addEventListener("change", chargerContributions);

// --- Demandes de retrait --------------------------------------------------------------------------

const STATUTS_RETRAIT = { nouvelle: "Nouvelle", en_cours: "En cours", traitee: "Traitée", refusee: "Refusée" };

async function chargerRetraits() {
  try {
    const { demandes } = await api("gestion/retraits");
    majCompteurRetraits(demandes);
    if (!demandes.length) {
      $("table-retraits").replaceChildren(el("p", { class: "vide" }, "Aucune demande."));
      return;
    }
    $("table-retraits").replaceChildren(
      el("table", {},
        el("thead", {}, el("tr", {}, ...["Date", "Photo", "Demande", "Demandeur", "Statut"].map((t) => el("th", {}, t)))),
        el("tbody", {},
          ...demandes.map((d) => {
            const sel = el("select", { "aria-label": "Statut" },
              ...Object.entries(STATUTS_RETRAIT).map(([v, l]) => el("option", { value: v, selected: v === d.statut }, l)));
            const note = el("input", { type: "text", value: d.note || "", placeholder: "Note interne", "aria-label": "Note" });
            return el("tr", {},
              el("td", {}, dateCourte(d.creeLe)),
              el("td", {}, el("a", { href: "#", onclick: (e) => { e.preventDefault(); ouvrirOnglet("photos"); ouvrirModeration(d.photoId); } }, "Modérer"),
                " · ", el("a", { href: `/photo.html?id=${d.photoId}`, target: "_blank" }, "Voir")),
              el("td", {}, el("strong", {}, d.type === "nom" ? `Retirer le nom « ${d.nomConcerne} »` : "Retirer la photo"), el("br"), d.message || ""),
              el("td", {}, `${d.prenom} ${d.nom}`, el("br"), el("a", { href: `mailto:${d.email}` }, d.email)),
              el("td", {}, sel, note,
                el("button", {
                  type: "button", class: "petit", style: "margin-top:.3rem",
                  onclick: async () => {
                    try {
                      await api(`gestion/retraits/${d.rowKey}`, { methode: "POST", corps: { statut: sel.value, note: note.value } });
                      chargerRetraits();
                    } catch (e) { erreur(e); }
                  },
                }, "Enregistrer"),
                d.traiteePar ? el("div", { class: "aide" }, `${d.traiteePar}, ${dateCourte(d.traiteeLe)}`) : null),
            );
          }),
        ),
      ),
    );
  } catch (e) {
    erreur(e);
  }
}

function majCompteurRetraits(demandes) {
  const n = demandes.filter((d) => d.statut === "nouvelle").length;
  $("nb-retraits").replaceChildren(n ? el("span", { class: "badge masquee" }, String(n)) : "");
}

// --- Téléversement --------------------------------------------------------------------------------

const ZONE = $("zone-depot");
ZONE.addEventListener("dragover", (e) => { e.preventDefault(); ZONE.classList.add("survol"); });
ZONE.addEventListener("dragleave", () => ZONE.classList.remove("survol"));
ZONE.addEventListener("drop", (e) => {
  e.preventDefault();
  ZONE.classList.remove("survol");
  televerser([...e.dataTransfer.files].filter((f) => f.type.startsWith("image/")));
});
$("fichiers").addEventListener("change", (e) => {
  televerser([...e.target.files]);
  e.target.value = "";
});

async function redimensionner(source, tailleMax, qualite) {
  const ratio = Math.min(1, tailleMax / Math.max(source.width, source.height));
  const w = Math.max(1, Math.round(source.width * ratio));
  const h = Math.max(1, Math.round(source.height * ratio));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingQuality = "high";
  ctx.fillStyle = "#fff"; // fond blanc pour les PNG transparents
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(source, 0, 0, w, h);
  return new Promise((ok, ko) => canvas.toBlob((b) => (b ? ok(b) : ko(new Error("Conversion impossible"))), "image/jpeg", qualite));
}

async function envoyerBlob(url, corps, type) {
  const r = await fetch(url, {
    method: "PUT",
    headers: { "x-ms-blob-type": "BlockBlob", "Content-Type": type || "application/octet-stream" },
    body: corps,
  });
  if (!r.ok) throw new Error(`Envoi refusé par le stockage (${r.status})`);
}

async function televerser(fichiers) {
  if (!fichiers.length) return;
  const liste = $("progression");
  const lignes = fichiers.map((f) => {
    const li = el("li", {}, `${f.name} — en attente`);
    liste.append(li);
    return li;
  });
  const lot = $("lot").value.trim();
  let reservations;
  try {
    // L'API accepte 50 fichiers par appel.
    reservations = [];
    for (let i = 0; i < fichiers.length; i += 50) {
      const r = await api("gestion/televersement", {
        methode: "POST",
        corps: { fichiers: fichiers.slice(i, i + 50).map((f) => ({ nomFichier: f.name })) },
      });
      reservations.push(...r.televersements);
    }
  } catch (e) {
    lignes.forEach((li) => (li.textContent += " — échec : " + e.message));
    return;
  }

  let suivant = 0, reussies = 0;
  async function travailleur() {
    while (suivant < fichiers.length) {
      const i = suivant++;
      const f = fichiers[i], res = reservations[i], li = lignes[i];
      try {
        li.textContent = `${f.name} — préparation…`;
        const image = await createImageBitmap(f, { imageOrientation: "from-image" });
        const [affichage, miniature] = [await redimensionner(image, 1600, 0.85), await redimensionner(image, 480, 0.8)];
        li.textContent = `${f.name} — envoi…`;
        await envoyerBlob(res.original.url, f, f.type);
        await envoyerBlob(res.affichage.url, affichage, "image/jpeg");
        await envoyerBlob(res.miniature.url, miniature, "image/jpeg");
        await api("gestion/photos", {
          methode: "POST",
          corps: { photoId: res.photoId, nomFichier: f.name, blobOriginal: res.original.blob, largeur: image.width, hauteur: image.height, lot },
        });
        image.close?.();
        li.replaceChildren(`✓ ${f.name} `, el("a", { href: `/photo.html?id=${res.photoId}`, target: "_blank" }, "voir"));
        reussies++;
      } catch (e) {
        li.textContent = `✗ ${f.name} — ${e.message || "format non lisible par le navigateur"}`;
      }
    }
  }
  await Promise.all([travailleur(), travailleur(), travailleur()]);
  liste.append(el("li", {}, el("strong", {}, `${reussies} / ${fichiers.length} photo(s) ajoutée(s).`)));
}

// --- Export ----------------------------------------------------------------------------------------

function majLiensExport() {
  const extra = ($("exp-masquees").checked ? "&masquees=1" : "") + ($("exp-toutes").checked ? "&toutes=1" : "");
  $("exp-json").href = `/api/gestion/export?format=json${extra}`;
  $("exp-csv").href = `/api/gestion/export?format=csv${extra}`;
}
$("exp-masquees").addEventListener("change", majLiensExport);
$("exp-toutes").addEventListener("change", majLiensExport);

// --- Démarrage ---------------------------------------------------------------------------------------

preparerEntete();
api("gestion/retraits").then((r) => majCompteurRetraits(r.demandes)).catch(() => {});
chargerPhotos().then(() => {
  const ancre = location.hash.slice(1);
  if (/^[0-9A-Z]{26}$/.test(ancre)) ouvrirModeration(ancre);
});
