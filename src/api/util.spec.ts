/**
 * The util shim, compared against node:util
 */

import assert from 'node:assert';
import nodeUtil from 'node:util';
import { installNova } from './nova.js';

installNova({ environment: { NODE_DEBUG: 'demo' } });

const util = (await import('./util.ts')).default;

function eq(actual: unknown, expected: unknown, label: string): void {
	assert.deepStrictEqual(actual, expected, label);
}

describe('promisify', () => {
	it('resolves and rejects like Node', async () => {
		const readish = (value: string, callback: (error: Error | null, result?: string) => void) =>
			setTimeout(() => callback(null, `got ${value}`), 0);
		const failing = (callback: (error: Error) => void) => setTimeout(() => callback(new Error('nope')), 0);

		const promisified = util.promisify(readish) as (value: string) => Promise<string>;

		eq(await promisified('x'), await nodeUtil.promisify(readish)('x'), 'resolves like Node');
		await assert.rejects(util.promisify(failing)(), /nope/);
	});

	it('honours the custom symbol, which is the one Node uses', async () => {
		const custom = (() => {}) as unknown as Record<symbol, unknown>;

		custom[Symbol.for('nodejs.util.promisify.custom')] = async () => 'custom';

		eq(await util.promisify(custom as never)(), 'custom', 'the custom implementation wins');
		eq(util.promisify.custom, nodeUtil.promisify.custom, "and the symbol is Node's own");
	});

	it('returns the promisified form the exec shim registers', async () => {
		const { exec } = await import('./child_process.ts');

		eq(typeof util.promisify(exec), 'function', 'exec can be promisified');
		eq(
			util.promisify(exec) === (exec as unknown as Record<symbol, unknown>)[Symbol.for('nodejs.util.promisify.custom')],
			true,
			'and the result is the form exec registered',
		);
	});
});

describe('callbackify', () => {
	it('passes a value through', async () => {
		const succeed = async () => 'value';

		eq(
			await new Promise((resolve) => util.callbackify(succeed)((error, value) => resolve([error, value]))),
			[null, 'value'],
			'callbackify passes a value through',
		);
	});

	it('passes a rejection through', async () => {
		const fail = async () => {
			throw new Error('bad');
		};

		const [error] = (await new Promise<unknown[]>((resolve) => {
			util.callbackify(fail)((...args) => resolve(args));
		})) as [Error];

		eq(error.message, 'bad', 'callbackify passes a rejection through');
	});
});

describe('inherits', () => {
	it('links the prototypes and records the parent', () => {
		function Parent() {}
		Parent.prototype.greet = () => 'hello';

		function Child() {}

		util.inherits(Child, Parent);

		const Constructable = Child as unknown as new () => { greet(): string };

		eq(new Constructable().greet(), 'hello', 'the prototype is linked');
		eq((Child as unknown as { super_: unknown }).super_, Parent, 'super_ points at the parent');
	});
});

describe('format', () => {
	it.each([
		['%s hello', 'world'],
		['%d apples', 42],
		['%i', '42.9'],
		['%f', '1.5'],
		['%j', { a: 1 }],
		['%s', null],
		['%s', undefined],
		['%s', 123n],
		['%d', 123n],
		['100%% sure'],
		['%s and %s', 'a'],
		['just a string'],
		['with extras', 'a', 'b'],
		['%s', 'x', 'leftover'],
	])('formats %s the way Node does', (...args) => {
		eq(util.format(...args), nodeUtil.format(...args), 'format');
	});

	it('formats a non-string first argument the way Node does', () => {
		eq(util.format(1, 2), nodeUtil.format(1, 2), 'format');
	});
});

describe('inspect', () => {
	it.each([
		'a string',
		42,
		-0,
		true,
		null,
		undefined,
		123n,
		Symbol('sym'),
		[1, 2, 3],
		[],
		{},
		{ a: 1, b: 'two' },
		{ 'needs-quotes': 1 },
		{ nested: { deep: { deeper: 1 } } },
		new Map([['a', 1]]),
		new Set([1, 2]),
		new Date('2020-01-01T00:00:00.000Z'),
		/pattern/gi,
		new Uint8Array([1, 2, 3]),
		[1, [2, [3, [4]]]],
	])('renders %s the way Node does', (value) => {
		eq(util.inspect(value), nodeUtil.inspect(value), 'inspect');
	});

	it('labels functions and classes', () => {
		eq(
			util.inspect(function named() {}),
			'[Function: named]',
			'a function gets a colon',
		);
		eq(util.inspect(class Foo {}), '[class Foo]', 'a class does not');
	});

	it('reports a circular reference rather than chasing it', () => {
		const circular: Record<string, unknown> = { name: 'root' };
		circular.self = circular;

		assert.match(util.inspect(circular), /Circular/);
	});

	it('honours the depth option', () => {
		const value = { a: { b: { c: { d: 1 } } } };

		eq(util.inspect(value, { depth: 1 }), nodeUtil.inspect(value, { depth: 1 }), 'inspect with depth');
	});

	it('honours the custom inspect symbol', () => {
		eq(util.inspect({ [Symbol.for('nodejs.util.inspect.custom')]: () => 'CUSTOM' }), 'CUSTOM', 'inspect');
	});
});

