import authMigration from "../../../migrations/0002_owner_authentication.sql";
import { ownerClaimChallengeStatements } from "./owner-claim-store";
import { encodeBase64Url, randomToken, sha256Hex } from "./security";

const SESSION_LIFETIME_SECONDS = 7 * 24 * 60 * 60;

export type Ceremony = "authentication" | "registration";

export type ChallengeRecord = {
  challenge: string;
  ceremony: Ceremony;
  expected_origin: string;
  expected_rp_id: string;
  webauthn_user_id: string | null;
};

export type OwnerRecord = {
  backed_up: 0 | 1;
  counter: number;
  credential_id: string;
  device_type: "multiDevice" | "singleDevice";
  public_key: string;
  transports: string;
  webauthn_user_id: string;
};

export type OwnerCredentialRecord = OwnerRecord & {
  created_at: number;
  last_authenticated_at: number | null;
};

export type SessionRecord = {
  csrf_hash: string;
  expires_at: number;
  owner_id: number;
  token_hash: string;
};

export type SessionMaterial = {
  csrfHash: string;
  csrfToken: string;
  expiresAt: number;
  maxAgeSeconds: number;
  token: string;
  tokenHash: string;
};

export type FirstOwnerInput = {
  backedUp: boolean;
  counter: number;
  credentialId: string;
  deviceType: "multiDevice" | "singleDevice";
  publicKey: Uint8Array;
  transports: string[];
  webauthnUserId: string;
};

export async function ensureAuthSchema(db: D1Database): Promise<void> {
  const schemaObjects = await db
    .prepare(
      `SELECT COUNT(*) AS count
       FROM sqlite_master
       WHERE name IN (
         'owners',
         'auth_challenges',
         'auth_challenges_expiry_idx',
         'sessions',
         'sessions_expiry_idx',
         'auth_rate_limits',
         'auth_rate_limits_updated_idx',
         'audit_events',
         'audit_events_created_idx'
       )`,
    )
    .first<{ count: number }>();

  if (schemaObjects?.count !== 9) {
    const executableMigration = authMigration
      .replace(/^--.*$/gmu, "")
      .replace(/\s+/gu, " ")
      .trim();
    await db.exec(executableMigration);
  }

  await db.exec(
    `CREATE TABLE IF NOT EXISTS owner_credentials (
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
      ON owner_credentials (owner_id, created_at);`
      .replace(/\s+/gu, " ")
      .trim(),
  );
}

export async function ownerExists(db: D1Database): Promise<boolean> {
  const row = await db
    .prepare("SELECT id FROM owners WHERE id = 1")
    .first<{ id: number }>();

  return row?.id === 1;
}

export async function readOwner(db: D1Database): Promise<OwnerRecord | null> {
  return db
    .prepare(
      `SELECT webauthn_user_id, credential_id, public_key, counter,
        transports, device_type, backed_up
       FROM owners
       WHERE id = 1`,
    )
    .first<OwnerRecord>();
}

export async function readOwnerCredentials(
  db: D1Database,
): Promise<OwnerCredentialRecord[]> {
  const rows = await db
    .prepare(
      `SELECT webauthn_user_id, credential_id, public_key, counter,
        transports, device_type, backed_up, created_at,
        last_authenticated_at
       FROM owner_credentials
       WHERE owner_id = 1
       ORDER BY created_at, credential_id
       LIMIT 16`,
    )
    .all<OwnerCredentialRecord>();
  if (rows.results.length > 0) return rows.results;
  const owner = await db
    .prepare(
      `SELECT webauthn_user_id, credential_id, public_key, counter,
        transports, device_type, backed_up, created_at,
        last_authenticated_at
       FROM owners WHERE id = 1`,
    )
    .first<OwnerCredentialRecord>();
  return owner === null ? [] : [owner];
}

