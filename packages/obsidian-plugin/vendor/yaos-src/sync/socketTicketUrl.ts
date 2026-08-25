/** Portable socket-ticket URL helpers. This module has no Obsidian dependency. */
export const TICKET_REFRESH_BUFFER_MS = 30_000;

export function patchTicketInUrl(url: string, ticketValue: string): string {
	const candidate = new URL(url);
	candidate.searchParams.delete("token");
	candidate.searchParams.set("ticket", ticketValue);
	return candidate.toString();
}
