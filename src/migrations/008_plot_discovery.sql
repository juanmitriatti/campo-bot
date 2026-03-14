-- Plot discovery: aliases and conversation state

CREATE TABLE IF NOT EXISTS plot_aliases (
  id SERIAL PRIMARY KEY,
  plot_id INT NOT NULL REFERENCES plots(id) ON DELETE CASCADE,
  alias VARCHAR(100) NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_plot_aliases_unique ON plot_aliases (plot_id, alias);
CREATE INDEX IF NOT EXISTS idx_plot_aliases_alias ON plot_aliases (alias);

CREATE TABLE IF NOT EXISTS conversation_state (
  user_id INT PRIMARY KEY REFERENCES users(id),
  last_plot_id INT REFERENCES plots(id) ON DELETE SET NULL,
  last_field_id INT REFERENCES fields(id) ON DELETE SET NULL,
  updated_at TIMESTAMP DEFAULT NOW()
);
