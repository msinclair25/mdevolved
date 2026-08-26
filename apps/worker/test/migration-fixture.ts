import migration0001 from "../../../migrations/0001_platform_metadata.sql";
import migration0002 from "../../../migrations/0002_owner_authentication.sql";
import migration0003 from "../../../migrations/0003_vault_pairing.sql";
import migration0004 from "../../../migrations/0004_pairing_origin.sql";
import migration0005 from "../../../migrations/0005_materialized_generations.sql";
import migration0006 from "../../../migrations/0006_agent_access.sql";
import migration0007 from "../../../migrations/0007_encrypted_backups.sql";
import migration0008 from "../../../migrations/0008_snapshot_recovery.sql";
import migration0009 from "../../../migrations/0009_snapshot_archiving.sql";
import phase9aCollaborationMigration from "../../../migrations/0010_phase9a_collaboration.sql";
import phase9bAgentFirstMigration from "../../../migrations/0011_phase9b_agent_first.sql";
import betaHardeningMigration from "../../../migrations/0012_beta_hardening.sql";
import invitedOwnerClaimMigration from "../../../migrations/0018_invited_owner_claim.sql";
import restoredContentAuthorizationMigration from "../../../migrations/0019_restored_content_authorization.sql";
import onboardingLifecycleMigration from "../../../migrations/0020_onboarding_lifecycle.sql";
import projectConnectionHardeningMigration from "../../../migrations/0021_project_connection_hardening.sql";
import projectCreationIdentityMigration from "../../../migrations/0022_project_creation_identity.sql";
import projectCreationCommitMigration from "../../../migrations/0023_project_creation_commit.sql";
import agentGrantContinuityMigration from "../../../migrations/0024_agent_grant_continuity.sql";
import projectAgentVisibilityMigration from "../../../migrations/0025_project_agent_visibility.sql";
import vaultPrimaryWriterMigration from "../../../migrations/0026_vault_primary_writer.sql";
import vaultRuntimeProfilesMigration from "../../../migrations/0027_vault_runtime_profiles.sql";
import preparedProjectHandoffsMigration from "../../../migrations/0028_prepared_project_handoffs.sql";
import vaultPrimaryWriterTransferMigration from "../../../migrations/0029_vault_primary_writer_transfer.sql";
import continuityR1Migration from "../../../migrations/0030_continuity_r1.sql";
import handsOffLeadR2Migration from "../../../migrations/0031_hands_off_lead_r2.sql";
import elasticActorPlaneR3Migration from "../../../migrations/0032_elastic_actor_plane_r3.sql";
import policyAutopilotR4Migration from "../../../migrations/0033_policy_autopilot_r4.sql";
import workingProfileSkillsMigration from "../../../migrations/0034_working_profile_skills.sql";
import compoundingDraftsMigration from "../../../migrations/0035_compounding_drafts.sql";
import sourceDescriptorsMigration from "../../../migrations/0036_source_descriptors.sql";
import sourceDevicesMigration from "../../../migrations/0037_source_devices.sql";

