import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';
import * as crypto from 'crypto';

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY!
);

const SAM_API_KEY = process.env.SAM_GOV_API_KEY!;
const SAM_API_BASE = 'https://api.sam.gov/entity-information/v3/entities';
const HUBSPOT_CLIENT_SECRET = process.env.HUBSPOT_CLIENT_SECRET!;

// Verify HubSpot webhook signature (v3)
function verifySignature(
  requestBody: string,
  signature: string,
  clientSecret: string,
  requestMethod: string,
  requestUri: string,
  timestamp: string
): boolean {
  // HubSpot v3 signature format: METHOD + URL + BODY + TIMESTAMP
  // The signature is base64-encoded HMAC-SHA256
  const sourceString = `${requestMethod}${requestUri}${requestBody}${timestamp}`;
  const hash = crypto
    .createHmac('sha256', clientSecret)
    .update(sourceString)
    .digest('base64');
  return hash === signature;
}

// Dice coefficient for fuzzy matching
function diceCoefficient(str1: string, str2: string): number {
  const s1 = str1.toLowerCase().replace(/[^a-z0-9]/g, '');
  const s2 = str2.toLowerCase().replace(/[^a-z0-9]/g, '');

  if (s1 === s2) return 1;
  if (s1.length < 2 || s2.length < 2) return 0;

  const bigrams1 = new Set<string>();
  for (let i = 0; i < s1.length - 1; i++) {
    bigrams1.add(s1.substring(i, i + 2));
  }

  let matches = 0;
  for (let i = 0; i < s2.length - 1; i++) {
    const bigram = s2.substring(i, i + 2);
    if (bigrams1.has(bigram)) {
      matches++;
      bigrams1.delete(bigram);
    }
  }

  return (2 * matches) / (s1.length + s2.length - 2);
}

function normalizeCompanyName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\b(inc|incorporated|llc|ltd|limited|corp|corporation|co|company)\b\.?/gi, '')
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

async function searchSamByName(name: string, state?: string): Promise<any[]> {
  const normalizedName = normalizeCompanyName(name);

  // Try search with wildcard for partial matching
  const searchName = `${normalizedName}*`;
  console.log('SAM.gov search name:', searchName, 'state:', state);

  const params = new URLSearchParams({
    api_key: SAM_API_KEY,
    legalBusinessName: searchName,
    registrationStatus: 'A',
  });

  if (state) {
    params.append('physicalAddressStateCode', state);
  }

  let response = await fetch(`${SAM_API_BASE}?${params}`, {
    headers: { Accept: 'application/json' },
  });

  if (!response.ok) {
    console.log('SAM.gov API error:', response.status, response.statusText);
    return [];
  }

  let data = await response.json() as { entityData?: any[] };

  // If no results with state filter, try without state
  if ((!data.entityData || data.entityData.length === 0) && state) {
    console.log('No results with state filter, trying without state...');
    const paramsNoState = new URLSearchParams({
      api_key: SAM_API_KEY,
      legalBusinessName: searchName,
      registrationStatus: 'A',
    });

    response = await fetch(`${SAM_API_BASE}?${paramsNoState}`, {
      headers: { Accept: 'application/json' },
    });

    if (response.ok) {
      data = await response.json() as { entityData?: any[] };
    }
  }

  console.log('SAM.gov returned', data.entityData?.length || 0, 'entities');
  return data.entityData || [];
}

async function getCompanyFromHubSpot(companyId: string, portalId: string): Promise<any> {
  // Get access token from our stored installation
  const { data: installation } = await supabase
    .from('hubspot_installations')
    .select('access_token, refresh_token, expires_at')
    .eq('portal_id', portalId)
    .single();

  if (!installation) {
    throw new Error('No installation found for portal');
  }

  // Check if token needs refresh
  let accessToken = installation.access_token;
  if (new Date(installation.expires_at) <= new Date()) {
    // Refresh the token
    const refreshResponse = await fetch('https://api.hubapi.com/oauth/v1/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: process.env.HUBSPOT_CLIENT_ID!,
        client_secret: process.env.HUBSPOT_CLIENT_SECRET!,
        refresh_token: installation.refresh_token,
      }),
    });

    if (!refreshResponse.ok) {
      throw new Error('Failed to refresh access token');
    }

    const tokens = await refreshResponse.json() as { access_token: string; refresh_token: string; expires_in: number };
    accessToken = tokens.access_token;

    // Update stored tokens
    await supabase
      .from('hubspot_installations')
      .update({
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        expires_at: new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
      })
      .eq('portal_id', portalId);
  }

  const response = await fetch(
    `https://api.hubapi.com/crm/v3/objects/companies/${companyId}?properties=name,domain,address,city,state,zip,country`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
    }
  );

  if (!response.ok) {
    throw new Error(`HubSpot API error: ${response.statusText}`);
  }

  return { company: await response.json(), accessToken };
}

