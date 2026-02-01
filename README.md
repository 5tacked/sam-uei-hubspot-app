# SAM.gov UEI Matcher - HubSpot App

A HubSpot public app that automatically matches companies with SAM.gov entities using UEI (Unique Entity Identifier) for government contracting data enrichment.

## Features

- **Automatic Matching**: When a company is created in HubSpot, the app automatically searches SAM.gov for matching entities
- **Fuzzy Name Matching**: Uses Dice coefficient algorithm to find similar company names
- **Subsidiary Detection**: Identifies potential subsidiaries that have UEIs
- **SAM Entity Card**: Rich UI extension showing SAM.gov data directly on company records
- **Manual Linking**: Allows users to search and manually link companies to SAM entities
- **Data Sync**: Keeps HubSpot company properties updated with SAM.gov data

## Architecture

- **Frontend**: React-based UI Extension (App Card) using HubSpot UI Extensions SDK
- **Backend**: Vercel serverless functions
- **Database**: Supabase (PostgreSQL)
- **APIs**: SAM.gov Entity Management API v3, HubSpot CRM API

## Project Structure

```
sam-uei-hubspot-project/
├── hsproject.json              # HubSpot project configuration
├── package.json                # Node.js dependencies
├── vercel.json                 # Vercel deployment configuration
├── tsconfig.json               # TypeScript configuration
├── src/
│   └── app/
│       ├── app-hsmeta.json     # HubSpot app configuration (OAuth, scopes)
│       ├── extensions/
│       │   └── sam-entity-card/
│       │       ├── sam-entity-card-hsmeta.json  # Card configuration
│       │       ├── SamEntityCard.tsx            # React component
│       │       └── package.json
│       └── webhooks/
│           └── company-webhook-hsmeta.json      # Webhook configuration
└── api/
    ├── oauth/
    │   ├── authorize.ts        # OAuth initiation
    │   └── callback.ts         # OAuth callback handler
    ├── webhooks/
    │   └── company.ts          # Company creation webhook handler
    └── functions/
        ├── getSamEntity.ts     # Get SAM entity for a company
        ├── searchSamEntities.ts # Search SAM.gov
        ├── linkSamEntity.ts    # Link company to SAM entity
        ├── unlinkSamEntity.ts  # Unlink company from SAM entity
        └── refreshSamEntity.ts # Refresh SAM data
```

## Setup Instructions

### 1. Prerequisites

- Node.js 18+
- npm or yarn
- HubSpot Developer Account
- Vercel Account
- Supabase Account
- SAM.gov API Key

### 2. Supabase Setup

Your Supabase project has already been created:
- **Project ID**: qwmmcwolkcgwuofqwgys
- **URL**: https://qwmmcwolkcgwuofqwgys.supabase.co

The database schema has been applied. You need to get the API keys:
1. Go to https://supabase.com/dashboard/project/qwmmcwolkcgwuofqwgys/settings/api
2. Copy the `anon` key (for public access)
3. Copy the `service_role` key (for server-side operations)

### 3. SAM.gov API Key

Your SAM.gov API key: `SAM-953ac27b-fe83-4955-9497-31f8a9de3ea5`

### 4. Deploy to Vercel

Option A: Via GitHub (Recommended)
1. Initialize git repo: `git init && git add . && git commit -m "Initial commit"`
2. Push to GitHub
3. Go to https://vercel.com/new
4. Import the GitHub repository
5. Add environment variables (see below)
6. Deploy

Option B: Via Vercel CLI
```bash
npm install -g vercel
vercel login
vercel --prod
```

### 5. Environment Variables for Vercel

Add these in the Vercel dashboard (Project Settings > Environment Variables):

```
SUPABASE_URL=https://qwmmcwolkcgwuofqwgys.supabase.co
SUPABASE_SERVICE_KEY=<your-service-role-key>
SAM_GOV_API_KEY=SAM-953ac27b-fe83-4955-9497-31f8a9de3ea5
HUBSPOT_CLIENT_ID=<from-hubspot-app>
HUBSPOT_CLIENT_SECRET=<from-hubspot-app>
HUBSPOT_REDIRECT_URI=https://your-vercel-app.vercel.app/api/oauth/callback
```

### 6. HubSpot App Setup

1. Go to https://app.hubspot.com/developer-projects/46167485
2. Click "Projects" > "Upload Project"
3. Upload this project using the HubSpot CLI:
   ```bash
   npm install -g @hubspot/cli
   hs project upload
   ```
4. After uploading, go to the project in HubSpot
5. Copy the Client ID and Client Secret from the Auth tab
6. Update the Vercel environment variables with these values

### 7. Configure Webhook URL

After deploying to Vercel, update the webhook URL in:
- `src/app/webhooks/company-webhook-hsmeta.json`
- Change `targetUrl` to your actual Vercel deployment URL

### 8. Install the App

1. Navigate to: `https://your-vercel-app.vercel.app/api/oauth/authorize`
2. This will redirect to HubSpot OAuth
3. Authorize the app for your portal
4. The app will be installed and SAM properties will be created

## Custom Properties Created

The app creates these custom properties on the Company object:

| Property | Type | Description |
|----------|------|-------------|
| sam_uei | String | Unique Entity Identifier |
| sam_cage_code | String | CAGE Code |
| sam_registration_status | String | Registration status |
| sam_registration_expiration | Date | Expiration date |
| sam_legal_name | String | Legal business name |
| sam_business_types | Text | Business type designations |
| sam_naics_codes | String | NAICS codes |
| sam_sba_certifications | Text | SBA certifications |
| sam_last_synced | DateTime | Last sync timestamp |

## Webhook Events

The app listens for:
- `company.creation` - Automatically matches new companies
- `company.propertyChange` (name) - Re-matches when name changes
- `company.propertyChange` (domain) - Re-matches when domain changes

## Matching Logic

1. When a company is created, the app searches SAM.gov by company name
2. Uses Dice coefficient algorithm for fuzzy name matching
3. Adds bonus for state/location matches
4. **Auto-links** if match score >= 85%
5. **Queues for review** if score is 50-85%
6. **No match** if score < 50%

## Development

```bash
# Install dependencies
npm install

# Run local development
npm run dev

# Upload to HubSpot
npm run hs:upload

# Deploy to Vercel
npm run deploy
```

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| /api/oauth/authorize | GET | Start OAuth flow |
| /api/oauth/callback | GET | OAuth callback |
| /api/webhooks/company | POST | Webhook handler |
| /api/functions/getSamEntity | POST | Get SAM entity data |
| /api/functions/searchSamEntities | POST | Search SAM.gov |
| /api/functions/linkSamEntity | POST | Link to SAM entity |
| /api/functions/unlinkSamEntity | POST | Unlink SAM entity |
| /api/functions/refreshSamEntity | POST | Refresh SAM data |

## License

MIT
