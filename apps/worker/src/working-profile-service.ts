import {
  agentSkillExportResponseSchema,
  agentSkillSummarySchema,
  canonicalizeCollaborationJson,
  projectSkillMutationResponseSchema,
  workingPreferenceSchema,
  workingProfileDeleteResponseSchema,
  workingProfileRecordBodySchema,
  type AgentSkillPackageFile,
  type DeleteAgentSkillRequest,
  type DeleteWorkingPreferenceRequest,
  type ImportAgentSkillRequest,
  type ProjectSkillMutationRequest,
  type SaveWorkingPreferenceRequest,
} from "@owd/contracts";
import { parseDocument } from "yaml";
import { sha256Hex } from "./security";
import { queueCollaborationObjectCleanup } from "./collaboration-retention";
import {
  activeProjectExists,
  canonicalWorkingProfileBody,
  insertWorkingProfileReceiptStatement,
  insertWorkingProfileRecordStatement,
  putImmutableWorkingProfileBody,
  readWorkingProfileBody,
  readWorkingProfileReceipt,
  type WorkingProfileRecord,
} from "./working-profile-store";

const MAX_PREFERENCES = 256;
const MAX_SKILLS = 256;
const MAX_PROJECT_SKILL_ATTACHMENTS = 32;
const MAX_SKILL_PROJECT_ATTACHMENTS = 31;
const SKILL_METADATA_READ_CONCURRENCY = 4;
const MAX_SKILL_FILES = 32;
const MAX_SKILL_FILE_BYTES = 64 * 1_024;
const MAX_SKILL_PACKAGE_BYTES = 256 * 1_024;
const encoder = new TextEncoder();

type WorkingProfileOperation =
  | "preference.save"
  | "preference.delete"
  | "skill.import"
  | "skill.delete"
  | "skill.attach"
  | "skill.detach";

export class WorkingProfileProblem extends Error {
  constructor(
    readonly code:
      | "idempotency_conflict"
      | "preference_conflict"
      | "preference_not_found"
      | "project_not_active"
      | "project_skill_limit_exceeded"
      | "skill_already_attached"
      | "skill_conflict"
      | "skill_not_attached"
      | "skill_not_found"
      | "skill_package_invalid"
      | "skill_package_too_large",
  ) {
    super(code);
    this.name = "WorkingProfileProblem";
  }
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1_000);
}

async function publishWorkingProfileBody(
  db: D1Database,
  bucket: R2Bucket,
  body: string,
  recordId: string,
  now: number,
) {
  try {
    return await putImmutableWorkingProfileBody(bucket, body, recordId);
  } catch (error) {
    await queueCollaborationObjectCleanup(
      db,
      [`working-profile/${recordId}.json`],
      now,
    );
    throw error;
  }
}

function decodeBase64(value: string): Uint8Array<ArrayBuffer> {
  try {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  } catch {
    throw new WorkingProfileProblem("skill_package_invalid");
  }
}

async function receiptIdentity(
  operation: WorkingProfileOperation,
  idempotencyKey: string,
  input: unknown,
): Promise<{ idempotencyKeyHash: string; inputSha256: string }> {
  return {
    idempotencyKeyHash: await sha256Hex(idempotencyKey),
    inputSha256: await sha256Hex(
      canonicalizeCollaborationJson({ input, operation }),
    ),
  };
}

async function replay<T>(
  db: D1Database,
  identity: { idempotencyKeyHash: string; inputSha256: string },
  operation: WorkingProfileOperation,
  parse: (value: unknown) => T,
): Promise<T | null> {
  const receipt = await readWorkingProfileReceipt(
    db,
    identity.idempotencyKeyHash,
  );
  if (receipt === null) return null;
  if (
    receipt.operation !== operation ||
    receipt.inputSha256 !== identity.inputSha256
  ) {
    throw new WorkingProfileProblem("idempotency_conflict");
  }
  return parse(JSON.parse(receipt.responseJson));
}

async function commit<T>(
  db: D1Database,
  statements: D1PreparedStatement[],
  receipt: {
    identity: { idempotencyKeyHash: string; inputSha256: string };
    now: number;
    operation: WorkingProfileOperation;
    response: T;
  },
  parse: (value: unknown) => T,
  publishedObjectKeys: string[] = [],
): Promise<T> {
  const responseJson = canonicalWorkingProfileBody(receipt.response);
  try {
    await db.batch([
      ...statements,
      insertWorkingProfileReceiptStatement(db, {
        createdAt: receipt.now,
        idempotencyKeyHash: receipt.identity.idempotencyKeyHash,
        inputSha256: receipt.identity.inputSha256,
        operation: receipt.operation,
        responseJson,
      }),
    ]);
    return receipt.response;
  } catch (error) {
    await queueCollaborationObjectCleanup(db, publishedObjectKeys, receipt.now);
    const recovered = await replay(
      db,
      receipt.identity,
      receipt.operation,
      parse,
    );
    if (recovered !== null) return recovered;
    throw error;
  }
}

