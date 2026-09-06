/**
 * Util module compatibility layer for Nova extensions
 *
 * Almost none of this needs Nova: promisify, inherits, format and the type
 * predicates are plain JavaScript that Node.js happens to ship in a built-in.
 * The two that do are TextEncoder and TextDecoder, which JavaScriptCore does
 * not provide, and which are implemented here on top of the Buffer shim.
 *
 * inspect is the one deliberate approximation. Node.js's is thousands of lines
 * and its exact line breaking is not worth reproducing; this covers the shapes
 * that appear in log output and says so where it differs.
 */

import { Buffer } from './buffer.js';

// ============================================================================
// Callbacks and Promises
// ============================================================================

/** Lets a function supply its own promisified form, as child_process does */
const customPromisify = Symbol.for('nodejs.util.promisify.custom');

/** Lets an object describe how it should be inspected */
export const inspectCustom = Symbol.for('nodejs.util.inspect.custom');

type Callback = (error: unknown, ...values: unknown[]) => void;

/**
 * Turns a callback-taking function into one that returns a promise
 *
 * A function carrying the promisify.custom symbol supplies its own version,
 * which is how exec and execFile hand back a child process rather than only
 * their output.
 */
export function promisify(original: (...args: never[]) => unknown): (...args: never[]) => Promise<unknown> {
	const provided = (original as unknown as Record<symbol, unknown>)[customPromisify];

	if (provided) {
		if (typeof provided !== 'function') {
			throw new TypeError('The "util.promisify.custom" property must be of type function.');
		}

		return provided as (...args: never[]) => Promise<unknown>;
	}

	function promisified(this: unknown, ...args: unknown[]): Promise<unknown> {
		return new Promise((resolve, reject) => {
			const callback: Callback = (error, ...values) => {
				if (error) {
					reject(error);
				} else {
					resolve(values[0]);
				}
			};

			(original as unknown as (...args: unknown[]) => unknown).call(this, ...args, callback);
		});
	}

	Object.setPrototypeOf(promisified, Object.getPrototypeOf(original));
	Object.defineProperties(promisified, Object.getOwnPropertyDescriptors(original));

	return promisified as (...args: never[]) => Promise<unknown>;
}

promisify.custom = customPromisify;

/**
 * Turns a promise-returning function into one that takes a callback
 *
 * The callback is always invoked asynchronously, and a rejection with a falsy
 * reason becomes a real Error, because a callback receiving a falsy error means
 * success to every caller.
 */
export function callbackify(
	original: (...args: never[]) => Promise<unknown>,
): (...args: [...never[], Callback]) => void {
	function callbackified(this: unknown, ...args: unknown[]): void {
		const callback = args.pop() as Callback;

		(original as unknown as (...args: unknown[]) => Promise<unknown>).call(this, ...args).then(
			(value) => {
				Promise.resolve().then(() => callback(null, value));
			},
			(reason: unknown) => {
				const error = reason || Object.assign(new Error('Promise was rejected with a falsy value'), { reason });

				Promise.resolve().then(() => callback(error));
			},
		);
	}

	Object.setPrototypeOf(callbackified, Object.getPrototypeOf(original));
	Object.defineProperties(callbackified, Object.getOwnPropertyDescriptors(original));

	return callbackified as (...args: [...never[], Callback]) => void;
}

// ============================================================================
// Inheritance
// ============================================================================

/**
 * Sets up prototypal inheritance between two constructors
 *
 * Predates class syntax and survives in older packages, which also read the
 * super_ property this defines.
 */
export function inherits(
	subclass: (...args: never[]) => unknown,
	superConstructor: (...args: never[]) => unknown,
): void {
	Object.defineProperty(subclass, 'super_', {
		value: superConstructor,
		writable: true,
		configurable: true,
	});

	Object.setPrototypeOf(
		(subclass as unknown as { prototype: object }).prototype,
		(superConstructor as unknown as { prototype: object }).prototype,
	);
}

// ============================================================================
// Inspection
// ============================================================================

export interface InspectOptions {
	depth?: number | null;
	showHidden?: boolean;
	/** Accepted and ignored; Nova's console has no ANSI rendering */
	colors?: boolean;
	breakLength?: number;
	maxArrayLength?: number | null;
	maxStringLength?: number | null;
	sorted?: boolean;
	compact?: boolean | number;
}

/** Keys that can appear unquoted in inspect output */
const plainKey = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function quote(value: string): string {
	const escaped = value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t');

	// Node.js prefers single quotes, switching only when that would need escaping
	return escaped.includes("'") && !escaped.includes('"') ? `"${escaped}"` : `'${escaped.replace(/'/g, "\\'")}'`;
}

