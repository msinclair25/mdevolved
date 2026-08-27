-- MD8 completion mode is additive and forward-only. Existing Runs retain the
-- reviewed three-actor path. Solo completion is opt-in through an immutable
-- owner-authored policy binding and never restores authority.
--
-- Recovery: deploy the prior application while leaving this column intact.
-- Old code ignores it and continues to require reviewed completion. Never
-- down-migrate or rewrite historical Run records.

ALTER TABLE project_runs ADD COLUMN completion_mode TEXT NOT NULL
  DEFAULT 'orchestrated-reviewed'
  CHECK (completion_mode IN ('orchestrated-reviewed', 'solo-verified'));

ALTER TABLE project_policy_bindings ADD COLUMN solo_verified_allowed INTEGER
  NOT NULL DEFAULT 0 CHECK (solo_verified_allowed IN (0, 1));
