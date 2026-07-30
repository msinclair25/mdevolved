-- Prerequisite: 0002_owner_authentication.sql.
--
-- Forward action: add an optional cell-local invitation gate for the first
-- owner claim. Community deployments leave owner_claim_configuration empty
-- and retain their open, atomic first-owner claim. Managed cells insert one
-- configuration row and one or more SHA-256 invitation digests before the
-- Worker is made reachable.
--
-- The registration ceremony does not consume the invitation. A short-lived
-- flow binding connects the verified WebAuthn user ID to the invitation
-- digest. The Worker rechecks and consumes that digest in the same D1 batch as
-- owner/session creation. D1 batches are transactional, so any failed guard
-- rolls back the complete first-owner claim.
--
-- Recovery: roll application code back without dropping these additive
-- objects. An unclaimed managed cell remains fail-closed when its runtime mode
-- is managed but its configuration or invitation is absent. Reissue an
-- invitation with a new digest rather than editing or reviving an old row.

CREATE TABLE owner_claim_configuration (
  id INTEGER PRIMARY KEY NOT NULL CHECK (id = 1),
  expected_hostname TEXT NOT NULL UNIQUE CHECK (
    expected_hostname = lower(expected_hostname)
    AND length(expected_hostname) BETWEEN 4 AND 253
    AND expected_hostname NOT LIKE '%.workers.dev'
  ),
  trial_days INTEGER NOT NULL CHECK (trial_days BETWEEN 1 AND 90),
  configured_at INTEGER NOT NULL CHECK (configured_at >= 0),
  claimed_at INTEGER CONSTRAINT owner_invitation_invalid CHECK (
    claimed_at IS NULL OR claimed_at >= configured_at
  )
) STRICT;

CREATE TABLE owner_claim_invitations (
  token_hash TEXT PRIMARY KEY NOT NULL CHECK (
    length(token_hash) = 64
    AND token_hash NOT GLOB '*[^0-9a-f]*'
  ),
  invitation_ref TEXT NOT NULL UNIQUE CHECK (
    length(invitation_ref) BETWEEN 8 AND 80
  ),
  expected_hostname TEXT NOT NULL
    REFERENCES owner_claim_configuration(expected_hostname),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  expires_at INTEGER NOT NULL CHECK (expires_at > created_at),
  consumed_at INTEGER CHECK (
    consumed_at IS NULL
    OR (consumed_at >= created_at AND consumed_at < expires_at)
  )
) STRICT;

CREATE INDEX owner_claim_invitations_expiry_idx
  ON owner_claim_invitations (expires_at);

CREATE TABLE owner_claim_challenges (
  flow_hash TEXT PRIMARY KEY NOT NULL
    REFERENCES auth_challenges(flow_hash) ON DELETE CASCADE,
  webauthn_user_id TEXT NOT NULL UNIQUE,
  invitation_token_hash TEXT NOT NULL
    REFERENCES owner_claim_invitations(token_hash),
  expected_hostname TEXT NOT NULL,
  expires_at INTEGER NOT NULL CHECK (expires_at > 0)
) STRICT;

CREATE INDEX owner_claim_challenges_expiry_idx
  ON owner_claim_challenges (expires_at);

CREATE TABLE owner_claim_transaction_assertions (
  id INTEGER PRIMARY KEY NOT NULL CHECK (id = 1),
  owner_inserted INTEGER NOT NULL
    CONSTRAINT owner_invitation_invalid CHECK (owner_inserted = 1)
) STRICT;