export async function readOwnerCredential(
  db: D1Database,
  credentialId: string,
): Promise<OwnerCredentialRecord | null> {
  const row = await db
    .prepare(
      `SELECT webauthn_user_id, credential_id, public_key, counter,
        transports, device_type, backed_up, created_at,
        last_authenticated_at
       FROM owner_credentials
       WHERE owner_id = 1 AND credential_id = ?`,
    )
    .bind(credentialId)
    .first<OwnerCredentialRecord>();
  if (row !== null) return row;
  return db
    .prepare(
      `SELECT webauthn_user_id, credential_id, public_key, counter,
        transports, device_type, backed_up, created_at,
        last_authenticated_at
       FROM owners WHERE id = 1 AND credential_id = ?`,
    )
    .bind(credentialId)
    .first<OwnerCredentialRecord>();
}

export async function addOwnerCredential(
  db: D1Database,
  owner: FirstOwnerInput,
  requestId: string,
  now: number,
): Promise<boolean> {
  const results = await db.batch<{ credential_id: string }>([
    db
      .prepare(
        `INSERT OR IGNORE INTO owner_credentials (
          credential_id, owner_id, webauthn_user_id, public_key, counter,
          transports, device_type, backed_up, created_at
        )
        SELECT ?, 1, webauthn_user_id, ?, ?, ?, ?, ?, ?
        FROM owners WHERE id = 1 AND webauthn_user_id = ?
        RETURNING credential_id`,
      )
      .bind(
        owner.credentialId,
        encodeBase64Url(owner.publicKey),
        owner.counter,
        JSON.stringify(owner.transports),
        owner.deviceType,
        owner.backedUp ? 1 : 0,
        now,
        owner.webauthnUserId,
      ),
    db
      .prepare(
        `INSERT INTO audit_events (id, event_type, request_id, created_at)
         SELECT ?, 'owner.passkey_added', ?, ? WHERE changes() > 0`,
      )
      .bind(crypto.randomUUID(), requestId, now),
  ]);
  return results[0]?.results[0]?.credential_id === owner.credentialId;
}

export async function createChallenge(
  db: D1Database,
  input: {
    ceremony: Ceremony;
    challenge: string;
    expectedOrigin: string;
    expectedRpId: string;
    flowHash: string;
    now: number;
    ownerClaim?: {
      expectedHostname: string;
      invitationTokenHash: string;
    };
    webauthnUserId?: string;
  },
): Promise<void> {
  const expiresAt = input.now + 300;
  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `DELETE FROM auth_challenges
         WHERE expires_at <= ? OR used_at IS NOT NULL`,
      )
      .bind(input.now),
    db.prepare("DELETE FROM sessions WHERE expires_at <= ?").bind(input.now),
    db
      .prepare("DELETE FROM auth_rate_limits WHERE updated_at < ?")
      .bind(input.now - 86_400),
    db
      .prepare(
        `INSERT INTO auth_challenges (
          flow_hash, ceremony, challenge, webauthn_user_id,
          expected_origin, expected_rp_id, created_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        input.flowHash,
        input.ceremony,
        input.challenge,
        input.webauthnUserId ?? null,
        input.expectedOrigin,
        input.expectedRpId,
        input.now,
        expiresAt,
      ),
  ];

  if (input.ownerClaim) {
    if (!input.webauthnUserId) {
      throw new Error(
        "An invited owner challenge requires a WebAuthn user identifier.",
      );
    }
    statements.push(
      ...ownerClaimChallengeStatements(db, {
        expectedHostname: input.ownerClaim.expectedHostname,
        expiresAt,
        flowHash: input.flowHash,
        invitationTokenHash: input.ownerClaim.invitationTokenHash,
        now: input.now,
        webauthnUserId: input.webauthnUserId,
      }),
    );
  }

  await db.batch(statements);
}

export async function consumeChallenge(
  db: D1Database,
  flowHash: string,
  ceremony: Ceremony,
  now: number,
): Promise<ChallengeRecord | null> {
  return db
    .prepare(
      `UPDATE auth_challenges
       SET used_at = ?
       WHERE flow_hash = ?
         AND ceremony = ?
         AND used_at IS NULL
         AND expires_at > ?
       RETURNING challenge, ceremony, webauthn_user_id,
         expected_origin, expected_rp_id`,
    )
    .bind(now, flowHash, ceremony, now)
    .first<ChallengeRecord>();
}

export async function createSessionMaterial(
  now: number,
): Promise<SessionMaterial> {
  const token = randomToken();
  const csrfToken = randomToken();
  const [tokenHash, csrfHash] = await Promise.all([
    sha256Hex(token),
    sha256Hex(csrfToken),
  ]);

  return {
    csrfHash,
    csrfToken,
    expiresAt: now + SESSION_LIFETIME_SECONDS,
    maxAgeSeconds: SESSION_LIFETIME_SECONDS,
    token,
    tokenHash,
  };
}

function insertSessionStatement(
  db: D1Database,
  session: SessionMaterial,
  now: number,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO sessions (
        token_hash, owner_id, csrf_hash, created_at, expires_at
      ) VALUES (?, 1, ?, ?, ?)`,
    )
    .bind(session.tokenHash, session.csrfHash, now, session.expiresAt);
}