function recordFromBody(
  stored: Awaited<ReturnType<typeof putImmutableWorkingProfileBody>>,
  input: Omit<
    WorkingProfileRecord,
    "bodyObjectKey" | "byteLength" | "contentSha256"
  >,
): WorkingProfileRecord {
  return { ...input, ...stored };
}

type PreferenceRow = {
  current_record_id: string;
  preference_id: string;
  preference_key: string;
  project_id: string | null;
  source_label: string;
  source_url: string | null;
  updated_at: number;
  value: string;
};

function preferenceFromRow(row: PreferenceRow) {
  return workingPreferenceSchema.parse({
    key: row.preference_key,
    preferenceId: row.preference_id,
    projectId: row.project_id,
    sourceLabel: row.source_label,
    sourceUrl: row.source_url,
    updatedAt: row.updated_at,
    value: row.value,
    versionRecordId: row.current_record_id,
  });
}

export async function listWorkingPreferences(
  db: D1Database,
  projectId: string | null,
) {
  if (projectId !== null && !(await activeProjectExists(db, projectId))) {
    throw new WorkingProfileProblem("project_not_active");
  }
  const rows = await db
    .prepare(
      `SELECT preference_id, project_id, preference_key, current_record_id,
              value, source_label, source_url, updated_at
       FROM working_preferences
       WHERE status = 'active' AND (project_id IS NULL OR project_id = ?)
       ORDER BY project_id IS NOT NULL, preference_key, updated_at DESC
       LIMIT ?`,
    )
    .bind(projectId, MAX_PREFERENCES * 2)
    .all<PreferenceRow>();
  const selected = new Map<string, PreferenceRow>();
  for (const row of rows.results) selected.set(row.preference_key, row);
  return [...selected.values()]
    .sort((left, right) =>
      left.preference_key.localeCompare(right.preference_key),
    )
    .slice(0, MAX_PREFERENCES)
    .map(preferenceFromRow);
}

