/**
 * Crypto module compatibility layer for Nova extensions
 * Maps Node.js crypto API to Nova-compatible implementations
 *
 * Nova provides two primitives via nova.crypto - getRandomValues and randomUUID
 * - and everything built on them (randomBytes, randomFill) is available.
 *
 * Hashing has no Nova counterpart at all, so createHash and createHmac run on
 * hash-wasm instead. That library compiles its WebAssembly asynchronously while
 * Node.js hashes synchronously, which is bridged by buffering the input and
 * hashing it at digest time; see the note on ready() below for the one thing
 * that asks of the caller.
 *
 * Ciphers, key derivation and signing still throw.
 */

import {
	createBLAKE2b,
	createBLAKE2s,
	createMD5,
	createRIPEMD160,
	createSHA1,
	createSHA3,
	createSHA224,
	createSHA256,
	createSHA384,
	createSHA512,
	createSM3,
	type IHasher,
} from 'hash-wasm';
import { Buffer } from './buffer.js';

// ============================================================================
// Random Number Generation
// ============================================================================

/**
 * Generates cryptographically strong random data
 *
 * Uses nova.crypto.getRandomValues internally but returns a Buffer rather than a
 * raw Uint8Array, because Node.js code routinely calls toString('hex') on the
 * result.
 *
 * @param size - The number of bytes to generate
 * @returns Buffer containing random bytes
 */
