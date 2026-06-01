-- harvest_loads.domain_event_id referenced domain_events(id) WITHOUT ON DELETE
-- CASCADE. Any hard-delete of a harvest domain_event (e.g. "borrá la cosecha
-- del lote X") hit a FK violation → 500 + empty reply, and the cosecha could
-- never be deleted. We now soft-delete domain_events in code and clean up loads
-- explicitly, but we also add CASCADE here as defense-in-depth so ANY future
-- hard-delete path frees its loads instead of erroring.
ALTER TABLE harvest_loads
  DROP CONSTRAINT IF EXISTS harvest_loads_domain_event_id_fkey;

ALTER TABLE harvest_loads
  ADD CONSTRAINT harvest_loads_domain_event_id_fkey
  FOREIGN KEY (domain_event_id) REFERENCES domain_events(id) ON DELETE CASCADE;
