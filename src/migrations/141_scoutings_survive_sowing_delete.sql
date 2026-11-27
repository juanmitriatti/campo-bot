-- Borrar una siembra con monitoreos fallaba por la clave foránea: el monitoreo
-- queda en su lote, sin campaña.
ALTER TABLE crop_scoutings DROP CONSTRAINT IF EXISTS crop_scoutings_plot_crop_id_fkey;
ALTER TABLE crop_scoutings
  ADD CONSTRAINT crop_scoutings_plot_crop_id_fkey
  FOREIGN KEY (plot_crop_id) REFERENCES plot_crops(id) ON DELETE SET NULL;
