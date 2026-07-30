/**
 * Domain events for rename admission.
 *
 * These represent what happened in the sync domain, without coupling to
 * the flight recorder's event taxonomy or schema. The FlightTraceSink
 * adapter maps them to FLIGHT_KIND constants.
 */

import type { DomainPathTraceEvent } from "./traceSink";

/**
 * A disk rename was observed (one event per side: source + target).
 */
export interface RenameObservedEvent extends DomainPathTraceEvent {
	readonly kind: "rename.observed";
	readonly scope: "file";
	readonly data: {
		readonly renameRole: "source" | "target";
		readonly category: "markdown" | "blob" | "excluded";
		readonly opId: string;
	};
}

/**
 * The rename admission invariant was violated: an excluded markdown
 * destination reached applyRenameBatch despite the admission policy.
 * This should never fire in correct operation.
 */
export interface RenameAdmissionInvariantFailedEvent extends DomainPathTraceEvent {
	readonly kind: "rename.admission.invariant-failed";
	readonly scope: "file";
	readonly severity: "error";
	readonly data: {
		readonly bug: string;
	};
}

export type RenameAdmissionDomainEvent =
	| RenameObservedEvent
	| RenameAdmissionInvariantFailedEvent;
