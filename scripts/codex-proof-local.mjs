import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, rm, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { TOOLS } from "./codex-continuity-proof-lib.mjs";

// Set before Wrangler loads: test request diagnostics must not escape the
// disposable lifecycle into the user's persistent Wrangler log directory.
process.env.WRANGLER_WRITE_LOGS = "false";
process.env.WRANGLER_SEND_METRICS = "false";
const { createTestHarness, unstable_splitSqlQuery } = await import("wrangler");

const ORIGIN = "https://codex-proof.test";
const REDIRECT = "https://codex-proof-client.test/callback";
const hash = (value) => createHash("sha256").update(value).digest("hex");

// Test-process-only bootstrap. No fixture route, auth switch, or test key is
// added to the product Worker. Every binding is a fresh local simulation.
export async function startLocalProof(progress = () => {}) {
  const root = await mkdtemp(join(tmpdir(), "mdevolved-proof-server-"));
  const repo = resolve(import.meta.dirname, "..");
  const harness = createTestHarness({
    root,
    workers: [
      {
        config: {
          name: "mdevolved-codex-proof",
          main: resolve(repo, "apps/worker/src/index.ts"),
          compatibility_date: "2026-07-26",
          compatibility_flags: [
            "nodejs_compat",
            "global_fetch_strictly_public",
          ],
          vars: {
            APP_ENVIRONMENT: "test",
            APP_DEPLOYMENT_MODE: "community",
            APP_VERSION: "proof",
            EXPECTED_HOSTNAME: "",
          },
          d1_databases: [
            {
              binding: "DB",
              database_name: "proof",
              database_id: "local-proof",
              migrations_dir: resolve(repo, "migrations"),
            },
          ],
          r2_buckets: [{ binding: "VAULT_STORAGE", bucket_name: "proof" }],
          kv_namespaces: [{ binding: "OAUTH_KV", id: "local-proof" }],
          durable_objects: {
            bindings: [{ name: "VAULTS", class_name: "VaultCoordinator" }],
          },
          migrations: [{ tag: "v1", new_sqlite_classes: ["VaultCoordinator"] }],
          ratelimits: [
            "OAUTH_REGISTRATION_ROUTE_LIMITER",
            "OAUTH_REGISTRATION_CLIENT_LIMITER",
            "OAUTH_TOKEN_CLIENT_LIMITER",
            "SOCKET_TICKET_IP_LIMITER",
            "SOCKET_TICKET_VAULT_LIMITER",
          ].map((name, i) => ({
            name,
            namespace_id: String(1001 + i),
            simple: { limit: 100, period: 60 },
          })),
        },
      },
    ],
  });
  let server;
  const close = async () => {
    if (server) {
      server.closeAllConnections();
      await new Promise((done) => server.close(done));
    }
    await harness.close();
    await rm(root, { recursive: true, force: true });
  };
  try {
    progress("starting-local-worker");
    await harness.listen();
    // listen() exposes the proxy before its first runtime reload settles.
    // Dispatch once before obtaining binding handles to avoid stale handles.
    await harness.fetch(`${ORIGIN}/healthz`);
    progress("applying-local-migrations");
    const worker = harness.getWorker();
    const { DB } = await worker.getEnv();
    progress("local-bindings-ready");
    for (const file of (await readdir(resolve(repo, "migrations")))
      .filter((name) => name.endsWith(".sql"))
      .sort()) {
      await DB.batch(
        unstable_splitSqlQuery(
          await readFile(resolve(repo, "migrations", file), "utf8"),
        ).map((sql) => DB.prepare(sql)),
      );
    }
    progress("seeding-synthetic-owner");
    const now = Math.floor(Date.now() / 1000);
    const session = randomBytes(32).toString("base64url");
    const csrf = randomBytes(32).toString("base64url");
    const vaultId = randomUUID();
    const generationId = randomUUID();
    await DB.batch([
      DB.prepare(
        "INSERT INTO owners (id,webauthn_user_id,credential_id,public_key,counter,transports,device_type,backed_up,created_at) VALUES (1,?,?,?,0,'[]','multiDevice',1,?)",
      ).bind(randomUUID(), randomUUID(), "synthetic-unused-key", now),
      DB.prepare(
        "INSERT INTO sessions (token_hash,owner_id,csrf_hash,created_at,expires_at) VALUES (?,1,?,?,?)",
      ).bind(hash(session), hash(csrf), now, now + 900),
      DB.prepare(
        "INSERT INTO vaults (id,display_name,status,created_at,paired_at) VALUES (?,'Codex continuity proof','active',?,?)",
      ).bind(vaultId, now, now),
      DB.prepare(
        "INSERT INTO vault_sync_states (vault_id,plugin_version,schema_version,connection_confirmed_at,initial_sync_at,last_sync_at,current_state_vector_sha256,library_stale,updated_at) VALUES (?,'synthetic',3,?,?,?,?,0,?)",
      ).bind(vaultId, now, now, now, "b".repeat(64), now),
      DB.prepare(
        "INSERT INTO materialization_generations (id,vault_id,source_state_vector_sha256,status,note_count,total_bytes,manifest_key,created_at,completed_at) VALUES (?,?,?,'published',0,0,'synthetic-empty',?,?)",
      ).bind(generationId, vaultId, "b".repeat(64), now, now),
      DB.prepare(
        "INSERT INTO current_materializations (vault_id,generation_id,updated_at) VALUES (?,?,?)",
      ).bind(vaultId, generationId, now),
    ]);
    const ownerHeaders = {
      Cookie: `__Host-mdevolved_session=${session}; __Host-mdevolved_csrf=${csrf}`,
      Origin: ORIGIN,
      "X-MDevolved-CSRF": csrf,
    };
    async function json(path, body, headers = {}) {
      const response = await worker.fetch(`${ORIGIN}${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: { "Content-Type": "application/json", ...headers },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (!response.ok)
        throw new Error(
          `local_setup_http_${response.status}_${path.split("?")[0]}`,
        );
      return response.json();
    }
    const project = await json(
      "/api/collaboration/projects",
      {
        knowledgeSpace: {
          label: "Synthetic only",
          members: [
            {
              vaultId,
              exclusions: [],
              pathPrefixes: [{ path: "", pathKey: "" }],
            },
          ],
        },
        packetExpiresInSeconds: 900,
        project: {
          label: "Codex continuity proof",
          objective: "Remember and continue a synthetic routing task.",
        },
        requestedRole: "contributor",
        sourceNotes: [],
        workItem: {
          constraints: ["Synthetic data only."],
          definitionOfDone: ["Save and resume a verified checkpoint."],
          objective: "Test continuity.",
          requestedOutput: "A classification.",
        },
      },
      ownerHeaders,
    );
    const client = await json("/register", {
      client_name: "Codex synthetic proof",
      grant_types: ["authorization_code", "refresh_token"],
      redirect_uris: [REDIRECT],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    });
    const verifier = randomBytes(32).toString("base64url");
    const contextQuery = new URLSearchParams({
      response_type: "code",
      client_id: client.client_id,
      redirect_uri: REDIRECT,
      scope: "vault.read project.connect.request",
      state: randomUUID(),
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
      resource: `${ORIGIN}/mcp`,
    });
    const consent = await json(
      `/api/agent/oauth/context?${contextQuery}`,
      undefined,
      ownerHeaders,
    );
    const approved = await json(
      "/api/agent/oauth/approve",
      {
        authorizationKind: "vault",
        approvedRestoreIds: [],
        flowToken: consent.flowToken,
        pathPrefixes: [""],
        vaultId,
      },
      ownerHeaders,
    );
    const tokenResponse = await worker.fetch(`${ORIGIN}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: client.client_id,
        code: new URL(approved.redirectTo).searchParams.get("code"),
        code_verifier: verifier,
        grant_type: "authorization_code",
        redirect_uri: REDIRECT,
        resource: `${ORIGIN}/mcp`,
      }).toString(),
    });
    const token = await tokenResponse.json();
    if (!tokenResponse.ok || typeof token.access_token !== "string")
      throw new Error("local_token_failed");
    const auth = {
      Authorization: `Bearer ${token.access_token}`,
      Accept: "application/json, text/event-stream",
    };
    let id = 0;
    const rpc = async (name, args, headers = auth) =>
      json(
        "/mcp",
        {
          jsonrpc: "2.0",
          id: ++id,
          method: "tools/call",
          params: { name, arguments: args },
        },
        headers,
      );
    const opened = await rpc("open_project", {
      projectId: project.projectId,
      documentationPlan: {
        decision: "no-root-markdown",
        proposedMoves: [],
        retainedRootPaths: [],
        rootMarkdownPaths: [],
      },
    });
    const accessRequestId =
      opened.result?.structuredContent?.access?.accessRequestId;
    if (!accessRequestId) throw new Error("local_project_access_failed");
    const projectConsent = await json(
      `/api/project-initializations/context?requestId=${accessRequestId}`,
      undefined,
      ownerHeaders,
    );
    await json(
      "/api/project-initializations/approve",
      {
        contextPolicy: projectConsent.contextPolicy,
        initializationToken: projectConsent.initializationToken,
      },
      ownerHeaders,
    );
    let requests = 0;
    const transport = { accepted: 0, rejected: 0 };
    const observedCalls = [];
    server = createServer(async (req, res) => {
      try {
        if (
          req.url !== "/mcp" ||
          req.headers.origin ||
          !timingSafeEqual(
            Buffer.from(hash(req.headers.authorization ?? "")),
            Buffer.from(hash(auth.Authorization)),
          ) ||
          ++requests > 100
        ) {
          transport.rejected++;
          res.writeHead(403).end();
          return;
        }
        transport.accepted++;
        let body = "";
        for await (const chunk of req) {
          body += chunk;
          if (Buffer.byteLength(body) > 65536) {
            res.writeHead(413).end();
            return;
          }
        }
        const message = body ? JSON.parse(body) : null;
        if (message) {
          if (
            ![
              "initialize",
              "notifications/initialized",
              "tools/list",
              "tools/call",
              "ping",
            ].includes(message.method) ||
            (message.method === "tools/call" &&
              (!TOOLS.includes(message.params?.name) ||
                message.params?.arguments?.projectId !== project.projectId))
          ) {
            res.writeHead(403).end();
            return;
          }
        }
        const headers = new Headers();
        for (const name of [
          "authorization",
          "content-type",
          "accept",
          "mcp-protocol-version",
          "mcp-session-id",
          "mcp-method",
          "mcp-name",
        ])
          if (typeof req.headers[name] === "string")
            headers.set(name, req.headers[name]);
        const response = await worker.fetch(`${ORIGIN}/mcp`, {
          method: req.method,
          headers,
          ...(body ? { body } : {}),
        });
        if (message?.method === "tools/call") {
          if (observedCalls.length >= 24)
            throw new Error("tool_budget_exceeded");
          // Keep bounded protocol evidence in memory, never transcripts or tokens.
          const reader = response.clone().body?.getReader();
          let bytes = 0;
          const chunks = [];
          if (reader) {
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              bytes += value.length;
              if (bytes > 524288) {
                await reader.cancel();
                throw new Error("evidence_too_large");
              }
              chunks.push(Buffer.from(value));
            }
          }
          const text = Buffer.concat(chunks).toString("utf8");
          const envelopes = response.headers
            .get("content-type")
            ?.includes("text/event-stream")
            ? text
                .split(/\r?\n/u)
                .filter((line) => line.startsWith("data: "))
                .map((line) => JSON.parse(line.slice(6)))
            : [JSON.parse(text)];
          const result = envelopes.find(
            (item) => item.id === message.id,
          )?.result;
          observedCalls.push({
            tool: message.params.name,
            arguments: message.params.arguments,
            data:
              response.ok && result?.isError !== true
                ? (result?.structuredContent ?? null)
                : null,
          });
        }
        res.writeHead(response.status, Object.fromEntries(response.headers));
        if (response.body)
          for await (const chunk of response.body) res.write(chunk);
        res.end();
      } catch {
        res.writeHead(500).end();
      }
    });
    await new Promise((done, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", done);
    });
    return {
      url: `http://127.0.0.1:${server.address().port}/mcp`,
      projectId: project.projectId,
      bearerToken: token.access_token,
      rpc,
      transport,
      takeCalls: () => observedCalls.splice(0),
      revoke: async () => {
        await DB.prepare(
          "UPDATE agent_grants SET status = 'revoked', revoked_at = ? WHERE oauth_client_id = ?",
        )
          .bind(Math.floor(Date.now() / 1000), client.client_id)
          .run();
      },
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
