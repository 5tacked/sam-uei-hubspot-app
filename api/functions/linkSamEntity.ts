import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY!
);

const SAM_API_KEY = process.env.SAM_GOV_API_KEY!;
const SAM_API_BASE = 'https://api.sam.gov/entity-information/v3/entities';

async function getEntityByUei(uei: string): Promise<any | null> {
  const response = await fetch(
    `${SAM_API_BASE}?api_key=${SAM_API_KEY}&ueiSAM=${uei}`,
    {
      headers: { Accept: 'application/json' },
    }
  );

  if (!response.ok) {
    return null;
  }

  const data = await response.json() as { entityData?: any[] };
  return data.entityData?.[0] || null;
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
      addressLine2: address.addressLine2,
      city: address.city || '',
      stateOrProvinceCode: address.stateOrProvinceCode || '',
      zipCode: address.zipCode || '',
      countryCode: address.countryCode || 'USA',
    },
    businessTypes: businessTypes.map((bt: any) => bt.businessTypeDesc || bt.businessType),
    naicsCode: naicsList.map((n: any) => n.naicsCode),
    sbaBusinessTypes: sbaTypes.map((s: any) => s.sbaBusinessTypeDesc || s.sbaBusinessType),
    entityUrl: `https://sam.gov/entity/${core.ueiSAM || raw.ueiSAM}`,
    congressionalDistrict: raw.coreData?.congressionalDistrict,
    entityStructure: raw.coreData?.entityStructure?.entityStructureDesc,
    activationDate: core.activationDate,
  };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { companyId, uei } = req.body;
    const accessToken = req.headers.authorization?.replace('Bearer ', '');

    if (!companyId || !uei || !accessToken) {
      return res.status(400).json({
        status: 'ERROR',
        message: 'Company ID, UEI, and authorization required'
      });
    }

    // Fetch entity from SAM.gov
    const rawEntity = await getEntityByUei(uei);

    if (!rawEntity) {
      return res.status(404).json({
        status: 'ERROR',
        message: 'SAM.gov entity not found'
      });
    }

    const entity = normalizeSamEntity(rawEntity);

    // Store/update in Supabase
    const { error: upsertError } = await supabase
      .from('sam_entities')
      .upsert({
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
        entity_structure: entity.entityStructure,
        congressional_district: entity.congressionalDistrict,
        last_updated: new Date().toISOString(),
        raw_data: rawEntity,
      }, {
        onConflict: 'uei'
      });

    if (upsertError) {
      console.error('Supabase upsert error:', upsertError);
    }

    // Create association
    const { error: assocError } = await supabase
      .from('company_sam_associations')
      .upsert({
        hubspot_company_id: companyId,
        sam_uei: entity.uei,
        match_type: 'manual',
        match_score: 1.0,
        linked_at: new Date().toISOString(),
      }, {
        onConflict: 'hubspot_company_id'
      });

    if (assocError) {
      console.error('Association error:', assocError);
    }

    // Update HubSpot company with SAM data
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

    // Remove from match queue if exists
    await supabase
      .from('match_queue')
      .delete()
      .eq('hubspot_company_id', companyId);

    return res.status(200).json({
      status: 'SUCCESS',
      data: {
        entity,
        matchScore: 1.0,
        matchStatus: 'matched',
      }
    });

  } catch (error: any) {
    console.error('Error in linkSamEntity:', error);
    return res.status(500).json({
      status: 'ERROR',
      message: error.message || 'Internal server error',
    });
  }
}
