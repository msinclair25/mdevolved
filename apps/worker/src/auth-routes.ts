import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type AuthenticatorTransportFuture,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import {
  authenticationResponseSchema,
  authenticatorTransportListSchema,
  ownerClaimRequestSchema,
  registrationResponseSchema,
  type AuthenticationResult,
  type CsrfResponse,
  type SessionStatus,
  type SetupStatus,
} from "@owd/contracts";
import type { Context, Hono } from "hono";
import { ApiProblem } from "./api-problem";
import {
  addOwnerCredential,
  commitAuthentication,
  commitFirstOwner,
  consumeChallenge,
  createChallenge,
  createSessionMaterial,
  enforceRateLimit,
  ownerExists,
  readOwner,
  readOwnerCredential,
  readOwnerCredentials,
  revokeSession,
  rotateSessionCsrf,
  type OwnerRecord,
} from "./auth-store";
import { readOwnerSession, requireOwnerSession } from "./owner-session";
import {
  readManagedOwnerClaimStatus,
  requireManagedOwnerInvitation,
} from "./owner-claim-store";
import {
  readManagedTrialPolicy,
  readRuntimeDeploymentConfig,
} from "./runtime-config";
import {
  clearFlowCookie,
  clearSessionCookies,
  decodeBase64Url,
  parseJsonBody,
  randomToken,
  readFlowToken,
  readSessionToken,
  requestOrigin,
  requireCsrf,
  requireSameOrigin,
  setAnonymousCsrfCookie,
  setFlowCookie,
  setSessionCookies,
  sha256Hex,
} from "./security";
import type { AppBindings } from "./types";

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function toRegistrationResponse(value: unknown): RegistrationResponseJSON {
  const result = registrationResponseSchema.safeParse(value);

  if (!result.success) {
    throw new ApiProblem(
      400,
      "invalid_credential_response",
      "The passkey response is invalid.",
    );
  }

  return {
    authenticatorAttachment: result.data.authenticatorAttachment ?? undefined,
    clientExtensionResults: result.data.clientExtensionResults,
    id: result.data.id,
    rawId: result.data.rawId,
    response: result.data.response,
    type: result.data.type,
  };
}

function toAuthenticationResponse(value: unknown): AuthenticationResponseJSON {
  const result = authenticationResponseSchema.safeParse(value);

  if (!result.success) {
    throw new ApiProblem(
      400,
      "invalid_credential_response",
      "The passkey response is invalid.",
    );
  }

  return {
    authenticatorAttachment: result.data.authenticatorAttachment ?? undefined,
    clientExtensionResults: result.data.clientExtensionResults,
    id: result.data.id,
    rawId: result.data.rawId,
    response: {
      ...result.data.response,
      userHandle: result.data.response.userHandle ?? undefined,
    },
    type: result.data.type,
  };
}

function parseTransports(owner: OwnerRecord): AuthenticatorTransportFuture[] {
  try {
    return authenticatorTransportListSchema.parse(JSON.parse(owner.transports));
  } catch {
    throw new ApiProblem(
      503,
      "credential_unavailable",
      "The stored passkey record is unavailable.",
    );
  }
}

async function applyAuthRateLimit(
  app: Context<AppBindings>,
  action: string,
): Promise<void> {
  const clientAddress =
    app.req.header("CF-Connecting-IP") ?? "address-unavailable";
  const allowed = await enforceRateLimit(app.env.DB, {
    action,
    keyHash: await sha256Hex(clientAddress),
    limit: 10,
    now: nowSeconds(),
    windowSeconds: 600,
  });

  if (!allowed) {
    throw new ApiProblem(
      429,
      "rate_limited",
      "Too many authentication attempts. Try again later.",
    );
  }
}

