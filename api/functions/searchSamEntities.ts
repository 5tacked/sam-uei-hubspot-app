import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY!
);

const SAM_API_KEY = process.env.SAM_GOV_API_KEY!;
const SAM_API_BASE = 'https://api.sam.gov/entity-information/v3/entities';

// Calculate string similarity using Dice coefficient
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
  const params = new URLSearchParams({
    api_key: SAM_API_KEY,
    legalBusinessName: normalizedName,
    registrationStatus: 'A', // Active only
  });

  if (state) {
    params.append('physicalAddressStateCode', state);
  }

  const response = await fetch(`${SAM_API_BASE}?${params}`, {
    headers: { Accept: 'application/json' },
  });

  if (!response.ok) {
    console.error('SAM API error:', response.statusText);
    return [];
  }

  const data = await response.json() as { entityData?: any[] };
  return data.entityData || [];
}

async function getCompanyFromHubSpot(companyId: string, accessToken: string): Promise<any> {
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

  return response.json();
}

function normalizeSamEntity(raw: any): any {
  const core = raw.entityRegistration || {};
  const address = raw.coreData?.physicalAddress || {};

  return {
    uei: core.ueiSAM || raw.ueiSAM,
    legalBusinessName: core.legalBusinessName || raw.legalBusinessName,
    dbaName: core.dbaName,
    cageCode: core.cageCode,
    registrationStatus: core.registrationStatus || 'Unknown',
    physicalAddress: {
      addressLine1: address.addressLine1 || '',
      city: address.city || '',
      stateOrProvinceCode: address.stateOrProvinceCode || '',
      zipCode: address.zipCode || '',
    },
  };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { companyId } = req.body;
    const accessToken = req.headers.authorization?.replace('Bearer ', '');

    if (!companyId || !accessToken) {
      return res.status(400).json({
        status: 'ERROR',
        message: 'Company ID and authorization required'
      });
    }

    // Get company from HubSpot
    const company = await getCompanyFromHubSpot(companyId, accessToken);
    const companyProps = company.properties;
    const companyName = companyProps.name;

    if (!companyName) {
      return res.status(400).json({
        status: 'ERROR',
        message: 'Company name is required for search'
      });
    }

    // Search SAM.gov
    const samEntities = await searchSamByName(companyName, companyProps.state);

    if (samEntities.length === 0) {
      // Try without state filter
      const broadResults = await searchSamByName(companyName);

      if (broadResults.length === 0) {
        return res.status(200).json({
          status: 'SUCCESS',
          data: {
            matches: [],
            message: 'No matching entities found'
          }
        });
      }
    }

    // Calculate match scores
    const matches = samEntities
      .map((entity: any) => {
        const normalized = normalizeSamEntity(entity);
        const nameScore = diceCoefficient(
          normalizeCompanyName(companyName),
          normalizeCompanyName(normalized.legalBusinessName)
        );

        // Bonus for DBA match
        let dbaScore = 0;
        if (normalized.dbaName) {
          dbaScore = diceCoefficient(
            normalizeCompanyName(companyName),
            normalizeCompanyName(normalized.dbaName)
          );
        }

        // Bonus for state match
        let stateBonus = 0;
        if (companyProps.state && normalized.physicalAddress?.stateOrProvinceCode) {
          if (companyProps.state.toLowerCase() === normalized.physicalAddress.stateOrProvinceCode.toLowerCase()) {
            stateBonus = 0.1;
          }
        }

        const score = Math.min(1, Math.max(nameScore, dbaScore) + stateBonus);

        return {
          ...normalized,
          score,
        };
      })
      .filter((m: any) => m.score >= 0.5) // Only include reasonable matches
      .sort((a: any, b: any) => b.score - a.score)
      .slice(0, 10); // Limit to top 10

    return res.status(200).json({
      status: 'SUCCESS',
      data: {
        matches,
        searchedName: companyName,
      }
    });

  } catch (error: any) {
    console.error('Error in searchSamEntities:', error);
    return res.status(500).json({
      status: 'ERROR',
      message: error.message || 'Internal server error',
    });
  }
}
