-- Audit fixes:
--   #4: expenses.amount + incomes.amount were NUMERIC without precision → tighten
--       to NUMERIC(14,2) and reject negative amounts via CHECK.
--   #5: users.phone_number VARCHAR(20) is too narrow for a fully-formatted AR
--       number ("+54 9 (11) 1234-5678" ≈ 21 chars). Widen to VARCHAR(32).
--
-- All operations are idempotent — wrapped in DO blocks that ignore the second
-- run on prod where the constraint or width is already applied.

-- expenses.amount → NUMERIC(14,2) + CHECK(amount > 0)
ALTER TABLE expenses
  ALTER COLUMN amount TYPE NUMERIC(14,2);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_expenses_amount_positive' AND conrelid = 'expenses'::regclass
  ) THEN
    ALTER TABLE expenses
      ADD CONSTRAINT chk_expenses_amount_positive CHECK (amount > 0) NOT VALID;
    -- NOT VALID skips backfill scan; new rows are enforced. Historical rows
    -- with amount <= 0 stay readable (we don't want a migration to crash the
    -- bot startup if some legacy seed had zeros).
  END IF;
END $$;

-- incomes.amount → NUMERIC(14,2) + CHECK(amount > 0)
ALTER TABLE incomes
  ALTER COLUMN amount TYPE NUMERIC(14,2);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_incomes_amount_positive' AND conrelid = 'incomes'::regclass
  ) THEN
    ALTER TABLE incomes
      ADD CONSTRAINT chk_incomes_amount_positive CHECK (amount > 0) NOT VALID;
  END IF;
END $$;

-- users.phone_number VARCHAR(20) → VARCHAR(32)
ALTER TABLE users
  ALTER COLUMN phone_number TYPE VARCHAR(32);
