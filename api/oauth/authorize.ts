import type { VercelRequest, VercelResponse } from '@vercel/node';

const HUBSPOT_CLIENT_ID = process.env.HUBSPOT_CLIENT_ID!;
const REDIRECT_URI = process.env.HUBSPOT_REDIRECT_URI || 'https://sam-uei-hubspot-app.vercel.app/api/oauth/callback';

const REQUIRED_SCOPES = [
  'crm.objects.companies.read',
  'crm.objects.companies.write',
  'crm.schemas.companies.read',
  'crm.schemas.companies.write',
];

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const { redirect_url } = req.query;

  const state = redirect_url ? encodeURIComponent(redirect_url as string) : '';

  const authUrl = new URL('https://app.hubspot.com/oauth/authorize');
  authUrl.searchParams.set('client_id', HUBSPOT_CLIENT_ID);
  authUrl.searchParams.set('redirect_uri', REDIRECT_URI);
  authUrl.searchParams.set('scope', REQUIRED_SCOPES.join(' '));

  if (state) {
    authUrl.searchParams.set('state', state);
  }

  return res.redirect(302, authUrl.toString());
}
