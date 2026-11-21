import { test } from "node:test";
import assert from "node:assert/strict";
import { calculerConsensus, consensusPublic, Contribution, Decision } from "../src/lib/consensus";
import { normaliser, ulid } from "../src/lib/util";

const P = { votesMinimum: 2, distancePersonnes: 0.05, tailleVisageParDefaut: 0.08, largeur: 1000, hauteur: 1000 };
let t = Date.UTC(2026, 0, 1);

function c(champ: Contribution["champ"], valeur: any, cle: string, qui: string): Contribution {
  const [prenom, nom] = qui.split(" ");
  return {
    rowKey: ulid(t++), photoId: "P", soumission: "S", champ, valeur, cle, prenom, nom, ipHash: "h", creeLe: new Date(t).toISOString(),
  };
}
const lieu = (txt: string, qui: string) => c("lieu", { texte: txt }, normaliser(txt), qui);
const pers = (nom: string, x: number, y: number, qui: string, w = 0, h = 0) =>
  c("personne", { nom, x, y, w, h }, normaliser(nom), qui);
function d(champ: Decision["champ"], action: Decision["action"], cle: string, extra: Partial<Decision> = {}): Decision {
  return { rowKey: ulid(t++), champ, action, cle, admin: "admin", creeLe: "", ...extra };
}

test("une seule contribution ne suffit pas", () => {
  const r = calculerConsensus([lieu("Stade municipal", "Jean Dupont")], [], P);
  assert.equal(r.lieu.validee, null);
  assert.equal(r.statut, "a_identifier");
  assert.equal(r.lieu.propositions[0].votes, 1);
});

test("deux contributeurs distincts concordants valident", () => {
  const r = calculerConsensus([lieu("Stade municipal", "Jean Dupont"), lieu("stade  Municipal", "Marie Durand")], [], P);
  assert.equal(r.lieu.validee?.votes, 2);
  assert.equal(r.statut, "partielle");
});

test("la même personne qui confirme deux fois ne compte qu'une voix", () => {
  const r = calculerConsensus([lieu("Stade", "Jean Dupont"), lieu("Stade", "jean DUPONT")], [], P);
  assert.equal(r.lieu.validee, null);
});

test("égalité : rien n'est validé", () => {
  const r = calculerConsensus([
    lieu("A", "a a"), lieu("A", "b b"), lieu("B", "c c"), lieu("B", "d d"),
  ], [], P);
  assert.equal(r.lieu.validee, null);
});

test("l'admin valide ou rejette, la dernière décision l'emporte", () => {
  const contribs = [lieu("A", "a a"), lieu("A", "b b"), lieu("B", "c c")];
  let r = calculerConsensus(contribs, [d("lieu", "valider", "b")], P);
  assert.equal(r.lieu.validee?.cle, "b");
  assert.ok(r.lieu.validee?.parAdmin);
  r = calculerConsensus(contribs, [d("lieu", "rejeter", "a")], P);
  assert.equal(r.lieu.validee, null);
  assert.equal(r.lieu.propositions.find((p) => p.cle === "a")?.statut, "rejetee");
  r = calculerConsensus(contribs, [d("lieu", "rejeter", "a"), d("lieu", "annuler", "a")], P);
  assert.equal(r.lieu.validee?.cle, "a");
});

test("contributions supprimées ignorées", () => {
  const x = lieu("A", "b b");
  x.supprimee = true;
  const r = calculerConsensus([lieu("A", "a a"), x], [], P);
  assert.equal(r.lieu.validee, null);
});

test("repères proches regroupés, nom le plus fréquent retenu", () => {
  const r = calculerConsensus([
    pers("Jean Martin", 0.30, 0.40, "a a"),
    pers("Jean Martin", 0.31, 0.41, "b b"),
    pers("Jacques Martin", 0.305, 0.395, "c c"),
    pers("Paul Petit", 0.70, 0.40, "a a"),
  ], [], P);
  assert.equal(r.personnes.length, 2);
  const g = r.personnes.find((p) => p.nbReperes === 3)!;
  assert.equal(g.nomValide, "Jean Martin");
  assert.equal(g.noms[0].votes, 2);
  const seul = r.personnes.find((p) => p.nbReperes === 1)!;
  assert.equal(seul.nomValide, null);
  assert.equal(seul.forme, "point");
  assert.ok(Math.abs(seul.w - 0.08) < 1e-9);
});

test("rectangles : cadre moyen et centre", () => {
  const r = calculerConsensus([
    pers("Jean", 0.2, 0.2, "a a", 0.1, 0.1),
    pers("Jean", 0.21, 0.2, "b b", 0.1, 0.12),
  ], [], P);
  assert.equal(r.personnes.length, 1);
  const g = r.personnes[0];
  assert.equal(g.forme, "rect");
  assert.equal(g.x, 0.205);
  assert.equal(g.h, 0.11);
  assert.equal(g.nomValide, "Jean");
});

test("décision admin sur une personne rattachée par position", () => {
  const contribs = [pers("Jean", 0.5, 0.5, "a a"), pers("Pierre", 0.51, 0.5, "b b")];
  const r = calculerConsensus(contribs, [d("personne", "valider", "pierre", { x: 0.505, y: 0.5 })], P);
  assert.equal(r.personnes[0].nomValide, "Pierre");
});

test("statut validée et version publique", () => {
  const contribs = [
    c("date", { texte: "1985", normalisee: { precision: "annee", valeur: "1985", environ: false, debut: "", fin: "", libelle: "1985" } }, "annee:1985", "a a"),
    c("date", { texte: "1985", normalisee: { precision: "annee", valeur: "1985", environ: false, debut: "", fin: "", libelle: "1985" } }, "annee:1985", "b b"),
    lieu("Stade", "a a"), lieu("Stade", "b b"),
    c("section", { texte: "Football", autre: false }, "football", "a a"),
    c("section", { texte: "Football", autre: false }, "football", "b b"),
    pers("Jean", 0.5, 0.5, "a a"), pers("Jean", 0.5, 0.5, "b b"),
    c("commentaire", { texte: "Finale départementale" }, "", "a a"),
  ];
  const r = calculerConsensus(contribs, [], P);
  assert.equal(r.statut, "validee");
  const pub = consensusPublic(r);
  assert.equal(pub.commentaires.length, 0, "commentaire non validé masqué");
  const r2 = calculerConsensus(contribs, [d("commentaire", "valider", contribs[8].rowKey)], P);
  assert.equal(consensusPublic(r2).commentaires.length, 1);
  // Un visage sans nom validé empêche le statut « validée ».
  const r3 = calculerConsensus([...contribs, pers("Inconnu", 0.1, 0.1, "c c")], [], P);
  assert.equal(r3.statut, "partielle");
});
