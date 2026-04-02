-- Migration 042: Activity dictionary for admin-editable AI agent synonyms
CREATE TABLE IF NOT EXISTS activity_dictionary (
  activity_type VARCHAR(30) PRIMARY KEY,
  display_name VARCHAR(50) NOT NULL,
  tool_name VARCHAR(30) NOT NULL,
  synonyms TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO activity_dictionary (activity_type, display_name, tool_name, synonyms) VALUES
  ('spraying',      'Fumigación',     'log_spraying',      E'fumigué\ntiré glifosato\napliqué herbicida\naplicación\npulvericé\ncuré\neché veneno\nhice una pasada'),
  ('fertilization', 'Fertilización',  'log_fertilization', E'fertilicé\naboné\neché fertilizante\ntiré urea\naplicación de fertilizante'),
  ('planting',      'Siembra',        'sow_crop',          E'sembré\nhice la siembra\nplanté\nsiembra directa'),
  ('harvest',       'Cosecha',        'harvest_crop',      E'coseché\nlevanté la cosecha\njunté\ntrillé\ncorté'),
  ('tillage',       'Laboreo',        'log_tillage',       E'aré\ndisqueé\nrastré\nhice laboreo\nlabranza\ncincelé\nsubsolé'),
  ('irrigation',    'Riego',          'log_irrigation',    E'regué\nhice riego\nprendí el riego\npivote\nriego por aspersión')
ON CONFLICT (activity_type) DO NOTHING;