function auditStatement(
  db: D1Database,
  eventType: string,
  requestId: string,
  now: number,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO audit_events (id, event_type, request_id, created_at)
       VALUES (?, ?, ?, ?)`,
    )
    .bind(crypto.randomUUID(), eventType, requestId, now);
}

export async function commitFirstOwner(
  db: D1Database,
  owner: FirstOwnerInput,
  session: SessionMaterial,
  requestId: string,
  now: number,
  requireManagedInvitation = false,
): Promise<void> {
  const insertOwner = requireManagedInvitation
    ? db
        .prepare(
          `INSERT INTO owners (
          id, webauthn_user_id, credential_id, public_key, counter,
          transports, device_type, backed_up, created_at
        )
        SELECT 1, ?, ?, ?, ?, ?, ?, ?, ?
         WHERE NOT EXISTS (
           SELECT 1 FROM owner_claim_configuration WHERE id = 1
         )
            OR EXISTS (
              SELECT 1
                FROM owner_claim_challenges AS challenge
                JOIN owner_claim_invitations AS invitation
                  ON invitation.token_hash =
                     challenge.invitation_token_hash
                JOIN owner_claim_configuration AS configuration
                  ON configuration.id = 1
               WHERE challenge.webauthn_user_id = ?
                 AND configuration.claimed_at IS NULL
                 AND challenge.expected_hostname =
                     configuration.expected_hostname
                 AND invitation.expected_hostname =
                     configuration.expected_hostname
                 AND challenge.expires_at > ?
                 AND invitation.consumed_at IS NULL
                 AND invitation.expires_at > ?
            )`,
        )
        .bind(
          owner.webauthnUserId,
          owner.credentialId,
          encodeBase64Url(owner.publicKey),
          owner.counter,
          JSON.stringify(owner.transports),
          owner.deviceType,
          owner.backedUp ? 1 : 0,
          now,
          owner.webauthnUserId,
          now,
          now,
        )
    : db
        .prepare(
          `INSERT INTO owners (
          id, webauthn_user_id, credential_id, public_key, counter,
          transports, device_type, backed_up, created_at
        ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          owner.webauthnUserId,
          owner.credentialId,
          encodeBase64Url(owner.publicKey),
          owner.counter,
          JSON.stringify(owner.transports),
          owner.deviceType,
          owner.backedUp ? 1 : 0,
          now,
        );

  const statements = [insertOwner];
  if (requireManagedInvitation) {
    statements.push(
      db.prepare(
        `INSERT INTO owner_claim_transaction_assertions (id, owner_inserted)
         VALUES (1, changes())
         ON CONFLICT (id) DO UPDATE
           SET owner_inserted = excluded.owner_inserted`,
      ),
      db
        .prepare(
          `UPDATE owner_claim_invitations
              SET consumed_at = ?
            WHERE token_hash = (
              SELECT challenge.invitation_token_hash
                FROM owner_claim_challenges AS challenge
               WHERE challenge.webauthn_user_id = ?
                 AND challenge.expires_at > ?
            )
              AND EXISTS (
                SELECT 1 FROM owner_claim_configuration WHERE id = 1
              )
              AND consumed_at IS NULL
              AND expires_at > ?`,
        )
        .bind(now, owner.webauthnUserId, now, now),
      db
        .prepare(
          `UPDATE owner_claim_configuration
              SET claimed_at = CASE
                WHEN changes() = 1 THEN ?
                ELSE -1
              END
            WHERE id = 1 AND claimed_at IS NULL`,
        )
        .bind(now),
    );
  }
  statements.push(
    db.prepare(
      `INSERT INTO owner_credentials (
          credential_id, owner_id, webauthn_user_id, public_key, counter,
          transports, device_type, backed_up, created_at
        )
        SELECT credential_id, id, webauthn_user_id, public_key, counter,
          transports, device_type, backed_up, created_at
        FROM owners WHERE id = 1
        ON CONFLICT (credential_id) DO NOTHING`,
    ),
    insertSessionStatement(db, session, now),
    auditStatement(db, "owner.claimed", requestId, now),
  );
  await db.batch(statements);
}

