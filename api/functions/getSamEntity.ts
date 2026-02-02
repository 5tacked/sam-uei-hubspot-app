import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY!
);

const SAM_API_KEY = process.env.SAM_GOV_API_KEY!;
const SAM_API_BASE = 'https://api.sam.gov/entity-information/v3/entities';

interface SamEntity {
  uei: string;
  legalBusinessName: string;
  dbaName?: string;
  cageCode?: string;
  registrationStatus: string;
  registrationExpirationDate?: string;
  physicalAddress: any;
  mailingAddress?: any;
  businessTypes: string[];
  naicsCode?: string[];
  pscCode?: string[];
  sbaBusinessTypes?: string[];
  entityUrl?: string;
  congressionalDistrict?: string;
  entityStructure?: string;
  entityStartDate?: string;
  fiscalYearEndCloseDate?: string;
  activationDate?: string;
}

async function getCompanyFromHubSpot(companyId: string, accessToken: string): Promise<any> {
  const response = await fetch(
    `https://api.hubapi.com/crm/v3/objects/companies/${companyId}?properties=name,domain,address,city,state,zip,country,sam_uei`,
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

async function searchSamByUei(uei: string): Promise<SamEntity | null> {
  const response = await fetch(
    `${SAM_API_BASE}?api_key=${SAM_API_KEY}&ueiSAM=${uei}`,
    {
      headers: { Accept: 'application/json' },
    }
  );

  if (!response.ok) {
    console.error('SAM API error:', response.statusText);
    return null;
  }

  const data = await response.json() as { entityData?: any[] };
  if (data.entityData && data.entityData.length > 0) {
    return normalizeSamEntity(data.entityData[0]);
  }
  return null;
}

function normalizeSamEntity(raw: any): SamEntity {
  const core = raw.entityRegistration || {};
  const address = raw.coreData?.physicalAddress || {};
  const mailingAddr = raw.coreData?.mailingAddress;
  const businessTypes = raw.coreData?.businessTypes?.businessTypeList || [];
  const naicsList = raw.assertions?.goodsAndServices?.naicsList || [];
  const pscList = raw.assertions?.goodsAndServices?.pscList || [];
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
      addressLine2: address.addressLine2,
      city: address.city || '',
      stateOrProvinceCode: address.stateOrProvinceCode || '',
      zipCode: address.zipCode || '',
      countryCode: address.countryCode || 'USA',
    },
    mailingAddress: mailingAddr ? {
      addressLine1: mailingAddr.addressLine1 || '',
      addressLine2: mailingAddr.addressLine2,
      city: mailingAddr.city || '',
      stateOrProvinceCode: mailingAddr.stateOrProvinceCode || '',
      zipCode: mailingAddr.zipCode || '',
      countryCode: mailingAddr.countryCode || 'USA',
    } : undefined,
    businessTypes: businessTypes.map((bt: any) => bt.businessTypeDesc || bt.businessType),
    naicsCode: naicsList.map((n: any) => n.naicsCode),
    pscCode: pscList.map((p: any) => p.pscCode),
    sbaBusinessTypes: sbaTypes.map((s: any) => s.sbaBusinessTypeDesc || s.sbaBusinessType),
    entityUrl: `https://sam.gov/entity/${core.ueiSAM || raw.ueiSAM}`,
    congressionalDistrict: raw.coreData?.congressionalDistrict,
    entityStructure: raw.coreData?.entityStructure?.entityStructureDesc,
    entityStartDate: raw.coreData?.entityStartDate,
    fiscalYearEndCloseDate: raw.coreData?.fiscalYearEndCloseDate,
    activationDate: core.activationDate,
  };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { companyId } = req.body;
    const accessToken = req.headers.authorization?.replace('Bearer ', '');

    if (!companyId) {
      return res.status(400).json({
        status: 'ERROR',
        message: 'Company ID is required'
      });
    }

    if (!accessToken) {
      return res.status(401).json({
        status: 'ERROR',
        message: 'Authorization required'
      });
    }

    // Get company from HubSpot
    const company = await getCompanyFromHubSpot(companyId, accessToken);
    const companyProps = company.properties;

    // Check if company already has a UEI linked
    if (companyProps.sam_uei) {
      // Fetch the entity data from SAM.gov
      const entity = await searchSamByUei(companyProps.sam_uei);

      if (entity) {
        // Check for subsidiaries
        const { data: subsidiaries } = await supabase
          .from('sam_entities')
          .select('*')
          .ilike('legal_business_name', `%${companyProps.name}%`)
          .neq('uei', companyProps.sam_uei)
          .limit(10);

        return res.status(200).json({
          status: 'SUCCESS',
          data: {
            entity,
            matchScore: 1.0,
            matchStatus: 'matched',
            subsidiaries: (subsidiaries as any[])?.map(normalizeSamEntity) || [],
          },
        });
      }
    }

    // Check our local database for a cached association
    const { data: association } = await supabase
      .from('company_sam_associations')
      .select('*, sam_entities(*)')
      .eq('hubspot_company_id', companyId)
      .single();

    const assocData = association as any;
    if (assocData?.sam_entities) {
      return res.status(200).json({
        status: 'SUCCESS',
        data: {
          entity: normalizeSamEntity(assocData.sam_entities),
          matchScore: assocData.match_score || 0.9,
          matchStatus: 'matched',
        },
      });
    }

    // No match found - check if there's a pending match in queue
    const { data: pendingMatch } = await supabase
      .from('match_queue')
      .select('*')
      .eq('hubspot_company_id', companyId)
      .eq('status', 'pending')
      .single();

    if (pendingMatch) {
      return res.status(200).json({
        status: 'SUCCESS',
        data: {
          entity: null,
          matchScore: 0,
          matchStatus: 'pending',
        },
      });
    }

    // Return no match status
    return res.status(200).json({
      status: 'SUCCESS',
      data: {
        entity: null,
        matchScore: 0,
        matchStatus: 'no_match',
      },
    });

  } catch (error: any) {
    console.error('Error in getSamEntity:', error);
    return res.status(500).json({
      status: 'ERROR',
      message: error.message || 'Internal server error',
    });
  }
}
