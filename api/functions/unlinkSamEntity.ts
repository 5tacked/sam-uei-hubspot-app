import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY!
);

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

    // Remove association from Supabase
    const { error: deleteError } = await supabase
      .from('company_sam_associations')
      .delete()
      .eq('hubspot_company_id', companyId);

    if (deleteError) {
      console.error('Delete association error:', deleteError);
    }

    // Clear SAM properties in HubSpot
    await updateHubSpotCompany(companyId, accessToken, {
      sam_uei: '',
      sam_cage_code: '',
      sam_registration_status: '',
      sam_registration_expiration: '',
      sam_legal_name: '',
      sam_business_types: '',
      sam_naics_codes: '',
      sam_sba_certifications: '',
      sam_last_synced: '',
    });

    return res.status(200).json({
      status: 'SUCCESS',
      message: 'Company unlinked from SAM.gov entity'
    });

  } catch (error: any) {
    console.error('Error in unlinkSamEntity:', error);
    return res.status(500).json({
      status: 'ERROR',
      message: error.message || 'Internal server error',
    });
  }
}
