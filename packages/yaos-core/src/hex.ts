const BYTE_TO_HEX: string[] = (() => {
  const table = Array.from({ length: 256 }, () => "");
  for (let i = 0; i < 256; i++) {
    table[i] = i.toString(16).padStart(2, "0");
  }
  return table;
})();

export function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += BYTE_TO_HEX[bytes[i] ?? 0] ?? "00";
  }
  return out;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const input = new Uint8Array(bytes.byteLength);
  input.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", input.buffer);
  return bytesToHex(new Uint8Array(digest));
}