export const migrations = [
  { file: "0001_platform_metadata.sql", source: migration0001 },
  { file: "0002_owner_authentication.sql", source: migration0002 },
  { file: "0003_vault_pairing.sql", source: migration0003 },
  { file: "0004_pairing_origin.sql", source: migration0004 },
  { file: "0005_materialized_generations.sql", source: migration0005 },
  { file: "0006_agent_access.sql", source: migration0006 },
  { file: "0007_encrypted_backups.sql", source: migration0007 },
  { file: "0008_snapshot_recovery.sql", source: migration0008 },
  { file: "0009_snapshot_archiving.sql", source: migration0009 },
  {
    file: "0010_phase9a_collaboration.sql",
    source: phase9aCollaborationMigration,
  },
  {
    file: "0011_phase9b_agent_first.sql",
    source: phase9bAgentFirstMigration,
  },
  {
    file: "0012_beta_hardening.sql",
    source: betaHardeningMigration,
  },
  {
    file: "0018_invited_owner_claim.sql",
    source: invitedOwnerClaimMigration,
  },
  {
    file: "0019_restored_content_authorization.sql",
    source: restoredContentAuthorizationMigration,
  },
  {
    file: "0020_onboarding_lifecycle.sql",
    source: onboardingLifecycleMigration,
  },
  {
    file: "0021_project_connection_hardening.sql",
    source: projectConnectionHardeningMigration,
  },
  {
    file: "0022_project_creation_identity.sql",
    source: projectCreationIdentityMigration,
  },
  {
    file: "0023_project_creation_commit.sql",
    source: projectCreationCommitMigration,
  },
  {
    file: "0024_agent_grant_continuity.sql",
    source: agentGrantContinuityMigration,
  },
  {
    file: "0025_project_agent_visibility.sql",
    source: projectAgentVisibilityMigration,
  },
  {
    file: "0026_vault_primary_writer.sql",
    source: vaultPrimaryWriterMigration,
  },
  {
    file: "0027_vault_runtime_profiles.sql",
    source: vaultRuntimeProfilesMigration,
  },
  {
    file: "0028_prepared_project_handoffs.sql",
    source: preparedProjectHandoffsMigration,
  },
  {
    file: "0029_vault_primary_writer_transfer.sql",
    source: vaultPrimaryWriterTransferMigration,
  },
  { file: "0030_continuity_r1.sql", source: continuityR1Migration },
  { file: "0031_hands_off_lead_r2.sql", source: handsOffLeadR2Migration },
  {
    file: "0032_elastic_actor_plane_r3.sql",
    source: elasticActorPlaneR3Migration,
  },
  {
    file: "0033_policy_autopilot_r4.sql",
    source: policyAutopilotR4Migration,
  },
  {
    file: "0034_working_profile_skills.sql",
    source: workingProfileSkillsMigration,
  },
  {
    file: "0035_compounding_drafts.sql",
    source: compoundingDraftsMigration,
  },
  {
    file: "0036_source_descriptors.sql",
    source: sourceDescriptorsMigration,
  },
  { file: "0037_source_devices.sql", source: sourceDevicesMigration },
] as const;

export const priorReleaseMigrations = migrations.slice(0, 10);
export const preBetaMigrations = migrations.slice(0, 11);
export const phase9aMigration = migrations[9]!;
export const phase9bMigration = migrations[10]!;
export const betaHardeningMigrationEntry = migrations[11]!;
export const invitedOwnerClaimMigrationEntry = migrations[12]!;
export const restoredContentAuthorizationMigrationEntry = migrations[13]!;
export const onboardingLifecycleMigrationEntry = migrations[14]!;
export const projectConnectionHardeningMigrationEntry = migrations[15]!;
export const projectCreationIdentityMigrationEntry = migrations[16]!;
export const projectCreationCommitMigrationEntry = migrations[17]!;
export const agentGrantContinuityMigrationEntry = migrations[18]!;
export const projectAgentVisibilityMigrationEntry = migrations[19]!;
export const vaultPrimaryWriterMigrationEntry = migrations[20]!;
export const vaultRuntimeProfilesMigrationEntry = migrations[21]!;
export const preparedProjectHandoffsMigrationEntry = migrations[22]!;
export const vaultPrimaryWriterTransferMigrationEntry = migrations[23]!;
export const continuityR1MigrationEntry = migrations[24]!;
export const handsOffLeadR2MigrationEntry = migrations[25]!;
export const elasticActorPlaneR3MigrationEntry = migrations[26]!;
export const policyAutopilotR4MigrationEntry = migrations[27]!;
export const workingProfileSkillsMigrationEntry = migrations[28]!;
export const compoundingDraftsMigrationEntry = migrations[29]!;
export const sourceDescriptorsMigrationEntry = migrations[30]!;
export const sourceDevicesMigrationEntry = migrations[31]!;

