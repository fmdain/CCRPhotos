#!/usr/bin/env node
// Adapte app/staticwebapp.config.json au mode d'accès choisi dans api/site.config.json
// (ou dans la variable d'environnement ACCESS_MODE).
//   public     : rien à faire (seule l'administration est protégée)
//   motdepasse : protégé par l'API (cookie signé), rien à changer côté routes
//   connecte   : toutes les pages exigent une connexion (rôle intégré « authenticated »)
// Lancé par le workflow GitHub Actions avant le déploiement ; peut aussi être lancé à la main.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const racine = join(dirname(fileURLToPath(import.meta.url)), "..");
const site = JSON.parse(readFileSync(join(racine, "api", "site.config.json"), "utf8"));
const mode = process.env.ACCESS_MODE || site.acces?.mode || "public";
const chemin = join(racine, "app", "staticwebapp.config.json");
const swa = JSON.parse(readFileSync(chemin, "utf8"));

// Routes ajoutées en mode « connecte » (placées en dernier : les règles admin restent prioritaires).
const GENEREES = [
  { route: "/mentions.html" },
  { route: "/favicon.svg" },
  { route: "/*", allowedRoles: ["authenticated"] },
];
const signature = (r) => JSON.stringify(r);
const aRetirer = new Set(GENEREES.map(signature));
swa.routes = swa.routes.filter((r) => !aRetirer.has(signature(r)));
if (mode === "connecte") swa.routes.push(...GENEREES);
writeFileSync(chemin, JSON.stringify(swa, null, 2) + "\n");
console.log(`staticwebapp.config.json : mode d'accès « ${mode} »`);
