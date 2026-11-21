import { barreOutils, Visionneuse } from "./annotateur.js";
import {
  api, badgeStatut, config, el, lireIdentite, memoriserIdentite, message, pluriel, preparerEntete, preparerTurnstile,
} from "./commun.js";

const $ = (id) => document.getElementById(id);
const id = new URLSearchParams(location.search).get("id");

let conf;
let photo;
let visionneuse;
let brouillons = []; // repères saisis par l'utilisateur, pas encore envoyés
let lireTurnstile = () => undefined;

// --- Affichage -------------------------------------------------------------------

function groupesPourImage(c) {
  return c.personnes.map((g, i) => ({
    ...g,
    valide: !!g.nomValide,
    libelle: g.nomValide || (g.noms[0] ? `${g.noms[0].libelle} ?` : `n° ${i + 1}`),
  }));
}

function redessiner() {
  visionneuse.afficher(groupesPourImage(photo.consensus), brouillons.map((b, i) => ({ ...b, numero: i + 1 })));
}

function afficherValidees(c) {
  const lignes = [];
  const ajouter = (titre, contenu) => lignes.push(el("dt", {}, titre), el("dd", {}, contenu));
  if (c.date.validee) ajouter("Date", c.date.validee.libelle);
  if (c.lieu.validee) ajouter("Lieu", c.lieu.validee.libelle);
  if (c.section.validee) ajouter("Section", c.section.validee.libelle);
  const noms = c.personnes.filter((g) => g.nomValide).map((g) => g.nomValide);
  if (noms.length) ajouter("Personnes", noms.join(", "));
  for (const m of c.commentaires) ajouter("Commentaire", el("span", {}, m.texte, " ", el("span", { class: "aide" }, `— ${m.auteur}`)));
  $("badge").replaceChildren(badgeStatut(c.statut));
  $("validees").replaceChildren(
    lignes.length ? el("dl", {}, ...lignes) : el("p", { class: "vide" }, "Aucune information validée pour l'instant. À vous de jouer !"),
  );
}

function boutonConfirmer(valeurs) {
  return el("button", {
    type: "button", class: "petit secondaire",
    onclick: (e) => envoyer(valeurs, e.currentTarget, $("retour-propositions")),
  }, "Je confirme");
}

function ligneProposition(p, valeursConfirmation) {
  return el("li", {},
    el("span", { class: "valeur" }, p.libelle, p.statut === "validee" ? el("span", { class: "statut-validee" }, " ✓ validée") : null),
    el("span", { class: "votes" }, pluriel(p.votes, "vote")),
    p.statut === "validee" ? null : boutonConfirmer(valeursConfirmation),
  );
}

function afficherPropositions(c) {
  const blocs = [];
  const champ = (titre, ch, versValeurs) => {
    const props = ch.propositions;
    if (!props.length || (props.length === 1 && props[0].statut === "validee")) return;
    blocs.push(el("h3", {}, titre), el("ul", { class: "propositions" }, ...props.map((p) => ligneProposition(p, versValeurs(p)))));
  };
  champ("Date", c.date, (p) => ({ date: p.valeur.texte }));
  champ("Lieu", c.lieu, (p) => ({ lieu: p.valeur.texte }));
  champ("Section", c.section, (p) =>
    p.valeur.autre ? { section: conf.valeurAutre, sectionAutre: p.valeur.texte } : { section: p.valeur.texte },
  );

  if (c.personnes.length) {
    blocs.push(el("h3", {}, "Personnes"));
    c.personnes.forEach((g, i) => {
      const position = g.forme === "rect" ? { x: g.x, y: g.y, w: g.w, h: g.h } : { x: g.cx, y: g.cy, w: 0, h: 0 };
      const bloc = el("div", { dataset: { groupe: g.id }, style: "margin-bottom:.5rem" },
        el("div", { class: "aide" },
          el("a", { href: "#", onclick: (e) => { e.preventDefault(); visionneuse.surligner(g.id); visionneuse.defilement.scrollIntoView({ behavior: "smooth", block: "center" }); } },
            `Repère n° ${i + 1}`),
          g.nomValide ? ` — validé : ${g.nomValide}` : ""),
        el("ul", { class: "propositions" },
          ...g.noms.map((n) => ligneProposition(n, { personnes: [{ ...position, nom: n.valeur.nom }] })),
          el("li", {}, el("button", {
            type: "button", class: "petit secondaire",
            onclick: () => ajouterBrouillon(position, true),
          }, "Proposer un autre nom")),
        ),
      );
      blocs.push(bloc);
    });
  }
  $("propositions").replaceChildren(...(blocs.length ? blocs : [el("p", { class: "vide" }, "Aucune proposition en attente.")]));
}

