const UUID_BYTE_LENGTH = 16;

export interface SecureRandomSource {
	getRandomValues(bytes: Uint8Array): Uint8Array;
}

/**
 * Generate a cryptographically random opaque identifier without relying on
 * Crypto.randomUUID(), which is unavailable in some plain-HTTP LAN contexts.
 */
export function createSecureOpaqueId(
	source: SecureRandomSource | null | undefined = globalThis.crypto
): string {
	if (!source || typeof source.getRandomValues !== 'function') {
		throw new Error('Secure browser entropy is unavailable');
	}

	const bytes = new Uint8Array(UUID_BYTE_LENGTH);
	source.getRandomValues(bytes);
	bytes[6] = (bytes[6] & 0x0f) | 0x40;
	bytes[8] = (bytes[8] & 0x3f) | 0x80;

	const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
