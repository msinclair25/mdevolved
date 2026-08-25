-- M2 working-profile records are additive, immutable, and trigger-free.
-- Application rollback leaves ledger rows and immutable R2 bodies in place.
-- Restored rows are quarantined evidence and can never enter a live projection.

CREATE TABLE IF NOT EXISTS working_profile_records (
  record_id TEXT PRIMARY KEY NOT NULL CHECK (length(record_id) = 36),
  record_type TEXT NOT NULL CHECK (record_type IN (
    'preference-version', 'preference-deleted', 'skill-version',
    'skill-deleted', 'skill-attached', 'skill-detached'
  )),
  portable_object_id TEXT NOT NULL UNIQUE CHECK (length(portable_object_id) = 36),
  project_id TEXT,
  source_project_id TEXT CHECK (
    source_project_id IS NULL OR length(source_project_id) = 36
  ),
  preference_id TEXT CHECK (preference_id IS NULL OR length(preference_id) = 36),
  skill_id TEXT CHECK (skill_id IS NULL OR length(skill_id) = 36),
  dependencies_json TEXT NOT NULL DEFAULT '[]' CHECK (
    json_valid(dependencies_json) AND json_type(dependencies_json) = 'array'
  ),
  body_object_key TEXT NOT NULL UNIQUE,
  content_sha256 TEXT NOT NULL CHECK (
    length(content_sha256) = 64 AND content_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  byte_length INTEGER NOT NULL CHECK (byte_length > 0 AND byte_length <= 524288),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  restored_at INTEGER CHECK (restored_at IS NULL OR restored_at >= 0),
  restore_state TEXT NOT NULL DEFAULT 'live' CHECK (
    restore_state IN ('live', 'quarantined')
  ),
  restored_authority_allowed INTEGER NOT NULL DEFAULT 0 CHECK (
    restored_authority_allowed = 0
  ),
  CHECK (
    (restore_state = 'live' AND restored_at IS NULL) OR
    (restore_state = 'quarantined' AND restored_at IS NOT NULL)
  ),
  CHECK (
    (restore_state = 'live' AND source_project_id IS NULL) OR
    restore_state = 'quarantined'
  ),
  CHECK (
    (record_type IN ('preference-version', 'preference-deleted')
      AND preference_id IS NOT NULL AND skill_id IS NULL) OR
    (record_type IN ('skill-version', 'skill-deleted')
      AND skill_id IS NOT NULL AND preference_id IS NULL AND project_id IS NULL) OR
    (record_type IN ('skill-attached', 'skill-detached')
      AND skill_id IS NOT NULL AND preference_id IS NULL
      AND (
        (restore_state = 'live' AND project_id IS NOT NULL) OR
        (restore_state = 'quarantined' AND project_id IS NULL
          AND source_project_id IS NOT NULL)
      ))
  ),
  UNIQUE (record_id, restore_state),
  FOREIGN KEY (project_id) REFERENCES collaboration_projects (project_id)
    ON DELETE RESTRICT
) STRICT;

CREATE INDEX IF NOT EXISTS working_profile_records_project_idx
  ON working_profile_records (project_id, record_type, created_at DESC, record_id);
CREATE INDEX IF NOT EXISTS working_profile_records_preference_idx
  ON working_profile_records (preference_id, created_at DESC, record_id);
CREATE INDEX IF NOT EXISTS working_profile_records_skill_idx
  ON working_profile_records (skill_id, created_at DESC, record_id);
CREATE INDEX IF NOT EXISTS working_profile_records_restore_idx
  ON working_profile_records (restore_state, record_type, created_at DESC);

CREATE TABLE IF NOT EXISTS working_preferences (
  preference_id TEXT PRIMARY KEY NOT NULL CHECK (length(preference_id) = 36),
  project_id TEXT,
  preference_key TEXT NOT NULL CHECK (
    length(preference_key) BETWEEN 1 AND 80 AND
    preference_key NOT GLOB '*[^a-z0-9-]*' AND
    preference_key NOT LIKE '-%' AND preference_key NOT LIKE '%-' AND
    preference_key NOT LIKE '%--%'
  ),
  current_record_id TEXT NOT NULL UNIQUE,
  record_restore_state TEXT NOT NULL DEFAULT 'live' CHECK (record_restore_state = 'live'),
  status TEXT NOT NULL CHECK (status IN ('active', 'deleted')),
  value TEXT CHECK (value IS NULL OR length(CAST(value AS BLOB)) <= 512),
  source_label TEXT NOT NULL CHECK (length(source_label) BETWEEN 1 AND 120),
  source_url TEXT CHECK (source_url IS NULL OR length(source_url) <= 2048),
  updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
  CHECK ((status = 'active' AND value IS NOT NULL) OR (status = 'deleted' AND value IS NULL)),
  FOREIGN KEY (project_id) REFERENCES collaboration_projects (project_id) ON DELETE RESTRICT,
  FOREIGN KEY (current_record_id, record_restore_state)
    REFERENCES working_profile_records (record_id, restore_state) ON DELETE RESTRICT
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS working_preferences_personal_key_unique
  ON working_preferences (preference_key) WHERE project_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS working_preferences_project_key_unique
  ON working_preferences (project_id, preference_key) WHERE project_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS working_preferences_live_project_idx
  ON working_preferences (project_id, status, preference_key);

CREATE TABLE IF NOT EXISTS agent_skills (
  skill_id TEXT PRIMARY KEY NOT NULL CHECK (length(skill_id) = 36),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 64),
  description TEXT NOT NULL CHECK (length(description) BETWEEN 1 AND 1024),
  current_version_record_id TEXT NOT NULL UNIQUE,
  record_restore_state TEXT NOT NULL DEFAULT 'live' CHECK (record_restore_state = 'live'),
  status TEXT NOT NULL CHECK (status IN ('active', 'deleted')),
  updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
  UNIQUE (skill_id, current_version_record_id, status),
  FOREIGN KEY (current_version_record_id, record_restore_state)
    REFERENCES working_profile_records (record_id, restore_state) ON DELETE RESTRICT
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS agent_skills_active_name_unique
  ON agent_skills (name COLLATE NOCASE) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS agent_skills_status_idx
  ON agent_skills (status, updated_at DESC, skill_id);

CREATE TABLE IF NOT EXISTS project_skill_attachments (
  project_id TEXT NOT NULL,
  skill_id TEXT NOT NULL,
  skill_version_record_id TEXT NOT NULL,
  project_slot INTEGER NOT NULL CHECK (project_slot BETWEEN 0 AND 31),
  skill_slot INTEGER NOT NULL CHECK (skill_slot BETWEEN 0 AND 30),
  attached_record_id TEXT NOT NULL UNIQUE,
  record_restore_state TEXT NOT NULL DEFAULT 'live' CHECK (record_restore_state = 'live'),
  attached_at INTEGER NOT NULL CHECK (attached_at >= 0),
  PRIMARY KEY (project_id, skill_id),
  FOREIGN KEY (project_id) REFERENCES collaboration_projects (project_id) ON DELETE RESTRICT,
  FOREIGN KEY (skill_id) REFERENCES agent_skills (skill_id) ON DELETE RESTRICT,
  FOREIGN KEY (skill_version_record_id, record_restore_state)
    REFERENCES working_profile_records (record_id, restore_state) ON DELETE RESTRICT,
  FOREIGN KEY (attached_record_id, record_restore_state)
    REFERENCES working_profile_records (record_id, restore_state) ON DELETE RESTRICT
) STRICT;

CREATE INDEX IF NOT EXISTS project_skill_attachments_skill_idx
  ON project_skill_attachments (skill_id, project_id);
CREATE UNIQUE INDEX IF NOT EXISTS project_skill_attachments_project_slot_unique
  ON project_skill_attachments (project_id, project_slot);
CREATE UNIQUE INDEX IF NOT EXISTS project_skill_attachments_skill_slot_unique
  ON project_skill_attachments (skill_id, skill_slot);

-- Retry protocol state is deliberately outside portable export and restore.
CREATE TABLE IF NOT EXISTS working_profile_mutation_receipts (
  idempotency_key_hash TEXT PRIMARY KEY NOT NULL CHECK (
    length(idempotency_key_hash) = 64 AND idempotency_key_hash NOT GLOB '*[^0-9a-f]*'
  ),
  operation TEXT NOT NULL CHECK (operation IN (
    'preference.save', 'preference.delete', 'skill.import', 'skill.delete',
    'skill.attach', 'skill.detach'
  )),
  input_sha256 TEXT NOT NULL CHECK (
    length(input_sha256) = 64 AND input_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  response_json TEXT NOT NULL CHECK (json_valid(response_json)),
  created_at INTEGER NOT NULL CHECK (created_at >= 0)
) STRICT;

CREATE INDEX IF NOT EXISTS working_profile_mutation_receipts_created_idx
  ON working_profile_mutation_receipts (created_at);

CREATE TABLE IF NOT EXISTS snapshot_working_profile_selections (
  snapshot_id TEXT PRIMARY KEY NOT NULL,
  included INTEGER NOT NULL DEFAULT 1 CHECK (included = 1),
  FOREIGN KEY (snapshot_id) REFERENCES snapshot_intelligence_selections (snapshot_id)
    ON DELETE CASCADE
) STRICT;