export function executableMigration(source: string): string {
  return source
    .replace(/^--.*$/gmu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

export async function applyMigrations(
  db: D1Database,
  selected: ReadonlyArray<(typeof migrations)[number]>,
): Promise<void> {
  for (const migration of selected) {
    try {
      await db.exec(executableMigration(migration.source));
    } catch (error) {
      throw new Error(`Failed to apply ${migration.file}.`, { cause: error });
    }
  }
}

export function declaredTables(source: string): string[] {
  return [
    ...source.matchAll(
      /CREATE\s+(?:VIRTUAL\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z0-9_]+)/giu,
    ),
  ].flatMap((match) => (match[1] === undefined ? [] : [match[1]]));
}

export function declaredIndexes(source: string): string[] {
  return [
    ...source.matchAll(
      /CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z0-9_]+)/giu,
    ),
  ].flatMap((match) => (match[1] === undefined ? [] : [match[1]]));
}

export async function applyPhase9aCollaborationMigration(
  db: D1Database,
): Promise<void> {
  await applyMigrations(db, [phase9aMigration]);
}

export async function applyRestoredContentAuthorizationMigration(
  db: D1Database,
): Promise<void> {
  await applyMigrations(db, [restoredContentAuthorizationMigrationEntry]);
}

export async function applyPhase9bAgentFirstMigration(
  db: D1Database,
): Promise<void> {
  await applyMigrations(db, [phase9bMigration]);
}

export async function applyOnboardingLifecycleMigration(
  db: D1Database,
): Promise<void> {
  const semanticKeyColumn = await db
    .prepare(
      `SELECT COUNT(*) AS count
       FROM pragma_table_info('project_initialization_requests')
       WHERE name = 'semantic_key_sha256'`,
    )
    .first<{ count: number }>();
  if (semanticKeyColumn?.count !== 1) {
    await applyMigrations(db, [onboardingLifecycleMigrationEntry]);
  }
}

export async function applyProjectConnectionHardeningMigration(
  db: D1Database,
): Promise<void> {
  const table = await db
    .prepare(
      `SELECT COUNT(*) AS count
       FROM sqlite_master
       WHERE type = 'table'
         AND name IN (
           'collaboration_packet_rotations',
           'collaboration_gc_objects',
           'project_initialization_approval_claims'
         )`,
    )
    .first<{ count: number }>();
  if (table?.count !== 3) {
    await applyMigrations(db, [projectConnectionHardeningMigrationEntry]);
  }
}

export async function applyProjectCreationIdentityMigration(
  db: D1Database,
): Promise<void> {
  const table = await db
    .prepare(
      `SELECT COUNT(*) AS count
       FROM sqlite_master
       WHERE type = 'table'
         AND name IN (
           'project_creation_reservations',
           'project_creation_requests'
         )`,
    )
    .first<{ count: number }>();
  if (table?.count !== 2) {
    await applyMigrations(db, [projectCreationIdentityMigrationEntry]);
  }
}

export async function applyProjectCreationCommitMigration(
  db: D1Database,
): Promise<void> {
  const table = await db
    .prepare(
      `SELECT COUNT(*) AS count
       FROM sqlite_master
       WHERE type = 'table' AND name = 'project_creation_commits'`,
    )
    .first<{ count: number }>();
  if (table?.count !== 1) {
    await applyMigrations(db, [projectCreationCommitMigrationEntry]);
  }
}

export async function applyAgentGrantContinuityMigration(
  db: D1Database,
): Promise<void> {
  const table = await db
    .prepare(
      `SELECT COUNT(*) AS count
       FROM sqlite_master
       WHERE type = 'table' AND name = 'agent_grant_replacements'`,
    )
    .first<{ count: number }>();
  if (table?.count !== 1) {
    await applyMigrations(db, [agentGrantContinuityMigrationEntry]);
  }
}

export async function applyProjectAgentVisibilityMigration(
  db: D1Database,
): Promise<void> {
  const column = await db
    .prepare(
      `SELECT COUNT(*) AS count
       FROM pragma_table_info('collaboration_projects')
       WHERE name = 'agent_visibility'`,
    )
    .first<{ count: number }>();
  if (column?.count !== 1) {
    await applyMigrations(db, [projectAgentVisibilityMigrationEntry]);
  }
}

