const BASE64URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

export function bytesToBase64Url(bytes: Uint8Array): string {
	let output = "";
	let i = 0;

	for (; i + 2 < bytes.length; i += 3) {
		const value = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
		output += BASE64URL_ALPHABET[(value >>> 18) & 63];
		output += BASE64URL_ALPHABET[(value >>> 12) & 63];
		output += BASE64URL_ALPHABET[(value >>> 6) & 63];
		output += BASE64URL_ALPHABET[value & 63];
	}

	const remaining = bytes.length - i;
	if (remaining === 1) {
		const value = bytes[i]! << 16;
		output += BASE64URL_ALPHABET[(value >>> 18) & 63];
		output += BASE64URL_ALPHABET[(value >>> 12) & 63];
	} else if (remaining === 2) {
		const value = (bytes[i]! << 16) | (bytes[i + 1]! << 8);
		output += BASE64URL_ALPHABET[(value >>> 18) & 63];
		output += BASE64URL_ALPHABET[(value >>> 12) & 63];
		output += BASE64URL_ALPHABET[(value >>> 6) & 63];
	}

	return output;
}

export function randomBase64Url(byteLength: number): string {
	const bytes = new Uint8Array(byteLength);
	crypto.getRandomValues(bytes);
	return bytesToBase64Url(bytes);
}
