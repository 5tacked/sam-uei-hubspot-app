/**
 * SAM.gov Entity Extract Importer
 *
 * Downloads the monthly SAM.gov entity extract and imports it into Supabase
 * for faster local lookups without API rate limits.
 *
 * Usage: npx ts-node scripts/import-sam-extract.ts
 *
 * Requires:
 * - SAM_GOV_API_KEY environment variable
 * - SUPABASE_URL environment variable
 * - SUPABASE_SERVICE_KEY environment variable
 */

import { createClient } from '@supabase/supabase-js';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { execSync } from 'child_process';

// Load environment variables from .env.local if running locally
const envPath = path.join(__dirname, '..', '.env.local');
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, 'utf-8');
  envContent.split('\n').forEach(line => {
    const [key, ...valueParts] = line.split('=');
    if (key && valueParts.length > 0) {
      process.env[key.trim()] = valueParts.join('=').trim();
    }
  });
}

const SAM_API_KEY = process.env.SAM_GOV_API_KEY!;
const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY!;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// SAM.gov Extract API endpoint
const EXTRACT_API_BASE = 'https://api.sam.gov/data-services/v1/extracts';

interface SamEntity {
  uei: string;
  legal_business_name: string;
  dba_name: string | null;
  cage_code: string | null;
  registration_status: string;
  registration_expiration_date: string | null;
  physical_address_line1: string | null;
  physical_address_city: string | null;
  physical_address_state: string | null;
  physical_address_zip: string | null;
  entity_url: string | null;
  naics_codes: string[] | null;
  business_types: string[] | null;
}

async function downloadExtract(): Promise<string> {
  console.log('Downloading SAM.gov monthly entity extract...');

  // Get current month/year for the extract
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const year = now.getFullYear();
  const dateParam = `${month}/${year}`;

  const url = `${EXTRACT_API_BASE}?api_key=${SAM_API_KEY}&fileType=ENTITY&sensitivity=PUBLIC&frequency=MONTHLY&date=${dateParam}&charset=UTF-8`;

  console.log(`Requesting extract for ${dateParam}...`);

  const response = await fetch(url);

  if (!response.ok) {
    // If current month not available, try previous month
    const prevMonth = now.getMonth() === 0 ? 12 : now.getMonth();
    const prevYear = now.getMonth() === 0 ? year - 1 : year;
    const prevDateParam = `${String(prevMonth).padStart(2, '0')}/${prevYear}`;

    console.log(`Current month extract not available, trying ${prevDateParam}...`);

    const prevUrl = `${EXTRACT_API_BASE}?api_key=${SAM_API_KEY}&fileType=ENTITY&sensitivity=PUBLIC&frequency=MONTHLY&date=${prevDateParam}&charset=UTF-8`;
    const prevResponse = await fetch(prevUrl);

    if (!prevResponse.ok) {
      throw new Error(`Failed to download extract: ${prevResponse.status} ${prevResponse.statusText}`);
    }

    const buffer = await prevResponse.arrayBuffer();
    const zipPath = path.join(__dirname, 'sam-extract.zip');
    fs.writeFileSync(zipPath, Buffer.from(buffer));
    return zipPath;
  }

  const buffer = await response.arrayBuffer();
  const zipPath = path.join(__dirname, 'sam-extract.zip');
  fs.writeFileSync(zipPath, Buffer.from(buffer));
  console.log(`Downloaded to ${zipPath}`);
  return zipPath;
}

async function extractZip(zipPath: string): Promise<string> {
  console.log('Extracting ZIP file...');
  const extractDir = path.join(__dirname, 'sam-extract');

  // Create extract directory if it doesn't exist
  if (!fs.existsSync(extractDir)) {
    fs.mkdirSync(extractDir, { recursive: true });
  }

  // Use unzip command (available on macOS and Linux)
  execSync(`unzip -o "${zipPath}" -d "${extractDir}"`);

  // Find the .dat file
  const files = fs.readdirSync(extractDir);
  const datFile = files.find(f => f.endsWith('.dat') || f.endsWith('.DAT'));

  if (!datFile) {
    throw new Error('No .dat file found in extract');
  }

  console.log(`Found data file: ${datFile}`);
  return path.join(extractDir, datFile);
}

/**
 * Parse SAM.gov entity extract file
 * The file is pipe-delimited with specific column positions
 * See: https://open.gsa.gov/api/sam-entity-extracts-api/ for field mapping
 */