export async function saveWorkingPreference(
  db: D1Database,
  bucket: R2Bucket,
  input: SaveWorkingPreferenceRequest,
) {
  if (encoder.encode(input.value).byteLength > 512) {
    throw new WorkingProfileProblem("preference_conflict");
  }
  if (
    input.projectId !== null &&
    !(await activeProjectExists(db, input.projectId))
  ) {
    throw new WorkingProfileProblem("project_not_active");
  }
  const identity = await receiptIdentity(
    "preference.save",
    input.idempotencyKey,
    input,
  );
  const parse = (value: unknown) => workingPreferenceSchema.parse(value);
  const priorReplay = await replay(db, identity, "preference.save", parse);
  if (priorReplay !== null) return priorReplay;

  const existing = await db
    .prepare(
      `SELECT preference_id, current_record_id
       FROM working_preferences
       WHERE preference_key = ? AND project_id IS ?`,
    )
    .bind(input.key, input.projectId)
    .first<{ current_record_id: string; preference_id: string }>();
  if (
    (input.preferenceId !== undefined &&
      existing !== null &&
      input.preferenceId !== existing.preference_id) ||
    (input.preferenceId !== undefined && existing === null)
  ) {
    throw new WorkingProfileProblem("preference_conflict");
  }
  const preferenceId =
    existing?.preference_id ?? input.preferenceId ?? crypto.randomUUID();
  if (existing === null) {
    const count = await db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM working_preferences WHERE status = 'active'`,
      )
      .first<{ count: number }>();
    if ((count?.count ?? 0) >= MAX_PREFERENCES) {
      throw new WorkingProfileProblem("preference_conflict");
    }
  }
  const recordId = crypto.randomUUID();
  const now = nowSeconds();
  const body = canonicalWorkingProfileBody({
    key: input.key,
    preferenceId,
    projectId: input.projectId,
    recordId,
    sourceLabel: input.sourceLabel,
    sourceUrl: input.sourceUrl,
    type: "preference-version",
    value: input.value,
  });
  const stored = await publishWorkingProfileBody(
    db,
    bucket,
    body,
    recordId,
    now,
  );
  const record = recordFromBody(stored, {
    createdAt: now,
    dependencies: existing === null ? [] : [existing.current_record_id],
    portableObjectId: recordId,
    preferenceId,
    projectId: input.projectId,
    recordId,
    recordType: "preference-version",
    skillId: null,
  });
  const response = preferenceFromRow({
    current_record_id: recordId,
    preference_id: preferenceId,
    preference_key: input.key,
    project_id: input.projectId,
    source_label: input.sourceLabel,
    source_url: input.sourceUrl,
    updated_at: now,
    value: input.value,
  });
  try {
    return await commit(
      db,
      [
        insertWorkingProfileRecordStatement(db, record),
        db
          .prepare(
            `INSERT INTO working_preferences (
             preference_id, project_id, preference_key, current_record_id,
             record_restore_state, status, value, source_label, source_url, updated_at
           ) VALUES (?, ?, ?, ?, 'live', 'active', ?, ?, ?, ?)
           ON CONFLICT(preference_id) DO UPDATE SET
             current_record_id = excluded.current_record_id,
             status = 'active', value = excluded.value,
             source_label = excluded.source_label, source_url = excluded.source_url,
             updated_at = excluded.updated_at`,
          )
          .bind(
            preferenceId,
            input.projectId,
            input.key,
            recordId,
            input.value,
            input.sourceLabel,
            input.sourceUrl,
            now,
          ),
      ],
      { identity, now, operation: "preference.save", response },
      parse,
      [stored.bodyObjectKey],
    );
  } catch (error) {
    const winner = await db
      .prepare(
        `SELECT preference_id FROM working_preferences
         WHERE preference_key = ? AND project_id IS ?`,
      )
      .bind(input.key, input.projectId)
      .first<{ preference_id: string }>();
    if (winner !== null && winner.preference_id !== preferenceId) {
      throw new WorkingProfileProblem("preference_conflict");
    }
    throw error;
  }
}

export async function deleteWorkingPreference(
  db: D1Database,
  bucket: R2Bucket,
  input: DeleteWorkingPreferenceRequest,
) {
  const identity = await receiptIdentity(
    "preference.delete",
    input.idempotencyKey,
    input,
  );
  const parse = (value: unknown) =>
    workingProfileDeleteResponseSchema.omit({ ok: true }).parse(value);
  const priorReplay = await replay(db, identity, "preference.delete", parse);
  if (priorReplay !== null) return priorReplay;
  const row = await db
    .prepare(
      `SELECT project_id, current_record_id, source_label, source_url
       FROM working_preferences WHERE preference_id = ? AND status = 'active'`,
    )
    .bind(input.preferenceId)
    .first<{
      current_record_id: string;
      project_id: string | null;
      source_label: string;
      source_url: string | null;
    }>();
  if (row === null) throw new WorkingProfileProblem("preference_not_found");
  const recordId = crypto.randomUUID();
  const now = nowSeconds();
  const stored = await publishWorkingProfileBody(
    db,
    bucket,
    canonicalWorkingProfileBody({
      preferenceId: input.preferenceId,
      projectId: row.project_id,
      recordId,
      type: "preference-deleted",
    }),
    recordId,
    now,
  );
  const response = { deleted: true as const, recordId };
  return commit(
    db,
    [
      insertWorkingProfileRecordStatement(
        db,
        recordFromBody(stored, {
          createdAt: now,
          dependencies: [row.current_record_id],
          portableObjectId: recordId,
          preferenceId: input.preferenceId,
          projectId: row.project_id,
          recordId,
          recordType: "preference-deleted",
          skillId: null,
        }),
      ),
      db
        .prepare(
          `UPDATE working_preferences
           SET current_record_id = ?, status = 'deleted', value = NULL, updated_at = ?
           WHERE preference_id = ? AND status = 'active'`,
        )
        .bind(recordId, now, input.preferenceId),
    ],
    { identity, now, operation: "preference.delete", response },
    parse,
    [stored.bodyObjectKey],
  );
}

function validateSkillPath(path: string): string {
  if (
    path !== path.normalize("NFC") ||
    path.startsWith("/") ||
    path.includes("\\") ||
    /[\p{Cc}\p{Cf}]/u.test(path)
  ) {
    throw new WorkingProfileProblem("skill_package_invalid");
  }
  const segments = path.split("/");
  if (
    segments.some(
      (segment) => segment === "" || segment === "." || segment === "..",
    )
  ) {
    throw new WorkingProfileProblem("skill_package_invalid");
  }
  return path;
}

type DerTlv = {
  end: number;
  tag: number;
  valueEnd: number;
  valueStart: number;
};

function readDerTlv(
  bytes: Uint8Array<ArrayBuffer>,
  offset: number,
): DerTlv | null {
  if (offset + 2 > bytes.byteLength) return null;
  const tag = bytes[offset];
  const lengthByte = bytes[offset + 1];
  if (tag === undefined || lengthByte === undefined) return null;
  let length = lengthByte;
  let cursor = offset + 2;
  if ((lengthByte & 0x80) !== 0) {
    const lengthBytes = lengthByte & 0x7f;
    if (
      lengthBytes === 0 ||
      lengthBytes > 4 ||
      cursor + lengthBytes > bytes.byteLength
    ) {
      return null;
    }
    length = 0;
    for (let index = 0; index < lengthBytes; index += 1) {
      length = length * 256 + (bytes[cursor + index] ?? 0);
    }
    cursor += lengthBytes;
  }
  const valueEnd = cursor + length;
  if (valueEnd > bytes.byteLength) return null;
  return { end: valueEnd, tag, valueEnd, valueStart: cursor };
}

function hasDerPrivateKeyShape(bytes: Uint8Array<ArrayBuffer>): boolean {
  const outer = readDerTlv(bytes, 0);
  if (outer === null || outer.tag !== 0x30 || outer.end !== bytes.byteLength) {
    return false;
  }
  const version = readDerTlv(bytes, outer.valueStart);
  if (
    version === null ||
    version.tag !== 0x02 ||
    version.valueEnd - version.valueStart !== 1
  ) {
    return false;
  }
  const versionValue = bytes[version.valueStart];
  if (versionValue === undefined) return false;

  // PKCS#8 PrivateKeyInfo: SEQUENCE { INTEGER 0, AlgorithmIdentifier,
  // OCTET STRING }. The algorithm OID is deliberately not allowlisted so this
  // rejects provider-neutral private-key material under any filename.
  if (versionValue === 0) {
    const second = readDerTlv(bytes, version.end);
    if (second?.tag === 0x30) {
      const oid = readDerTlv(bytes, second.valueStart);
      const privateKey = oid === null ? null : readDerTlv(bytes, second.end);
      return (
        oid?.tag === 0x06 &&
        privateKey?.tag === 0x04 &&
        privateKey.valueEnd - privateKey.valueStart >= 16
      );
    }

    // PKCS#1 RSA private key: version followed by at least eight INTEGERs.
    let cursor = version.end;
    let integerCount = 0;
    while (cursor < outer.valueEnd) {
      const item = readDerTlv(bytes, cursor);
      if (
        item === null ||
        item.tag !== 0x02 ||
        item.valueEnd === item.valueStart
      ) {
        return false;
      }
      integerCount += 1;
      cursor = item.end;
    }
    return cursor === outer.valueEnd && integerCount >= 8;
  }

  // SEC1 ECPrivateKey: version 1, private OCTET STRING, and the optional
  // curve/public-key context fields. Requiring a context field avoids treating
  // arbitrary opaque files as credentials.
  if (versionValue === 1) {
    const privateKey = readDerTlv(bytes, version.end);
    const context =
      privateKey === null ? null : readDerTlv(bytes, privateKey.end);
    return (
      privateKey?.tag === 0x04 &&
      privateKey.valueEnd - privateKey.valueStart >= 16 &&
      (context?.tag === 0xa0 || context?.tag === 0xa1)
    );
  }
  return false;
}

function rejectCredential(path: string, bytes: Uint8Array<ArrayBuffer>): void {
  if (
    /(?:^|\/)(?:\.env(?:\..*)?|id_(?:rsa|dsa|ecdsa|ed25519)|credentials?|secrets?|private[-_]?key)(?:$|\.)|\.(?:pem|key|p12|pfx)$/iu.test(
      path,
    )
  ) {
    throw new WorkingProfileProblem("skill_package_invalid");
  }
  if (hasDerPrivateKeyShape(bytes)) {
    throw new WorkingProfileProblem("skill_package_invalid");
  }
  const text = new TextDecoder().decode(bytes);
  const unlabeledCredential =
    /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{20,}|AIza[0-9A-Za-z_-]{35}|sk-(?:proj-)?[A-Za-z0-9_-]{20,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b/gu.exec(
      text,
    )?.[0];
  const credentialBody = unlabeledCredential
    ?.replace(/^(?:gh[pousr]_|github_pat_|xox[baprs]-|AIza|sk-(?:proj-)?)/u, "")
    .replace(/[^A-Za-z0-9]/gu, "")
    .toLowerCase();
  const looksLikePlaceholder =
    credentialBody !== undefined &&
    (/^(?:(?:example|placeholder|redacted|replace|your(?:api)?key)|x)+$/u.test(
      credentialBody,
    ) ||
      new Set(credentialBody).size <= 3);
  if (
    /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/u.test(text) ||
    /\bAKIA[0-9A-Z]{16}\b/u.test(text) ||
    (unlabeledCredential !== undefined && !looksLikePlaceholder) ||
    /(?:api[_-]?key|client[_-]?secret|password|access[_-]?token)\s*[:=]\s*["']?[A-Za-z0-9_+/.=-]{12,}/iu.test(
      text,
    )
  ) {
    throw new WorkingProfileProblem("skill_package_invalid");
  }
}

function skillMetadata(files: AgentSkillPackageFile[]): {
  description: string;
  files: AgentSkillPackageFile[];
  name: string;
} {
  if (files.length > MAX_SKILL_FILES) {
    throw new WorkingProfileProblem("skill_package_too_large");
  }
  let totalBytes = 0;
  const seen = new Set<string>();
  let rootSkill: Uint8Array<ArrayBuffer> | null = null;
  for (const file of files) {
    const path = validateSkillPath(file.path);
    const folded = path.toLowerCase();
    if (
      seen.has(folded) ||
      (folded.endsWith("/skill.md") && path !== "SKILL.md")
    ) {
      throw new WorkingProfileProblem("skill_package_invalid");
    }
    seen.add(folded);
    const bytes = decodeBase64(file.contentBase64);
    if (bytes.byteLength > MAX_SKILL_FILE_BYTES) {
      throw new WorkingProfileProblem("skill_package_too_large");
    }
    totalBytes += bytes.byteLength;
    if (totalBytes > MAX_SKILL_PACKAGE_BYTES) {
      throw new WorkingProfileProblem("skill_package_too_large");
    }
    rejectCredential(path, bytes);
    if (path === "SKILL.md") rootSkill = bytes;
  }
  if (rootSkill === null)
    throw new WorkingProfileProblem("skill_package_invalid");
  let markdown: string;
  try {
    markdown = new TextDecoder("utf-8", { fatal: true }).decode(rootSkill);
  } catch {
    throw new WorkingProfileProblem("skill_package_invalid");
  }
  const match = /^(?:\uFEFF)?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(
    markdown,
  );
  if (match?.[1] === undefined)
    throw new WorkingProfileProblem("skill_package_invalid");
  const document = parseDocument(match[1], {
    customTags: [],
    schema: "core",
    strict: true,
    uniqueKeys: true,
  });
  if (document.errors.length !== 0 || document.warnings.length !== 0) {
    throw new WorkingProfileProblem("skill_package_invalid");
  }
  let metadata: unknown;
  try {
    metadata = document.toJS({ maxAliasCount: 0 });
  } catch {
    throw new WorkingProfileProblem("skill_package_invalid");
  }
  if (
    typeof metadata !== "object" ||
    metadata === null ||
    Array.isArray(metadata)
  ) {
    throw new WorkingProfileProblem("skill_package_invalid");
  }
  const parsed = agentSkillSummarySchema
    .pick({ name: true, description: true })
    .safeParse({
      description: Reflect.get(metadata, "description"),
      name: Reflect.get(metadata, "name"),
    });
  if (!parsed.success) throw new WorkingProfileProblem("skill_package_invalid");
  return { ...parsed.data, files };
}

type SkillRow = {
  current_version_record_id: string;
  description: string;
  name: string;
  skill_id: string;
  updated_at: number;
};

function skillFromRow(row: SkillRow) {
  return agentSkillSummarySchema.parse({
    description: row.description,
    name: row.name,
    skillId: row.skill_id,
    updatedAt: row.updated_at,
    versionRecordId: row.current_version_record_id,
  });
}

function parseSkillVersionBody(
  value: unknown,
  identity: { recordId: string; skillId: string },
) {
  const parsed = workingProfileRecordBodySchema.safeParse(value);
  if (
    !parsed.success ||
    parsed.data.type !== "skill-version" ||
    parsed.data.recordId !== identity.recordId ||
    parsed.data.skillId !== identity.skillId
  ) {
    throw new WorkingProfileProblem("skill_package_invalid");
  }
  return parsed.data;
}

export async function listAgentSkills(db: D1Database) {
  const rows = await db
    .prepare(
      `SELECT skill_id, name, description, current_version_record_id, updated_at
       FROM agent_skills WHERE status = 'active'
       ORDER BY name COLLATE NOCASE, skill_id LIMIT ?`,
    )
    .bind(MAX_SKILLS)
    .all<SkillRow>();
  return rows.results.map(skillFromRow);
}

export async function listProjectSkillAttachments(
  db: D1Database,
  bucket: R2Bucket,
  projectId: string,
) {
  if (!(await activeProjectExists(db, projectId))) {
    throw new WorkingProfileProblem("project_not_active");
  }
  const rows = await db
    .prepare(
      `SELECT attachment.attached_at, attachment.skill_id,
              attachment.skill_version_record_id, record.body_object_key,
              record.content_sha256, record.byte_length, record.created_at
       FROM project_skill_attachments attachment
       JOIN agent_skills skill ON skill.skill_id = attachment.skill_id
       JOIN working_profile_records record
         ON record.record_id = attachment.skill_version_record_id
        AND record.restore_state = 'live'
        AND record.record_type = 'skill-version'
       WHERE attachment.project_id = ? AND skill.status = 'active'
       ORDER BY attachment.attached_at, attachment.skill_id LIMIT ?`,
    )
    .bind(projectId, MAX_PROJECT_SKILL_ATTACHMENTS + 1)
    .all<{
      attached_at: number;
      body_object_key: string;
      byte_length: number;
      content_sha256: string;
      created_at: number;
      skill_id: string;
      skill_version_record_id: string;
    }>();
  if (rows.results.length > MAX_PROJECT_SKILL_ATTACHMENTS) {
    throw new WorkingProfileProblem("project_skill_limit_exceeded");
  }
  const attachments = [];
  for (
    let offset = 0;
    offset < rows.results.length;
    offset += SKILL_METADATA_READ_CONCURRENCY
  ) {
    attachments.push(
      ...(await Promise.all(
        rows.results
          .slice(offset, offset + SKILL_METADATA_READ_CONCURRENCY)
          .map(async (row) => {
            const body = await readWorkingProfileBody(bucket, {
              bodyObjectKey: row.body_object_key,
              byteLength: row.byte_length,
              contentSha256: row.content_sha256,
            });
            const skillBody = parseSkillVersionBody(body, {
              recordId: row.skill_version_record_id,
              skillId: row.skill_id,
            });
            return {
              attachedAt: row.attached_at,
              projectId,
              skill: agentSkillSummarySchema.parse({
                description: skillBody.description,
                name: skillBody.name,
                skillId: row.skill_id,
                updatedAt: row.created_at,
                versionRecordId: row.skill_version_record_id,
              }),
            };
          }),
      )),
    );
  }
  return attachments;
}

export async function importAgentSkill(
  db: D1Database,
  bucket: R2Bucket,
  input: ImportAgentSkillRequest,
) {
  const identity = await receiptIdentity(
    "skill.import",
    input.idempotencyKey,
    input,
  );
  const parse = (value: unknown) => agentSkillSummarySchema.parse(value);
  const priorReplay = await replay(db, identity, "skill.import", parse);
  if (priorReplay !== null) return priorReplay;
  const metadata = skillMetadata(input.files);
  const existing =
    input.skillId === undefined
      ? null
      : await db
          .prepare(
            `SELECT skill_id, name, description, current_version_record_id, updated_at
             FROM agent_skills WHERE skill_id = ? AND status = 'active'`,
          )
          .bind(input.skillId)
          .first<SkillRow>();
  if (input.skillId !== undefined && existing === null) {
    throw new WorkingProfileProblem("skill_not_found");
  }
  const nameOwner = await db
    .prepare(
      `SELECT skill_id FROM agent_skills
       WHERE name = ? COLLATE NOCASE AND status = 'active'`,
    )
    .bind(metadata.name)
    .first<{ skill_id: string }>();
  if (nameOwner !== null && nameOwner.skill_id !== input.skillId) {
    throw new WorkingProfileProblem("skill_conflict");
  }
  if (existing === null) {
    const count = await db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM agent_skills WHERE status = 'active'`,
      )
      .first<{ count: number }>();
    if ((count?.count ?? 0) >= MAX_SKILLS) {
      throw new WorkingProfileProblem("skill_package_too_large");
    }
  }
  const skillId = input.skillId ?? crypto.randomUUID();
  const recordId = crypto.randomUUID();
  const now = nowSeconds();
  const body = canonicalWorkingProfileBody({
    description: metadata.description,
    files: metadata.files,
    name: metadata.name,
    recordId,
    skillId,
    type: "skill-version",
  });
  const stored = await publishWorkingProfileBody(
    db,
    bucket,
    body,
    recordId,
    now,
  );
  const response = agentSkillSummarySchema.parse({
    description: metadata.description,
    name: metadata.name,
    skillId,
    updatedAt: now,
    versionRecordId: recordId,
  });
  try {
    return await commit(
      db,
      [
        insertWorkingProfileRecordStatement(
          db,
          recordFromBody(stored, {
            createdAt: now,
            dependencies:
              existing === null ? [] : [existing.current_version_record_id],
            portableObjectId: recordId,
            preferenceId: null,
            projectId: null,
            recordId,
            recordType: "skill-version",
            skillId,
          }),
        ),
        db
          .prepare(
            `INSERT INTO agent_skills (
             skill_id, name, description, current_version_record_id,
             record_restore_state, status, updated_at
           ) VALUES (?, ?, ?, ?, 'live', 'active', ?)
           ON CONFLICT(skill_id) DO UPDATE SET
             name = excluded.name, description = excluded.description,
             current_version_record_id = excluded.current_version_record_id,
             status = 'active', updated_at = excluded.updated_at`,
          )
          .bind(skillId, metadata.name, metadata.description, recordId, now),
      ],
      { identity, now, operation: "skill.import", response },
      parse,
      [stored.bodyObjectKey],
    );
  } catch (error) {
    const winner = await db
      .prepare(
        `SELECT skill_id FROM agent_skills
         WHERE name = ? COLLATE NOCASE AND status = 'active'`,
      )
      .bind(metadata.name)
      .first<{ skill_id: string }>();
    if (winner !== null && winner.skill_id !== skillId) {
      throw new WorkingProfileProblem("skill_conflict");
    }
    throw error;
  }
}

