/**
 * Type definitions missing from @types/nova-editor-node
 *
 * nova.crypto has been part of the Nova API since Nova 10, but is not yet
 * declared by the type definitions. These declarations merge into the existing
 * interfaces and can be dropped once upstream catches up.
 *
 * @see https://docs.nova.app/api-reference/crypto/
 */

interface Crypto {
	/** Fills the given TypedArray with cryptographically sound random values */
	getRandomValues<T extends ArrayBufferView>(typedArray: T): T;

	/** Returns a random UUID v4 identifier */
	randomUUID(): string;
}

interface Environment {
	readonly crypto: Crypto;
}
