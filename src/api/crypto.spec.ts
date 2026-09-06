/**
 * The crypto shim's hashing, compared against node:crypto
 *
 * Every supported algorithm is checked across several input shapes, every
 * digest encoding, and three HMAC key lengths - short, exactly one block, and
 * longer than a block - because the HMAC is hand-rolled rather than delegated.
 */

import assert from 'node:assert';
import nodeCrypto from 'node:crypto';
import { installNova } from './nova.js';

installNova({
	crypto: {
		getRandomValues: (array: Parameters<typeof nodeCrypto.webcrypto.getRandomValues>[0]) =>
			nodeCrypto.webcrypto.getRandomValues(array),
		randomUUID: () => nodeCrypto.randomUUID(),
	},
});

const shim = (await import('./crypto.ts')).default;

function eq(actual: unknown, expected: unknown, label: string): void {
	assert.deepStrictEqual(actual, expected, label);
}

const nodeHashes = new Set(nodeCrypto.getHashes());

// Compiling the WebAssembly is asynchronous, and has to happen before the first
// digest rather than during it. This is the call an extension makes on activate.
beforeAll(async () => {
	await shim.ready();
});

describe('before ready()', () => {
	it('fails loudly rather than returning something wrong', async () => {
		// A fresh copy of the module, in which nothing has been compiled yet
		vi.resetModules();

		const fresh = (await import('./crypto.ts')).default;

		assert.throws(() => fresh.createHash('sha256').update('x').digest('hex'), /has not finished loading/);
	});
});

describe('hashing', () => {
	const algorithms = shim.getHashes().filter((algorithm) => nodeHashes.has(algorithm));

	const inputs = ['', 'abc', 'hello world', 'a'.repeat(1000), 'ünïcödé 👋 multi-byte', ' ÿ binary-ish'];

	it('has an algorithm list this Node build can verify in full', () => {
		eq(
			shim.getHashes().filter((algorithm) => !nodeHashes.has(algorithm)),
			[],
			'every supported algorithm can be compared against Node',
		);
	});

	it.each(algorithms)('%s digests the same bytes as Node', (algorithm) => {
		for (const input of inputs) {
			eq(
				shim.createHash(algorithm).update(input).digest('hex'),
				nodeCrypto.createHash(algorithm).update(input).digest('hex'),
				`${algorithm} of ${input.length} chars`,
			);
		}

		const bytes = new Uint8Array([0, 1, 2, 250, 251, 255]);

		eq(
			shim.createHash(algorithm).update(bytes).digest('hex'),
			nodeCrypto.createHash(algorithm).update(bytes).digest('hex'),
			`${algorithm} of raw bytes`,
		);
	});

	it.each(algorithms)('%s accumulates chained updates', (algorithm) => {
		eq(
			shim.createHash(algorithm).update('one').update('two').update('three').digest('hex'),
			nodeCrypto.createHash(algorithm).update('onetwothree').digest('hex'),
			`${algorithm} chained updates`,
		);
	});

	it.each(algorithms)('%s produces the same HMAC as Node', (algorithm) => {
		for (const key of ['k', 'x'.repeat(64), 'y'.repeat(200)]) {
			let expected: string;

			try {
				expected = nodeCrypto.createHmac(algorithm, key).update('message').digest('hex');
			} catch {
				// This Node build has no HMAC for this algorithm
				continue;
			}

			eq(
				shim.createHmac(algorithm, key).update('message').digest('hex'),
				expected,
				`hmac-${algorithm} with a ${key.length}-byte key`,
			);
		}
	});
});

describe('digest output', () => {
	const expected = nodeCrypto.createHash('sha256').update('abc').digest();

	it.each(['hex', 'base64', 'base64url', 'latin1'] as const)('encodes a digest as %s', (encoding) => {
		eq(shim.createHash('sha256').update('abc').digest(encoding), expected.toString(encoding), `digest('${encoding}')`);
	});

	it('returns a Buffer when no encoding is given', () => {
		const digest = shim.createHash('sha256').update('abc').digest();

		eq(digest instanceof Uint8Array, true, 'digest() returns a Buffer');
		eq([...digest], [...expected], 'holding the same bytes as Node');
	});

	it('honours an input encoding', () => {
		eq(
			shim.createHash('sha256').update('616263', 'hex').digest('hex'),
			nodeCrypto.createHash('sha256').update('616263', 'hex').digest('hex'),
			'update with an encoding',
		);
	});
});

describe('copy', () => {
	it('forks the state independently', () => {
		const base = shim.createHash('sha256').update('prefix');

		eq(
			base.copy().update('-a').digest('hex'),
			nodeCrypto.createHash('sha256').update('prefix-a').digest('hex'),
			'a copy continues from the same state',
		);
		eq(
			base.copy().update('-b').digest('hex'),
			nodeCrypto.createHash('sha256').update('prefix-b').digest('hex'),
			'and copies do not affect one another',
		);
	});
});

describe('algorithm names and errors', () => {
	it('resolves names case-insensitively and through aliases', () => {
		const expected = shim.createHash('sha256').update('abc').digest('hex');

		eq(shim.createHash('SHA256').update('abc').digest('hex'), expected, 'names are case-insensitive');
		eq(shim.createHash('sha-256').update('abc').digest('hex'), expected, 'an OpenSSL alias resolves');
	});

	it('rejects an unknown algorithm', () => {
		assert.throws(() => shim.createHash('nope'), /Digest method not supported/);
	});

	it('rejects an update after the digest, as Node does', () => {
		assert.throws(() => {
			const hash = shim.createHash('sha256');

			hash.digest('hex');
			hash.update('late');
		}, /Digest already called/);
	});
});
