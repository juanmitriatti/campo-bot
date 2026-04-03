-- Track stock deduction status on activities
ALTER TABLE domain_events ADD COLUMN IF NOT EXISTS stock_deduction_status VARCHAR(20) DEFAULT NULL;
-- Values: NULL, 'suggested', 'accepted', 'declined'