function afficherTout() {
  afficherValidees(photo.consensus);
  afficherPropositions(photo.consensus);
  redessiner();
}

// --- Repères saisis ---------------------------------------------------------------

function afficherBrouillons() {
  $("liste-personnes").replaceChildren(
    ...brouillons.map((b, i) =>
      el("li", {},
        el("span", { class: "num", "aria-hidden": "true" }, String(i + 1)),
        el("input", {
          type: "text", value: b.nom || "", placeholder: "Prénom Nom", "aria-label": `Nom de la personne n° ${i + 1}`, maxlength: 100,
          oninput: (e) => { b.nom = e.target.value; },
        }),
        el("button", {
          type: "button", class: "petit secondaire", "aria-label": `Retirer le repère ${i + 1}`,
          onclick: () => { brouillons.splice(i, 1); afficherBrouillons(); redessiner(); },
        }, "✕"),
      ),
    ),
  );
  redessiner();
}

function ajouterBrouillon(repere, defiler = false) {
  brouillons.push({ ...repere, nom: "" });
  afficherBrouillons();
  const champs = $("liste-personnes").querySelectorAll("input");
  const dernier = champs[champs.length - 1];
  if (defiler) dernier?.scrollIntoView({ behavior: "smooth", block: "center" });
  dernier?.focus({ preventScroll: !defiler });
}

function basculerAnnotation(actif) {
  visionneuse.activerAnnotation(actif);
  $("aide-annotation").hidden = !actif;
  const b = document.getElementById("bouton-annoter");
  b.classList.toggle("actif", actif);
  b.textContent = actif ? "✓ Terminer les repères" : "＋ Placer un repère";
}

// --- Envoi ------------------------------------------------------------------------

function identite() {
  return { prenom: $("prenom").value.trim(), nom: $("nom").value.trim(), email: $("email").value.trim() };
}

async function envoyer(valeurs, bouton, retour = $("retour-formulaire")) {
  $("retour-formulaire").replaceChildren();
  $("retour-propositions").replaceChildren();
  const qui = identite();
  if (!qui.prenom || !qui.nom) {
    message($("retour-formulaire"), "Merci d'indiquer votre prénom et votre nom avant d'envoyer ou de confirmer.", "erreur");
    $(qui.prenom ? "nom" : "prenom").focus();
    return false;
  }
  if ($("memoriser").checked) memoriserIdentite(qui);
  else memoriserIdentite(null);
  if (bouton) bouton.disabled = true;
  try {
    const r = await api(`photos/${encodeURIComponent(id)}/contributions`, {
      methode: "POST",
      corps: { ...valeurs, ...qui, site_web: $("site_web").value, turnstile: lireTurnstile() },
    });
    if (r.consensus) {
      photo.consensus = r.consensus;
      afficherTout();
    }
    message(retour, `Merci ! ${pluriel(r.enregistrees, "information enregistrée", "informations enregistrées")}.`, "ok");
    return true;
  } catch (e) {
    message(retour, e.message, "erreur");
    retour.scrollIntoView({ behavior: "smooth", block: "center" });
    return false;
  } finally {
    if (bouton) bouton.disabled = false;
  }
}

async function soumettre(e) {
  e.preventDefault();
  const sansNom = brouillons.filter((b) => !b.nom?.trim());
  if (sansNom.length) {
    message($("retour-formulaire"), "Indiquez un nom pour chaque repère placé, ou retirez-le.", "erreur");
    return;
  }
  const valeurs = {
    date: $("date").value,
    lieu: $("lieu").value,
    section: $("section").value,
    sectionAutre: $("section-autre").value,
    personnes: brouillons.map(({ x, y, w, h, nom }) => ({ x, y, w, h, nom: nom.trim() })),
    commentaire: $("commentaire").value,
  };
  const rien = !valeurs.date.trim() && !valeurs.lieu.trim() && !valeurs.section && !valeurs.personnes.length && !valeurs.commentaire.trim();
  if (rien) {
    message($("retour-formulaire"), "Renseignez au moins une information.", "erreur");
    return;
  }
  const ok = await envoyer(valeurs, $("envoyer"));
  if (ok) {
    for (const champ of ["date", "lieu", "section", "section-autre", "commentaire"]) $(champ).value = "";
    $("bloc-autre").hidden = true;
    $("apercu-date").textContent = "";
    brouillons = [];
    afficherBrouillons();
    basculerAnnotation(false);
  }
}

// --- Aide à la saisie de la date ----------------------------------------------------

