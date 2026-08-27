import {
  decodeFileMeta,
  encodeSyncUpdateFrame,
  isStateVectorGe,
  parseSvEchoMessage,
} from "@mdevolved/yaos-core";
import {
  SELF,
  env,
  evictDurableObject,
  listDurableObjectIds,
  runInDurableObject,
} from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import fixtureFile from "../../../packages/yaos-core/fixtures/schema-compatibility.json";
import { ensurePairingSchema } from "../src/pairing-store";

interface SchemaFixture {
  schemaVersion: number;
  path: string;
  fileId: string;
  content: string;
  updateBase64: string;
}

interface SchemaRejection {
  type: "error";
  code: "update_required";
  reason: string;
  clientSchemaVersion: number | null;
  roomSchemaVersion: number | null;
  supportedSchemaVersions: {
    min: number;
    max: number;
  };
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

async function registerVault(vaultId: string): Promise<void> {
  const now = Math.floor(Date.now() / 1_000);
  await env.DB.prepare(
    `INSERT INTO vaults (
      id, display_name, status, created_at, paired_at
    ) VALUES (?, ?, 'active', ?, ?)`,
  )
    .bind(vaultId, vaultId, now, now)
    .run();
}

function assertFixtureState(update: ArrayBuffer, fixture: SchemaFixture): void {
  const document = new Y.Doc();
  Y.applyUpdate(document, new Uint8Array(update));

  expect(document.getMap("sys").get("schemaVersion")).toBe(
    fixture.schemaVersion,
  );
  expect(document.getMap("pathToId").get(fixture.path)).toBe(fixture.fileId);

  const text = document.getMap<Y.Text>("idToText").get(fixture.fileId);
  expect(text?.toString()).toBe(fixture.content);

  const metadata = decodeFileMeta(document.getMap("meta").get(fixture.fileId));
  expect(metadata?.path).toBe(fixture.path);
  expect(metadata?.shape).toBe(fixture.schemaVersion === 3 ? "nested" : "flat");
  document.destroy();
}

function waitForDurableReceipt(
  socket: WebSocket,
  candidate: Uint8Array,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("Timed out waiting for a durable YAOS receipt."));
    }, 5_000);

    socket.addEventListener("message", (event) => {
      if (typeof event.data !== "string" || !event.data.startsWith("__YPS:")) {
        return;
      }

      const stateVector = parseSvEchoMessage(event.data.slice("__YPS:".length));
      if (stateVector === null || !isStateVectorGe(stateVector, candidate)) {
        return;
      }

      clearTimeout(timeout);
      resolve();
    });
  });
}

function waitForPersistenceFailure(
  socket: WebSocket,
  candidate: Uint8Array,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("Timed out waiting for the failed socket to close."));
    }, 5_000);

    socket.addEventListener("message", (event) => {
      if (typeof event.data !== "string" || !event.data.startsWith("__YPS:")) {
        return;
      }
      const stateVector = parseSvEchoMessage(event.data.slice("__YPS:".length));
      if (stateVector !== null && isStateVectorGe(stateVector, candidate)) {
        clearTimeout(timeout);
        reject(new Error("A failed persistence attempt emitted a receipt."));
      }
    });

    socket.addEventListener("close", (event) => {
      clearTimeout(timeout);
      try {
        expect(event.code).toBe(1011);
        expect(event.reason).toBe("Vault persistence unavailable");
        resolve();
      } catch (error) {
        reject(error);
      }
    });
  });
}

function waitForSchemaRejection(socket: WebSocket): Promise<SchemaRejection> {
  return new Promise((resolve, reject) => {
    let rejection: SchemaRejection | null = null;
    const timeout = setTimeout(() => {
      reject(new Error("Timed out waiting for a schema rejection."));
    }, 5_000);

    socket.addEventListener("message", (event) => {
      if (typeof event.data !== "string") return;

      const raw = event.data.startsWith("__YPS:")
        ? event.data.slice("__YPS:".length)
        : event.data;
      try {
        const candidate = JSON.parse(raw) as Partial<SchemaRejection>;
        if (candidate.code === "update_required") {
          rejection = candidate as SchemaRejection;
        }
      } catch {
        // Ignore non-JSON y-partyserver protocol messages.
      }
    });

    socket.addEventListener("close", (event) => {
      clearTimeout(timeout);
      try {
        expect(event.code).toBe(1008);
        expect(event.reason).toBe("Update required");
        if (rejection === null) {
          throw new Error("Schema rejection closed without an error payload.");
        }
        resolve(rejection);
      } catch (error) {
        reject(error);
      }
    });
  });
}