async function currentSkill(
  db: D1Database,
  skillId: string,
): Promise<SkillRow> {
  const row = await db
    .prepare(
      `SELECT skill_id, name, description, current_version_record_id, updated_at
       FROM agent_skills WHERE skill_id = ? AND status = 'active'`,
    )
    .bind(skillId)
    .first<SkillRow>();
  if (row === null) throw new WorkingProfileProblem("skill_not_found");
  return row;
}

export async function exportAgentSkill(
  db: D1Database,
  bucket: R2Bucket,
  skillId: string,
) {
  const skill = await currentSkill(db, skillId);
  const record = await db
    .prepare(
      `SELECT body_object_key, content_sha256, byte_length
       FROM working_profile_records
       WHERE record_id = ? AND record_type = 'skill-version'
         AND restore_state = 'live'`,
    )
    .bind(skill.current_version_record_id)
    .first<{
      body_object_key: string;
      byte_length: number;
      content_sha256: string;
    }>();
  if (record === null) throw new WorkingProfileProblem("skill_not_found");
  const body = await readWorkingProfileBody(bucket, {
    bodyObjectKey: record.body_object_key,
    byteLength: record.byte_length,
    contentSha256: record.content_sha256,
  });
  const skillBody = parseSkillVersionBody(body, {
    recordId: skill.current_version_record_id,
    skillId,
  });
  return agentSkillExportResponseSchema.parse({
    executes: false,
    files: skillBody.files,
    grantsAuthority: false,
    ok: true,
    packageSha256: record.content_sha256,
    skill: skillFromRow(skill),
  });
}

