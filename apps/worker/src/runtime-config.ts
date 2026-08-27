import type { ApiError } from "@mdevolved/contracts";

export type DeploymentMode = "community" | "managed";

export type RuntimeEnv = Omit<
  Env,
  "APP_DEPLOYMENT_MODE" | "EXPECTED_HOSTNAME" | "WORKER_VERSION"
> & {
  APP_DEPLOYMENT_MODE: string;
  EXPECTED_HOSTNAME: string;
  WORKER_VERSION?: {
    id: string;
    tag?: string;
    timestamp: string;
  };
};

export type RuntimeDeploymentConfig =
  | {
      mode: "community";
    }
  | {
      expectedHostname: string;
      mode: "managed";
    };

const hostnamePattern =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])$/u;

export class RuntimeConfigurationError extends Error {
  override readonly name = "RuntimeConfigurationError";
}

export function readRuntimeDeploymentConfig(
  env: Pick<RuntimeEnv, "APP_DEPLOYMENT_MODE" | "EXPECTED_HOSTNAME">,
): RuntimeDeploymentConfig {
  const modeValue: unknown = env.APP_DEPLOYMENT_MODE;
  const hostnameValue: unknown = env.EXPECTED_HOSTNAME;

  if (modeValue === "community") {
    if (hostnameValue !== "") {
      throw new RuntimeConfigurationError(
        "Community mode cannot pin a managed hostname.",
      );
    }
    return { mode: "community" };
  }

  if (
    modeValue !== "managed" ||
    typeof hostnameValue !== "string" ||
    hostnameValue !== hostnameValue.toLowerCase() ||
    !hostnamePattern.test(hostnameValue) ||
    hostnameValue.endsWith(".workers.dev")
  ) {
    throw new RuntimeConfigurationError(
      "Managed mode requires one exact permanent custom hostname.",
    );
  }

  return {
    expectedHostname: hostnameValue,
    mode: "managed",
  };
}

function routingProblem(
  status: 421 | 503,
  code: string,
  message: string,
): Response {
  const requestId = crypto.randomUUID();
  const body: ApiError = {
    error: {
      code,
      message,
      requestId,
    },
  };

  return Response.json(body, {
    headers: {
      "Cache-Control": "private, no-store",
      "X-Request-Id": requestId,
    },
    status,
  });
}

export function enforceRuntimeRouting(
  request: Request,
  env: Pick<RuntimeEnv, "APP_DEPLOYMENT_MODE" | "EXPECTED_HOSTNAME">,
): Response | null {
  let config: RuntimeDeploymentConfig;
  try {
    config = readRuntimeDeploymentConfig(env);
  } catch {
    return routingProblem(
      503,
      "deployment_configuration_invalid",
      "This MDevolved deployment is not configured for activation.",
    );
  }

  if (config.mode === "community") return null;

  const url = new URL(request.url);
  if (
    url.protocol !== "https:" ||
    url.port !== "" ||
    url.hostname !== config.expectedHostname
  ) {
    return routingProblem(
      421,
      "deployment_hostname_denied",
      "Use this workspace's permanent invitation hostname.",
    );
  }

  return null;
}

export type ManagedTrialPolicy = {
  claimedAt: number | null;
  endsAt: number | null;
  expired: boolean;
  maxVaults: 2;
  trialDays: number | null;
};

export async function readManagedTrialPolicy(
  db: D1Database,
  now: number,
): Promise<ManagedTrialPolicy> {
  const row = await db
    .prepare(
      `SELECT claimed_at, trial_days
       FROM owner_claim_configuration WHERE id = 1`,
    )
    .first<{ claimed_at: number | null; trial_days: number }>();
  const endsAt =
    row?.claimed_at === null || row?.claimed_at === undefined
      ? null
      : row.claimed_at + row.trial_days * 86_400;
  return {
    claimedAt: row?.claimed_at ?? null,
    endsAt,
    expired: endsAt !== null && endsAt <= now,
    maxVaults: 2,
    trialDays: row?.trial_days ?? null,
  };
}

export async function enforceManagedTrialAccess(
  request: Request,
  env: Pick<RuntimeEnv, "APP_DEPLOYMENT_MODE" | "DB" | "EXPECTED_HOSTNAME">,
): Promise<Response | null> {
  const deployment = readRuntimeDeploymentConfig(env);
  if (deployment.mode !== "managed") return null;
  const method = request.method.toUpperCase();
  const path = new URL(request.url).pathname;
  if (
    method === "GET" ||
    method === "HEAD" ||
    method === "OPTIONS" ||
    path.startsWith("/api/auth/")
  ) {
    return null;
  }
  const policy = await readManagedTrialPolicy(
    env.DB,
    Math.floor(Date.now() / 1_000),
  );
  if (!policy.expired) return null;
  return routingProblem(
    503,
    "managed_trial_ended",
    "This managed trial has ended. Owner sign-in and read-only export remain available.",
  );
}
