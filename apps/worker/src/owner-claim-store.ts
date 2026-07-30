import { z } from "zod";

const tokenHashSchema = z.string().regex(/^[0-9a-f]{64}$/u);
const invitationReferenceSchema = z.string().regex(/^inv_[a-z0-9]{20,32}$/u);
const hostnameSchema = z
  .string()
  .max(253)
  .regex(
    /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])$/u,
  );

const ownerClaimStatusRowSchema = z
  .object({
    claimed_at: z.number().int().nullable(),
    expected_hostname: hostnameSchema,
    expires_at: z.number().int().nullable(),
    trial_days: z.number().int().min(1).max(90),
  })
  .strict();

export type ManagedOwnerClaimStatus = {
  available: boolean;
  claimedAt: number | null;
  configured: boolean;
  expiresAt: number | null;
  trialDays: number | null;
};

export async function readManagedOwnerClaimStatus(
  db: D1Database,
  expectedHostname: string,
  now: number,
): Promise<ManagedOwnerClaimStatus> {
  const hostname = hostnameSchema.parse(expectedHostname);
  const row = await db
    .prepare(
      `SELECT configuration.expected_hostname,
              configuration.trial_days,
              configuration.claimed_at,
              MAX(
                CASE
                  WHEN invitation.consumed_at IS NULL
                   AND invitation.expires_at > ?
                  THEN invitation.expires_at
                  ELSE NULL
                END
              ) AS expires_at
         FROM owner_claim_configuration AS configuration
         LEFT JOIN owner_claim_invitations AS invitation
           ON invitation.expected_hostname = configuration.expected_hostname
        WHERE configuration.id = 1
          AND configuration.expected_hostname = ?
        GROUP BY configuration.id`,
    )
    .bind(now, hostname)
    .first();

  if (row === null) {
    return {
      available: false,
      claimedAt: null,
      configured: false,
      expiresAt: null,
      trialDays: null,
    };
  }

  const parsed = ownerClaimStatusRowSchema.parse(row);
  return {
    available: parsed.claimed_at === null && parsed.expires_at !== null,
    claimedAt: parsed.claimed_at,
    configured: true,
    expiresAt: parsed.expires_at,
    trialDays: parsed.trial_days,
  };
}

export async function requireManagedOwnerInvitation(
  db: D1Database,
  input: {
    expectedHostname: string;
    now: number;
    tokenHash: string;
  },
): Promise<string | null> {
  const hostname = hostnameSchema.parse(input.expectedHostname);
  const tokenHash = tokenHashSchema.parse(input.tokenHash);
  const row = await db
    .prepare(
      `SELECT invitation.token_hash
         FROM owner_claim_invitations AS invitation
         JOIN owner_claim_configuration AS configuration
           ON configuration.expected_hostname = invitation.expected_hostname
        WHERE configuration.id = 1
          AND configuration.claimed_at IS NULL
          AND configuration.expected_hostname = ?
          AND invitation.expected_hostname = ?
          AND invitation.token_hash = ?
          AND invitation.consumed_at IS NULL
          AND invitation.expires_at > ?`,
    )
    .bind(hostname, hostname, tokenHash, input.now)
    .first<{ token_hash: string }>();

  return row?.token_hash === tokenHash ? tokenHash : null;
}

export function ownerClaimChallengeStatements(
  db: D1Database,
  input: {
    expectedHostname: string;
    expiresAt: number;
    flowHash: string;
    invitationTokenHash: string;
    now: number;
    webauthnUserId: string;
  },
): readonly D1PreparedStatement[] {
  return [
    db
      .prepare("DELETE FROM owner_claim_challenges WHERE expires_at <= ?")
      .bind(input.now),
    db
      .prepare(
        `INSERT INTO owner_claim_challenges (
          flow_hash, webauthn_user_id, invitation_token_hash,
          expected_hostname, expires_at
        ) VALUES (?, ?, ?, ?, ?)`,
      )
      .bind(
        input.flowHash,
        input.webauthnUserId,
        tokenHashSchema.parse(input.invitationTokenHash),
        hostnameSchema.parse(input.expectedHostname),
        input.expiresAt,
      ),
  ];
}

export async function installManagedOwnerInvitation(
  db: D1Database,
  input: {
    configuredAt: number;
    expectedHostname: string;
    expiresAt: number;
    invitationRef: string;
    tokenHash: string;
    trialDays: number;
  },
): Promise<void> {
  const parsed = z
    .object({
      configuredAt: z.number().int().nonnegative(),
      expectedHostname: hostnameSchema.refine(
        (value) => !value.endsWith(".workers.dev"),
      ),
      expiresAt: z.number().int().positive(),
      invitationRef: invitationReferenceSchema,
      tokenHash: tokenHashSchema,
      trialDays: z.number().int().min(1).max(90),
    })
    .refine((value) => value.expiresAt > value.configuredAt)
    .parse(input);

  await db.batch([
    db
      .prepare(
        `INSERT INTO owner_claim_configuration (
          id, expected_hostname, trial_days, configured_at
        ) VALUES (1, ?, ?, ?)
        ON CONFLICT (id) DO NOTHING`,
      )
      .bind(parsed.expectedHostname, parsed.trialDays, parsed.configuredAt),
    db
      .prepare(
        `INSERT INTO owner_claim_invitations (
          token_hash, invitation_ref, expected_hostname, created_at, expires_at
        ) VALUES (?, ?, ?, ?, ?)`,
      )
      .bind(
        parsed.tokenHash,
        parsed.invitationRef,
        parsed.expectedHostname,
        parsed.configuredAt,
        parsed.expiresAt,
      ),
  ]);
}
