// Affichage d'une photo avec ses repères, et saisie de nouveaux repères
// (clic = point, glisser = rectangle). Coordonnées normalisées 0–1.
import { el } from "./commun.js";

const SEUIL_RECTANGLE = 0.015; // en dessous, un glisser est considéré comme un clic

export class Visionneuse {
  /**
   * @param {HTMLElement} racine conteneur vide
   * @param {{ src: string, largeur: number, hauteur: number, alt?: string, onRepere?: Function, onClicGroupe?: Function }} opts
   */
  constructor(racine, opts) {
    this.opts = opts;
    this.zoom = 1;
    this.groupes = [];
    this.brouillons = [];
    this.annotation = false;

    this.img = el("img", { src: opts.src, alt: opts.alt || "Photo", draggable: "false" });
    this.calque = el("div", { class: "calque" });
    this.cadre = el("div", { class: "cadre" }, this.img, this.calque);
    this.defilement = el("div", { class: "defilement" }, this.cadre);
    racine.replaceChildren(this.defilement);

    if (opts.largeur && opts.hauteur) this.img.style.aspectRatio = `${opts.largeur} / ${opts.hauteur}`;
    this.calque.addEventListener("pointerdown", (e) => this.#debut(e));
    this.calque.addEventListener("pointermove", (e) => this.#mouvement(e));
    this.calque.addEventListener("pointerup", (e) => this.#fin(e));
    this.calque.addEventListener("pointercancel", () => this.#annulerTrace());
  }

  definirZoom(z) {
    this.zoom = z;
    this.cadre.style.width = `${z * 100}%`;
  }

  basculerEtiquettes(visible) {
    this.calque.classList.toggle("sans-etiquettes", !visible);
  }

  activerAnnotation(actif) {
    this.annotation = actif;
    this.calque.classList.toggle("annotation", actif);
  }

  /** groupes : [{ id, cx, cy, x, y, w, h, forme, libelle, valide }] ; brouillons : [{ x, y, w, h, numero }] */
  afficher(groupes = this.groupes, brouillons = this.brouillons) {
    this.groupes = groupes;
    this.brouillons = brouillons;
    const enfants = [];
    for (const g of groupes) {
      const r = this.#repere(g, `repere ${g.valide ? "valide" : ""}`, g.libelle);
      r.dataset.groupe = g.id;
      r.title = g.libelle || "";
      r.addEventListener("click", (e) => {
        if (this.annotation) return;
        e.stopPropagation();
        this.opts.onClicGroupe?.(g);
      });
      enfants.push(r);
    }
    for (const b of brouillons) enfants.push(this.#repere(b, "repere brouillon", String(b.numero)));
    this.calque.replaceChildren(...enfants);
  }

  surligner(idGroupe) {
    for (const r of this.calque.querySelectorAll(".repere")) {
      r.classList.toggle("surbrillance", r.dataset.groupe === idGroupe);
    }
  }

  #repere(v, classe, etiquette) {
    const estRect = v.w > 0 && v.h > 0 && (v.forme ? v.forme === "rect" : true);
    const r = el("div", { class: `${classe} ${estRect ? "" : "point"}` });
    if (estRect) {
      Object.assign(r.style, { left: pct(v.x), top: pct(v.y), width: pct(v.w), height: pct(v.h) });
    } else {
      const cx = v.cx ?? v.x, cy = v.cy ?? v.y;
      Object.assign(r.style, { left: pct(cx), top: pct(cy) });
    }
    if (etiquette) r.append(el("span", { class: "etiquette" }, etiquette));
    return r;
  }

  #coord(e) {
    const b = this.calque.getBoundingClientRect();
    return {
      x: Math.min(1, Math.max(0, (e.clientX - b.left) / b.width)),
      y: Math.min(1, Math.max(0, (e.clientY - b.top) / b.height)),
    };
  }

  #debut(e) {
    if (!this.annotation || (e.pointerType === "mouse" && e.button !== 0)) return;
    e.preventDefault();
    this.calque.setPointerCapture(e.pointerId);
    this.depart = this.#coord(e);
    this.trace = el("div", { class: "trace" });
    this.calque.append(this.trace);
    this.#majTrace(this.depart);
  }

  #mouvement(e) {
    if (!this.depart) return;
    this.#majTrace(this.#coord(e));
  }

  #majTrace(p) {
    const x = Math.min(p.x, this.depart.x), y = Math.min(p.y, this.depart.y);
    Object.assign(this.trace.style, {
      left: pct(x), top: pct(y),
      width: pct(Math.abs(p.x - this.depart.x)), height: pct(Math.abs(p.y - this.depart.y)),
    });
  }

  #fin(e) {
    if (!this.depart) return;
    const p = this.#coord(e);
    const d = this.depart;
    this.#annulerTrace();
    const w = Math.abs(p.x - d.x), h = Math.abs(p.y - d.y);
    const repere = w > SEUIL_RECTANGLE && h > SEUIL_RECTANGLE
      ? { x: Math.min(p.x, d.x), y: Math.min(p.y, d.y), w, h }
      : { x: d.x, y: d.y, w: 0, h: 0 };
    this.opts.onRepere?.(arrondir(repere));
  }

  #annulerTrace() {
    this.trace?.remove();
    this.trace = null;
    this.depart = null;
  }
}

function pct(v) {
  return `${(v * 100).toFixed(3)}%`;
}

function arrondir(r) {
  const a = (n) => Math.round(n * 10000) / 10000;
  return { x: a(r.x), y: a(r.y), w: a(r.w), h: a(r.h) };
}

/** Barre de zoom et d'affichage des noms, commune à la page photo et à l'admin. */
export function barreOutils(visionneuse, ...autres) {
  const niveaux = [1, 1.5, 2, 3];
  const boutons = niveaux.map((z) =>
    el("button", {
      type: "button", class: `petit secondaire ${z === 1 ? "actif" : ""}`, "aria-label": `Zoom ${z}×`,
      onclick: (e) => {
        visionneuse.definirZoom(z);
        boutons.forEach((b) => b.classList.remove("actif"));
        e.currentTarget.classList.add("actif");
      },
    }, `${z}×`),
  );
  const noms = el("input", { type: "checkbox", checked: true, onchange: (e) => visionneuse.basculerEtiquettes(e.target.checked) });
  return el("div", { class: "outils" },
    ...autres,
    el("span", { class: "aide" }, "Zoom :"), ...boutons,
    el("label", { class: "aide", style: "display:inline-flex;gap:.3rem;margin:0;font-weight:400" }, noms, "noms"),
  );
}