let minuterieDate;
function apercuDate() {
  clearTimeout(minuterieDate);
  const texte = $("date").value.trim();
  if (!texte) {
    $("apercu-date").textContent = "";
    return;
  }
  minuterieDate = setTimeout(async () => {
    try {
      const d = await api("dates/interpreter?texte=" + encodeURIComponent(texte));
      $("apercu-date").textContent = d.precision === "inconnue"
        ? "Format non reconnu : votre texte sera conservé tel quel."
        : `Compris : ${d.libelle}`;
    } catch {
      $("apercu-date").textContent = "";
    }
  }, 400);
}

// --- Demande de retrait ---------------------------------------------------------------

function preparerRetrait() {
  const dlg = $("dialogue-retrait");
  const form = $("form-retrait");
  $("lien-retrait").addEventListener("click", (e) => {
    e.preventDefault();
    const qui = identite();
    $("r-prenom").value ||= qui.prenom;
    $("r-nom").value ||= qui.nom;
    $("r-email").value ||= qui.email;
    $("retour-retrait").replaceChildren();
    dlg.showModal();
  });
  $("fermer-retrait").addEventListener("click", () => dlg.close());
  form.addEventListener("change", () => {
    $("bloc-nom-concerne").hidden = form.elements.type.value !== "nom";
  });
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = form.elements;
    try {
      await api(`photos/${encodeURIComponent(id)}/retrait`, {
        methode: "POST",
        corps: {
          type: f.type.value, nomConcerne: f.nomConcerne.value, message: f.message.value,
          prenom: f.prenom.value, nom: f.nom.value, email: f.email.value, site_web: f.site_web.value,
        },
      });
      message($("retour-retrait"), "Votre demande a bien été enregistrée. Nous vous répondrons par email.", "ok");
      setTimeout(() => dlg.close(), 2500);
    } catch (err) {
      message($("retour-retrait"), err.message, "erreur");
    }
  });
}

// --- Démarrage ----------------------------------------------------------------------

async function demarrer() {
  preparerEntete();
  if (document.referrer && new URL(document.referrer).origin === location.origin && new URL(document.referrer).pathname === "/") {
    $("lien-retour").href = document.referrer;
  }
  if (!id) {
    message($("etat"), "Photo introuvable.", "erreur");
    return;
  }
  message($("etat"), "Chargement…");
  try {
    [conf, photo] = await Promise.all([config(), api(`photos/${encodeURIComponent(id)}`)]);
  } catch (e) {
    message($("etat"), e.status === 404 ? "Cette photo n'existe pas ou n'est plus visible." : e.message, "erreur");
    return;
  }
  $("etat").replaceChildren();
  $("page").hidden = false;
  $("n-votes").textContent = conf.votesMinimum;

  const sel = $("section");
  for (const s of conf.sections) sel.append(el("option", { value: s }, s));
  sel.append(el("option", { value: conf.valeurAutre }, "Autre…"));
  sel.addEventListener("change", () => { $("bloc-autre").hidden = sel.value !== conf.valeurAutre; });

  visionneuse = new Visionneuse($("visionneuse"), {
    src: photo.image,
    largeur: photo.largeur,
    hauteur: photo.hauteur,
    alt: "Photo à identifier",
    onRepere: (r) => ajouterBrouillon(r),
    onClicGroupe: (g) => {
      visionneuse.surligner(g.id);
      document.querySelector(`[data-groupe="${CSS.escape(g.id)}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" });
    },
  });
  const boutonAnnoter = el("button", { type: "button", id: "bouton-annoter", class: "petit", onclick: () => basculerAnnotation(!visionneuse.annotation) }, "＋ Placer un repère");
  $("barre").replaceChildren(barreOutils(visionneuse, boutonAnnoter));
  $("ajouter-personne").addEventListener("click", () => {
    basculerAnnotation(true);
    visionneuse.defilement.scrollIntoView({ behavior: "smooth", block: "center" });
  });

  afficherTout();

  const qui = lireIdentite();
  if (qui) {
    $("prenom").value = qui.prenom || "";
    $("nom").value = qui.nom || "";
    $("email").value = qui.email || "";
    $("memoriser").checked = true;
  }
  $("date").addEventListener("input", apercuDate);
  $("formulaire").addEventListener("submit", soumettre);
  preparerRetrait();

  api("lieux").then((r) => $("liste-lieux").replaceChildren(...r.lieux.map((l) => el("option", { value: l })))).catch(() => {});
  preparerTurnstile($("turnstile")).then((f) => { lireTurnstile = f; }).catch(() => {});
}

demarrer();
