import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY!
);

const HUBSPOT_CLIENT_ID = process.env.HUBSPOT_CLIENT_ID!;
const HUBSPOT_CLIENT_SECRET = process.env.HUBSPOT_CLIENT_SECRET!;
const REDIRECT_URI = process.env.HUBSPOT_REDIRECT_URI || 'https://sam-uei-hubspot-app.vercel.app/api/oauth/callback';

// SAM-related custom properties to create on first install
const SAM_PROPERTIES = [
  {
    name: 'sam_uei',
    label: 'SAM.gov UEI',
    type: 'string',
    fieldType: 'text',
    groupName: 'companyinformation',
    description: 'Unique Entity Identifier from SAM.gov',
  },
  {
    name: 'sam_cage_code',
    label: 'CAGE Code',
    type: 'string',
    fieldType: 'text',
    groupName: 'companyinformation',
    description: 'Commercial and Government Entity Code',
  },
  {
    name: 'sam_registration_status',
    label: 'SAM Registration Status',
    type: 'string',
    fieldType: 'text',
    groupName: 'companyinformation',
    description: 'Current SAM.gov registration status',
  },
  {
    name: 'sam_registration_expiration',
    label: 'SAM Registration Expiration',
    type: 'date',
    fieldType: 'date',
    groupName: 'companyinformation',
    description: 'SAM.gov registration expiration date',
  },
  {
    name: 'sam_legal_name',
    label: 'SAM Legal Business Name',
    type: 'string',
    fieldType: 'text',
    groupName: 'companyinformation',
    description: 'Legal business name from SAM.gov',
  },
  {
    name: 'sam_business_types',
    label: 'SAM Business Types',
    type: 'string',
    fieldType: 'textarea',
    groupName: 'companyinformation',
    description: 'Business type designations from SAM.gov',
  },
  {
    name: 'sam_naics_codes',
    label: 'NAICS Codes',
    type: 'string',
    fieldType: 'text',
    groupName: 'companyinformation',
    description: 'North American Industry Classification System codes',
  },
  {
    name: 'sam_sba_certifications',
    label: 'SBA Certifications',
    type: 'string',
    fieldType: 'textarea',
    groupName: 'companyinformation',
    description: 'Small Business Administration certifications',
  },
  {
    name: 'sam_last_synced',
    label: 'SAM Last Synced',
    type: 'datetime',
    fieldType: 'date',
    groupName: 'companyinformation',
    description: 'Last time SAM.gov data was synchronized',
  },
];

async function createSamProperties(accessToken: string): Promise<void> {
  for (const prop of SAM_PROPERTIES) {
    try {
      // Check if property already exists
      const checkResponse = await fetch(
        `https://api.hubapi.com/crm/v3/properties/companies/${prop.name}`,
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
        }
      );

      if (checkResponse.status === 404) {
        // Property doesn't exist, create it
        const createResponse = await fetch(
          'https://api.hubapi.com/crm/v3/properties/companies',
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${accessToken}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(prop),
          }
        );

        if (!createResponse.ok) {
          const error = await createResponse.text();
          console.error(`Failed to create property ${prop.name}:`, error);
        } else {
          console.log(`Created property: ${prop.name}`);
        }
      }
    } catch (error) {
      console.error(`Error handling property ${prop.name}:`, error);
    }
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const { code, state } = req.query;

  if (!code) {
    return res.status(400).json({ error: 'Authorization code required' });
  }

  try {
    // Exchange code for tokens
    const tokenResponse = await fetch('https://api.hubapi.com/oauth/v1/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: HUBSPOT_CLIENT_ID,
        client_secret: HUBSPOT_CLIENT_SECRET,
        redirect_uri: REDIRECT_URI,
        code: code as string,
      }),
    });

    if (!tokenResponse.ok) {
      const error = await tokenResponse.text();
      console.error('Token exchange failed:', error);
      return res.status(400).json({ error: 'Failed to exchange authorization code' });
    }

    const tokens = await tokenResponse.json();
    const { access_token, refresh_token, expires_in } = tokens;

    // Get portal info
    const portalResponse = await fetch('https://api.hubapi.com/oauth/v1/access-tokens/' + access_token);
    const portalInfo = await portalResponse.json();

    const portalId = portalInfo.hub_id;
    const userEmail = portalInfo.user;

    // Store installation in Supabase
    const { error: upsertError } = await supabase
      .from('hubspot_installations')
      .upsert({
        portal_id: portalId.toString(),
        access_token,
        refresh_token,
        expires_at: new Date(Date.now() + expires_in * 1000).toISOString(),
        installed_by: userEmail,
        installed_at: new Date().toISOString(),
        scopes: portalInfo.scopes || [],
      }, {
        onConflict: 'portal_id',
      });

    if (upsertError) {
      console.error('Failed to store installation:', upsertError);
    }

    // Create SAM properties in the portal
    await createSamProperties(access_token);

    // Redirect to success page or HubSpot
    const successUrl = state
      ? decodeURIComponent(state as string)
      : `https://app.hubspot.com/settings/${portalId}/integrations/apps`;

    return res.redirect(302, successUrl);

  } catch (error: any) {
    console.error('OAuth callback error:', error);
    return res.status(500).json({
      error: 'Internal server error',
      message: error.message,
    });
  }
}
