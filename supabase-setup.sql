CREATE TABLE IF NOT EXISTS crm_state (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  state_data jsonb NOT NULL,
  updated_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- Disable Row Level Security so the frontend can read/write without complex auth logic
ALTER TABLE crm_state DISABLE ROW LEVEL SECURITY;

-- Insert a default empty row if the table is empty
INSERT INTO crm_state (id, state_data)
SELECT '00000000-0000-0000-0000-000000000001', '{}'::jsonb
WHERE NOT EXISTS (SELECT 1 FROM crm_state);