export async function deleteAgentSkill(
  db: D1Database,
  bucket: R2Bucket,
  input: DeleteAgentSkillRequest,
) {
  const identity = await receiptIdentity(
    "skill.delete",
    input.idempotencyKey,
    input,
  );
  const parse = (value: unknown) =>
    workingProfileDeleteResponseSchema.omit({ ok: true }).parse(value);
  const priorReplay = await replay(db, identity, "skill.delete", parse);
  if (priorReplay !== null) return priorReplay;
  const skill = await currentSkill(db, input.skillId);
  const attachments = await db
    .prepare(
      `SELECT project_id, attached_record_id, skill_version_record_id
       FROM project_skill_attachments WHERE skill_id = ?
       ORDER BY project_id LIMIT ?`,
    )
    .bind(input.skillId, MAX_SKILL_PROJECT_ATTACHMENTS + 1)
    .all<{
      attached_record_id: string;
      project_id: string;
      skill_version_record_id: string;
    }>();
  if (attachments.results.length > MAX_SKILL_PROJECT_ATTACHMENTS) {
    throw new WorkingProfileProblem("project_skill_limit_exceeded");
  }
  const now = nowSeconds();
  const deleteRecordId = crypto.randomUUID();
  const deleteStored = await publishWorkingProfileBody(
    db,
    bucket,
    canonicalWorkingProfileBody({
      recordId: deleteRecordId,
      skillId: input.skillId,
      type: "skill-deleted",
    }),
    deleteRecordId,
    now,
  );
  const records: WorkingProfileRecord[] = [
    recordFromBody(deleteStored, {
      createdAt: now,
      dependencies: [skill.current_version_record_id],
      portableObjectId: deleteRecordId,
      preferenceId: null,
      projectId: null,
      recordId: deleteRecordId,
      recordType: "skill-deleted",
      skillId: input.skillId,
    }),
  ];
  for (const attachment of attachments.results) {
    const recordId = crypto.randomUUID();
    const stored = await publishWorkingProfileBody(
      db,
      bucket,
      canonicalWorkingProfileBody({
        projectId: attachment.project_id,
        recordId,
        skillId: input.skillId,
        skillVersionRecordId: attachment.skill_version_record_id,
        type: "skill-detached",
      }),
      recordId,
      now,
    );
    records.push(
      recordFromBody(stored, {
        createdAt: now,
        dependencies: [
          attachment.attached_record_id,
          attachment.skill_version_record_id,
        ],
        portableObjectId: recordId,
        preferenceId: null,
        projectId: attachment.project_id,
        recordId,
        recordType: "skill-detached",
        skillId: input.skillId,
      }),
    );
  }
  const response = { deleted: true as const, recordId: deleteRecordId };
  return commit(
    db,
    [
      ...records.map((record) =>
        insertWorkingProfileRecordStatement(db, record),
      ),
      db
        .prepare("DELETE FROM project_skill_attachments WHERE skill_id = ?")
        .bind(input.skillId),
      db
        .prepare(
          `UPDATE agent_skills
           SET current_version_record_id = ?, status = 'deleted', updated_at = ?
           WHERE skill_id = ? AND status = 'active'`,
        )
        .bind(deleteRecordId, now, input.skillId),
    ],
    { identity, now, operation: "skill.delete", response },
    parse,
    records.map((record) => record.bodyObjectKey),
  );
}