async function parseAndImport(datFilePath: string): Promise<void> {
  console.log('Parsing and importing entities...');

  const fileStream = fs.createReadStream(datFilePath, { encoding: 'utf-8' });
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity,
  });

  let lineCount = 0;
  let importedCount = 0;
  let batch: SamEntity[] = [];
  const BATCH_SIZE = 1000;

  // Skip header line
  let isFirstLine = true;

  for await (const line of rl) {
    if (isFirstLine) {
      isFirstLine = false;
      // Log header to understand column structure
      console.log('Header columns:', line.split('|').slice(0, 20).join(', ') + '...');
      continue;
    }

    lineCount++;

    try {
      const fields = line.split('|');

      // SAM.gov V2 Public Extract field positions (0-indexed):
      // 0: UEI
      // 1: UEI Status
      // 2: Legal Business Name
      // 3: DBA Name
      // 4: Physical Address Line 1
      // 5: Physical Address Line 2
      // 6: Physical Address City
      // 7: Physical Address State/Province
      // 8: Physical Address Zip Code
      // 9: Physical Address Zip Code+4
      // 10: Physical Address Country Code
      // 11: Entity URL
      // 12: Government Business POC First Name
      // ... (more fields)
      // 28: CAGE Code
      // 29: Registration Status
      // 30: Activation Date
      // 31: Registration Expiration Date

      const uei = fields[0]?.trim();
      const legalName = fields[2]?.trim();
      const registrationStatus = fields[29]?.trim();

      // Only import active entities with UEI and name
      if (!uei || !legalName || registrationStatus !== 'A') {
        continue;
      }

      const entity: SamEntity = {
        uei,
        legal_business_name: legalName,
        dba_name: fields[3]?.trim() || null,
        cage_code: fields[28]?.trim() || null,
        registration_status: registrationStatus,
        registration_expiration_date: fields[31]?.trim() || null,
        physical_address_line1: fields[4]?.trim() || null,
        physical_address_city: fields[6]?.trim() || null,
        physical_address_state: fields[7]?.trim() || null,
        physical_address_zip: fields[8]?.trim() || null,
        entity_url: fields[11]?.trim() || null,
        naics_codes: null, // NAICS codes are in separate columns, would need mapping
        business_types: null, // Business types are in separate columns
      };

      batch.push(entity);

      // Import in batches
      if (batch.length >= BATCH_SIZE) {
        await importBatch(batch);
        importedCount += batch.length;
        console.log(`Imported ${importedCount} entities...`);
        batch = [];
      }
    } catch (error) {
      console.error(`Error parsing line ${lineCount}:`, error);
    }
  }

  // Import remaining batch
  if (batch.length > 0) {
    await importBatch(batch);
    importedCount += batch.length;
  }

  console.log(`\nImport complete! Total lines: ${lineCount}, Imported: ${importedCount}`);
}

async function importBatch(entities: SamEntity[]): Promise<void> {
  const { error } = await supabase
    .from('sam_entities_local')
    .upsert(entities, {
      onConflict: 'uei',
      ignoreDuplicates: false
    });

  if (error) {
    console.error('Batch import error:', error);
    throw error;
  }
}

async function createTable(): Promise<void> {
  console.log('Ensuring sam_entities_local table exists...');

  // Create table using Supabase SQL (you may need to run this manually in Supabase dashboard)
  const createTableSQL = `
    CREATE TABLE IF NOT EXISTS sam_entities_local (
      uei TEXT PRIMARY KEY,
      legal_business_name TEXT NOT NULL,
      dba_name TEXT,
      cage_code TEXT,
      registration_status TEXT,
      registration_expiration_date TEXT,
      physical_address_line1 TEXT,
      physical_address_city TEXT,
      physical_address_state TEXT,
      physical_address_zip TEXT,
      entity_url TEXT,
      naics_codes TEXT[],
      business_types TEXT[],
      created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
      updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
    );

    -- Create indexes for fast searching
    CREATE INDEX IF NOT EXISTS idx_sam_local_legal_name ON sam_entities_local USING gin(to_tsvector('english', legal_business_name));
    CREATE INDEX IF NOT EXISTS idx_sam_local_dba_name ON sam_entities_local USING gin(to_tsvector('english', dba_name));
    CREATE INDEX IF NOT EXISTS idx_sam_local_state ON sam_entities_local(physical_address_state);
    CREATE INDEX IF NOT EXISTS idx_sam_local_entity_url ON sam_entities_local(entity_url);
    CREATE INDEX IF NOT EXISTS idx_sam_local_cage ON sam_entities_local(cage_code);
  `;

  console.log('Table creation SQL (run in Supabase dashboard if needed):');
  console.log(createTableSQL);
}

async function cleanup(zipPath: string, extractDir: string): Promise<void> {
  console.log('Cleaning up temporary files...');

  if (fs.existsSync(zipPath)) {
    fs.unlinkSync(zipPath);
  }

  if (fs.existsSync(extractDir)) {
    fs.rmSync(extractDir, { recursive: true, force: true });
  }
}

async function main() {
  console.log('=== SAM.gov Entity Extract Importer ===\n');

  if (!SAM_API_KEY || !SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    console.error('Missing required environment variables:');
    console.error('- SAM_GOV_API_KEY:', SAM_API_KEY ? '✓' : '✗');
    console.error('- SUPABASE_URL:', SUPABASE_URL ? '✓' : '✗');
    console.error('- SUPABASE_SERVICE_KEY:', SUPABASE_SERVICE_KEY ? '✓' : '✗');
    process.exit(1);
  }

  try {
    await createTable();
    const zipPath = await downloadExtract();
    const datPath = await extractZip(zipPath);
    await parseAndImport(datPath);
    await cleanup(zipPath, path.dirname(datPath));
    console.log('\n✓ Import completed successfully!');
  } catch (error) {
    console.error('\n✗ Import failed:', error);
    process.exit(1);
  }
}

main();
