// Capability changes require a server deployment, so a five-minute degraded
// poll is responsive without creating a permanent per-client request loop.
export const CAPABILITY_REFRESH_INTERVAL_MS = 5 * 60_000;
