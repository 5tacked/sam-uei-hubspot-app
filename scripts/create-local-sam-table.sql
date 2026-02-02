-- Create the sam_entities_local table for storing SAM.gov extract data
-- Run this in the Supabase SQL Editor

-- Drop existing table if you want to start fresh
-- DROP TABLE IF EXISTS sam_entities_local;

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
-- Full-text search on legal business name
CREATE INDEX IF NOT EXISTS idx_sam_local_legal_name_tsvector
ON sam_entities_local
USING gin(to_tsvector('english', legal_business_name));

-- Full-text search on DBA name
CREATE INDEX IF NOT EXISTS idx_sam_local_dba_name_tsvector
ON sam_entities_local
USING gin(to_tsvector('english', COALESCE(dba_name, '')));

-- Index for state filtering
CREATE INDEX IF NOT EXISTS idx_sam_local_state
ON sam_entities_local(physical_address_state);

-- Index for entity URL (domain) matching
CREATE INDEX IF NOT EXISTS idx_sam_local_entity_url
ON sam_entities_local(entity_url);

-- Index for CAGE code lookups
CREATE INDEX IF NOT EXISTS idx_sam_local_cage
ON sam_entities_local(cage_code);

-- Trigram index for fuzzy matching (requires pg_trgm extension)
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS idx_sam_local_legal_name_trgm
ON sam_entities_local
USING gin(legal_business_name gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_sam_local_dba_name_trgm
ON sam_entities_local
USING gin(dba_name gin_trgm_ops);

-- Create a function for similarity search
CREATE OR REPLACE FUNCTION search_sam_entities(
  search_name TEXT,
  search_state TEXT DEFAULT NULL,
  search_domain TEXT DEFAULT NULL,
  min_similarity FLOAT DEFAULT 0.3,
  result_limit INT DEFAULT 10
)
RETURNS TABLE (
  uei TEXT,
  legal_business_name TEXT,
  dba_name TEXT,
  cage_code TEXT,
  registration_status TEXT,
  registration_expiration_date TEXT,
  physical_address_state TEXT,
  entity_url TEXT,
  name_similarity FLOAT,
  dba_similarity FLOAT
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    s.uei,
    s.legal_business_name,
    s.dba_name,
    s.cage_code,
    s.registration_status,
    s.registration_expiration_date,
    s.physical_address_state,
    s.entity_url,
    similarity(LOWER(s.legal_business_name), LOWER(search_name)) AS name_similarity,
    COALESCE(similarity(LOWER(s.dba_name), LOWER(search_name)), 0) AS dba_similarity
  FROM sam_entities_local s
  WHERE
    s.registration_status = 'A'
    AND (
      similarity(LOWER(s.legal_business_name), LOWER(search_name)) >= min_similarity
      OR (s.dba_name IS NOT NULL AND similarity(LOWER(s.dba_name), LOWER(search_name)) >= min_similarity)
      OR (search_domain IS NOT NULL AND s.entity_url ILIKE '%' || search_domain || '%')
    )
    AND (search_state IS NULL OR s.physical_address_state = search_state)
  ORDER BY
    GREATEST(
      similarity(LOWER(s.legal_business_name), LOWER(search_name)),
      COALESCE(similarity(LOWER(s.dba_name), LOWER(search_name)), 0)
    ) DESC
  LIMIT result_limit;
END;
$$ LANGUAGE plpgsql;

-- Grant access to the function
GRANT EXECUTE ON FUNCTION search_sam_entities TO anon, authenticated, service_role;

-- Add comment
COMMENT ON TABLE sam_entities_local IS 'Local copy of SAM.gov entity data for fast lookups without API rate limits';
