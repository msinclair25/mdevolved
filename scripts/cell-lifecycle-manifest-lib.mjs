import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const FORMAT = "owd-managed-cell-build-manifest-v1";
const PLAN_FORMAT = "owd-managed-cell-deprovision-plan-v1";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const HEX_32_PATTERN = /^[0-9a-f]{32}$/u;
const SHA_256_PATTERN = /^[0-9a-f]{64}$/u;
const MIGRATION_PATTERN = /^[0-9]{4}_[a-z0-9_]+\.sql$/u;
const SECRET_NAME_PATTERN = /^[A-Z][A-Z0-9_]{2,63}$/u;
const REQUIRED_RATE_LIMIT_BINDINGS = [
  "OAUTH_REGISTRATION_CLIENT_LIMITER",
  "OAUTH_REGISTRATION_ROUTE_LIMITER",
  "OAUTH_TOKEN_CLIENT_LIMITER",
  "SOCKET_TICKET_IP_LIMITER",
  "SOCKET_TICKET_VAULT_LIMITER",
];
const COMMUNITY_RATE_LIMIT_NAMESPACE_IDS = new Set([
  "1001",
  "1002",
  "1003",
  "1004",
  "1005",
]);
const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
const cellManifestSchema = JSON.parse(
  readFileSync(
    new URL(
      "../infra/managed/cell-build-manifest.schema.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const rateLimitRegistrySchema = JSON.parse(
  readFileSync(
    new URL(
      "../infra/managed/cell-rate-limit-registry.schema.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const validateCellManifestSchema = ajv.compile(cellManifestSchema);
const validateRateLimitRegistrySchema = ajv.compile(rateLimitRegistrySchema);

function reject(message) {
  throw new Error(`Invalid managed cell build manifest: ${message}`);
}

function requireSchema(validator, value, label) {
  if (validator(value)) return;
  const detail = (validator.errors ?? [])
    .slice(0, 3)
    .map((error) => `${error.instancePath || "/"} ${error.message}`)
    .join("; ");
  reject(`${label} violates its public JSON schema: ${detail}.`);
}

function requireObject(value, path) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    reject(`${path} must be an object.`);
  }
  return value;
}

function requireExactKeys(value, expected, path) {
  const actual = Object.keys(requireObject(value, path)).sort();
  const wanted = [...expected].sort();
  if (actual.join("\0") !== wanted.join("\0")) {
    reject(`${path} must contain exactly: ${wanted.join(", ")}.`);
  }
}

function requireString(value, path, options = {}) {
  if (typeof value !== "string") reject(`${path} must be a string.`);
  if (options.min !== undefined && value.length < options.min) {
    reject(`${path} is shorter than ${options.min} characters.`);
  }
  if (options.max !== undefined && value.length > options.max) {
    reject(`${path} is longer than ${options.max} characters.`);
  }
  if (options.pattern && !options.pattern.test(value)) {
    reject(`${path} has an unsupported value.`);
  }
  return value;
}

function requireBoolean(value, expected, path) {
  if (
    typeof value !== "boolean" ||
    (expected !== undefined && value !== expected)
  ) {
    reject(`${path} must be ${String(expected)}.`);
  }
}

function requireArray(value, path, minimum = 0) {
  if (!Array.isArray(value) || value.length < minimum) {
    reject(`${path} must contain at least ${minimum} item(s).`);
  }
  return value;
}

function requireUnique(values, path) {
  if (new Set(values).size !== values.length) reject(`${path} must be unique.`);
}

function requireTimestamp(value, path) {
  requireString(value, path);
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value) {
    reject(`${path} must be an exact ISO-8601 UTC timestamp.`);
  }
  return time;
}

function validateRoute(route, index) {
  const path = `cloudflare.worker.routes[${index}]`;
  requireExactKeys(
    route,
    ["deprovisionMode", "pattern", "routeId", "zoneId"],
    path,
  );
  requireString(route.pattern, `${path}.pattern`, {
    min: 4,
    max: 253,
  });
  requireString(route.zoneId, `${path}.zoneId`, { pattern: HEX_32_PATTERN });
  requireString(route.routeId, `${path}.routeId`, {
    pattern: HEX_32_PATTERN,
  });
  if (route.deprovisionMode !== "explicit-delete") {
    reject(`${path}.deprovisionMode is unsupported.`);
  }
}

function validateCustomDomain(domain, index) {
  const path = `cloudflare.worker.customDomains[${index}]`;
  requireExactKeys(
    domain,
    ["deprovisionMode", "domainId", "hostname", "zoneId"],
    path,
  );
  const hostname = requireString(domain.hostname, `${path}.hostname`, {
    min: 4,
    max: 253,
  });
  if (hostname !== hostname.toLowerCase() || !hostname.includes(".")) {
    reject(`${path}.hostname must be a lower-case hostname.`);
  }
  requireString(domain.zoneId, `${path}.zoneId`, { pattern: HEX_32_PATTERN });
  requireString(domain.domainId, `${path}.domainId`, {
    pattern: /^[0-9a-f]{40}$/u,
  });
  if (domain.deprovisionMode !== "delete-domain-and-verify-dns") {
    reject(`${path}.deprovisionMode is unsupported.`);
  }
}

function validateBoundResource(value, path, binding, fields) {
  requireExactKeys(value, ["binding", ...Object.keys(fields)], path);
  if (value.binding !== binding) reject(`${path}.binding must be ${binding}.`);
  for (const [field, rule] of Object.entries(fields)) {
    requireString(value[field], `${path}.${field}`, rule);
  }
}

export function hashMigrationLedger(entries) {
  const hash = createHash("sha256");
  for (const entry of entries) {
    hash.update(entry.name, "utf8");
    hash.update("\0", "utf8");
    hash.update(entry.contents, "utf8");
    hash.update("\0", "utf8");
  }
  return hash.digest("hex");
}

export function hashManifestSource(source) {
  return createHash("sha256").update(source, "utf8").digest("hex");
}

export function validateCellBuildManifest(value, expectations = {}) {
  requireSchema(validateCellManifestSchema, value, "manifest");
  requireExactKeys(
    value,
    [
      "cellRef",
      "cloudflare",
      "deprovision",
      "expiresAt",
      "format",
      "provisionedAt",
      "purpose",
      "release",
      "schemaVersion",
    ],
    "manifest",
  );
  if (value.format !== FORMAT || value.schemaVersion !== 1) {
    reject(`format must be ${FORMAT} at schema version 1.`);
  }
  requireString(value.cellRef, "cellRef", {
    min: 8,
    max: 64,
    pattern: /^[a-z0-9][a-z0-9-]+$/u,
  });
  if (value.purpose !== "disposable-test") {
    reject("purpose must be disposable-test.");
  }

  requireExactKeys(
    value.release,
    [
      "appliedMigrations",
      "communityVersion",
      "compatibilityDate",
      "gitCommit",
      "migrationLedgerSha256",
    ],
    "release",
  );
  requireString(value.release.communityVersion, "release.communityVersion", {
    pattern: /^[0-9]+\.[0-9]+\.[0-9]+-alpha\.[0-9]+$/u,
  });
  requireString(value.release.gitCommit, "release.gitCommit", {
    pattern: /^[0-9a-f]{40}$/u,
  });
  requireString(value.release.compatibilityDate, "release.compatibilityDate", {
    pattern: /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/u,
  });
  if (
    !Number.isFinite(Date.parse(`${value.release.compatibilityDate}T00:00:00Z`))
  ) {
    reject("release.compatibilityDate must be a calendar date.");
  }
  requireString(
    value.release.migrationLedgerSha256,
    "release.migrationLedgerSha256",
    { pattern: SHA_256_PATTERN },
  );
  const migrations = requireArray(
    value.release.appliedMigrations,
    "release.appliedMigrations",
    1,
  ).map((migration, index) =>
    requireString(migration, `release.appliedMigrations[${index}]`, {
      pattern: MIGRATION_PATTERN,
    }),
  );
  requireUnique(migrations, "release.appliedMigrations");
  if (migrations.join("\0") !== [...migrations].sort().join("\0")) {
    reject("release.appliedMigrations must be in filename order.");
  }
  if (
    expectations.communityVersion &&
    value.release.communityVersion !== expectations.communityVersion
  ) {
    reject("release.communityVersion does not match this checkout.");
  }
  if (
    expectations.compatibilityDate &&
    value.release.compatibilityDate !== expectations.compatibilityDate
  ) {
    reject("release.compatibilityDate does not match wrangler.jsonc.");
  }
  if (
    expectations.migrationFiles &&
    migrations.join("\0") !== expectations.migrationFiles.join("\0")
  ) {
    reject("release.appliedMigrations does not match the complete ledger.");
  }
  if (
    expectations.migrationLedgerSha256 &&
    value.release.migrationLedgerSha256 !== expectations.migrationLedgerSha256
  ) {
    reject("release.migrationLedgerSha256 does not match the complete ledger.");
  }

  const provisionedAt = requireTimestamp(value.provisionedAt, "provisionedAt");
  const expiresAt = requireTimestamp(value.expiresAt, "expiresAt");
  if (expiresAt <= provisionedAt)
    reject("expiresAt must follow provisionedAt.");
  if (expectations.requireFutureExpiry) {
    const now = expectations.now ?? Date.now();
    if (provisionedAt > now) reject("provisionedAt cannot be in the future.");
    if (expiresAt <= now) reject("expiresAt must be in the future.");
  }

  requireExactKeys(
    value.cloudflare,
    [
      "accountId",
      "d1",
      "durableObject",
      "kv",
      "r2",
      "rateLimits",
      "secretNames",
      "worker",
    ],
    "cloudflare",
  );
  requireString(value.cloudflare.accountId, "cloudflare.accountId", {
    pattern: HEX_32_PATTERN,
  });

  requireExactKeys(
    value.cloudflare.worker,
    [
      "cronTriggers",
      "customDomains",
      "deploymentId",
      "name",
      "routes",
      "versionId",
      "workersDevEnabled",
    ],
    "cloudflare.worker",
  );
  requireString(value.cloudflare.worker.name, "cloudflare.worker.name", {
    min: 1,
    max: 63,
    pattern: /^[a-z0-9][a-z0-9-]+$/u,
  });
  requireString(
    value.cloudflare.worker.deploymentId,
    "cloudflare.worker.deploymentId",
    { pattern: UUID_PATTERN },
  );
  requireString(
    value.cloudflare.worker.versionId,
    "cloudflare.worker.versionId",
    {
      pattern: UUID_PATTERN,
    },
  );
  requireBoolean(
    value.cloudflare.worker.workersDevEnabled,
    undefined,
    "cloudflare.worker.workersDevEnabled",
  );
  const cronTriggers = requireArray(
    value.cloudflare.worker.cronTriggers,
    "cloudflare.worker.cronTriggers",
  ).map((cron, index) =>
    requireString(cron, `cloudflare.worker.cronTriggers[${index}]`, {
      min: 1,
      max: 100,
    }),
  );
  requireUnique(cronTriggers, "cloudflare.worker.cronTriggers");
  const customDomains = requireArray(
    value.cloudflare.worker.customDomains,
    "cloudflare.worker.customDomains",
  );
  customDomains.forEach(validateCustomDomain);
  requireUnique(
    customDomains.map((domain) => domain.hostname),
    "cloudflare.worker.customDomains hostnames",
  );
  const routes = requireArray(
    value.cloudflare.worker.routes,
    "cloudflare.worker.routes",
  );
  routes.forEach(validateRoute);
  requireUnique(
    routes.map((route) => `${route.zoneId}:${route.routeId}`),
    "cloudflare.worker.routes",
  );
  if (
    !value.cloudflare.worker.workersDevEnabled &&
    customDomains.length === 0 &&
    routes.length === 0
  ) {
    reject("cloudflare.worker must record at least one reachable route.");
  }

  validateBoundResource(value.cloudflare.d1, "cloudflare.d1", "DB", {
    name: { min: 1, max: 63 },
    id: { pattern: UUID_PATTERN },
  });
  validateBoundResource(value.cloudflare.r2, "cloudflare.r2", "VAULT_STORAGE", {
    bucket: { min: 3, max: 63, pattern: /^[a-z0-9][a-z0-9-]+$/u },
  });
  validateBoundResource(value.cloudflare.kv, "cloudflare.kv", "OAUTH_KV", {
    namespaceName: { min: 1, max: 128 },
    id: { pattern: HEX_32_PATTERN },
  });
  requireExactKeys(
    value.cloudflare.durableObject,
    ["binding", "className", "deprovisionMode", "namespaceId"],
    "cloudflare.durableObject",
  );
  if (
    value.cloudflare.durableObject.binding !== "VAULTS" ||
    value.cloudflare.durableObject.className !== "VaultCoordinator" ||
    value.cloudflare.durableObject.deprovisionMode !==
      "worker-delete-and-verify"
  ) {
    reject(
      "cloudflare.durableObject has an unsupported binding or deletion mode.",
    );
  }
  requireString(
    value.cloudflare.durableObject.namespaceId,
    "cloudflare.durableObject.namespaceId",
    { pattern: HEX_32_PATTERN },
  );

  const rateLimits = requireArray(
    value.cloudflare.rateLimits,
    "cloudflare.rateLimits",
    5,
  );
  const rateLimitRefs = rateLimits.map((rateLimit, index) => {
    const path = `cloudflare.rateLimits[${index}]`;
    requireExactKeys(rateLimit, ["binding", "namespaceId"], path);
    requireString(rateLimit.binding, `${path}.binding`);
    requireString(rateLimit.namespaceId, `${path}.namespaceId`, {
      pattern: /^[1-9][0-9]{0,8}$/u,
    });
    return `${rateLimit.binding}:${rateLimit.namespaceId}`;
  });
  requireUnique(rateLimitRefs, "cloudflare.rateLimits");
  const actualRateLimitBindings = rateLimits
    .map((rateLimit) => rateLimit.binding)
    .sort();
  if (
    actualRateLimitBindings.join("\0") !==
    REQUIRED_RATE_LIMIT_BINDINGS.join("\0")
  ) {
    reject(
      "cloudflare.rateLimits must reserve the five exact MDevolved bindings.",
    );
  }
  requireUnique(
    rateLimits.map((rateLimit) => rateLimit.namespaceId),
    "cloudflare.rateLimits namespace IDs",
  );
  if (
    rateLimits.some((rateLimit) =>
      COMMUNITY_RATE_LIMIT_NAMESPACE_IDS.has(rateLimit.namespaceId),
    )
  ) {
    reject("managed cells cannot reuse Community rate-limit namespace IDs.");
  }

  const secretNames = requireArray(
    value.cloudflare.secretNames,
    "cloudflare.secretNames",
  ).map((name, index) =>
    requireString(name, `cloudflare.secretNames[${index}]`, {
      pattern: SECRET_NAME_PATTERN,
    }),
  );
  requireUnique(secretNames, "cloudflare.secretNames");

  requireExactKeys(
    value.deprovision,
    [
      ...(value.deprovision.authorizedDisposition === undefined
        ? []
        : ["authorizedDisposition"]),
      "deleteAfter",
      "requireExplicitDisposition",
      "requirePostDeleteInventory",
      "requireZeroAuthorityPrecheck",
    ],
    "deprovision",
  );
  requireBoolean(
    value.deprovision.requireExplicitDisposition,
    true,
    "deprovision.requireExplicitDisposition",
  );
  requireBoolean(
    value.deprovision.requireZeroAuthorityPrecheck,
    true,
    "deprovision.requireZeroAuthorityPrecheck",
  );
  requireBoolean(
    value.deprovision.requirePostDeleteInventory,
    true,
    "deprovision.requirePostDeleteInventory",
  );
  const deleteAfter = requireTimestamp(
    value.deprovision.deleteAfter,
    "deprovision.deleteAfter",
  );
  if (deleteAfter !== expiresAt) {
    reject("deprovision.deleteAfter must equal expiresAt.");
  }
  if (value.deprovision.authorizedDisposition !== undefined) {
    const disposition = value.deprovision.authorizedDisposition;
    requireExactKeys(
      disposition,
      [
        "authorizationReceiptSha256",
        "authorizedAt",
        "mode",
        "predeleteEvidenceReceiptSha256",
      ],
      "deprovision.authorizedDisposition",
    );
    requireTimestamp(
      disposition.authorizedAt,
      "deprovision.authorizedDisposition.authorizedAt",
    );
    requireString(
      disposition.authorizationReceiptSha256,
      "deprovision.authorizedDisposition.authorizationReceiptSha256",
      { pattern: SHA_256_PATTERN },
    );
    requireString(
      disposition.predeleteEvidenceReceiptSha256,
      "deprovision.authorizedDisposition.predeleteEvidenceReceiptSha256",
      { pattern: SHA_256_PATTERN },
    );
  }
  return value;
}

export function validateRateLimitRegistry(
  registry,
  manifest,
  manifestSha256,
  expectations = {},
) {
  requireSchema(
    validateRateLimitRegistrySchema,
    registry,
    "rate-limit registry",
  );
  if (registry.accountId !== manifest.cloudflare.accountId) {
    reject("rate-limit registry accountId does not match the manifest.");
  }
  if (expectations.requireFresh) {
    const now = expectations.now ?? Date.now();
    const updatedAt = Date.parse(registry.updatedAt);
    if (updatedAt > now || now - updatedAt > 15 * 60 * 1_000) {
      reject("rate-limit registry must be refreshed within 15 minutes.");
    }
  }
  const cellRefs = registry.reservations.map((entry) => entry.cellRef);
  const workerNames = registry.reservations.map((entry) => entry.workerName);
  const namespaceIds = registry.reservations.flatMap(
    (entry) => entry.namespaceIds,
  );
  requireUnique(cellRefs, "rate-limit registry cell references");
  requireUnique(workerNames, "rate-limit registry Worker names");
  requireUnique(namespaceIds, "account-scoped rate-limit namespace IDs");
  const reservation = registry.reservations.find(
    (entry) => entry.cellRef === manifest.cellRef,
  );
  if (!reservation) {
    reject("rate-limit registry has no reservation for this cell.");
  }
  if (
    reservation.workerName !== manifest.cloudflare.worker.name ||
    reservation.manifestSha256 !== manifestSha256
  ) {
    reject("rate-limit registry reservation provenance does not match.");
  }
  const manifestIds = manifest.cloudflare.rateLimits
    .map((rateLimit) => rateLimit.namespaceId)
    .sort();
  if (
    [...reservation.namespaceIds].sort().join("\0") !== manifestIds.join("\0")
  ) {
    reject("rate-limit registry reservation IDs do not match the manifest.");
  }
  return registry;
}

export function validateEmptyRateLimitRegistryAfterCleanup(registry, context) {
  requireSchema(
    validateRateLimitRegistrySchema,
    registry,
    "rate-limit registry",
  );
  requireExactKeys(
    context,
    ["absenceReceiptSha256", "accountId", "phase", "verifiedAt"],
    "postCleanupContext",
  );
  if (context.phase !== "post-delete-absence-verified") {
    reject("postCleanupContext.phase must be post-delete-absence-verified.");
  }
  requireString(context.accountId, "postCleanupContext.accountId", {
    pattern: HEX_32_PATTERN,
  });
  if (registry.accountId !== context.accountId) {
    reject("post-cleanup accountId does not match the registry.");
  }
  requireTimestamp(context.verifiedAt, "postCleanupContext.verifiedAt");
  requireString(
    context.absenceReceiptSha256,
    "postCleanupContext.absenceReceiptSha256",
    { pattern: SHA_256_PATTERN },
  );
  if (registry.reservations.length !== 0) {
    reject("post-cleanup registry must contain zero reservations.");
  }
  return registry;
}

function redact(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex").slice(0, 12)}`;
}

export function createDeprovisionPlan(manifest, options = {}) {
  validateCellBuildManifest(manifest, options.expectations);
  const disposition = manifest.deprovision.authorizedDisposition;
  if (disposition === undefined) {
    reject(
      "deprovision plan requires an authorized disposition and bounded pre-delete evidence receipts.",
    );
  }
  const target = (value) => (options.showTargets ? value : redact(value));
  const actions = [];
  let sequence = 1;
  for (const route of manifest.cloudflare.worker.routes) {
    actions.push({
      sequence: sequence++,
      kind: "worker-route",
      operation: "delete-explicit-route",
      target: target(`${route.zoneId}:${route.routeId}`),
    });
  }
  for (const domain of manifest.cloudflare.worker.customDomains) {
    actions.push({
      sequence: sequence++,
      kind: "custom-domain",
      operation: "delete-custom-domain",
      target: target(domain.domainId),
    });
  }
  for (const secretName of manifest.cloudflare.secretNames) {
    actions.push({
      sequence: sequence++,
      kind: "secret",
      operation: "delete-secret-before-worker",
      target: target(
        `${manifest.cloudflare.accountId}:${manifest.cloudflare.worker.name}:${secretName}`,
      ),
    });
  }
  actions.push({
    sequence: sequence++,
    kind: "worker",
    operation: "force-delete-worker-and-associated-durable-objects",
    target: target(manifest.cloudflare.worker.name),
    forceRequired: true,
  });
  if (manifest.cloudflare.worker.workersDevEnabled) {
    actions.push({
      sequence: sequence++,
      kind: "workers-dev",
      operation: "verify-workers-dev-hostname-is-absent",
      target: target(manifest.cloudflare.worker.name),
    });
  }
  for (const cron of manifest.cloudflare.worker.cronTriggers) {
    actions.push({
      sequence: sequence++,
      kind: "scheduled-trigger",
      operation: "verify-trigger-removed-with-worker",
      target: target(`${manifest.cloudflare.worker.name}:${cron}`),
    });
  }
  actions.push({
    sequence: sequence++,
    kind: "durable-object",
    operation: "verify-namespace-removed-with-worker",
    target: target(manifest.cloudflare.durableObject.namespaceId),
  });
  for (const rateLimit of manifest.cloudflare.rateLimits) {
    actions.push({
      sequence: sequence++,
      kind: "rate-limit-binding",
      operation: "verify-binding-removed-with-worker",
      target: target(`${rateLimit.binding}:${rateLimit.namespaceId}`),
    });
  }
  if (manifest.cloudflare.secretNames.length > 0) {
    actions.push({
      sequence: sequence++,
      kind: "secret-inventory",
      operation: "verify-worker-secret-list-is-absent",
      target: target(
        `${manifest.cloudflare.accountId}:${manifest.cloudflare.worker.name}`,
      ),
    });
  }
  actions.push({
    sequence: sequence++,
    kind: "d1",
    operation: "delete-database",
    target: target(manifest.cloudflare.d1.name),
  });
  actions.push({
    sequence: sequence++,
    kind: "r2",
    operation: "delete-bucket",
    target: target(manifest.cloudflare.r2.bucket),
  });
  actions.push({
    sequence: sequence++,
    kind: "kv",
    operation: "delete-namespace",
    target: target(manifest.cloudflare.kv.id),
  });
  for (const domain of manifest.cloudflare.worker.customDomains) {
    actions.push({
      sequence: sequence++,
      kind: "dns",
      operation: "verify-custom-domain-dns-is-absent",
      target: target(domain.hostname),
    });
  }
  actions.push({
    sequence,
    kind: "inventory",
    operation: "verify-every-recorded-resource-is-absent",
    target: target(manifest.cellRef),
  });
  return {
    format: PLAN_FORMAT,
    sourceFormat: FORMAT,
    cellRef: target(manifest.cellRef),
    accountRef: target(manifest.cloudflare.accountId),
    releaseCommit: manifest.release.gitCommit,
    authorityPrecheckRequired: true,
    authorizedDisposition: {
      mode: disposition.mode,
      authorizedAt: disposition.authorizedAt,
      authorizationReceipt: target(disposition.authorizationReceiptSha256),
      predeleteEvidenceReceipt: target(
        disposition.predeleteEvidenceReceiptSha256,
      ),
    },
    targetsRedacted: !options.showTargets,
    actions,
  };
}