export function randomBytes(size: number): Buffer {
	if (size < 0 || !Number.isInteger(size)) {
		throw new RangeError('The "size" argument must be a non-negative integer');
	}

	return nova.crypto.getRandomValues(Buffer.alloc(size));
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
// Hashing
// ============================================================================

/**
 * The hash algorithms hash-wasm provides under the names Node.js uses
 *
 * blockSize is the block length HMAC pads the key to. For the SHA-3 family that
 * is the sponge rate rather than a power of two, which is why the numbers look
 * irregular.
 */
const algorithms: Record<string, { create: () => Promise<IHasher>; blockSize: number }> = {
	blake2b512: { create: () => createBLAKE2b(512), blockSize: 128 },
	blake2s256: { create: () => createBLAKE2s(256), blockSize: 64 },
	md5: { create: createMD5, blockSize: 64 },
	ripemd160: { create: createRIPEMD160, blockSize: 64 },
	sha1: { create: createSHA1, blockSize: 64 },
	sha224: { create: createSHA224, blockSize: 64 },
	sha256: { create: createSHA256, blockSize: 64 },
	sha384: { create: createSHA384, blockSize: 128 },
	sha512: { create: createSHA512, blockSize: 128 },
	'sha3-224': { create: () => createSHA3(224), blockSize: 144 },
	'sha3-256': { create: () => createSHA3(256), blockSize: 136 },
	'sha3-384': { create: () => createSHA3(384), blockSize: 104 },
	'sha3-512': { create: () => createSHA3(512), blockSize: 72 },
	sm3: { create: createSM3, blockSize: 64 },
};

/** Names OpenSSL accepts for an algorithm listed above */
const aliases: Record<string, string> = {
	'blake2b-512': 'blake2b512',
	'blake2s-256': 'blake2s256',
	rmd160: 'ripemd160',
	'ripemd-160': 'ripemd160',
	'sha-1': 'sha1',
	'sha-224': 'sha224',
	'sha-256': 'sha256',
	'sha-384': 'sha384',
	'sha-512': 'sha512',
};

const loaded = new Map<string, IHasher>();
const loading = new Map<string, Promise<IHasher>>();

function normalizeAlgorithm(algorithm: string): string {
	const name = algorithm.toLowerCase();
	const resolved = aliases[name] ?? name;

	if (!algorithms[resolved]) {
		const error = new Error(`Digest method not supported: ${algorithm}`);

		(error as Error & { code?: string }).code = 'ERR_CRYPTO_INVALID_DIGEST';

		throw error;
	}

	return resolved;
}

/**
 * Compile the WebAssembly behind one or more algorithms
 *
 * Node.js hashes synchronously and hash-wasm compiles asynchronously, so the
 * compile has to happen before the first digest rather than during it. Call
 * this once while the extension activates:
 *
 *     exports.activate = async () => { await crypto.ready(); };
 *
 * With no argument every supported algorithm is compiled, which is a handful of
 * milliseconds and means nothing further has to be predicted. Pass a list to
 * compile only what the extension actually uses.
 */
export async function ready(algorithmNames?: string[]): Promise<void> {
	const wanted = (algorithmNames ?? Object.keys(algorithms)).map(normalizeAlgorithm);

	await Promise.all(wanted.map((name) => load(name)));
}

function load(algorithm: string): Promise<IHasher> {
	const pending = loading.get(algorithm);

	if (pending) {
		return pending;
	}

	const promise = (algorithms[algorithm] as { create: () => Promise<IHasher> }).create().then((hasher) => {
		loaded.set(algorithm, hasher);

		return hasher;
	});

	loading.set(algorithm, promise);

	return promise;
}

/**
 * Hash a sequence of chunks in one go
 *
 * The hasher instance is shared per algorithm, which is safe because init,
 * update and digest all run synchronously here with nothing able to interleave
 * between them.
 */
function digestChunks(algorithm: string, chunks: Uint8Array[]): Uint8Array {
	const hasher = loaded.get(algorithm);

	if (!hasher) {
		// Compiling now does not help this call, but it helps the next one
		load(algorithm);

		throw new Error(
			`The WebAssembly implementation of '${algorithm}' has not finished loading. Node.js hashes synchronously and this one cannot, so call 'await crypto.ready()' once while your extension activates.`,
		);
	}

	hasher.init();

	for (const chunk of chunks) {
		hasher.update(chunk);
	}

	return hasher.digest('binary');
}

/** HMAC as defined in RFC 2104, over whichever hash was asked for */
function digestHmac(algorithm: string, key: Uint8Array, chunks: Uint8Array[]): Uint8Array {
	const { blockSize } = algorithms[algorithm] as { blockSize: number };
	const padded = new Uint8Array(blockSize);

	padded.set(key.length > blockSize ? digestChunks(algorithm, [key]) : key);

	const inner = new Uint8Array(blockSize);
	const outer = new Uint8Array(blockSize);

	for (let index = 0; index < blockSize; index++) {
		inner[index] = (padded[index] as number) ^ 0x36;
		outer[index] = (padded[index] as number) ^ 0x5c;
	}

	return digestChunks(algorithm, [outer, digestChunks(algorithm, [inner, ...chunks])]);
}

function toBytes(data: string | ArrayBufferView | ArrayBuffer, encoding?: BufferEncoding): Uint8Array {
	if (typeof data === 'string') {
		return Buffer.from(data, encoding ?? 'utf8');
	}

	return ArrayBuffer.isView(data)
		? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
		: new Uint8Array(data);
}

/**
 * A Hash or Hmac object
 *
 * Input is buffered rather than fed to the hasher as it arrives, because the
 * WebAssembly may still be compiling while update is being called. That costs
 * memory proportional to the input, which is the trade for keeping Node.js's
 * synchronous digest.
 */
export class Hash {
	#algorithm: string;
	#chunks: Uint8Array[];
	#key: Uint8Array | null;
	#digested = false;

	constructor(algorithm: string, key?: Uint8Array | null, chunks: Uint8Array[] = []) {
		this.#algorithm = normalizeAlgorithm(algorithm);
		this.#key = key ?? null;
		this.#chunks = chunks;

		// Nothing needs it yet, but the compile can overlap with whatever follows
		if (!loaded.has(this.#algorithm)) {
			load(this.#algorithm);
		}
	}

	update(data: string | ArrayBufferView | ArrayBuffer, inputEncoding?: BufferEncoding): this {
		if (this.#digested) {
			throw new Error('Digest already called');
		}

		this.#chunks.push(toBytes(data, inputEncoding));

		return this;
	}

	digest(): Buffer;
	digest(encoding: BufferEncoding): string;
	digest(encoding?: BufferEncoding): string | Buffer {
		this.#digested = true;

		const bytes = this.#key
			? digestHmac(this.#algorithm, this.#key, this.#chunks)
			: digestChunks(this.#algorithm, this.#chunks);
		const result = Buffer.from(bytes);

		return encoding ? result.toString(encoding) : result;
	}

	copy(): Hash {
		return new Hash(this.#algorithm, this.#key, [...this.#chunks]);
	}
}

/**
 * Creates a Hash object for the given algorithm
 *
 * Requires the algorithm's WebAssembly to have been compiled; see ready().
 */
export function createHash(algorithm: string): Hash {
	return new Hash(algorithm);
}

/**
 * Creates an Hmac object for the given algorithm and key
 *
 * Requires the algorithm's WebAssembly to have been compiled; see ready().
 */
export function createHmac(algorithm: string, key: string | ArrayBufferView | ArrayBuffer): Hash {
	return new Hash(algorithm, toBytes(key));
}

/**
 * Lists the supported hash algorithms
 *
 * Shorter than the Node.js list, which reports everything the linked OpenSSL
 * offers, and reports only what can actually be computed here.
 */
export function getHashes(): string[] {
	return Object.keys(algorithms).sort();
}

// ============================================================================
// Unsupported Operations
// ============================================================================

const unsupportedError = (method: string) => () => {
	throw new Error(
		`crypto.${method} is not supported in Nova extensions. Nova only provides randomBytes, randomFill, getRandomValues and randomUUID.`,
	);
};

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
	Hash,
	createHash,
	createHmac,
	getHashes,
	ready,
	randomBytes,
	randomFill,
	randomFillSync,
	getRandomValues,
	randomUUID,
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
