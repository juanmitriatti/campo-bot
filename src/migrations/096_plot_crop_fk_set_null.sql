-- Deleting a siembra ("borrá la siembra de soja del lote 1") frees the lote by
-- removing its plot_crops row. But domain_events.plot_crop_id and
-- harvest_loads.plot_crop_id referenced plot_crops WITHOUT an ON DELETE rule
-- (default RESTRICT) → deleting the plot_crop raised
-- "violates foreign key constraint domain_events_plot_crop_id_fkey" (500).
-- SET NULL: dependent rows survive but unlink from the removed campaign, which
-- is exactly what we want when a siembra is deleted (historical events stay,
-- just detached). deleteDomainEvent() already soft-deletes the event itself.
ALTER TABLE domain_events
  DROP CONSTRAINT IF EXISTS domain_events_plot_crop_id_fkey;
ALTER TABLE domain_events
  ADD CONSTRAINT domain_events_plot_crop_id_fkey
  FOREIGN KEY (plot_crop_id) REFERENCES plot_crops(id) ON DELETE SET NULL;

ALTER TABLE harvest_loads
  DROP CONSTRAINT IF EXISTS harvest_loads_plot_crop_id_fkey;
ALTER TABLE harvest_loads
  ADD CONSTRAINT harvest_loads_plot_crop_id_fkey
  FOREIGN KEY (plot_crop_id) REFERENCES plot_crops(id) ON DELETE SET NULL;