async function challengeFromFlow(
  app: Context<AppBindings>,
  ceremony: "authentication" | "registration",
) {
  const flowToken = readFlowToken(app);

  if (!flowToken) {
    throw new ApiProblem(
      400,
      "challenge_invalid",
      "The passkey challenge is missing or expired.",
    );
  }

  const challenge = await consumeChallenge(
    app.env.DB,
    await sha256Hex(flowToken),
    ceremony,
    nowSeconds(),
  );

  if (!challenge) {
    throw new ApiProblem(
      400,
      "challenge_invalid",
      "The passkey challenge is missing, expired, or already used.",
    );
  }

  const relyingParty = requestOrigin(app);

  if (
    challenge.expected_origin !== relyingParty.origin ||
    challenge.expected_rp_id !== relyingParty.rpID
  ) {
    throw new ApiProblem(
      403,
      "relying_party_denied",
      "The passkey challenge belongs to a different site.",
    );
  }

  return challenge;
}

function authenticationResult(csrfToken: string): AuthenticationResult {
  return {
    authenticated: true,
    csrfToken,
    verified: true,
  };
}

export function registerAuthRoutes(app: Hono<AppBindings>): void {
  app.get("/api/setup/status", async (context) => {
    const [claimed, session] = await Promise.all([
      ownerExists(context.env.DB),
      readOwnerSession(context),
    ]);
    const deployment = readRuntimeDeploymentConfig(context.env);
    const managedClaim =
      deployment.mode === "managed"
        ? await readManagedOwnerClaimStatus(
            context.env.DB,
            deployment.expectedHostname,
            nowSeconds(),
          )
        : null;
    const managedTrial =
      deployment.mode === "managed"
        ? await readManagedTrialPolicy(context.env.DB, nowSeconds())
        : null;
    const authenticated = session !== null;
    const response: SetupStatus = {
      authenticated,
      claimAvailable:
        deployment.mode === "community"
          ? !claimed
          : !claimed && managedClaim?.available === true,
      claimExpiresAt: managedClaim?.expiresAt ?? null,
      claimMode: deployment.mode === "managed" ? "invitation" : "open",
      claimed,
      nextAction: !claimed
        ? "claim-owner"
        : authenticated
          ? "pair-vault"
          : "authenticate",
      pairingEnabled: true,
      state: claimed ? "ready" : "unclaimed",
      trialDays: managedClaim?.trialDays ?? null,
      trialEndsAt: managedTrial?.endsAt ?? null,
      trialExpired: managedTrial?.expired ?? false,
      maxVaults: managedTrial?.maxVaults ?? null,
    };

    context.header("Cache-Control", "no-store");
    return context.json(response);
  });

  app.get("/api/auth/session", async (context) => {
    const response: SessionStatus = {
      authenticated: (await readOwnerSession(context)) !== null,
    };

    context.header("Cache-Control", "no-store");
    return context.json(response);
  });

  app.get("/api/auth/csrf", async (context) => {
    const csrfToken = randomToken();
    const sessionToken = readSessionToken(context);

    if (sessionToken) {
      const rotated = await rotateSessionCsrf(
        context.env.DB,
        await sha256Hex(sessionToken),
        await sha256Hex(csrfToken),
        nowSeconds(),
      );

      if (!rotated) {
        clearSessionCookies(context);
      }
    }

    setAnonymousCsrfCookie(context, csrfToken);
    context.header("Cache-Control", "no-store");
    context.header("Vary", "Cookie");

    const response: CsrfResponse = { csrfToken };
    return context.json(response);
  });

  app.post("/api/auth/register/options", async (context) => {
    await requireCsrf(context);
    await applyAuthRateLimit(context, "registration");

    if (await ownerExists(context.env.DB)) {
      throw new ApiProblem(
        409,
        "owner_already_claimed",
        "This deployment already has an owner.",
      );
    }

    const relyingParty = requestOrigin(context);
    const deployment = readRuntimeDeploymentConfig(context.env);
    let managedInvitationHash: string | null = null;
    if (deployment.mode === "managed") {
      if (relyingParty.rpID !== deployment.expectedHostname) {
        throw new ApiProblem(
          403,
          "relying_party_denied",
          "This invitation belongs to a different workspace.",
        );
      }
      const parsedClaim = ownerClaimRequestSchema.safeParse(
        await parseJsonBody(context),
      );
      if (!parsedClaim.success) {
        throw new ApiProblem(
          403,
          "owner_invitation_invalid",
          "This workspace invitation is missing, expired, or already used.",
        );
      }
      managedInvitationHash = await requireManagedOwnerInvitation(
        context.env.DB,
        {
          expectedHostname: deployment.expectedHostname,
          now: nowSeconds(),
          tokenHash: await sha256Hex(parsedClaim.data.claimToken),
        },
      );
      if (managedInvitationHash === null) {
        throw new ApiProblem(
          403,
          "owner_invitation_invalid",
          "This workspace invitation is missing, expired, or already used.",
        );
      }
    }
    const userID = crypto.getRandomValues(new Uint8Array(32));
    const options = await generateRegistrationOptions({
      attestationType: "none",
      authenticatorSelection: {
        residentKey: "required",
        userVerification: "required",
      },
      rpID: relyingParty.rpID,
      rpName: "MDevolved",
      supportedAlgorithmIDs: [-7, -257],
      timeout: 120_000,
      userDisplayName: "MDevolved owner",
      userID,
      userName: "owner",
    });
    const flowToken = randomToken();

    await createChallenge(context.env.DB, {
      ceremony: "registration",
      challenge: options.challenge,
      expectedOrigin: relyingParty.origin,
      expectedRpId: relyingParty.rpID,
      flowHash: await sha256Hex(flowToken),
      now: nowSeconds(),
      ...(managedInvitationHash !== null && deployment.mode === "managed"
        ? {
            ownerClaim: {
              expectedHostname: deployment.expectedHostname,
              invitationTokenHash: managedInvitationHash,
            },
          }
        : {}),
      webauthnUserId: options.user.id,
    });
    setFlowCookie(context, flowToken);
    context.header("Cache-Control", "no-store");

    return context.json(options);
  });

  app.post("/api/auth/register/verify", async (context) => {
    await requireCsrf(context);
    await applyAuthRateLimit(context, "registration");

    const deployment = readRuntimeDeploymentConfig(context.env);
    const credentialResponse = toRegistrationResponse(
      await parseJsonBody(context),
    );
    const challenge = await challengeFromFlow(context, "registration");
    let verification;

    try {
      verification = await verifyRegistrationResponse({
        expectedChallenge: challenge.challenge,
        expectedOrigin: challenge.expected_origin,
        expectedRPID: challenge.expected_rp_id,
        requireUserPresence: true,
        requireUserVerification: true,
        response: credentialResponse,
        supportedAlgorithmIDs: [-7, -257],
      });
    } catch {
      throw new ApiProblem(
        400,
        "credential_verification_failed",
        "The passkey could not be verified.",
      );
    }

    if (!verification.verified || !challenge.webauthn_user_id) {
      throw new ApiProblem(
        400,
        "credential_verification_failed",
        "The passkey could not be verified.",
      );
    }

    const now = nowSeconds();
    const session = await createSessionMaterial(now);
    const { credential, credentialBackedUp, credentialDeviceType } =
      verification.registrationInfo;

    try {
      await commitFirstOwner(
        context.env.DB,
        {
          backedUp: credentialBackedUp,
          counter: credential.counter,
          credentialId: credential.id,
          deviceType: credentialDeviceType,
          publicKey: credential.publicKey,
          transports: credential.transports ?? [],
          webauthnUserId: challenge.webauthn_user_id,
        },
        session,
        context.get("requestId"),
        now,
        deployment.mode === "managed",
      );
    } catch (error) {
      if (await ownerExists(context.env.DB)) {
        throw new ApiProblem(
          409,
          "owner_already_claimed",
          "This deployment already has an owner.",
        );
      }

      if (
        error instanceof Error &&
        error.message.includes("owner_invitation_invalid")
      ) {
        throw new ApiProblem(
          403,
          "owner_invitation_invalid",
          "This workspace invitation is missing, expired, or already used.",
        );
      }

      throw error;
    }

    clearFlowCookie(context);
    setSessionCookies(
      context,
      session.token,
      session.csrfToken,
      session.maxAgeSeconds,
    );
    context.header("Cache-Control", "no-store");

    return context.json(authenticationResult(session.csrfToken));
  });

  app.post("/api/auth/login/options", async (context) => {
    await requireCsrf(context);
    await applyAuthRateLimit(context, "authentication");

    const owner = await readOwner(context.env.DB);

    if (!owner) {
      throw new ApiProblem(
        409,
        "owner_not_claimed",
        "Claim this deployment before signing in.",
      );
    }
    const credentials = await readOwnerCredentials(context.env.DB);
    if (credentials.length === 0) {
      throw new ApiProblem(
        503,
        "credential_unavailable",
        "The stored passkey record is unavailable.",
      );
    }

    const relyingParty = requestOrigin(context);
    const options = await generateAuthenticationOptions({
      allowCredentials: credentials.map((credential) => ({
        id: credential.credential_id,
        transports: parseTransports(credential),
      })),
      rpID: relyingParty.rpID,
      timeout: 120_000,
      userVerification: "required",
    });
    const flowToken = randomToken();

    await createChallenge(context.env.DB, {
      ceremony: "authentication",
      challenge: options.challenge,
      expectedOrigin: relyingParty.origin,
      expectedRpId: relyingParty.rpID,
      flowHash: await sha256Hex(flowToken),
      now: nowSeconds(),
      webauthnUserId: owner.webauthn_user_id,
    });
    setFlowCookie(context, flowToken);
    context.header("Cache-Control", "no-store");

    return context.json(options);
  });

  app.post("/api/auth/login/verify", async (context) => {
    await requireCsrf(context);
    await applyAuthRateLimit(context, "authentication");

    const credentialResponse = toAuthenticationResponse(
      await parseJsonBody(context),
    );
    const challenge = await challengeFromFlow(context, "authentication");
    const owner = await readOwner(context.env.DB);
    const credential = await readOwnerCredential(
      context.env.DB,
      credentialResponse.id,
    );

    if (!owner || credential === null) {
      throw new ApiProblem(
        400,
        "credential_verification_failed",
        "The passkey could not be verified.",
      );
    }

    let verification;

    try {
      verification = await verifyAuthenticationResponse({
        credential: {
          counter: credential.counter,
          id: credential.credential_id,
          publicKey: decodeBase64Url(credential.public_key),
          transports: parseTransports(credential),
        },
        expectedChallenge: challenge.challenge,
        expectedOrigin: challenge.expected_origin,
        expectedRPID: challenge.expected_rp_id,
        requireUserVerification: true,
        response: credentialResponse,
      });
    } catch {
      throw new ApiProblem(
        400,
        "credential_verification_failed",
        "The passkey could not be verified.",
      );
    }

    if (!verification.verified) {
      throw new ApiProblem(
        400,
        "credential_verification_failed",
        "The passkey could not be verified.",
      );
    }

    const now = nowSeconds();
    const session = await createSessionMaterial(now);

    await commitAuthentication(
      context.env.DB,
      {
        backedUp: verification.authenticationInfo.credentialBackedUp,
        counter: verification.authenticationInfo.newCounter,
        credentialId: credential.credential_id,
        deviceType: verification.authenticationInfo.credentialDeviceType,
        requestId: context.get("requestId"),
        session,
      },
      now,
    );

    clearFlowCookie(context);
    setSessionCookies(
      context,
      session.token,
      session.csrfToken,
      session.maxAgeSeconds,
    );
    context.header("Cache-Control", "no-store");

    return context.json(authenticationResult(session.csrfToken));
  });

  app.post("/api/auth/passkeys/register/options", async (context) => {
    await requireOwnerSession(context, { csrf: true });
    await applyAuthRateLimit(context, "registration");
    const owner = await readOwner(context.env.DB);
    if (owner === null) {
      throw new ApiProblem(
        409,
        "owner_not_claimed",
        "Claim this deployment before adding a passkey.",
      );
    }
    const credentials = await readOwnerCredentials(context.env.DB);
    if (credentials.length >= 16) {
      throw new ApiProblem(
        409,
        "passkey_limit_reached",
        "This workspace already has the maximum number of passkeys.",
      );
    }
    const relyingParty = requestOrigin(context);
    const options = await generateRegistrationOptions({
      attestationType: "none",
      authenticatorSelection: {
        residentKey: "required",
        userVerification: "required",
      },
      excludeCredentials: credentials.map((credential) => ({
        id: credential.credential_id,
        transports: parseTransports(credential),
      })),
      rpID: relyingParty.rpID,
      rpName: "MDevolved",
      supportedAlgorithmIDs: [-7, -257],
      timeout: 120_000,
      userDisplayName: "MDevolved owner",
      userID: decodeBase64Url(owner.webauthn_user_id),
      userName: "owner",
    });
    const flowToken = randomToken();
    await createChallenge(context.env.DB, {
      ceremony: "registration",
      challenge: options.challenge,
      expectedOrigin: relyingParty.origin,
      expectedRpId: relyingParty.rpID,
      flowHash: await sha256Hex(flowToken),
      now: nowSeconds(),
      webauthnUserId: owner.webauthn_user_id,
    });
    setFlowCookie(context, flowToken);
    context.header("Cache-Control", "no-store");
    return context.json(options);
  });

  app.post("/api/auth/passkeys/register/verify", async (context) => {
    await requireOwnerSession(context, { csrf: true });
    await applyAuthRateLimit(context, "registration");
    const response = toRegistrationResponse(await parseJsonBody(context));
    const challenge = await challengeFromFlow(context, "registration");
    const owner = await readOwner(context.env.DB);
    if (
      owner === null ||
      challenge.webauthn_user_id !== owner.webauthn_user_id
    ) {
      throw new ApiProblem(
        400,
        "credential_verification_failed",
        "The passkey could not be verified.",
      );
    }
    let verification;
    try {
      verification = await verifyRegistrationResponse({
        expectedChallenge: challenge.challenge,
        expectedOrigin: challenge.expected_origin,
        expectedRPID: challenge.expected_rp_id,
        requireUserPresence: true,
        requireUserVerification: true,
        response,
        supportedAlgorithmIDs: [-7, -257],
      });
    } catch {
      throw new ApiProblem(
        400,
        "credential_verification_failed",
        "The passkey could not be verified.",
      );
    }
    if (!verification.verified) {
      throw new ApiProblem(
        400,
        "credential_verification_failed",
        "The passkey could not be verified.",
      );
    }
    const { credential, credentialBackedUp, credentialDeviceType } =
      verification.registrationInfo;
    const added = await addOwnerCredential(
      context.env.DB,
      {
        backedUp: credentialBackedUp,
        counter: credential.counter,
        credentialId: credential.id,
        deviceType: credentialDeviceType,
        publicKey: credential.publicKey,
        transports: credential.transports ?? [],
        webauthnUserId: owner.webauthn_user_id,
      },
      context.get("requestId"),
      nowSeconds(),
    );
    if (!added) {
      throw new ApiProblem(
        409,
        "passkey_already_registered",
        "That passkey is already registered to this workspace.",
      );
    }
    clearFlowCookie(context);
    context.header("Cache-Control", "no-store");
    return context.body(null, 204);
  });

  app.post("/api/auth/logout", async (context) => {
    requireSameOrigin(context);

    const sessionToken = readSessionToken(context);

    if (sessionToken) {
      const tokenHash = await sha256Hex(sessionToken);
      const session = await readOwnerSession(context);

      if (session) {
        await requireCsrf(context, session.csrf_hash);
        await revokeSession(
          context.env.DB,
          tokenHash,
          context.get("requestId"),
          nowSeconds(),
        );
      }
    }

    clearSessionCookies(context);
    context.header("Cache-Control", "no-store");
    return context.body(null, 204);
  });
}