describe("pinned YAOS synchronization", () => {
  beforeEach(async () => {
    await ensurePairingSchema(env.DB);
  });

  it("keeps the public sync route closed without a vault ticket", async () => {
    const response = await SELF.fetch(
      "https://example.com/vault/sync/not-paired",
      {
        headers: { Upgrade: "websocket" },
      },
    );
    const body = await response.json<{ error: { code: string } }>();

    expect(response.status).toBe(401);
    expect(body.error.code).toBe("vault_ticket_denied");
    expect(await listDurableObjectIds(env.VAULTS)).toHaveLength(0);
  });

  for (const fixture of fixtureFile.fixtures satisfies SchemaFixture[]) {
    it(`loads schema v${fixture.schemaVersion} after an acknowledged update and eviction`, async () => {
      const update = decodeBase64(fixture.updateBase64);
      const candidateDocument = new Y.Doc();
      Y.applyUpdate(candidateDocument, update);
      const candidateStateVector = Y.encodeStateVector(candidateDocument);
      await registerVault(`fixture-schema-${fixture.schemaVersion}`);
      const vault = env.VAULTS.getByName(
        `fixture-schema-${fixture.schemaVersion}`,
      );

      const receipt = await vault.applyUpdate(toArrayBuffer(update));
      expect(receipt.durable).toBe(true);
      expect(
        isStateVectorGe(
          new Uint8Array(receipt.stateVector),
          candidateStateVector,
        ),
      ).toBe(true);

      await evictDurableObject(vault);

      const reloaded = await vault.exportState();
      assertFixtureState(reloaded, fixture);
      expect(
        await vault.includesStateVector(toArrayBuffer(candidateStateVector)),
      ).toBe(true);
      candidateDocument.destroy();
    });
  }

  it("connects a synthetic YAOS client and persists before its receipt", async () => {
    const vaultName = "synthetic-socket-vault";
    await registerVault(vaultName);
    const vault = env.VAULTS.getByName(vaultName);
    const clientDocument = new Y.Doc();
    clientDocument.getMap("sys").set("schemaVersion", 3);
    clientDocument.getText("synthetic-note").insert(0, "durable socket update");
    const update = Y.encodeStateAsUpdate(clientDocument);
    const candidate = Y.encodeStateVector(clientDocument);

    const response = await vault.fetch(
      "https://internal.example/vault/sync/synthetic-socket-vault?schemaVersion=3",
      {
        headers: {
          Upgrade: "websocket",
          "x-partykit-room": vaultName,
        },
      },
    );
    const socket = response.webSocket;

    expect(response.status).toBe(101);
    expect(socket).not.toBeNull();
    if (socket === null) throw new Error("Missing synthetic client socket.");

    const receipt = waitForDurableReceipt(socket, candidate);
    socket.accept();
    socket.send(encodeSyncUpdateFrame(update));
    await receipt;

    expect(await vault.includesStateVector(toArrayBuffer(candidate))).toBe(
      true,
    );

    socket.close(1000, "test complete");
    await evictDurableObject(vault, { webSockets: "close" });
    expect(await vault.includesStateVector(toArrayBuffer(candidate))).toBe(
      true,
    );

    const reloaded = new Y.Doc();
    Y.applyUpdate(reloaded, new Uint8Array(await vault.exportState()));
    expect(reloaded.getText("synthetic-note").toString()).toBe(
      "durable socket update",
    );
    reloaded.destroy();
    clientDocument.destroy();
  });

  it("closes without a receipt when persistence fails", async () => {
    const vaultName = "synthetic-persistence-failure";
    await registerVault(vaultName);
    const vault = env.VAULTS.getByName(vaultName);
    const clientDocument = new Y.Doc();
    clientDocument.getMap("sys").set("schemaVersion", 3);
    clientDocument.getText("unacknowledged-note").insert(0, "must not ack");
    const update = Y.encodeStateAsUpdate(clientDocument);
    const candidate = Y.encodeStateVector(clientDocument);

    const response = await vault.fetch(
      "https://internal.example/vault/sync/synthetic-persistence-failure?schemaVersion=3",
      {
        headers: {
          Upgrade: "websocket",
          "x-partykit-room": vaultName,
        },
      },
    );
    const socket = response.webSocket;
    if (socket === null) throw new Error("Missing synthetic client socket.");

    socket.accept();
    await runInDurableObject(vault, async (_instance, state) => {
      await state.storage.put("document:journal:meta", { invalid: true });
    });

    const failed = waitForPersistenceFailure(socket, candidate);
    socket.send(encodeSyncUpdateFrame(update));
    await failed;

    await runInDurableObject(vault, async (_instance, state) => {
      await state.storage.delete("document:journal:meta");
    });
    await evictDurableObject(vault, { webSockets: "close" });

    clientDocument.destroy();
  });

  it("explicitly rejects a client schema newer than the server supports", async () => {
    const vaultName = "unsupported-client-schema";
    const vault = env.VAULTS.getByName(vaultName);
    const response = await vault.fetch(
      `https://internal.example/vault/sync/${vaultName}?schemaVersion=4`,
      {
        headers: {
          Upgrade: "websocket",
          "x-partykit-room": vaultName,
        },
      },
    );
    const socket = response.webSocket;
    if (socket === null) throw new Error("Missing synthetic client socket.");

    const rejected = waitForSchemaRejection(socket);
    socket.accept();

    await expect(rejected).resolves.toMatchObject({
      code: "update_required",
      reason: "unsupported_client_schema",
      clientSchemaVersion: 4,
      roomSchemaVersion: null,
      supportedSchemaVersions: { min: 1, max: 3 },
    });
  });

  it("requires an upgrade when a client is older than the vault schema", async () => {
    const vaultName = "client-older-than-vault";
    await registerVault(vaultName);
    const vault = env.VAULTS.getByName(vaultName);
    const fixture = (fixtureFile.fixtures satisfies SchemaFixture[]).find(
      ({ schemaVersion }) => schemaVersion === 3,
    );
    if (fixture === undefined) throw new Error("Missing schema v3 fixture.");

    await vault.applyUpdate(toArrayBuffer(decodeBase64(fixture.updateBase64)));
    const response = await vault.fetch(
      `https://internal.example/vault/sync/${vaultName}?schemaVersion=1`,
      {
        headers: {
          Upgrade: "websocket",
          "x-partykit-room": vaultName,
        },
      },
    );
    const socket = response.webSocket;
    if (socket === null) throw new Error("Missing synthetic client socket.");

    const rejected = waitForSchemaRejection(socket);
    socket.accept();

    await expect(rejected).resolves.toMatchObject({
      code: "update_required",
      reason: "client_schema_older_than_room",
      clientSchemaVersion: 1,
      roomSchemaVersion: 3,
      supportedSchemaVersions: { min: 1, max: 3 },
    });
  });
});