export async function mutateProjectSkill(
  db: D1Database,
  bucket: R2Bucket,
  input: ProjectSkillMutationRequest,
  attach: boolean,
  slotRetry = false,
) {
  const operation = attach ? "skill.attach" : "skill.detach";
  const identity = await receiptIdentity(
    operation,
    input.idempotencyKey,
    input,
  );
  const parse = (value: unknown) =>
    projectSkillMutationResponseSchema.omit({ ok: true }).parse(value);
  const priorReplay = await replay(db, identity, operation, parse);
  if (priorReplay !== null) return priorReplay;
  if (!(await activeProjectExists(db, input.projectId))) {
    throw new WorkingProfileProblem("project_not_active");
  }
  const skill = await currentSkill(db, input.skillId);
  const existing = await db
    .prepare(
      `SELECT attached_record_id, skill_version_record_id
       FROM project_skill_attachments WHERE project_id = ? AND skill_id = ?`,
    )
    .bind(input.projectId, input.skillId)
    .first<{ attached_record_id: string; skill_version_record_id: string }>();
  if (attach ? existing !== null : existing === null) {
    throw new WorkingProfileProblem(
      attach ? "skill_already_attached" : "skill_not_attached",
    );
  }
  let attachmentSlots = { projectSlot: -1, skillSlot: -1 };
  if (attach) {
    const occupied = await db
      .prepare(
        `SELECT project_slot AS slot, 'project' AS slot_kind
         FROM project_skill_attachments WHERE project_id = ?
         UNION ALL
         SELECT skill_slot AS slot, 'skill' AS slot_kind
         FROM project_skill_attachments WHERE skill_id = ?`,
      )
      .bind(input.projectId, input.skillId)
      .all<{ slot: number; slot_kind: "project" | "skill" }>();
    const projectSlots = new Set(
      occupied.results
        .filter((row) => row.slot_kind === "project")
        .map((row) => row.slot),
    );
    const skillSlots = new Set(
      occupied.results
        .filter((row) => row.slot_kind === "skill")
        .map((row) => row.slot),
    );
    const firstOpenSlot = (slots: Set<number>, limit: number) => {
      for (let slot = 0; slot < limit; slot += 1) {
        if (!slots.has(slot)) return slot;
      }
      return null;
    };
    const projectSlot = firstOpenSlot(
      projectSlots,
      MAX_PROJECT_SKILL_ATTACHMENTS,
    );
    const skillSlot = firstOpenSlot(skillSlots, MAX_SKILL_PROJECT_ATTACHMENTS);
    if (projectSlot === null || skillSlot === null) {
      throw new WorkingProfileProblem("project_skill_limit_exceeded");
    }
    attachmentSlots = { projectSlot, skillSlot };
  }
  const versionRecordId = attach
    ? skill.current_version_record_id
    : (existing?.skill_version_record_id ?? skill.current_version_record_id);
  const recordId = crypto.randomUUID();
  const now = nowSeconds();
  const recordType = attach ? "skill-attached" : "skill-detached";
  const stored = await publishWorkingProfileBody(
    db,
    bucket,
    canonicalWorkingProfileBody({
      projectId: input.projectId,
      recordId,
      skillId: input.skillId,
      skillVersionRecordId: versionRecordId,
      type: recordType,
    }),
    recordId,
    now,
  );
  const response = {
    attached: attach,
    projectId: input.projectId,
    recordId,
    skillId: input.skillId,
    versionRecordId,
  };
  const projection = attach
    ? db
        .prepare(
          `INSERT INTO project_skill_attachments (
             project_id, skill_id, skill_version_record_id, project_slot,
             skill_slot, attached_record_id, record_restore_state, attached_at
           ) VALUES (?, ?, ?, ?, ?, ?, 'live', ?)`,
        )
        .bind(
          input.projectId,
          input.skillId,
          versionRecordId,
          attachmentSlots.projectSlot,
          attachmentSlots.skillSlot,
          recordId,
          now,
        )
    : db
        .prepare(
          "DELETE FROM project_skill_attachments WHERE project_id = ? AND skill_id = ?",
        )
        .bind(input.projectId, input.skillId);
  try {
    return await commit(
      db,
      [
        insertWorkingProfileRecordStatement(
          db,
          recordFromBody(stored, {
            createdAt: now,
            dependencies: attach
              ? [versionRecordId]
              : [existing?.attached_record_id ?? "", versionRecordId],
            portableObjectId: recordId,
            preferenceId: null,
            projectId: input.projectId,
            recordId,
            recordType,
            skillId: input.skillId,
          }),
        ),
        projection,
      ],
      { identity, now, operation, response },
      parse,
      [stored.bodyObjectKey],
    );
  } catch (error) {
    if (!attach) throw error;
    const attached = await db
      .prepare(
        `SELECT 1 FROM project_skill_attachments
         WHERE project_id = ? AND skill_id = ?`,
      )
      .bind(input.projectId, input.skillId)
      .first();
    if (attached !== null) {
      throw new WorkingProfileProblem("skill_already_attached");
    }
    if (!slotRetry) {
      return mutateProjectSkill(db, bucket, input, true, true);
    }
    throw new WorkingProfileProblem("skill_conflict");
  }
}
