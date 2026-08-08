import {
  apiErrorSchema,
  pairingExchangeResponseSchema,
  pairingGrantResponseSchema,
  serverCapabilitiesSchema,
  socketTicketResponseSchema,
  vaultListResponseSchema,
  type PairingExchangeResponse,
  type PairingGrantResponse,
} from "@owd/contracts";
import { env } from "cloudflare:workers";
import { createExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { ensureAgentAccessSchema } from "../src/agent-access-store";
import {
  commitFirstOwner,
  createSessionMaterial,
  ensureAuthSchema,
} from "../src/auth-store";
import { createPairingGrant, ensurePairingSchema } from "../src/pairing-store";
import { sha256Hex } from "../src/security";
import {
  applyPhase9aCollaborationMigration,
  applyPhase9bAgentFirstMigration,
  applyPreparedProjectHandoffsMigration,
} from "./migration-fixture";

const ORIGIN = "https://owd.test";

interface OwnerSession {
  cookie: string;
  csrf: string;
}

async function fetchWorker(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  return worker.fetch(new Request(input, init), env, createExecutionContext());
}

async function cleanPairingTables(): Promise<void> {
  await ensureAuthSchema(env.DB);
  await ensurePairingSchema(env.DB);
  await ensureAgentAccessSchema(env.DB);
  await applyPhase9aCollaborationMigration(env.DB);
  await applyPhase9bAgentFirstMigration(env.DB);
  await applyPreparedProjectHandoffsMigration(env.DB);
  await env.DB.exec(`
    DELETE FROM prepared_project_handoffs;
    DELETE FROM collaboration_grants;
    DELETE FROM agent_grants;
    DELETE FROM oauth_consent_flows;
    DELETE FROM vault_credentials;
    DELETE FROM pairing_grant_origins;
    DELETE FROM pairing_grants;
    DELETE FROM vaults;
    DELETE FROM sessions;
    DELETE FROM auth_challenges;
    DELETE FROM auth_rate_limits;
    DELETE FROM audit_events;
    DELETE FROM owners;
  `);
}

async function createOwnerSession(): Promise<OwnerSession> {
  const now = Math.floor(Date.now() / 1_000);
  const session = await createSessionMaterial(now);
  await commitFirstOwner(
    env.DB,
    {
      backedUp: true,
      counter: 0,
      credentialId: "pairing-test-passkey",
      deviceType: "multiDevice",
      publicKey: new Uint8Array([1, 2, 3]),
      transports: ["internal"],
      webauthnUserId: "pairing-test-owner",
    },
    session,
    crypto.randomUUID(),
    now,
  );

  return {
    cookie: `__Host-owd_session=${session.token}; __Host-owd_csrf=${session.csrfToken}`,
    csrf: session.csrfToken,
  };
}

function ownerMutationHeaders(
  session: OwnerSession,
  origin = ORIGIN,
): HeadersInit {
  return {
    Cookie: session.cookie,
    Origin: origin,
    "X-OWD-CSRF": session.csrf,
  };
}

async function createGrant(
  session: OwnerSession,
): Promise<PairingGrantResponse> {
  const response = await fetchWorker(`${ORIGIN}/api/pairing/grants`, {
    headers: ownerMutationHeaders(session),
    method: "POST",
  });
  expect(response.status).toBe(201);
  return pairingGrantResponseSchema.parse(await response.json());
}

function grantFromUrl(pairingUrl: string): string {
  const grant = new URL(pairingUrl).searchParams.get("grant");
  if (!grant) throw new Error("Pairing URL did not contain a grant.");
  return grant;
}

async function exchangeGrant(
  grant: PairingGrantResponse,
  vaultName = "Synthetic disposable vault",
  origin = ORIGIN,
  pluginVersion = "0.1.7",
): Promise<{
  response: Response;
  result: PairingExchangeResponse | null;
  body: unknown;
}> {
  const response = await fetchWorker(`${origin}/api/pairing/exchange`, {
    body: JSON.stringify({
      grant: grantFromUrl(grant.pairingUrl),
      pluginVersion,
      schemaVersion: 3,
      vaultName,
    }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  const body: unknown = await response.json();

  return {
    response,
    result: response.ok ? pairingExchangeResponseSchema.parse(body) : null,
    body,
  };
}

async function issueTicket(
  pairing: PairingExchangeResponse,
  vaultId = pairing.vaultId,
): Promise<Response> {
  return fetchWorker(`${ORIGIN}/vault/${vaultId}/auth/ticket`, {
    headers: { Authorization: `Bearer ${pairing.credential}` },
    method: "POST",
  });
}

beforeEach(async () => {
  await cleanPairingTables();
});

describe("vault pairing and authorization", () => {
  it("atomically caps managed trial vault grants at two", async () => {
    const now = Math.floor(Date.now() / 1_000);
    const attempts = await Promise.all(
      Array.from({ length: 3 }, () =>
        createPairingGrant(env.DB, {
          deploymentUrl: ORIGIN,
          maxVaults: 2,
          now,
          requestId: crypto.randomUUID(),
        }),
      ),
    );
    const vaultCount = await env.DB.prepare(
      `SELECT COUNT(*) AS count
       FROM vaults WHERE status IN ('active', 'pending')`,
    ).first<{ count: number }>();

    expect(attempts.filter((attempt) => attempt !== null)).toHaveLength(2);
    expect(vaultCount?.count).toBe(2);
  });

  it("publishes the YAOS-compatible server capability contract", async () => {
    const unclaimed = serverCapabilitiesSchema.parse(
      await (await fetchWorker(`${ORIGIN}/api/capabilities`)).json(),
    );
    expect(unclaimed).toMatchObject({
      claimed: false,
      authMode: "unclaimed",
      socketTicketAuth: true,
      serverVersion: "0.3.0",
      minSchemaVersion: 1,
      maxSchemaVersion: 3,
      minPluginVersion: "0.1.7",
      recommendedPluginVersion: "0.1.7",
    });

    await createOwnerSession();
    const claimed = serverCapabilitiesSchema.parse(
      await (await fetchWorker(`${ORIGIN}/api/capabilities`)).json(),
    );
    expect(claimed).toMatchObject({ claimed: true, authMode: "claim" });
  });

  it("requires an owner session, exact origin, and CSRF for grant creation", async () => {
    const session = await createOwnerSession();
    const anonymous = await fetchWorker(`${ORIGIN}/api/pairing/grants`, {
      method: "POST",
    });
    const crossOrigin = await fetchWorker(`${ORIGIN}/api/pairing/grants`, {
      headers: ownerMutationHeaders(session, "https://evil.test"),
      method: "POST",
    });
    const missingCsrf = await fetchWorker(`${ORIGIN}/api/pairing/grants`, {
      headers: { Cookie: session.cookie, Origin: ORIGIN },
      method: "POST",
    });

    expect(anonymous.status).toBe(401);
    expect(crossOrigin.status).toBe(403);
    expect(missingCsrf.status).toBe(403);
  });

  it("pairs once without exposing stored grants or credentials", async () => {
    const session = await createOwnerSession();
    const grant = await createGrant(session);
    const pairingUrl = new URL(grant.pairingUrl);
    const obsidianUrl = new URL(grant.obsidianUrl);
    const rawGrant = grantFromUrl(grant.pairingUrl);

    expect(pairingUrl.protocol).toBe("owd-pair:");
    expect(pairingUrl.host).toBe("connect");
    expect([...pairingUrl.searchParams.keys()].sort()).toEqual([
      "deployment",
      "grant",
    ]);
    expect(pairingUrl.searchParams.get("deployment")).toBe(ORIGIN);
    expect(obsidianUrl.protocol).toBe("obsidian:");
    expect(obsidianUrl.host).toBe("owd-pair");
    expect(obsidianUrl.searchParams.get("deployment")).toBe(ORIGIN);
    expect(obsidianUrl.searchParams.get("grant")).toBe(rawGrant);

    const storedGrant = await env.DB.prepare(
      "SELECT grant_hash FROM pairing_grants WHERE vault_id = ?",
    )
      .bind(grant.vaultId)
      .first<{ grant_hash: string }>();
    expect(storedGrant?.grant_hash).toBe(await sha256Hex(rawGrant));
    expect(storedGrant?.grant_hash).not.toBe(rawGrant);

    const exchange = await exchangeGrant(grant);
    expect(exchange.response.status).toBe(200);
    if (!exchange.result) throw new Error("Pairing exchange failed.");

    const credentialRow = await env.DB.prepare(
      `SELECT token_hash FROM vault_credentials WHERE vault_id = ?`,
    )
      .bind(grant.vaultId)
      .first<{ token_hash: string }>();
    expect(credentialRow?.token_hash).toBe(
      await sha256Hex(exchange.result.credential),
    );
    expect(credentialRow?.token_hash).not.toBe(exchange.result.credential);

    const replay = await exchangeGrant(grant);
    expect(replay.response.status).toBe(400);
    expect(apiErrorSchema.parse(replay.body).error.code).toBe(
      "pairing_grant_invalid",
    );

    const credentialCount = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM vault_credentials WHERE vault_id = ?",
    )
      .bind(grant.vaultId)
      .first<{ count: number }>();
    expect(credentialCount?.count).toBe(1);

    const vaults = vaultListResponseSchema.parse(
      await (
        await fetchWorker(`${ORIGIN}/api/vaults`, {
          headers: { Cookie: session.cookie },
        })
      ).json(),
    );
    expect(vaults.vaults).toContainEqual(
      expect.objectContaining({
        id: grant.vaultId,
        displayName: "Synthetic disposable vault",
        status: "active",
      }),
    );
  });

  it("allows only one winner when the same grant is exchanged concurrently", async () => {
    const session = await createOwnerSession();
    const grant = await createGrant(session);
    const [first, second] = await Promise.all([
      exchangeGrant(grant, "First contender"),
      exchangeGrant(grant, "Second contender"),
    ]);
    const statuses = [first.response.status, second.response.status].sort();
    const credentialCount = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM vault_credentials WHERE vault_id = ?",
    )
      .bind(grant.vaultId)
      .first<{ count: number }>();

    expect(statuses).toEqual([200, 400]);
    expect(credentialCount?.count).toBe(1);
  });

  it("rejects an expired grant", async () => {
    const session = await createOwnerSession();
    const grant = await createGrant(session);
    await env.DB.prepare(
      `UPDATE pairing_grants
       SET created_at = ?, expires_at = ?
       WHERE grant_hash = ?`,
    )
      .bind(0, 1, await sha256Hex(grantFromUrl(grant.pairingUrl)))
      .run();

    const exchange = await exchangeGrant(grant);
    const error = apiErrorSchema.parse(exchange.body);

    expect(exchange.response.status).toBe(400);
    expect(error.error.code).toBe("pairing_grant_invalid");
  });

  it("requires the bounded-retry plugin without consuming the pairing grant", async () => {
    const session = await createOwnerSession();
    const grant = await createGrant(session);
    const outdated = await exchangeGrant(
      grant,
      "Outdated plugin vault",
      ORIGIN,
      "0.1.6",
    );
    const current = await exchangeGrant(grant);

    expect(outdated.response.status).toBe(409);
    expect(apiErrorSchema.parse(outdated.body).error.code).toBe(
      "plugin_update_required",
    );
    expect(current.response.status).toBe(200);
  });

  it("binds a grant to its exact deployment origin without consuming it on mismatch", async () => {
    const session = await createOwnerSession();
    const grant = await createGrant(session);

    const mismatched = await exchangeGrant(
      grant,
      "Origin-bound vault",
      "https://alias.owd.test",
    );
    const matched = await exchangeGrant(grant, "Origin-bound vault");

    expect(mismatched.response.status).toBe(400);
    expect(apiErrorSchema.parse(mismatched.body).error.code).toBe(
      "pairing_grant_invalid",
    );
    expect(matched.response.status).toBe(200);
  });

  it("binds credentials and WebSocket tickets to exactly one vault", async () => {
    const session = await createOwnerSession();
    const first = await exchangeGrant(await createGrant(session), "Vault one");
    const second = await exchangeGrant(await createGrant(session), "Vault two");
    if (!first.result || !second.result) throw new Error("Pairing failed.");

    const crossVaultCredential = await issueTicket(
      first.result,
      second.result.vaultId,
    );
    expect(crossVaultCredential.status).toBe(401);

    const ticketResponse = await issueTicket(first.result);
    const ticket = socketTicketResponseSchema.parse(
      await ticketResponse.json(),
    );
    const crossVaultTicket = await fetchWorker(
      `${ORIGIN}/vault/sync/${second.result.vaultId}?ticket=${encodeURIComponent(ticket.ticket)}&schemaVersion=3`,
      { headers: { Upgrade: "websocket" } },
    );
    const directCredentialQuery = await fetchWorker(
      `${ORIGIN}/vault/sync/${first.result.vaultId}?token=${encodeURIComponent(first.result.credential)}&schemaVersion=3`,
      { headers: { Upgrade: "websocket" } },
    );

    expect(crossVaultTicket.status).toBe(401);
    expect(directCredentialQuery.status).toBe(401);
  });

  it("routes a valid ticket to the vault object and records the connection", async () => {
    const session = await createOwnerSession();
    const exchange = await exchangeGrant(await createGrant(session));
    if (!exchange.result) throw new Error("Pairing failed.");
    const ticket = socketTicketResponseSchema.parse(
      await (await issueTicket(exchange.result)).json(),
    );

    const response = await fetchWorker(
      `${ORIGIN}/vault/sync/${exchange.result.vaultId}?ticket=${encodeURIComponent(ticket.ticket)}&schemaVersion=3`,
      { headers: { Upgrade: "websocket" } },
    );
    expect(response.status).toBe(101);
    expect(response.webSocket).not.toBeNull();
    response.webSocket?.accept();
    response.webSocket?.close(1000, "test complete");

    const vaults = vaultListResponseSchema.parse(
      await (
        await fetchWorker(`${ORIGIN}/api/vaults`, {
          headers: { Cookie: session.cookie },
        })
      ).json(),
    );
    expect(vaults.vaults[0]?.lastConnectedAt).not.toBeNull();
  });

  it("revokes future tickets, pre-issued tickets, and an active socket", async () => {
    const session = await createOwnerSession();
    const exchange = await exchangeGrant(await createGrant(session));
    if (!exchange.result) throw new Error("Pairing failed.");
    const agentGrantId = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO agent_grants (
        id, owner_id, oauth_client_id, client_name, client_origin,
        redirect_uri, audience, vault_id, scopes_json, path_prefixes_json,
        path_key_prefixes_json, status, created_at, activated_at
      ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, '[]', '[]', 'active', ?, ?)`,
    )
      .bind(
        agentGrantId,
        "vault-revocation-client",
        "Vault revocation client",
        "https://agent.example",
        "https://agent.example/callback",
        `${ORIGIN}/mcp`,
        exchange.result.vaultId,
        JSON.stringify(["vault.read", "project.initialize.request"]),
        1,
        1,
      )
      .run();
    const ticket = socketTicketResponseSchema.parse(
      await (await issueTicket(exchange.result)).json(),
    );
    const socketResponse = await fetchWorker(
      `${ORIGIN}/vault/sync/${exchange.result.vaultId}?ticket=${encodeURIComponent(ticket.ticket)}&schemaVersion=3`,
      { headers: { Upgrade: "websocket" } },
    );
    const socket = socketResponse.webSocket;
    if (!socket) throw new Error("Missing paired WebSocket.");
    const closed = new Promise<CloseEvent>((resolve) => {
      socket.addEventListener("close", resolve, { once: true });
    });
    socket.accept();

    const revokeResponse = await fetchWorker(
      `${ORIGIN}/api/vaults/${exchange.result.vaultId}/revoke`,
      {
        headers: ownerMutationHeaders(session),
        method: "POST",
      },
    );
    expect(revokeResponse.status).toBe(204);
    await expect(closed).resolves.toMatchObject({
      code: 1008,
      reason: "Vault credential revoked",
    });

    const credentialDenied = await issueTicket(exchange.result);
    const oldTicketDenied = await fetchWorker(
      `${ORIGIN}/vault/sync/${exchange.result.vaultId}?ticket=${encodeURIComponent(ticket.ticket)}&schemaVersion=3`,
      { headers: { Upgrade: "websocket" } },
    );
    expect(credentialDenied.status).toBe(401);
    expect(oldTicketDenied.status).toBe(401);
    const revokedAgent = await env.DB.prepare(
      "SELECT status, revoked_at FROM agent_grants WHERE id = ?",
    )
      .bind(agentGrantId)
      .first<{ revoked_at: number | null; status: string }>();
    expect(revokedAgent?.status).toBe("revoked");
    expect(revokedAgent?.revoked_at).not.toBeNull();
  });

  it("keeps grants and credentials out of logs and error responses", async () => {
    const session = await createOwnerSession();
    const grant = await createGrant(session);
    const exchange = await exchangeGrant(grant);
    if (!exchange.result) throw new Error("Pairing failed.");
    const rawGrant = grantFromUrl(grant.pairingUrl);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      const denied = await fetchWorker(
        `${ORIGIN}/vault/${crypto.randomUUID()}/auth/ticket`,
        {
          headers: { Authorization: `Bearer ${exchange.result.credential}` },
          method: "POST",
        },
      );
      const responseText = await denied.text();
      const logs = [...errorSpy.mock.calls, ...logSpy.mock.calls]
        .flat()
        .join(" ");

      expect(responseText).not.toContain(exchange.result.credential);
      expect(responseText).not.toContain(rawGrant);
      expect(logs).not.toContain(exchange.result.credential);
      expect(logs).not.toContain(rawGrant);
    } finally {
      errorSpy.mockRestore();
      logSpy.mockRestore();
    }
  });
});
