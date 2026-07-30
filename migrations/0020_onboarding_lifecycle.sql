-- Prerequisites: 0019_restored_content_authorization.sql, a reviewed D1
-- backup, and the matching OWD Sync release.
--
-- Forward action: make vault synchronization and derived-library freshness
-- explicit; make repeated semantic Project initialization idempotent even when
-- an MCP client generates a new transport idempotency key; and bind Project
-- OAuth consent to the exact approved initialization that requested it.
--
-- Recovery: every change is additive. Older application code may ignore these
-- rows and nullable columns, but it does not enforce the new freshness or exact
-- Project-binding invariants and therefore must not be used after an isolation
-- incident. Never remove duplicate Projects by deleting records. Archive the
-- unwanted Project through the owner API after confirming its ID and activity.

CREATE TABLE IF NOT EXISTS owner_credentials (
  credential_id TEXT PRIMARY KEY NOT NULL,
  owner_id INTEGER NOT NULL CHECK (owner_id = 1),
  webauthn_user_id TEXT NOT NULL,
  public_key TEXT NOT NULL,
  counter INTEGER NOT NULL DEFAULT 0 CHECK (counter >= 0),
  transports TEXT NOT NULL DEFAULT '[]',
  device_type TEXT NOT NULL
    CHECK (device_type IN ('singleDevice', 'multiDevice')),
  backed_up INTEGER NOT NULL CHECK (backed_up IN (0, 1)),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  last_authenticated_at INTEGER,
  FOREIGN KEY (owner_id) REFERENCES owners (id) ON DELETE CASCADE
) STRICT;

CREATE INDEX IF NOT EXISTS owner_credentials_owner_idx
  ON owner_credentials (owner_id, created_at);

INSERT OR IGNORE INTO owner_credentials (
  credential_id, owner_id, webauthn_user_id, public_key, counter,
  transports, device_type, backed_up, created_at, last_authenticated_at
)
SELECT
  credential_id, id, webauthn_user_id, public_key, counter,
  transports, device_type, backed_up, created_at, last_authenticated_at
FROM owners;

CREATE TABLE IF NOT EXISTS vault_sync_states (
  vault_id TEXT PRIMARY KEY NOT NULL,
  credential_id TEXT,
  plugin_version TEXT,
  schema_version INTEGER CHECK (
    schema_version IS NULL OR schema_version > 0
  ),
  connection_confirmed_at INTEGER CHECK (
    connection_confirmed_at IS NULL OR connection_confirmed_at >= 0
  ),
  initial_sync_at INTEGER CHECK (
    initial_sync_at IS NULL OR initial_sync_at >= 0
  ),
  last_sync_at INTEGER CHECK (
    last_sync_at IS NULL OR last_sync_at >= 0
  ),
  current_state_vector_sha256 TEXT CHECK (
    current_state_vector_sha256 IS NULL
    OR length(current_state_vector_sha256) = 64
  ),
  library_stale INTEGER NOT NULL DEFAULT 1 CHECK (library_stale IN (0, 1)),
  last_error_code TEXT,
  last_error_at INTEGER CHECK (
    last_error_at IS NULL OR last_error_at >= 0
  ),
  updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
  FOREIGN KEY (vault_id) REFERENCES vaults (id) ON DELETE CASCADE,
  FOREIGN KEY (credential_id) REFERENCES vault_credentials (id)
    ON DELETE SET NULL
) STRICT;

CREATE INDEX IF NOT EXISTS vault_sync_states_readiness_idx
  ON vault_sync_states (
    initial_sync_at, library_stale, connection_confirmed_at
  );

-- Existing active installations already proved a server connection before
-- this state machine existed. Preserve their last published generation as the
-- baseline; a later Yjs mutation immediately makes it stale in the Worker.
INSERT OR IGNORE INTO vault_sync_states (
  vault_id, credential_id, plugin_version, schema_version,
  connection_confirmed_at, initial_sync_at, last_sync_at,
  current_state_vector_sha256, library_stale, updated_at
)
SELECT
  vaults.id,
  (
    SELECT credentials.id
    FROM vault_credentials credentials
    WHERE credentials.vault_id = vaults.id
      AND credentials.revoked_at IS NULL
    ORDER BY credentials.created_at DESC, credentials.id DESC
    LIMIT 1
  ),
  (
    SELECT credentials.plugin_version
    FROM vault_credentials credentials
    WHERE credentials.vault_id = vaults.id
      AND credentials.revoked_at IS NULL
    ORDER BY credentials.created_at DESC, credentials.id DESC
    LIMIT 1
  ),
  (
    SELECT credentials.schema_version
    FROM vault_credentials credentials
    WHERE credentials.vault_id = vaults.id
      AND credentials.revoked_at IS NULL
    ORDER BY credentials.created_at DESC, credentials.id DESC
    LIMIT 1
  ),
  vaults.last_connected_at,
  COALESCE(vaults.last_connected_at, vaults.paired_at),
  COALESCE(current.updated_at, vaults.last_connected_at, vaults.paired_at),
  generation.source_state_vector_sha256,
  CASE WHEN generation.id IS NULL THEN 1 ELSE 0 END,
  COALESCE(current.updated_at, vaults.last_connected_at, vaults.paired_at,
    vaults.created_at)
FROM vaults
LEFT JOIN current_materializations current ON current.vault_id = vaults.id
LEFT JOIN materialization_generations generation
  ON generation.id = current.generation_id
  AND generation.status = 'published'
WHERE vaults.status = 'active';

ALTER TABLE project_initialization_requests
  ADD COLUMN semantic_key_sha256 TEXT CHECK (
    semantic_key_sha256 IS NULL OR length(semantic_key_sha256) = 64
  );

CREATE INDEX IF NOT EXISTS project_initialization_semantic_lookup_idx
  ON project_initialization_requests (
    oauth_client_id, vault_id, semantic_key_sha256, created_at DESC
  );

CREATE UNIQUE INDEX IF NOT EXISTS project_initialization_semantic_active_idx
  ON project_initialization_requests (
    oauth_client_id, vault_id, semantic_key_sha256
  )
  WHERE semantic_key_sha256 IS NOT NULL
    AND status IN ('pending', 'approving', 'approved');

CREATE TABLE IF NOT EXISTS project_initialization_token_aliases (
  token_sha256 TEXT PRIMARY KEY NOT NULL CHECK (length(token_sha256) = 64),
  initialization_request_id TEXT NOT NULL,
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  expires_at INTEGER NOT NULL CHECK (expires_at > created_at),
  FOREIGN KEY (initialization_request_id)
    REFERENCES project_initialization_requests (id) ON DELETE CASCADE
) STRICT;

CREATE INDEX IF NOT EXISTS project_initialization_alias_request_idx
  ON project_initialization_token_aliases (
    initialization_request_id, expires_at
  );

ALTER TABLE oauth_consent_flows
  ADD COLUMN project_initialization_request_id TEXT
    REFERENCES project_initialization_requests (id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS oauth_consent_project_initialization_idx
  ON oauth_consent_flows (
    project_initialization_request_id, expires_at
  );