export async function applyVaultPrimaryWriterMigration(
  db: D1Database,
): Promise<void> {
  const table = await db
    .prepare(
      `SELECT COUNT(*) AS count
       FROM sqlite_master
       WHERE type = 'table'
         AND name = 'vault_local_writer_assignments'`,
    )
    .first<{ count: number }>();
  if (table?.count !== 1) {
    await applyMigrations(db, [vaultPrimaryWriterMigrationEntry]);
  }
}

export async function applyVaultPrimaryWriterTransferMigration(
  db: D1Database,
): Promise<void> {
  const table = await db
    .prepare(
      `SELECT COUNT(*) AS count
       FROM sqlite_master
       WHERE type = 'table'
         AND name = 'vault_local_writer_transfers'`,
    )
    .first<{ count: number }>();
  if (table?.count !== 1) {
    await applyMigrations(db, [vaultPrimaryWriterTransferMigrationEntry]);
  }
}

export async function applyVaultRuntimeProfilesMigration(
  db: D1Database,
): Promise<void> {
  const [profileColumn, privateColumn] = await Promise.all([
    db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM pragma_table_info('vault_sync_states')
         WHERE name = 'runtime_profile_json'`,
      )
      .first<{ count: number }>(),
    db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM pragma_table_info('materialized_notes')
         WHERE name = 'agent_private'`,
      )
      .first<{ count: number }>(),
  ]);
  if (profileColumn?.count !== 1 || privateColumn?.count !== 1) {
    await applyMigrations(db, [vaultRuntimeProfilesMigrationEntry]);
  }
}

export async function applyPreparedProjectHandoffsMigration(
  db: D1Database,
): Promise<void> {
  const table = await db
    .prepare(
      `SELECT COUNT(*) AS count
       FROM sqlite_master
       WHERE type = 'table' AND name = 'prepared_project_handoffs'`,
    )
    .first<{ count: number }>();
  if (table?.count !== 1) {
    await applyMigrations(db, [preparedProjectHandoffsMigrationEntry]);
  }
}

export async function applyContinuityR1Migration(
  db: D1Database,
): Promise<void> {
  const table = await db
    .prepare(
      `SELECT COUNT(*) AS count
       FROM sqlite_master
       WHERE type = 'table' AND name = 'project_continuity_points'`,
    )
    .first<{ count: number }>();
  if (table?.count !== 1) {
    await applyMigrations(db, [continuityR1MigrationEntry]);
  }
}

export async function applyHandsOffLeadR2Migration(
  db: D1Database,
): Promise<void> {
  const table = await db
    .prepare(
      `SELECT COUNT(*) AS count
       FROM sqlite_master
       WHERE type = 'table' AND name = 'project_operation_records'`,
    )
    .first<{ count: number }>();
  if (table?.count !== 1) {
    await applyMigrations(db, [handsOffLeadR2MigrationEntry]);
  }
}

export async function applyElasticActorPlaneR3Migration(
  db: D1Database,
): Promise<void> {
  const table = await db
    .prepare(
      `SELECT COUNT(*) AS count
       FROM sqlite_master
       WHERE type = 'table' AND name = 'project_elastic_records'`,
    )
    .first<{ count: number }>();
  if (table?.count !== 1) {
    await applyMigrations(db, [elasticActorPlaneR3MigrationEntry]);
  }
}

export async function applyPolicyAutopilotR4Migration(
  db: D1Database,
): Promise<void> {
  const table = await db
    .prepare(
      `SELECT COUNT(*) AS count
       FROM sqlite_master
       WHERE type = 'table' AND name = 'project_operational_records'`,
    )
    .first<{ count: number }>();
  if (table?.count !== 1) {
    await applyMigrations(db, [policyAutopilotR4MigrationEntry]);
  }
}
