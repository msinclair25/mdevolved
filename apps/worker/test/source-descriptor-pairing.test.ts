import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import {
  createPairingGrant,
  ensurePairingSchema,
  exchangePairingGrant,
} from "../src/pairing-store";
import { sha256Hex } from "../src/security";
import { ensureAuthSchema } from "../src/auth-store";
import type { SourceDescriptorInput } from "@owd/contracts";

const ORIGIN = "https://owd.test";
const DESCRIPTOR = {
  sourceKind: "folder",
  label: "Folder workspace",
  capabilities: ["markdown", "watch"],
  clientVersion: "0.1.0",
  syncSchemaVersion: 1,
} satisfies SourceDescriptorInput;

function grantToken(pairingUrl: string): string {
  const token = new URL(pairingUrl).searchParams.get("grant");
  if (token === null) throw new Error("missing pairing grant");
  return token;
}

async function clean(): Promise<void> {
  await ensureAuthSchema(env.DB);
  await ensurePairingSchema(env.DB);
  await env.DB.exec(`
    DELETE FROM vault_credentials;
    DELETE FROM pairing_grant_origins;
    DELETE FROM pairing_grants;
    DELETE FROM vaults;
  `);
}

beforeEach(clean);

describe("source descriptor pairing", () => {
  it("records an upgraded descriptor transactionally while preserving old requests", async () => {
    const grant = await createPairingGrant(env.DB, {
      deploymentUrl: ORIGIN,
      now: 100,
      requestId: crypto.randomUUID(),
    });
    if (grant === null) throw new Error("grant creation failed");
    const pairing = await exchangePairingGrant(env.DB, {
      grant: grantToken(grant.pairingUrl),
      vaultName: "Folder workspace",
      pluginVersion: "0.1.7",
      schemaVersion: 3,
      sourceDescriptor: DESCRIPTOR,
      deploymentUrl: ORIGIN,
      now: 101,
      requestId: crypto.randomUUID(),
    });
    expect(pairing?.vaultId).toBe(grant.vaultId);
    const row = await env.DB.prepare(
      "SELECT source_descriptor_json FROM vaults WHERE id = ?",
    )
      .bind(grant.vaultId)
      .first<{ source_descriptor_json: string | null }>();
    const stored = JSON.parse(row?.source_descriptor_json ?? "null") as {
      sourceKind: string;
      provenance: { descriptorSha256: string };
    };
    expect(stored.sourceKind).toBe("folder");
    expect(stored.provenance.descriptorSha256).toMatch(/^[0-9a-f]{64}$/u);

    const legacyGrant = await createPairingGrant(env.DB, {
      deploymentUrl: ORIGIN,
      now: 102,
      requestId: crypto.randomUUID(),
    });
    if (legacyGrant === null) throw new Error("legacy grant creation failed");
    const legacyPairing = await exchangePairingGrant(env.DB, {
      grant: grantToken(legacyGrant.pairingUrl),
      vaultName: "Legacy vault",
      pluginVersion: "0.1.7",
      schemaVersion: 3,
      deploymentUrl: ORIGIN,
      now: 103,
      requestId: crypto.randomUUID(),
    });
    expect(legacyPairing?.vaultId).toBe(legacyGrant.vaultId);
    const legacyRow = await env.DB.prepare(
      "SELECT source_descriptor_json FROM vaults WHERE id = ?",
    )
      .bind(legacyGrant.vaultId)
      .first<{ source_descriptor_json: string | null }>();
    expect(legacyRow?.source_descriptor_json).toBeNull();
  });

  it("fails closed on a conflicting descriptor without consuming the reconnect grant", async () => {
    const grant = await createPairingGrant(env.DB, {
      deploymentUrl: ORIGIN,
      now: 200,
      requestId: crypto.randomUUID(),
    });
    if (grant === null) throw new Error("grant creation failed");
    const first = await exchangePairingGrant(env.DB, {
      grant: grantToken(grant.pairingUrl),
      vaultName: "Folder workspace",
      pluginVersion: "0.1.7",
      schemaVersion: 3,
      sourceDescriptor: DESCRIPTOR,
      deploymentUrl: ORIGIN,
      now: 201,
      requestId: crypto.randomUUID(),
    });
    expect(first?.vaultId).toBe(grant.vaultId);

    const reconnect = await createPairingGrant(env.DB, {
      deploymentUrl: ORIGIN,
      now: 202,
      requestId: crypto.randomUUID(),
      vaultId: grant.vaultId,
    });
    if (reconnect === null) throw new Error("reconnect grant failed");
    const conflict = await exchangePairingGrant(env.DB, {
      grant: grantToken(reconnect.pairingUrl),
      vaultName: "Obsidian workspace",
      pluginVersion: "0.1.7",
      schemaVersion: 3,
      sourceDescriptor: {
        ...DESCRIPTOR,
        sourceKind: "obsidian",
      },
      deploymentUrl: ORIGIN,
      now: 203,
      requestId: crypto.randomUUID(),
    });
    expect(conflict).toBeNull();
    const used = await env.DB.prepare(
      "SELECT used_at FROM pairing_grants WHERE grant_hash = ?",
    )
      .bind(await sha256Hex(grantToken(reconnect.pairingUrl)))
      .first<{ used_at: number | null }>();
    expect(used?.used_at).toBeNull();
  });
});