async function updateHubSpotCompany(
  companyId: string,
  accessToken: string,
  properties: Record<string, any>
): Promise<void> {
  const response = await fetch(
    `https://api.hubapi.com/crm/v3/objects/companies/${companyId}`,
    {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ properties }),
    }
  );

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`HubSpot update error: ${error}`);
  }
}

function normalizeSamEntity(raw: any): any {
  const core = raw.entityRegistration || {};
  const address = raw.coreData?.physicalAddress || {};
  const businessTypes = raw.coreData?.businessTypes?.businessTypeList || [];
  const naicsList = raw.assertions?.goodsAndServices?.naicsList || [];
  const sbaTypes = raw.certifications?.sbaBusinessTypes || [];

  return {
    uei: core.ueiSAM || raw.ueiSAM,
    legalBusinessName: core.legalBusinessName || raw.legalBusinessName,
    dbaName: core.dbaName,
    cageCode: core.cageCode,
    registrationStatus: core.registrationStatus || 'Unknown',
    registrationExpirationDate: core.registrationExpirationDate,
    physicalAddress: {
      addressLine1: address.addressLine1 || '',
      city: address.city || '',
      stateOrProvinceCode: address.stateOrProvinceCode || '',
      zipCode: address.zipCode || '',
    },
    businessTypes: businessTypes.map((bt: any) => bt.businessTypeDesc || bt.businessType),
    naicsCode: naicsList.map((n: any) => n.naicsCode),
    sbaBusinessTypes: sbaTypes.map((s: any) => s.sbaBusinessTypeDesc || s.sbaBusinessType),
  };
}

