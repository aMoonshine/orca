import { LEGACY_RUN_ID } from '../contract-constants'

export function createCoreTablesSql(): string {
  return `
CREATE TABLE IF NOT EXISTS runs (
  id                    TEXT PRIMARY KEY,
  objective             TEXT NOT NULL,
  home_database         TEXT NOT NULL DEFAULT 'this_database',
  coordinator_handle    TEXT,
  coordinator_pane_key  TEXT,
  -- Bare Orca session id the coordinator is addressed by, when it has one (today only structured
  -- sessions); for a /clear'd chat, its lineage root's.
  coordinator_orca_session_id TEXT,
  -- The consumer_generation coordinator_orca_session_id was written at; the id counts only while they
  -- are equal (run-coordinator-orca-session). So bump consumer_generation for a rebind or unbind only.
  coordinator_orca_session_id_generation INTEGER,
  consumer_generation   INTEGER NOT NULL DEFAULT 0,
  legacy                INTEGER NOT NULL DEFAULT 0,
  -- How this group of agents relates to each other, and where it is in that protocol.
  -- Mode lives on the Run, not the agent: it describes the relationship between
  -- workers, so a Run of six swarm agents is in swarm mode and each worker inherits
  -- it. That is what lets a launch-many control and a mode compose without either
  -- having to arbitrate against the other.
  mode                  TEXT NOT NULL DEFAULT 'solo'
    CHECK(mode IN ('solo', 'fusion', 'orchestrator', 'swarm')),
  mode_phase            TEXT NOT NULL DEFAULT 'work',
  -- Round counter for the current phase; the spec's bounded catch-up. Reset on every
  -- phase change so a mode with several repeat-capable phases does not spend the
  -- budget of the first one.
  mode_phase_round      INTEGER NOT NULL DEFAULT 1,
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at            TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS messages (
  id            TEXT NOT NULL,
  run_id        TEXT NOT NULL DEFAULT '${LEGACY_RUN_ID}',
  delivery_contract TEXT NOT NULL DEFAULT 'current_delivery'
    CHECK(delivery_contract IN ('legacy_direct', 'current_delivery', 'audit_only')),
  from_handle   TEXT NOT NULL,
  to_handle     TEXT NOT NULL,
  subject       TEXT NOT NULL,
  body          TEXT NOT NULL DEFAULT '',
  type          TEXT NOT NULL DEFAULT 'status'
    CHECK(type IN (
      'status', 'dispatch', 'worker_done', 'merge_ready',
      'escalation', 'handoff', 'decision_gate', 'question', 'heartbeat'
    )),
  priority      TEXT NOT NULL DEFAULT 'normal'
    CHECK(priority IN ('normal', 'high', 'urgent')),
  thread_id     TEXT,
  payload       TEXT,
  read          INTEGER NOT NULL DEFAULT 0,
  sequence      INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  delivered_at  TEXT,
  sender_pane_key TEXT,
  pointer_enter_pending INTEGER NOT NULL DEFAULT 0,
  pointer_pty_id TEXT,
  pointer_process_incarnation TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_id ON messages(id);
CREATE INDEX IF NOT EXISTS idx_inbox ON messages(to_handle, read);
CREATE INDEX IF NOT EXISTS idx_thread ON messages(thread_id);
CREATE TABLE IF NOT EXISTS run_coordinator_handles (
  run_id          TEXT NOT NULL,
  terminal_handle TEXT NOT NULL,
  first_bound_at  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (run_id, terminal_handle)
);

CREATE INDEX IF NOT EXISTS idx_run_coordinator_handles_handle
  ON run_coordinator_handles(terminal_handle, run_id);

-- Handle-only on purpose; migrate-v42 replaces both triggers with a form that also remembers the
-- coordinator's session address. This SQL runs before migrate on every open, so it
-- must compile against a pre-v42 runs table: a trigger naming coordinator_orca_session_id there makes
-- the next INSERT INTO runs fail to prepare mid-migration.
CREATE TRIGGER IF NOT EXISTS trg_runs_remember_coordinator_insert
AFTER INSERT ON runs
WHEN NEW.legacy = 0 AND NEW.coordinator_handle IS NOT NULL
BEGIN
  INSERT OR IGNORE INTO run_coordinator_handles (run_id, terminal_handle)
  VALUES (NEW.id, NEW.coordinator_handle);
END;

CREATE TRIGGER IF NOT EXISTS trg_runs_remember_coordinator_update
AFTER UPDATE OF coordinator_handle ON runs
WHEN NEW.legacy = 0 AND NEW.coordinator_handle IS NOT NULL
BEGIN
  INSERT OR IGNORE INTO run_coordinator_handles (run_id, terminal_handle)
  VALUES (NEW.id, NEW.coordinator_handle);
END;

CREATE TRIGGER IF NOT EXISTS trg_runs_forget_coordinator_handles
AFTER DELETE ON runs
BEGIN
  DELETE FROM run_coordinator_handles WHERE run_id = OLD.id;
END;

CREATE TABLE IF NOT EXISTS deliveries (
  id                    TEXT PRIMARY KEY,
  run_id                TEXT NOT NULL,
  -- Default keeps a downgraded binary's column-less INSERT working against a v34 database.
  mailbox_handle        TEXT NOT NULL DEFAULT '',
  consumer_generation   INTEGER NOT NULL,
  message_ids           TEXT NOT NULL,
  status                TEXT NOT NULL DEFAULT 'outstanding'
    CHECK(status IN ('outstanding', 'acknowledged', 'fenced')),
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  acknowledged_at       TEXT
);

CREATE INDEX IF NOT EXISTS idx_deliveries_run_created
  ON deliveries(run_id, created_at);

CREATE TABLE IF NOT EXISTS mutation_receipts (
  caller_fingerprint  TEXT NOT NULL,
  request_id          TEXT NOT NULL,
  method              TEXT NOT NULL,
  payload_hash        TEXT NOT NULL,
  state               TEXT NOT NULL DEFAULT 'pending'
    CHECK(state IN ('pending', 'completed')),
  receipt             TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (caller_fingerprint, request_id)
);

CREATE TABLE IF NOT EXISTS mutation_caller_identities (
  transport           TEXT PRIMARY KEY,
  caller_fingerprint  TEXT NOT NULL UNIQUE
);

-- Attempt evidence stays additive so old Task/Dispatch/worker CHECK enums remain wire-compatible.
CREATE TABLE IF NOT EXISTS attempt_observation_facts (
  id                    TEXT PRIMARY KEY,
  dispatch_id           TEXT NOT NULL,
  task_id               TEXT NOT NULL,
  sequence              INTEGER NOT NULL,
  authority_id          TEXT NOT NULL,
  authority_clock       TEXT NOT NULL,
  facet                 TEXT NOT NULL,
  payload               TEXT NOT NULL,
  source_observed_at    INTEGER,
  execution_received_at INTEGER,
  home_received_at      INTEGER NOT NULL,
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(dispatch_id, sequence)
);

CREATE INDEX IF NOT EXISTS idx_attempt_observation_facts_projection
  ON attempt_observation_facts(dispatch_id, facet, sequence);

CREATE TABLE IF NOT EXISTS worker_dispatches (
  dispatch_id            TEXT PRIMARY KEY,
  runtime_epoch          TEXT,
  state                  TEXT NOT NULL DEFAULT 'starting'
    CHECK(state IN (
      'starting', 'ready', 'start_unknown', 'failed', 'succeeded',
      'stopping', 'stop_unknown', 'stopped', 'abandoned'
    )),
  stage                  TEXT NOT NULL DEFAULT 'accepted',
  worktree_id            TEXT,
  agent_terminal_handle  TEXT,
  setup_state            TEXT NOT NULL DEFAULT 'not_applicable',
  effects                TEXT NOT NULL DEFAULT '[]',
  residual_resources     TEXT NOT NULL DEFAULT '[]',
  start_options          TEXT NOT NULL DEFAULT '{}',
  last_error             TEXT,
  created_at             TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at             TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS worker_terminal_resources (
  id                       TEXT PRIMARY KEY,
  origin_dispatch_id       TEXT NOT NULL,
  owner_dispatch_id        TEXT NOT NULL,
  prior_owner_dispatch_ids TEXT NOT NULL DEFAULT '[]',
  worktree_id              TEXT,
  terminal_handle          TEXT NOT NULL,
  pane_key                 TEXT,
  process_incarnation      TEXT,
  endpoint_id              TEXT,
  endpoint_incarnation     TEXT,
  host_scope               TEXT,
  ownership_state          TEXT NOT NULL DEFAULT 'owned'
    CHECK(ownership_state IN ('owned', 'transferred', 'user_owned', 'external', 'released')),
  release_state            TEXT NOT NULL DEFAULT 'not_requested'
    CHECK(release_state IN (
      'not_requested', 'retained', 'requested', 'releasing', 'released', 'unknown'
    )),
  retained_reason          TEXT,
  release_requested_at     TEXT,
  release_completed_at     TEXT,
  release_error            TEXT,
  recovery_attempt_count   INTEGER NOT NULL DEFAULT 0,
  last_recovery_at         TEXT,
  archive_source           TEXT,
  archive_status           TEXT,
  created_at               TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at               TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_worker_terminal_resources_owner
  ON worker_terminal_resources(owner_dispatch_id);
CREATE INDEX IF NOT EXISTS idx_worker_terminal_resources_handle
  ON worker_terminal_resources(terminal_handle);
CREATE INDEX IF NOT EXISTS idx_worker_terminal_resources_pane
  ON worker_terminal_resources(pane_key);
CREATE INDEX IF NOT EXISTS idx_worker_terminal_resources_identity
  ON worker_terminal_resources(process_incarnation, host_scope);
CREATE INDEX IF NOT EXISTS idx_worker_terminal_resources_release
  ON worker_terminal_resources(release_state);

-- One live agent-session operation id per structured worker mailbox. Persisted because the id is
-- the send's idempotency key: re-minting it after a restart would re-deliver an already-queued
-- pointer as a second turn.
CREATE TABLE IF NOT EXISTS structured_pointer_operations (
  mailbox_handle    TEXT PRIMARY KEY,
  session_id        TEXT NOT NULL,
  operation_id      TEXT NOT NULL,
  batch_fingerprint  TEXT NOT NULL,
  minted_at_ms      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS worker_terminal_archives (
  dispatch_id   TEXT PRIMARY KEY,
  resource_id   TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK(kind IN ('transcript_pin', 'terminal_tail', 'structured_journal')),
  content       TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Per-path edit ownership inside one workspace, so workers sharing a directory
-- cannot silently overwrite each other. Scoped to (run_id, workspace_id): a new Run
-- starts with a clean slate, and the same path in two workspaces is not a conflict.
-- One owner per key - a second claim on a held key is refused, not queued.
CREATE TABLE IF NOT EXISTS worker_file_claims (
  run_id        TEXT NOT NULL,
  workspace_id  TEXT NOT NULL,
  claim_key     TEXT NOT NULL,
  display_path  TEXT NOT NULL,
  dispatch_id   TEXT NOT NULL,
  claimed_at    TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (run_id, workspace_id, claim_key)
);

CREATE INDEX IF NOT EXISTS idx_worker_file_claims_dispatch
  ON worker_file_claims(dispatch_id);
CREATE INDEX IF NOT EXISTS idx_worker_file_claims_scope
  ON worker_file_claims(run_id, workspace_id);

-- Standing contracts published by the peers working one task, per the multi-agent
-- mode spec: a signature, interface or schema an agent fixed on behalf of everyone.
-- A table rather than a message because a contract is re-read for the life of the Run,
-- not consumed once from a mailbox, and an integrator is meant to read exactly this
-- list without also reading the chatter that produced it. 'frozen' is the state that
-- makes it binding; an open decision is still negotiable.
CREATE TABLE IF NOT EXISTS run_decisions (
  id                TEXT PRIMARY KEY,
  run_id            TEXT NOT NULL,
  proposed_by       TEXT NOT NULL,
  title             TEXT NOT NULL,
  contract          TEXT NOT NULL,
  rationale         TEXT NOT NULL DEFAULT '',
  -- Workspace-relative paths the contract governs, so a peer knows which files it
  -- must read before editing. Informational: it does not grant a worker_file_claims
  -- claim, which stays a separate and deliberate act.
  affects           TEXT NOT NULL DEFAULT '[]',
  -- The frozen decision this one replaces, so a contract can change without
  -- rewriting history the peers already built against.
  supersedes        TEXT,
  status            TEXT NOT NULL DEFAULT 'open'
    CHECK(status IN ('open', 'frozen', 'withdrawn')),
  frozen_at         TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_run_decisions_run
  ON run_decisions(run_id, status);
CREATE INDEX IF NOT EXISTS idx_run_decisions_supersedes
  ON run_decisions(supersedes) WHERE supersedes IS NOT NULL;

-- One response per peer per decision. The spec forbids empty acknowledgements, so a
-- response always carries either an objection or a reason worth reading.
CREATE TABLE IF NOT EXISTS decision_responses (
  decision_id       TEXT NOT NULL,
  dispatch_id       TEXT NOT NULL,
  stance            TEXT NOT NULL CHECK(stance IN ('accepted', 'objected')),
  note              TEXT NOT NULL DEFAULT '',
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (decision_id, dispatch_id)
);

CREATE INDEX IF NOT EXISTS idx_decision_responses_objected
  ON decision_responses(decision_id) WHERE stance = 'objected';

-- Phase history, so a coordinator can see how a Run got to where it is and a late
-- joiner can be told what already happened. Append-only by design: a phase that was
-- entered and left is a fact, not something to rewrite when the protocol changes.
CREATE TABLE IF NOT EXISTS run_phase_events (
  id                TEXT PRIMARY KEY,
  run_id            TEXT NOT NULL,
  mode              TEXT NOT NULL,
  phase             TEXT NOT NULL,
  phase_round       INTEGER NOT NULL,
  entered_at        TEXT NOT NULL DEFAULT (datetime('now')),
  advanced_by       TEXT,
  note              TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_run_phase_events_run
  ON run_phase_events(run_id, entered_at);

  `
}
