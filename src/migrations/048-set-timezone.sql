-- Set database timezone to Argentina (UTC-3)
-- Uses current_database() so it works on Railway, local docker, or any other environment
DO $$
BEGIN
  EXECUTE format(
    'ALTER DATABASE %I SET timezone = %L',
    current_database(),
    'America/Argentina/Buenos_Aires'
  );
END $$;
