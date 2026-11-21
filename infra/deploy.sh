#!/usr/bin/env bash
# Crée (ou met à jour) l'infrastructure Azure du site.
# Usage : ./infra/deploy.sh [groupe-de-ressources] [region]
# Variables facultatives : PREFIXE, MODE_ACCES, MOT_DE_PASSE_ACCES, SECRET_TURNSTILE
set -euo pipefail

GROUPE="${1:-rg-ccr-photos}"
REGION="${2:-francecentral}"
PREFIXE="${PREFIXE:-ccrphotos}"
MODE_ACCES="${MODE_ACCES:-public}"
DOSSIER="$(cd "$(dirname "$0")" && pwd)"

command -v az >/dev/null || { echo "Azure CLI introuvable : https://learn.microsoft.com/cli/azure/install-azure-cli"; exit 1; }
az account show >/dev/null 2>&1 || az login

echo "→ Groupe de ressources $GROUPE ($REGION)"
az group create --name "$GROUPE" --location "$REGION" --output none

echo "→ Déploiement Bicep (quelques minutes)"
SORTIES=$(az deployment group create \
  --resource-group "$GROUPE" \
  --name "ccr-photos-$(date +%Y%m%d%H%M%S)" \
  --template-file "$DOSSIER/main.bicep" \
  --parameters prefixe="$PREFIXE" modeAcces="$MODE_ACCES" \
               motDePasseAcces="${MOT_DE_PASSE_ACCES:-}" secretTurnstile="${SECRET_TURNSTILE:-}" \
  --query properties.outputs --output json)

NOM_SITE=$(echo "$SORTIES" | python3 -c 'import json,sys; print(json.load(sys.stdin)["nomSite"]["value"])')
URL_SITE=$(echo "$SORTIES" | python3 -c 'import json,sys; print(json.load(sys.stdin)["urlSite"]["value"])')
NOM_STOCKAGE=$(echo "$SORTIES" | python3 -c 'import json,sys; print(json.load(sys.stdin)["nomStockage"]["value"])')

JETON=$(az staticwebapp secrets list --name "$NOM_SITE" --resource-group "$GROUPE" --query properties.apiKey --output tsv)

cat <<FIN

✓ Infrastructure prête.
  Site          : $URL_SITE
  Static Web App: $NOM_SITE
  Stockage      : $NOM_STOCKAGE

Étape suivante : dans GitHub (Settings → Secrets and variables → Actions), créez le secret
  AZURE_STATIC_WEB_APPS_API_TOKEN = $JETON
puis poussez sur la branche main pour déployer le site.

Chaîne de connexion pour le script ExifTool (à garder secrète) :
  az storage account show-connection-string -g $GROUPE -n $NOM_STOCKAGE --query connectionString -o tsv
FIN
