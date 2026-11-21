// Infrastructure du site d'identification des photos du CCR.
// Crée : compte de stockage (4 conteneurs privés, 6 tables, règles CORS), application Static Web Apps (plan gratuit)
// et ses paramètres d'application (chaîne de connexion, secrets).

@description('Préfixe des noms de ressources (minuscules et chiffres, 3 à 11 caractères).')
@minLength(3)
@maxLength(11)
param prefixe string = 'ccrphotos'

@description('Région du compte de stockage.')
param region string = resourceGroup().location

@description('Région de Static Web Apps (régions disponibles : westeurope, centralus, eastus2, westus2, eastasia).')
param regionSwa string = 'westeurope'

@description('Mode d\'accès : public, motdepasse ou connecte.')
@allowed(['public', 'motdepasse', 'connecte'])
param modeAcces string = 'public'

@description('Mot de passe commun (mode « motdepasse » uniquement).')
@secure()
param motDePasseAcces string = ''

@description('Secret Cloudflare Turnstile (facultatif).')
@secure()
param secretTurnstile string = ''

@description('Secret servant à hacher les adresses IP. Généré automatiquement par défaut.')
@secure()
param secretIp string = newGuid()

@description('Secret servant à signer le cookie d\'accès. Généré automatiquement par défaut.')
@secure()
param secretCookie string = newGuid()

@description('Origines supplémentaires autorisées à envoyer des fichiers (ex. domaine personnalisé).')
param originesSupplementaires array = []

var nomStockage = toLower('${prefixe}${uniqueString(resourceGroup().id)}')
var conteneurs = ['originaux', 'affichage', 'miniatures', 'annotees']
var tables = ['Photos', 'Contributions', 'Moderation', 'Retraits', 'Lieux', 'Debit']

resource swa 'Microsoft.Web/staticSites@2023-12-01' = {
  name: '${prefixe}-site'
  location: regionSwa
  sku: {
    name: 'Free'
    tier: 'Free'
  }
  properties: {
    // Le dépôt est relié par le workflow GitHub Actions (jeton de déploiement), pas ici.
    allowConfigFileUpdates: true
    stagingEnvironmentPolicy: 'Enabled'
  }
}

resource stockage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: take(nomStockage, 24)
  location: region
  sku: {
    name: 'Standard_LRS'
  }
  kind: 'StorageV2'
  properties: {
    accessTier: 'Hot'
    allowBlobPublicAccess: false
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
    allowSharedKeyAccess: true // nécessaire pour signer les URL SAS avec la clé du compte
  }
}

resource blobs 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: stockage
  name: 'default'
  properties: {
    // Le navigateur de l'administrateur envoie les fichiers directement dans le stockage.
    cors: {
      corsRules: [
        {
          allowedOrigins: concat(['https://${swa.properties.defaultHostname}', 'http://localhost:4280'], originesSupplementaires)
          allowedMethods: ['GET', 'HEAD', 'PUT', 'OPTIONS']
          allowedHeaders: ['*']
          exposedHeaders: ['*']
          maxAgeInSeconds: 3600
        }
      ]
    }
    deleteRetentionPolicy: {
      enabled: true
      days: 30 // filet de sécurité : un original supprimé par erreur reste récupérable 30 jours
    }
  }
}

resource conteneursRes 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = [for c in conteneurs: {
  parent: blobs
  name: c
  properties: {
    publicAccess: 'None'
  }
}]

resource tablesService 'Microsoft.Storage/storageAccounts/tableServices@2023-05-01' = {
  parent: stockage
  name: 'default'
}

resource tablesRes 'Microsoft.Storage/storageAccounts/tableServices/tables@2023-05-01' = [for t in tables: {
  parent: tablesService
  name: t
}]

var connexion = 'DefaultEndpointsProtocol=https;AccountName=${stockage.name};AccountKey=${stockage.listKeys().keys[0].value};EndpointSuffix=${environment().suffixes.storage}'

resource parametres 'Microsoft.Web/staticSites/config@2023-12-01' = {
  parent: swa
  name: 'appsettings'
  properties: {
    STORAGE_CONNECTION_STRING: connexion
    IP_HASH_SECRET: secretIp
    ACCESS_COOKIE_SECRET: secretCookie
    ACCESS_MODE: modeAcces
    ACCESS_PASSWORD: motDePasseAcces
    TURNSTILE_SECRET: secretTurnstile
  }
}

output nomSite string = swa.name
output urlSite string = 'https://${swa.properties.defaultHostname}'
output nomStockage string = stockage.name