export async function commitAuthentication(
  db: D1Database,
  input: {
    backedUp: boolean;
    counter: number;
    credentialId: string;
    deviceType: "multiDevice" | "singleDevice";
    requestId: string;
    session: SessionMaterial;
  },
  now: number,
): Promise<void> {
  await db.batch([
    db.prepare("DELETE FROM sessions WHERE owner_id = 1"),
    db
      .prepare(
        `UPDATE owner_credentials
         SET counter = CASE WHEN counter < ? THEN ? ELSE counter END,
           device_type = ?, backed_up = ?, last_authenticated_at = ?
         WHERE owner_id = 1 AND credential_id = ?`,
      )
      .bind(
        input.counter,
        input.counter,
        input.deviceType,
        input.backedUp ? 1 : 0,
        now,
        input.credentialId,
      ),
    db
      .prepare(
        `UPDATE owners
         SET counter = CASE WHEN counter < ? THEN ? ELSE counter END,
           device_type = ?, backed_up = ?, last_authenticated_at = ?
         WHERE id = 1 AND credential_id = ?`,
      )
      .bind(
        input.counter,
        input.counter,
        input.deviceType,
        input.backedUp ? 1 : 0,
        now,
        input.credentialId,
      ),
    insertSessionStatement(db, input.session, now),
    auditStatement(db, "owner.authenticated", input.requestId, now),
  ]);
}

export async function readSession(
  db: D1Database,
  tokenHash: string,
  now: number,
): Promise<SessionRecord | null> {
  return db
    .prepare(
      `SELECT token_hash, owner_id, csrf_hash, expires_at
       FROM sessions
       WHERE token_hash = ? AND expires_at > ?`,
    )
    .bind(tokenHash, now)
    .first<SessionRecord>();
}

export async function rotateSessionCsrf(
  db: D1Database,
  tokenHash: string,
  csrfHash: string,
  now: number,
): Promise<boolean> {
  const updated = await db
    .prepare(
      `UPDATE sessions
       SET csrf_hash = ?
       WHERE token_hash = ? AND expires_at > ?
       RETURNING owner_id`,
    )
    .bind(csrfHash, tokenHash, now)
    .first<{ owner_id: number }>();

  return updated?.owner_id === 1;
}

export async function revokeSession(
  db: D1Database,
  tokenHash: string,
  requestId: string,
  now: number,
): Promise<void> {
  await db.batch([
    db.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(tokenHash),
    auditStatement(db, "owner.logged_out", requestId, now),
  ]);
}

export async function enforceRateLimit(
  db: D1Database,
  input: {
    action: string;
    keyHash: string;
    limit: number;
    now: number;
    windowSeconds: number;
  },
): Promise<boolean> {
  const bucketStart =
    Math.floor(input.now / input.windowSeconds) * input.windowSeconds;
  const result = await db
    .prepare(
      `INSERT INTO auth_rate_limits (
        key_hash, action, bucket_start, count, updated_at
      ) VALUES (?, ?, ?, 1, ?)
      ON CONFLICT (key_hash, action, bucket_start)
      DO UPDATE SET count = count + 1, updated_at = excluded.updated_at
      WHERE auth_rate_limits.count < ?
      RETURNING count`,
    )
    .bind(input.keyHash, input.action, bucketStart, input.now, input.limit)
    .first<{ count: number }>();

  return (result?.count ?? input.limit + 1) <= input.limit;
}
