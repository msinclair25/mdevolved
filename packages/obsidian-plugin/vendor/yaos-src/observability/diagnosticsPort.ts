/** Minimal boundary retained when the optional upstream telemetry bundle is excluded. */
export interface DiagnosticsPort {
	buildDebugInfo(): string;
	buildRecentEventsText(limit: number): string;
	exportDiagnostics(): Promise<void>;
	exportDiagnosticsWithFilenames(): Promise<void>;
}
