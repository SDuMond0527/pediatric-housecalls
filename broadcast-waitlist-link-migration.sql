-- Link a pairing broadcast back to the waitlist entry that spawned it.
-- Used by the waitlist accept flow: when an MD/NP accepts a CMA+telemedicine
-- or IV fluids waitlist entry, no appointment is created — a pairing broadcast
-- is sent instead. When a CMA/RN claims the broadcast, we look up
-- waitlist_entry_id to mark the entry as converted.
ALTER TABLE broadcasts ADD COLUMN IF NOT EXISTS waitlist_entry_id uuid REFERENCES waitlist_entries(id);