describe('isDeepStrictEqual', () => {
	it.each([
		[{ a: 1 }, { a: 1 }, true],
		[{ a: 1 }, { a: 2 }, false],
		[{ a: 1 }, { a: '1' }, false],
		[[1, 2], [1, 2], true],
		[[1, 2], [2, 1], false],
		[Number.NaN, Number.NaN, true],
		[0, -0, false],
		[new Date(5), new Date(5), true],
		[new Map([['a', 1]]), new Map([['a', 1]]), true],
		[new Set([1]), new Set([1]), true],
		[new Set([1]), new Set([2]), false],
		[/x/g, /x/g, true],
		[/x/g, /x/i, false],
		[new Uint8Array([1, 2]), new Uint8Array([1, 2]), true],
		[new Uint8Array([1, 2]), new Uint8Array([1, 3]), false],
		[{ a: { b: [1, { c: 2 }] } }, { a: { b: [1, { c: 2 }] } }, true],
		[null, undefined, false],
		[{}, [], false],
	])('compares %s with %s', (left, right, expected) => {
		eq(util.isDeepStrictEqual(left, right), nodeUtil.isDeepStrictEqual(left, right), 'agrees with Node');
		eq(util.isDeepStrictEqual(left, right), expected, 'and is right');
	});

	it('terminates on self-referencing structures', () => {
		const left: Record<string, unknown> = { name: 'a' };
		const right: Record<string, unknown> = { name: 'a' };

		left.self = left;
		right.self = right;

		eq(util.isDeepStrictEqual(left, right), nodeUtil.isDeepStrictEqual(left, right), 'cycles');
	});
});

describe('types', () => {
	it.each([
		['isDate', new Date()],
		['isRegExp', /x/],
		['isMap', new Map()],
		['isSet', new Set()],
		['isPromise', Promise.resolve()],
		['isTypedArray', new Uint8Array()],
		['isUint8Array', new Uint8Array()],
		['isArrayBuffer', new ArrayBuffer(1)],
		['isDataView', new DataView(new ArrayBuffer(1))],
		['isAsyncFunction', async () => {}],
		['isGeneratorFunction', function* gen() {}],
		['isNativeError', new TypeError('x')],
		['isWeakMap', new WeakMap()],
		['isBoxedPrimitive', new Number(1)],
	] as const)('types.%s agrees with Node', (predicate, value) => {
		const mine = util.types as unknown as Record<string, (value: unknown) => boolean>;
		const theirs = nodeUtil.types as unknown as Record<string, (value: unknown) => boolean>;

		eq(mine[predicate]?.(value), true, `${predicate} recognises its type`);
		eq(mine[predicate]?.(null), theirs[predicate]?.(null), `${predicate} rejects null as Node does`);
		eq(mine[predicate]?.({}), theirs[predicate]?.({}), `${predicate} rejects a plain object as Node does`);
	});
});

describe('TextEncoder and TextDecoder', () => {
	const encoder = new util.TextEncoder();
	const decoder = new util.TextDecoder();

	it.each(['', 'hello', 'ünïcödé', '👋 emoji', 'a'.repeat(500)])('round trips %s', (text) => {
		const encoded = encoder.encode(text);

		eq([...encoded], [...new TextEncoder().encode(text)], 'encoding matches Node');
		eq(decoder.decode(encoded), text, 'decoding round trips');
	});

	it('reports its encoding and handles empty input', () => {
		eq(encoder.encoding, 'utf-8', 'the encoder reports utf-8');
		eq(decoder.decode(), '', 'decoding nothing yields an empty string');
	});

	it('strips a BOM unless told not to', () => {
		eq(decoder.decode(new Uint8Array([0xef, 0xbb, 0xbf, 0x61])), 'a', 'the BOM is stripped by default');
		eq(
			new util.TextDecoder('utf-8', { ignoreBOM: true }).decode(new Uint8Array([0xef, 0xbb, 0xbf, 0x61])).length,
			2,
			'ignoreBOM keeps it',
		);
	});

	it('rejects an encoding it cannot decode rather than guessing', () => {
		assert.throws(() => new util.TextDecoder('latin1'), /only decode UTF-8/);
	});

	it('reports what fitted from encodeInto', () => {
		eq(encoder.encodeInto('abcdef', new Uint8Array(3)), { read: 3, written: 3 }, 'encodeInto');
	});
});

describe('deprecate and debuglog', () => {
	it('warns exactly once, and keeps working', () => {
		const warnings: string[] = [];
		const original = console.warn;

		console.warn = (message: string) => warnings.push(message);

		const deprecated = util.deprecate(() => 'result', 'do not use this');

		eq(deprecated(), 'result', 'a deprecated function still works');
		eq(deprecated(), 'result', 'and keeps working');

		console.warn = original;

		eq(warnings.length, 1, 'the deprecation warns exactly once');
		assert.match(warnings[0] as string, /do not use this/);
	});

	it('enables only the sections NODE_DEBUG names', () => {
		eq(util.debuglog('demo').enabled, true, 'the named section is enabled');
		eq(util.debuglog('other').enabled, false, 'others are not');
	});
});