function functionLabel(value: (...args: never[]) => unknown): string {
	// Node.js separates a class from its name with a space, a function with a colon
	if (/^class[\s{]/.test(Function.prototype.toString.call(value))) {
		return value.name ? `[class ${value.name}]` : '[class (anonymous)]';
	}

	return value.name ? `[Function: ${value.name}]` : '[Function (anonymous)]';
}

function primitiveLabel(value: unknown): string | null {
	if (value === null) return 'null';
	if (value === undefined) return 'undefined';

	switch (typeof value) {
		case 'string':
			return quote(value);
		case 'number':
			return Object.is(value, -0) ? '-0' : String(value);
		case 'bigint':
			return `${value}n`;
		case 'boolean':
			return String(value);
		case 'symbol':
			return value.toString();
		case 'function':
			return functionLabel(value as (...args: never[]) => unknown);
		default:
			return null;
	}
}

/**
 * Renders a value the way Node.js's console does
 *
 * Differs from Node.js in where it breaks lines and in showing a promise only
 * as pending, because a promise's state cannot be read synchronously.
 */
export function inspect(value: unknown, options: InspectOptions = {}): string {
	const maxDepth = options.depth === null ? Number.POSITIVE_INFINITY : (options.depth ?? 2);
	const breakLength = options.breakLength ?? 80;
	const maxArrayLength = options.maxArrayLength === null ? Number.POSITIVE_INFINITY : (options.maxArrayLength ?? 100);
	const seen = new Set<object>();

	function render(current: unknown, depth: number, indent: string): string {
		const primitive = primitiveLabel(current);

		if (primitive !== null) {
			return primitive;
		}

		const object = current as object;

		if (seen.has(object)) {
			return '[Circular *1]';
		}

		const custom = (object as Record<symbol, unknown>)[inspectCustom];

		if (typeof custom === 'function') {
			const produced = (custom as (depth: number, options: InspectOptions) => unknown).call(
				object,
				maxDepth - depth,
				options,
			);

			return typeof produced === 'string' ? produced : render(produced, depth, indent);
		}

		if (object instanceof Date) {
			return Number.isNaN(object.getTime()) ? 'Invalid Date' : object.toISOString();
		}

		if (object instanceof RegExp) {
			return String(object);
		}

		if (object instanceof Error) {
			return object.stack ?? `${object.name}: ${object.message}`;
		}

		if (typeof Promise !== 'undefined' && object instanceof Promise) {
			// A promise's state is not observable synchronously
			return 'Promise { <pending> }';
		}

		if (depth > maxDepth) {
			return Array.isArray(object) ? '[Array]' : '[Object]';
		}

		seen.add(object);

		try {
			const inner = `${indent}  `;
			const wrap = (prefix: string, parts: string[], open: string, close: string): string => {
				if (parts.length === 0) {
					return prefix ? `${prefix} ${open}${close}` : `${open}${close}`;
				}

				const single = `${prefix}${prefix ? ' ' : ''}${open} ${parts.join(', ')} ${close}`;

				if (single.length + indent.length <= breakLength && !single.includes('\n')) {
					return single;
				}

				return `${prefix}${prefix ? ' ' : ''}${open}\n${inner}${parts.join(`,\n${inner}`)}\n${indent}${close}`;
			};

			if (Array.isArray(object)) {
				const shown = object.slice(0, maxArrayLength).map((entry) => render(entry, depth + 1, inner));
				const hidden = object.length - shown.length;

				if (hidden > 0) {
					shown.push(`... ${hidden} more item${hidden === 1 ? '' : 's'}`);
				}

				return wrap('', [...shown, ...renderExtraKeys(object, depth, inner)], '[', ']');
			}

			if (ArrayBuffer.isView(object) && !(object instanceof DataView)) {
				const typed = object as unknown as { length: number; [index: number]: number };
				const parts = Array.from({ length: Math.min(typed.length, maxArrayLength) }, (_, index) =>
					String(typed[index]),
				);

				return wrap(`${object.constructor.name}(${typed.length})`, parts, '[', ']');
			}

			if (object instanceof Map) {
				const parts = [...object].map(
					([key, entry]) => `${render(key, depth + 1, inner)} => ${render(entry, depth + 1, inner)}`,
				);

				return wrap(`Map(${object.size})`, parts, '{', '}');
			}

			if (object instanceof Set) {
				const parts = [...object].map((entry) => render(entry, depth + 1, inner));

				return wrap(`Set(${object.size})`, parts, '{', '}');
			}

			const prototype = Object.getPrototypeOf(object);
			const name =
				prototype === null
					? '[Object: null prototype]'
					: prototype.constructor && prototype.constructor.name !== 'Object'
						? prototype.constructor.name
						: '';

			return wrap(name, renderEntries(object, depth, inner), '{', '}');
		} finally {
			seen.delete(object);
		}
	}

	function renderEntries(object: object, depth: number, inner: string): string[] {
		const keys = options.showHidden ? Object.getOwnPropertyNames(object) : Object.keys(object);
		const entries = (options.sorted ? [...keys].sort() : keys).map((key) => {
			const label = plainKey.test(key) ? key : quote(key);
			const descriptor = Object.getOwnPropertyDescriptor(object, key);

			if (descriptor && !('value' in descriptor)) {
				return `${label}: ${descriptor.get ? '[Getter]' : '[Setter]'}`;
			}

			return `${label}: ${render((object as Record<string, unknown>)[key], depth + 1, inner)}`;
		});

		for (const key of Object.getOwnPropertySymbols(object)) {
			if (Object.getOwnPropertyDescriptor(object, key)?.enumerable) {
				entries.push(`[${String(key)}]: ${render((object as Record<symbol, unknown>)[key], depth + 1, inner)}`);
			}
		}

		return entries;
	}

	/** Properties set on an array beyond its indices, which Node.js also prints */
	function renderExtraKeys(object: object, depth: number, inner: string): string[] {
		return Object.keys(object)
			.filter((key) => !/^\d+$/.test(key))
			.map(
				(key) =>
					`${plainKey.test(key) ? key : quote(key)}: ${render((object as Record<string, unknown>)[key], depth + 1, inner)}`,
			);
	}

	return render(value, 0, '');
}

inspect.custom = inspectCustom;

const specifiers = /%[sdifjoOc%]/g;

/**
 * Formats a string the way console.log does
 *
 * Arguments left over after the placeholders are appended, which is what makes
 * console.log('a', {b: 1}) print both.
 */
export function formatWithOptions(options: InspectOptions, ...args: unknown[]): string {
	const [first, ...rest] = args;

	if (typeof first !== 'string') {
		return args.map((value) => (typeof value === 'string' ? value : inspect(value, options))).join(' ');
	}

	// With nothing to substitute, Node.js returns the string untouched, which
	// means even '%%' is left alone
	if (rest.length === 0) {
		return first;
	}

	let index = 0;

	const formatted = first.replace(specifiers, (match) => {
		if (match === '%%') {
			return '%';
		}

		if (index >= rest.length) {
			return match;
		}

		const value = rest[index++];

		switch (match) {
			case '%s':
				return typeof value === 'object' && value !== null
					? inspect(value, { ...options, depth: 0 })
					: typeof value === 'bigint'
						? `${value}n`
						: String(value);
			case '%d':
				return typeof value === 'bigint' ? `${value}n` : typeof value === 'symbol' ? 'NaN' : String(Number(value));
			case '%i':
				return typeof value === 'bigint' ? `${value}n` : String(Number.parseInt(String(value), 10));
			case '%f':
				return String(Number.parseFloat(String(value)));
			case '%j':
				try {
					return JSON.stringify(value) ?? 'undefined';
				} catch {
					return '[Circular]';
				}
			case '%o':
				return inspect(value, { ...options, showHidden: true, depth: 4 });
			case '%O':
				return inspect(value, options);
			default:
				// %c is a CSS directive, which has no meaning outside a browser
				return '';
		}
	});

	const remaining = rest.slice(index).map((value) => (typeof value === 'string' ? value : inspect(value, options)));

	return [formatted, ...remaining].join(' ');
}

export function format(...args: unknown[]): string {
	return formatWithOptions({}, ...args);
}

// ============================================================================
// Deep Comparison
// ============================================================================

/**
 * Compares two values the way assert.deepStrictEqual does
 *
 * Uses Object.is for primitives, so NaN equals NaN and 0 does not equal -0, and
 * requires matching prototypes, as the strict variant does.
 */
export function isDeepStrictEqual(left: unknown, right: unknown): boolean {
	return deepEqual(left, right, new Map());
}

function deepEqual(left: unknown, right: unknown, seen: Map<unknown, unknown>): boolean {
	if (Object.is(left, right)) {
		return true;
	}

	if (typeof left !== 'object' || typeof right !== 'object' || left === null || right === null) {
		return false;
	}

	if (Object.getPrototypeOf(left) !== Object.getPrototypeOf(right)) {
		return false;
	}

	// A pair already being compared higher up the stack is equal by assumption
	if (seen.get(left) === right) {
		return true;
	}

	seen.set(left, right);

	try {
		if (left instanceof Date) {
			return left.getTime() === (right as Date).getTime();
		}

		if (left instanceof RegExp) {
			return String(left) === String(right);
		}

		if (ArrayBuffer.isView(left) && ArrayBuffer.isView(right)) {
			const leftBytes = new Uint8Array(left.buffer, left.byteOffset, left.byteLength);
			const rightBytes = new Uint8Array(right.buffer, right.byteOffset, right.byteLength);

			return leftBytes.length === rightBytes.length && leftBytes.every((byte, index) => byte === rightBytes[index]);
		}

		if (left instanceof Map) {
			const other = right as Map<unknown, unknown>;

			return (
				left.size === other.size &&
				[...left].every(([key, value]) => other.has(key) && deepEqual(value, other.get(key), seen))
			);
		}

		if (left instanceof Set) {
			const other = right as Set<unknown>;

			return left.size === other.size && [...left].every((value) => other.has(value));
		}

		const leftKeys = Reflect.ownKeys(left).filter((key) => Object.getOwnPropertyDescriptor(left, key)?.enumerable);
		const rightKeys = Reflect.ownKeys(right).filter((key) => Object.getOwnPropertyDescriptor(right, key)?.enumerable);

		return (
			leftKeys.length === rightKeys.length &&
			leftKeys.every(
				(key) =>
					Object.hasOwn(right, key) &&
					deepEqual((left as Record<PropertyKey, unknown>)[key], (right as Record<PropertyKey, unknown>)[key], seen),
			)
		);
	} finally {
		seen.delete(left);
	}
}

// ============================================================================
// Type Predicates
// ============================================================================

const tagOf = (value: unknown): string => Object.prototype.toString.call(value).slice(8, -1);

export const types = {
	isAnyArrayBuffer: (value: unknown): boolean => tagOf(value) === 'ArrayBuffer' || tagOf(value) === 'SharedArrayBuffer',
	isArrayBuffer: (value: unknown): boolean => tagOf(value) === 'ArrayBuffer',
	isArgumentsObject: (value: unknown): boolean => tagOf(value) === 'Arguments',
	isAsyncFunction: (value: unknown): boolean => tagOf(value) === 'AsyncFunction',
	isBigInt64Array: (value: unknown): boolean => tagOf(value) === 'BigInt64Array',
	isBigUint64Array: (value: unknown): boolean => tagOf(value) === 'BigUint64Array',
	isBoxedPrimitive: (value: unknown): boolean =>
		['Number', 'String', 'Boolean', 'Symbol', 'BigInt'].includes(tagOf(value)) && typeof value === 'object',
	isDataView: (value: unknown): boolean => tagOf(value) === 'DataView',
	isDate: (value: unknown): boolean => tagOf(value) === 'Date',
	isFloat32Array: (value: unknown): boolean => tagOf(value) === 'Float32Array',
	isFloat64Array: (value: unknown): boolean => tagOf(value) === 'Float64Array',
	isGeneratorFunction: (value: unknown): boolean => tagOf(value) === 'GeneratorFunction',
	isGeneratorObject: (value: unknown): boolean => tagOf(value) === 'Generator',
	isInt8Array: (value: unknown): boolean => tagOf(value) === 'Int8Array',
	isInt16Array: (value: unknown): boolean => tagOf(value) === 'Int16Array',
	isInt32Array: (value: unknown): boolean => tagOf(value) === 'Int32Array',
	isMap: (value: unknown): boolean => tagOf(value) === 'Map',
	isMapIterator: (value: unknown): boolean => tagOf(value) === 'Map Iterator',
	isNativeError: (value: unknown): boolean => value instanceof Error && tagOf(value) === 'Error',
	isPromise: (value: unknown): boolean => tagOf(value) === 'Promise',
	// Nova has no way to tell a proxy from its target
	isProxy: (): boolean => false,
	isRegExp: (value: unknown): boolean => tagOf(value) === 'RegExp',
	isSet: (value: unknown): boolean => tagOf(value) === 'Set',
	isSetIterator: (value: unknown): boolean => tagOf(value) === 'Set Iterator',
	isSharedArrayBuffer: (value: unknown): boolean => tagOf(value) === 'SharedArrayBuffer',
	isTypedArray: (value: unknown): boolean => ArrayBuffer.isView(value) && !(value instanceof DataView),
	isUint8Array: (value: unknown): boolean => tagOf(value) === 'Uint8Array',
	isUint8ClampedArray: (value: unknown): boolean => tagOf(value) === 'Uint8ClampedArray',
	isUint16Array: (value: unknown): boolean => tagOf(value) === 'Uint16Array',
	isUint32Array: (value: unknown): boolean => tagOf(value) === 'Uint32Array',
	isWeakMap: (value: unknown): boolean => tagOf(value) === 'WeakMap',
	isWeakSet: (value: unknown): boolean => tagOf(value) === 'WeakSet',
};

// ============================================================================
// Diagnostics
// ============================================================================

/**
 * Wraps a function so that calling it warns once
 */
export function deprecate<T extends (...args: never[]) => unknown>(fn: T, message: string, code?: string): T {
	let warned = false;

	function deprecated(this: unknown, ...args: unknown[]): unknown {
		if (!warned) {
			warned = true;
			console.warn(code ? `[${code}] DeprecationWarning: ${message}` : `DeprecationWarning: ${message}`);
		}

		return (fn as unknown as (...args: unknown[]) => unknown).apply(this, args);
	}

	return deprecated as unknown as T;
}

/**
 * Returns a logger that is silent unless NODE_DEBUG names its section
 *
 * Reads nova.environment directly rather than the process shim, so that
 * importing util does not drag the process shim in behind it.
 */
export function debuglog(section: string): ((...args: unknown[]) => void) & { enabled: boolean } {
	const configured = nova.environment.NODE_DEBUG ?? '';
	const enabled = configured
		.split(',')
		.map((entry) => entry.trim().toLowerCase())
		.includes(section.toLowerCase());

	const log = enabled
		? (...args: unknown[]) => console.log(`${section.toUpperCase()}: ${format(...args)}`)
		: () => undefined;

	return Object.assign(log, { enabled });
}

export const debug = debuglog;

/** Removes ANSI escape sequences, which Nova's console renders literally */
export function stripVTControlCharacters(value: string): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: matching escape sequences is the point
	return value.replace(/\u001B\[[0-9;]*[A-Za-z]/g, '');
}

// ============================================================================
// Text Encoding
// ============================================================================

/**
 * Encodes strings as UTF-8 bytes
 *
 * JavaScriptCore provides no TextEncoder, so this is built on the Buffer shim,
 * which carries its own UTF-8 implementation for the same reason.
 */
export class TextEncoder {
	readonly encoding = 'utf-8';

	encode(input = ''): Uint8Array {
		return new Uint8Array(Buffer.from(input, 'utf8'));
	}

	encodeInto(input: string, destination: Uint8Array): { read: number; written: number } {
		const encoded = this.encode(input);
		const written = Math.min(encoded.length, destination.length);

		destination.set(encoded.subarray(0, written));

		// Reporting the whole input as read is only right when it all fit
		return { read: written === encoded.length ? input.length : written, written };
	}
}

/**
 * Decodes UTF-8 bytes as a string
 *
 * Only UTF-8 is supported. Any other encoding throws rather than silently
 * mis-decoding, which is the failure that would be hardest to trace.
 */
export class TextDecoder {
	readonly encoding: string;
	readonly fatal: boolean;
	readonly ignoreBOM: boolean;

	constructor(encoding = 'utf-8', options: { fatal?: boolean; ignoreBOM?: boolean } = {}) {
		const normalized = encoding.toLowerCase();

		if (normalized !== 'utf-8' && normalized !== 'utf8' && normalized !== 'unicode-1-1-utf-8') {
			throw new RangeError(`The "${encoding}" encoding is not supported in Nova extensions, which only decode UTF-8.`);
		}

		this.encoding = 'utf-8';
		this.fatal = options.fatal ?? false;
		this.ignoreBOM = options.ignoreBOM ?? false;
	}

	decode(input?: ArrayBufferView | ArrayBuffer): string {
		if (input === undefined) {
			return '';
		}

		const bytes = ArrayBuffer.isView(input)
			? new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
			: new Uint8Array(input);
		const decoded = Buffer.from(bytes).toString('utf8');

		return !this.ignoreBOM && decoded.charCodeAt(0) === 0xfeff ? decoded.slice(1) : decoded;
	}
}

// ============================================================================
// Default Export
// ============================================================================

export default {
	TextDecoder,
	TextEncoder,
	callbackify,
	debug,
	debuglog,
	deprecate,
	format,
	formatWithOptions,
	inherits,
	inspect,
	isDeepStrictEqual,
	promisify,
	stripVTControlCharacters,
	types,
};
