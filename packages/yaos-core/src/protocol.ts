import * as encoding from "lib0/encoding";
import * as syncProtocol from "y-protocols/sync";

const MESSAGE_SYNC = 0;

/** Encode one Yjs update exactly as a YAOS/y-partyserver sync update frame. */
export function encodeSyncUpdateFrame(update: Uint8Array): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_SYNC);
  syncProtocol.writeUpdate(encoder, update);
  return encoding.toUint8Array(encoder);
}
