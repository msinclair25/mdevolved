import { SocketTicketHttpError } from "./socketTicketError";

export const SOCKET_TICKET_RETRY_BASE_MS = 30_000;
export const SOCKET_TICKET_RETRY_MAX_MS = 30 * 60_000;
export const SOCKET_TICKET_RETRY_JITTER_RATIO = 0.2;

export type SocketTicketFailureDecision =
	| {
			kind: "fatal";
			code: "unauthorized";
			reason: string;
			status: 401 | 403;
	  }
	| {
			kind: "retry";
			delayMs: number;
			nextAttempt: number;
	  };

/**
 * Exponential retry delay for transient ticket failures. The caller supplies
 * randomUnit in tests; production uses Math.random because this jitter is for
 * traffic de-correlation, not security.
 */
export function socketTicketRetryDelayMs(
	attempt: number,
	randomUnit = Math.random(),
): number {
	const safeAttempt =
		Number.isSafeInteger(attempt) && attempt > 0 ? attempt : 0;
	const boundedRandom = Number.isFinite(randomUnit)
		? Math.min(1, Math.max(0, randomUnit))
		: 0.5;
	const exponential = Math.min(
		SOCKET_TICKET_RETRY_MAX_MS,
		SOCKET_TICKET_RETRY_BASE_MS * 2 ** Math.min(safeAttempt, 16),
	);
	const jitterMultiplier =
		1 -
		SOCKET_TICKET_RETRY_JITTER_RATIO +
		2 * SOCKET_TICKET_RETRY_JITTER_RATIO * boundedRandom;
	return Math.min(
		SOCKET_TICKET_RETRY_MAX_MS,
		Math.max(1_000, Math.round(exponential * jitterMultiplier)),
	);
}

/**
 * Authentication rejection is terminal until the owner re-pairs the vault.
 * Every other failure is transient and receives bounded exponential backoff.
 */
export function decideSocketTicketFailure(
	error: unknown,
	attempt: number,
	randomUnit = Math.random(),
): SocketTicketFailureDecision {
	if (
		error instanceof SocketTicketHttpError &&
		(error.status === 401 || error.status === 403)
	) {
		return {
			kind: "fatal",
			code: "unauthorized",
			reason:
				"The vault credential was rejected. Re-pair this vault before syncing again.",
			status: error.status,
		};
	}
	const safeAttempt = Number.isSafeInteger(attempt) && attempt > 0 ? attempt : 0;

	return {
		kind: "retry",
		delayMs: socketTicketRetryDelayMs(safeAttempt, randomUnit),
		nextAttempt: Math.min(safeAttempt + 1, 16),
	};
}
