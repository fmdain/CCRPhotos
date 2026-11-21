import { test } from "node:test";
import assert from "node:assert/strict";
import { cleDate, interpreterDate } from "../src/lib/dates";

const A = 2026;
const cas: [string, string, string | null, boolean][] = [
  ["12/06/1985", "jour", "1985-06-12", false],
  ["1985-06-12", "jour", "1985-06-12", false],
  ["12 juin 1985", "jour", "1985-06-12", false],
  ["1er mai 1972", "jour", "1972-05-01", false],
  ["juin 85", "mois", "1985-06", false],
  ["06/1985", "mois", "1985-06", false],
  ["Août 1990", "mois", "1990-08", false],
  ["1985", "annee", "1985", false],
  ["vers 1985", "annee", "1985", true],
  ["1985 ?", "annee", "1985", true],
  ["env. 1985", "annee", "1985", true],
  ["années 80", "decennie", "198X", false],
  ["les années 1960", "decennie", "196X", false],
  ["198X", "decennie", "198X", false],
  ["1970s", "decennie", "197X", false],
  ["fin des années 70", "decennie", "197X", true],
  ["entre 1984 et 1986", "intervalle", "1984/1986", false],
  ["1984-1986", "intervalle", "1984/1986", false],
  ["31/02/1985", "inconnue", null, false],
  ["un jour de pluie", "inconnue", null, false],
  ["2099", "inconnue", null, false],
];

for (const [texte, precision, valeur, environ] of cas) {
  test(`date « ${texte} »`, () => {
    const d = interpreterDate(texte, A);
    assert.equal(d.precision, precision);
    assert.equal(d.valeur, valeur);
    if (precision !== "inconnue") assert.equal(d.environ, environ);
  });
}

test("libellés", () => {
  assert.equal(interpreterDate("12/06/1985", A).libelle, "12 juin 1985");
  assert.equal(interpreterDate("vers 1985", A).libelle, "vers 1985");
  assert.equal(interpreterDate("années 80", A).libelle, "les années 1980");
});

test("deux saisies équivalentes ont la même clé", () => {
  const a = interpreterDate("juin 1985", A);
  const b = interpreterDate("06/1985", A);
  assert.equal(cleDate(a, "juin 1985"), cleDate(b, "06/1985"));
  assert.notEqual(cleDate(interpreterDate("1985", A), "1985"), cleDate(interpreterDate("vers 1985", A), "vers 1985"));
});
