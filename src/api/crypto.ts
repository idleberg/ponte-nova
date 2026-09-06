/**
 * Crypto module compatibility layer for Nova extensions
 * Maps Node.js crypto API to Nova-compatible implementations
 *
 * Nova provides limited crypto functionality via nova.crypto:
 * - getRandomValues(typedArray) - fills TypedArray with secure random values
 * - randomUUID() - generates UUID v4 identifier
 *
 * Everything built on those primitives (randomBytes, randomFill) is available.
 * Hashing, ciphers, key derivation and signing have no Nova counterpart and
 * throw - which, since hashing is what most packages reach for, means a lot of
 * crypto-dependent packages will still not work.
 */

// ============================================================================
// Types
// ============================================================================

/**
 * Simple Buffer-like class for compatibility
 *
 * Nova doesn't have Node.js Buffer, so we create a minimal implementation that
 * extends Uint8Array with the encoding methods (toString with 'hex', 'base64', 'utf8')
 * that Node.js code commonly uses. This allows randomBytes() to return a Buffer-like
 * object that works with existing Node.js code patterns.
 */
export class BufferCompat extends Uint8Array {
	override toString(encoding = 'utf8'): string {
		if (encoding === 'hex') {
			return Array.from(this, (byte) => byte.toString(16).padStart(2, '0')).join('');
		}

		if (encoding === 'base64') {
			// Nova provides btoa, which expects one character per byte
			return btoa(Array.from(this, (byte) => String.fromCharCode(byte)).join(''));
		}

		// TextDecoder is not part of the documented Nova API, so its absence is
		// reported rather than silently substituting a different encoding
		if (typeof TextDecoder === 'undefined') {
			throw new Error(`Encoding '${encoding}' is not supported in Nova extensions. Use 'hex' or 'base64' instead.`);
		}

		return new TextDecoder(encoding).decode(this);
	}
}

// ============================================================================
// Random Number Generation
// ============================================================================

/**
 * Generates cryptographically strong random data
 *
 * Uses nova.crypto.getRandomValues internally but returns a BufferCompat instance
 * instead of a raw Uint8Array. This is because Node.js returns a Buffer object with
 * methods like toString('hex') and toString('base64') that code may rely on. Nova
 * doesn't have Node's Buffer class, so BufferCompat provides a minimal compatible
 * implementation.
 *
 * @param size - The number of bytes to generate
 * @returns BufferCompat containing random bytes (extends Uint8Array with toString encoding support)
 */
export function randomBytes(size: number): BufferCompat {
	if (size < 0 || !Number.isInteger(size)) {
		throw new RangeError('The "size" argument must be a non-negative integer');
	}

	return nova.crypto.getRandomValues(new BufferCompat(size));
}

/**
 * Generates cryptographically strong random values
 * Direct wrapper around Nova's crypto.getRandomValues
 *
 * @param typedArray - The TypedArray to fill with random values
 * @returns The same TypedArray instance, filled with random values
 */
export function getRandomValues<T extends ArrayBufferView>(typedArray: T): T {
	return nova.crypto.getRandomValues(typedArray);
}

/**
 * Generates a random UUID v4 identifier
 * Direct wrapper around Nova's crypto.randomUUID
 *
 * @returns A UUID v4 string (36 characters)
 */
export function randomUUID(): string {
	return nova.crypto.randomUUID();
}

/**
 * Fills a buffer with cryptographically strong random values
 *
 * Built on nova.crypto.getRandomValues, which fills an entire TypedArray. The
 * requested region is filled by handing it a subarray view of the buffer.
 *
 * @param buffer - The buffer to fill
 * @param offset - Byte offset to start filling at (default 0)
 * @param size - Number of bytes to fill (default: the rest of the buffer)
 * @returns The same buffer instance
 */
export function randomFillSync<T extends ArrayBufferView>(buffer: T, offset = 0, size?: number): T {
	const bytes = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
	const length = size ?? bytes.length - offset;

	if (offset < 0 || length < 0 || offset + length > bytes.length) {
		throw new RangeError('The value of "offset" and "size" is out of range');
	}

	nova.crypto.getRandomValues(bytes.subarray(offset, offset + length));

	return buffer;
}

/**
 * Fills a buffer with cryptographically strong random values, asynchronously
 *
 * Nova only provides setTimeout, so a zero-delay timeout stands in for the
 * deferred callback Node.js would schedule.
 */
export function randomFill<T extends ArrayBufferView>(
	buffer: T,
	offset: number | ((error: Error | null, buffer: T) => void),
	size?: number | ((error: Error | null, buffer: T) => void),
	callback?: (error: Error | null, buffer: T) => void,
): void {
	const done = (typeof offset === 'function' ? offset : typeof size === 'function' ? size : callback) as (
		error: Error | null,
		buffer: T,
	) => void;

	const start = typeof offset === 'number' ? offset : 0;
	const length = typeof size === 'number' ? size : undefined;

	try {
		randomFillSync(buffer, start, length);
		setTimeout(() => done(null, buffer), 0);
	} catch (error) {
		setTimeout(() => done(error as Error, buffer), 0);
	}
}

// ============================================================================
// Unsupported Operations
// ============================================================================

const unsupportedError = (method: string) => () => {
	throw new Error(
		`crypto.${method} is not supported in Nova extensions. Nova only provides randomBytes, randomFill, getRandomValues and randomUUID.`,
	);
};

export const createHash = unsupportedError('createHash');

export const createHmac = unsupportedError('createHmac');

export const createCipher = unsupportedError('createCipher');

export const createDecipher = unsupportedError('createDecipher');

export const createCipheriv = unsupportedError('createCipheriv');

export const createDecipheriv = unsupportedError('createDecipheriv');

export const createDiffieHellman = unsupportedError('createDiffieHellman');

export const createSign = unsupportedError('createSign');

export const createVerify = unsupportedError('createVerify');

export const generateKeyPair = unsupportedError('generateKeyPair');

export const generateKeyPairSync = unsupportedError('generateKeyPairSync');

export const pbkdf2 = unsupportedError('pbkdf2');

export const pbkdf2Sync = unsupportedError('pbkdf2Sync');

export const scrypt = unsupportedError('scrypt');

export const scryptSync = unsupportedError('scryptSync');

// ============================================================================
// Default Export
// ============================================================================

export default {
	randomBytes,
	randomFill,
	randomFillSync,
	getRandomValues,
	randomUUID,
	createHash,
	createHmac,
	createCipher,
	createDecipher,
	createCipheriv,
	createDecipheriv,
	createDiffieHellman,
	createSign,
	createVerify,
	generateKeyPair,
	generateKeyPairSync,
	pbkdf2,
	pbkdf2Sync,
	scrypt,
	scryptSync,
};