async function processCompanyCreation(companyId: string, portalId: string): Promise<void> {
  try {
    const { company, accessToken } = await getCompanyFromHubSpot(companyId, portalId);
    const companyProps = company.properties;
    const companyName = companyProps.name;

    console.log('Processing company:', { companyId, companyName, state: companyProps.state });

    if (!companyName) {
      console.log('Company has no name, skipping SAM matching');
      return;
    }

    // Search SAM.gov
    console.log('Searching SAM.gov for:', normalizeCompanyName(companyName));
    const samEntities = await searchSamByName(companyName, companyProps.state);
    console.log('SAM.gov returned', samEntities.length, 'entities');

    if (samEntities.length === 0) {
      // No matches - add to queue for manual review
      await supabase.from('match_queue').insert({
        hubspot_company_id: companyId,
        hubspot_portal_id: portalId,
        company_name: companyName,
        status: 'no_match',
        search_results: [],
        created_at: new Date().toISOString(),
      });
      return;
    }

    // Calculate match scores
    const matches = samEntities
      .map((entity: any) => {
        const normalized = normalizeSamEntity(entity);
        const nameScore = diceCoefficient(
          normalizeCompanyName(companyName),
          normalizeCompanyName(normalized.legalBusinessName)
        );

        let dbaScore = 0;
        if (normalized.dbaName) {
          dbaScore = diceCoefficient(
            normalizeCompanyName(companyName),
            normalizeCompanyName(normalized.dbaName)
          );
        }

        let stateBonus = 0;
        if (companyProps.state && normalized.physicalAddress?.stateOrProvinceCode) {
          if (companyProps.state.toLowerCase() === normalized.physicalAddress.stateOrProvinceCode.toLowerCase()) {
            stateBonus = 0.1;
          }
        }

        const score = Math.min(1, Math.max(nameScore, dbaScore) + stateBonus);

        return { entity: normalized, raw: entity, score };
      })
      .filter((m: any) => m.score >= 0.5)
      .sort((a: any, b: any) => b.score - a.score);

    if (matches.length === 0) {
      // No good matches
      await supabase.from('match_queue').insert({
        hubspot_company_id: companyId,
        hubspot_portal_id: portalId,
        company_name: companyName,
        status: 'no_match',
        search_results: samEntities.slice(0, 5),
        created_at: new Date().toISOString(),
      });
      return;
    }

    const bestMatch = matches[0];
    console.log('Best match:', {
      legalName: bestMatch.entity.legalBusinessName,
      uei: bestMatch.entity.uei,
      score: bestMatch.score,
    });

    // If high confidence match (>85%), auto-link
    if (bestMatch.score >= 0.85) {
      const entity = bestMatch.entity;

      // Store in Supabase
      await supabase.from('sam_entities').upsert({
        uei: entity.uei,
        legal_business_name: entity.legalBusinessName,
        dba_name: entity.dbaName,
        cage_code: entity.cageCode,
        registration_status: entity.registrationStatus,
        registration_expiration_date: entity.registrationExpirationDate,
        physical_address: entity.physicalAddress,
        business_types: entity.businessTypes,
        naics_codes: entity.naicsCode,
        sba_certifications: entity.sbaBusinessTypes,
        last_updated: new Date().toISOString(),
        raw_data: bestMatch.raw,
      }, { onConflict: 'uei' });

      // Create association
      await supabase.from('company_sam_associations').insert({
        hubspot_company_id: companyId,
        sam_uei: entity.uei,
        match_type: 'automatic',
        match_score: bestMatch.score,
        linked_at: new Date().toISOString(),
      });

      // Update HubSpot company
      await updateHubSpotCompany(companyId, accessToken, {
        sam_uei: entity.uei,
        sam_cage_code: entity.cageCode || '',
        sam_registration_status: entity.registrationStatus,
        sam_registration_expiration: entity.registrationExpirationDate || '',
        sam_legal_name: entity.legalBusinessName,
        sam_business_types: entity.businessTypes?.join('; ') || '',
        sam_naics_codes: entity.naicsCode?.join(', ') || '',
        sam_sba_certifications: entity.sbaBusinessTypes?.join('; ') || '',
        sam_last_synced: new Date().toISOString(),
      });

      // Log sync
      await supabase.from('sync_log').insert({
        hubspot_company_id: companyId,
        sam_uei: entity.uei,
        action: 'auto_match',
        status: 'success',
        details: { matchScore: bestMatch.score },
      });

    } else {
      // Add to queue for manual review with potential matches
      await supabase.from('match_queue').insert({
        hubspot_company_id: companyId,
        hubspot_portal_id: portalId,
        company_name: companyName,
        status: 'pending',
        search_results: matches.slice(0, 5).map((m: any) => ({
          entity: m.entity,
          score: m.score,
        })),
        created_at: new Date().toISOString(),
      });
    }

  } catch (error: any) {
    console.error('Error processing company:', error);

    // Log error
    await supabase.from('sync_log').insert({
      hubspot_company_id: companyId,
      action: 'webhook_process',
      status: 'error',
      details: { error: error.message },
    });
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Verify webhook signature (v3)
  const signature = req.headers['x-hubspot-signature-v3'] as string;
  const timestamp = req.headers['x-hubspot-request-timestamp'] as string;

  if (signature && timestamp && HUBSPOT_CLIENT_SECRET) {
    // Build full URL - HubSpot v3 requires complete URL including protocol and host
    const protocol = req.headers['x-forwarded-proto'] || 'https';
    const host = req.headers['x-forwarded-host'] || req.headers.host || 'sam-uei-hubspot-app.vercel.app';
    const fullUrl = `${protocol}://${host}${req.url || '/api/webhooks/company'}`;

    const requestBody = JSON.stringify(req.body);
    const isValid = verifySignature(
      requestBody,
      signature,
      HUBSPOT_CLIENT_SECRET,
      'POST',
      fullUrl,
      timestamp
    );

    if (!isValid) {
      console.error('Invalid webhook signature', {
        expectedUrl: fullUrl,
        timestamp,
        bodyLength: requestBody.length,
      });
      return res.status(401).json({ error: 'Invalid webhook signature' });
    }
  }

  try {
    const events = Array.isArray(req.body) ? req.body : [req.body];
    console.log('Webhook received events:', JSON.stringify(events, null, 2));

    // Process all events and wait for completion
    const processingPromises: Promise<void>[] = [];

    for (const event of events) {
      const { subscriptionType, objectId, portalId, propertyName } = event;
      console.log('Processing event:', { subscriptionType, objectId, portalId, propertyName });

      // HubSpot sends 'object.creation' and 'object.propertyChange' for webhooks
      if (subscriptionType === 'object.creation' ||
          (subscriptionType === 'object.propertyChange' &&
           (propertyName === 'name' || propertyName === 'domain'))) {

        console.log('Event matched! Starting processCompanyCreation for', objectId);
        // Add to processing queue
        processingPromises.push(
          processCompanyCreation(objectId.toString(), portalId.toString())
        );
      }
    }

    console.log('Total processing promises:', processingPromises.length);
    // Wait for all processing to complete before responding
    await Promise.all(processingPromises);
    console.log('All processing complete');

    return res.status(200).json({ status: 'processed' });

  } catch (error: any) {
    console.error('Webhook handler error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
