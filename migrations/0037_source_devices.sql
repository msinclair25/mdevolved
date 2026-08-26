-- MD4 source devices are additive, source-scoped sync principals. They never
-- grant Project, agent, owner, lease, actor, OAuth, or recovery authority.
--
-- Prerequisite: 0003 vault pairing, 0020 sync state, and 0036 source
-- descriptors. Apply this migration before the matching Worker.
--
-- Forward action: add an exact provider-neutral source boundary, mark
-- owner-created pairing grants that may enroll another device, store bounded
-- device identity/publication provenance, and link hashed sync credentials to
-- their device. Existing credentials remain nullable legacy credentials.
--
-- Recovery: redeploy the prior application while leaving these additive
-- columns, rows, and indexes intact. Never down-migrate or copy device
-- credentials. Snapshot restore may preserve only inert quarantined history.

ALTER TABLE vaults ADD COLUMN source_boundary_json TEXT
  CHECK (source_boundary_json IS NULL OR json_valid(source_boundary_json));

ALTER TABLE vaults ADD COLUMN source_boundary_sha256 TEXT
  CHECK (
    source_boundary_sha256 IS NULL
    OR length(source_boundary_sha256) = 64
  );

ALTER TABLE snapshot_vaults ADD COLUMN source_devices_json TEXT
  CHECK (source_devices_json IS NULL OR json_valid(source_devices_json));

ALTER TABLE pairing_grants ADD COLUMN device_enrollment INTEGER NOT NULL
  DEFAULT 0 CHECK (device_enrollment IN (0, 1));

ALTER TABLE pairing_grants ADD COLUMN device_expires_at INTEGER
  CHECK (device_expires_at IS NULL OR device_expires_at > created_at);

CREATE TABLE source_devices (
  id TEXT PRIMARY KEY NOT NULL,
  vault_id TEXT NOT NULL,
  display_name TEXT NOT NULL CHECK (
    length(display_name) BETWEEN 1 AND 120
  ),
  root_fingerprint_sha256 TEXT NOT NULL CHECK (
    length(root_fingerprint_sha256) = 64
  ),
  boundary_json TEXT NOT NULL CHECK (json_valid(boundary_json)),
  boundary_sha256 TEXT NOT NULL CHECK (length(boundary_sha256) = 64),
  client_version TEXT NOT NULL CHECK (length(client_version) BETWEEN 1 AND 64),
  sync_schema_version INTEGER NOT NULL CHECK (sync_schema_version > 0),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'revoked')),
  enrollment_idempotency_key TEXT NOT NULL UNIQUE,
  enrollment_request_sha256 TEXT NOT NULL CHECK (
    length(enrollment_request_sha256) = 64
  ),
  enrollment_grant_sha256 TEXT NOT NULL CHECK (
    length(enrollment_grant_sha256) = 64
  ),
  enrollment_origin_sha256 TEXT NOT NULL CHECK (
    length(enrollment_origin_sha256) = 64
  ),
  enrolled_at INTEGER NOT NULL CHECK (enrolled_at >= 0),
  expires_at INTEGER CHECK (expires_at IS NULL OR expires_at > enrolled_at),
  revoked_at INTEGER CHECK (revoked_at IS NULL OR revoked_at >= enrolled_at),
  last_seen_at INTEGER CHECK (last_seen_at IS NULL OR last_seen_at >= enrolled_at),
  last_published_at INTEGER CHECK (
    last_published_at IS NULL OR last_published_at >= enrolled_at
  ),
  last_published_state_vector_sha256 TEXT CHECK (
    last_published_state_vector_sha256 IS NULL
    OR length(last_published_state_vector_sha256) = 64
  ),
  last_published_credential_id TEXT,
  last_published_sequence INTEGER CHECK (
    last_published_sequence IS NULL OR last_published_sequence > 0
  ),
  FOREIGN KEY (vault_id) REFERENCES vaults (id) ON DELETE CASCADE
) STRICT;

CREATE INDEX source_devices_vault_status_idx
  ON source_devices (vault_id, status, enrolled_at);

CREATE UNIQUE INDEX source_devices_active_root_idx
  ON source_devices (vault_id, root_fingerprint_sha256)
  WHERE status = 'active';

ALTER TABLE vault_credentials ADD COLUMN source_device_id TEXT
  REFERENCES source_devices (id) ON DELETE RESTRICT;

CREATE UNIQUE INDEX vault_credentials_source_device_active_idx
  ON vault_credentials (source_device_id)
  WHERE source_device_id IS NOT NULL AND revoked_at IS NULL;

CREATE TABLE quarantined_source_devices (
  portable_id TEXT PRIMARY KEY NOT NULL,
  restore_id TEXT NOT NULL,
  target_vault_id TEXT NOT NULL,
  source_vault_id TEXT,
  body_json TEXT NOT NULL CHECK (json_valid(body_json)),
  body_sha256 TEXT NOT NULL CHECK (length(body_sha256) = 64),
  restored_at INTEGER NOT NULL CHECK (restored_at >= 0),
  authority_restored INTEGER NOT NULL DEFAULT 0
    CHECK (authority_restored = 0),
  credential_restored INTEGER NOT NULL DEFAULT 0
    CHECK (credential_restored = 0),
  connection_restored INTEGER NOT NULL DEFAULT 0
    CHECK (connection_restored = 0),
  FOREIGN KEY (restore_id) REFERENCES restore_jobs (id) ON DELETE CASCADE,
  FOREIGN KEY (target_vault_id) REFERENCES vaults (id) ON DELETE CASCADE
) STRICT;

CREATE INDEX quarantined_source_devices_target_idx
  ON quarantined_source_devices (target_vault_id, restored_at);

CREATE INDEX quarantined_source_devices_restore_idx
  ON quarantined_source_devices (restore_id);
