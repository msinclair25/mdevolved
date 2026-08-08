/** Typed failure returned by the socket-ticket HTTP endpoint. */
export class SocketTicketHttpError extends Error {
	constructor(readonly status: number) {
		super(`socket ticket request failed (${status})`);
		this.name = "SocketTicketHttpError";
	}
}
