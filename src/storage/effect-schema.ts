export const effectSchema = `
CREATE TABLE run_budgets (
  run_id TEXT PRIMARY KEY REFERENCES runs (run_id) DEFERRABLE INITIALLY DEFERRED,
  effect_limit INTEGER NOT NULL,
  spent INTEGER NOT NULL CHECK (spent <= effect_limit),
  capabilities TEXT NOT NULL,
  exhausted_sequence INTEGER REFERENCES events (sequence) DEFERRABLE INITIALLY DEFERRED
) STRICT;
CREATE TABLE operations (
  operation_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs (run_id) DEFERRABLE INITIALLY DEFERRED,
  capability TEXT NOT NULL,
  method TEXT NOT NULL,
  target TEXT NOT NULL,
  payload TEXT NOT NULL,
  input_digest TEXT NOT NULL,
  units INTEGER NOT NULL,
  lease_key TEXT NOT NULL,
  recovery_limit INTEGER NOT NULL,
  status TEXT NOT NULL,
  reason TEXT,
  attempts INTEGER NOT NULL,
  receipt TEXT,
  worker TEXT,
  result TEXT,
  requested_sequence INTEGER NOT NULL REFERENCES events (sequence) DEFERRABLE INITIALLY DEFERRED,
  wait_sequence INTEGER REFERENCES events (sequence) DEFERRABLE INITIALLY DEFERRED,
  settled_sequence INTEGER REFERENCES events (sequence) DEFERRABLE INITIALLY DEFERRED
) STRICT;
CREATE INDEX operations_run ON operations (run_id);
CREATE INDEX operations_waiting ON operations (wait_sequence) WHERE status = 'waiting';
CREATE TABLE leases (
  resource_key TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL REFERENCES operations (operation_id) DEFERRABLE INITIALLY DEFERRED,
  generation INTEGER NOT NULL CHECK (generation > 0),
  expires_at TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('held', 'expired', 'released')),
  granted_sequence INTEGER NOT NULL REFERENCES events (sequence) DEFERRABLE INITIALLY DEFERRED
) STRICT;
CREATE INDEX leases_due ON leases (expires_at) WHERE state = 'held';
CREATE TABLE effect_evidence (
  sequence INTEGER PRIMARY KEY REFERENCES events (sequence) DEFERRABLE INITIALLY DEFERRED,
  run_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  disposition TEXT NOT NULL,
  reason TEXT
) STRICT;
CREATE TABLE stopped_operations (
  operation_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs (run_id) DEFERRABLE INITIALLY DEFERRED,
  sequence INTEGER NOT NULL REFERENCES events (sequence) DEFERRABLE INITIALLY DEFERRED
) STRICT;
CREATE TABLE dispatch_attempts (
  effect_id TEXT PRIMARY KEY REFERENCES deliveries (effect_id) DEFERRABLE INITIALLY DEFERRED,
  purpose TEXT NOT NULL,
  lease_generation INTEGER,
  authority_epoch INTEGER NOT NULL
) STRICT;
`;
