/**
 * Buffer compatibility layer for Nova extensions
 *
 * Nova has no Buffer, and none of the primitives Buffer is usually built on
 * either: TextEncoder and TextDecoder are DOM APIs that JavaScriptCore does
 * not expose to extensions. Only atob and btoa are available, which cover
 * base64 and nothing else, so the UTF-8 codec here is written by hand.
 *
 * Buffer extends Uint8Array in Node.js, and so does this, which means the
 * inherited half of the API (set, subarray, iteration, sort, the numeric
 * indexer) comes for free and behaves identically.
 */

export type BufferEncoding =
	| 'ascii'
	| 'base64'
	| 'base64url'
	| 'binary'
	| 'hex'
	| 'latin1'
	| 'ucs-2'
	| 'ucs2'
	| 'utf-8'
	| 'utf-16le'
	| 'utf16le'
	| 'utf8';

// ============================================================================
// Encodings
// ============================================================================

const encodingAliases: Record<string, string> = {
	ascii: 'ascii',
	base64: 'base64',
	base64url: 'base64url',
	binary: 'latin1',
	hex: 'hex',
	latin1: 'latin1',
	'ucs-2': 'utf16le',
	ucs2: 'utf16le',
	'utf-8': 'utf8',
	'utf-16le': 'utf16le',
	utf16le: 'utf16le',
	utf8: 'utf8',
};

function normalizeEncoding(encoding = 'utf8'): string {
	const normalized = encodingAliases[encoding.toLowerCase()];

	if (!normalized) {
		const error = new TypeError(`Unknown encoding: ${encoding}`) as TypeError & { code: string };

		error.code = 'ERR_UNKNOWN_ENCODING';

		throw error;
	}

	return normalized;
}

/**
 * Encode a string as UTF-8 bytes
 */
function encodeUtf8(value: string): Uint8Array {
	const bytes: number[] = [];

	for (const character of value) {
		const code = character.codePointAt(0) as number;

		if (code < 0x80) {
			bytes.push(code);
		} else if (code < 0x800) {
			bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
		} else if (code < 0x10000) {
			bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
		} else {
			bytes.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 0x3f), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
		}
	}

	return Uint8Array.from(bytes);
}

/**
 * Decode UTF-8 bytes into a string
 *
 * Malformed sequences become U+FFFD, as they do in Node.js. The number of
 * replacement characters emitted for a given run of invalid bytes is not
 * guaranteed to match Node.js exactly; well-formed input always round-trips.
 */
function decodeUtf8(bytes: Uint8Array): string {
	let result = '';
	let index = 0;

	while (index < bytes.length) {
		const byte = bytes[index++] as number;

		if (byte < 0x80) {
			result += String.fromCharCode(byte);
			continue;
		}

		let code: number;
		let following: number;

		if ((byte & 0xe0) === 0xc0) {
			code = byte & 0x1f;
			following = 1;
		} else if ((byte & 0xf0) === 0xe0) {
			code = byte & 0x0f;
			following = 2;
		} else if ((byte & 0xf8) === 0xf0) {
			code = byte & 0x07;
			following = 3;
		} else {
			result += '�';
			continue;
		}

		if (index + following > bytes.length) {
			result += '�';
			break;
		}

		let valid = true;

		for (let step = 0; step < following; step++) {
			const continuation = bytes[index + step] as number;

			if ((continuation & 0xc0) !== 0x80) {
				valid = false;
				break;
			}

			code = (code << 6) | (continuation & 0x3f);
		}

		if (!valid) {
			result += '�';
			continue;
		}

		index += following;

		// Surrogates and out-of-range code points are not valid UTF-8
		result += code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff) ? '�' : String.fromCodePoint(code);
	}

	return result;
}

/**
 * Convert bytes to a string of one character per byte, as atob and btoa expect
 */
function toBinaryString(bytes: Uint8Array): string {
	// ponytail: chunked to stay clear of the argument limit on large buffers
	const chunkSize = 0x8000;
	let result = '';

	for (let offset = 0; offset < bytes.length; offset += chunkSize) {
		result += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
	}

	return result;
}

function decodeString(value: string, encoding: string): Uint8Array {
	switch (encoding) {
		case 'utf8':
			return encodeUtf8(value);

		case 'hex': {
			// Node.js stops at the first character that is not a hex digit
			const match = /^(?:[\da-fA-F]{2})*/.exec(value)?.[0] ?? '';
			const bytes = new Uint8Array(match.length / 2);

			for (let index = 0; index < bytes.length; index++) {
				bytes[index] = Number.parseInt(match.substr(index * 2, 2), 16);
			}

			return bytes;
		}

		case 'base64':
		case 'base64url': {
			// Node.js ignores characters outside the alphabet and tolerates missing padding
			let normalized = value
				.replace(/[^A-Za-z\d+/\-_]/g, '')
				.replace(/-/g, '+')
				.replace(/_/g, '/');

			normalized = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');

			try {
				return Uint8Array.from(atob(normalized), (character) => character.charCodeAt(0));
			} catch {
				return new Uint8Array(0);
			}
		}

		// Encoding to ascii is identical to latin1 in Node.js; only decoding
		// strips the high bit
		case 'latin1':
		case 'ascii': {
			// Indexed rather than iterated, because latin1 works on UTF-16 code
			// units and iteration would collapse a surrogate pair into one byte
			const bytes = new Uint8Array(value.length);

			for (let index = 0; index < value.length; index++) {
				bytes[index] = value.charCodeAt(index) & 0xff;
			}

			return bytes;
		}

		case 'utf16le': {
			const bytes = new Uint8Array(value.length * 2);
			const view = new DataView(bytes.buffer);

			for (let index = 0; index < value.length; index++) {
				view.setUint16(index * 2, value.charCodeAt(index), true);
			}

			return bytes;
		}

		default:
			return encodeUtf8(value);
	}
}

function encodeBytes(bytes: Uint8Array, encoding: string): string {
	switch (encoding) {
		case 'utf8':
			return decodeUtf8(bytes);

		case 'hex':
			return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');

		case 'base64':
			return btoa(toBinaryString(bytes));

		case 'base64url':
			return btoa(toBinaryString(bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

		case 'latin1':
			return toBinaryString(bytes);

		case 'ascii':
			return toBinaryString(Uint8Array.from(bytes, (byte) => byte & 0x7f));

		case 'utf16le': {
			const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
			let result = '';

			// A trailing odd byte is dropped, as it is in Node.js
			for (let offset = 0; offset + 1 < bytes.byteLength + 1 && offset + 2 <= bytes.byteLength; offset += 2) {
				result += String.fromCharCode(view.getUint16(offset, true));
			}

			return result;
		}

		default:
			return decodeUtf8(bytes);
	}
}

// ============================================================================
// Buffer
// ============================================================================

export class Buffer extends Uint8Array {
	#view: DataView | undefined;

	get #data(): DataView {
		this.#view ??= new DataView(this.buffer, this.byteOffset, this.byteLength);

		return this.#view;
	}

	// --------------------------------------------------------------------------
	// Construction
	// --------------------------------------------------------------------------

	static override from(value: string, encoding?: BufferEncoding): Buffer;
	static override from(value: ArrayLike<number> | ArrayBufferLike | Iterable<number>): Buffer;
	static override from(value: ArrayBufferLike, byteOffset?: number, length?: number): Buffer;
	static override from<T>(
		value: ArrayLike<T> | Iterable<T>,
		mapfn: (v: T, k: number) => number,
		thisArg?: unknown,
	): Buffer;
	static override from(
		value: string | ArrayLike<number> | ArrayBufferLike | Iterable<number> | { type?: string; data?: number[] },
		encodingOrOffsetOrMapfn?: BufferEncoding | number | ((v: never, k: number) => number),
		lengthOrThisArg?: number | unknown,
	): Buffer {
		if (typeof value === 'string') {
			const bytes = decodeString(value, normalizeEncoding(encodingOrOffsetOrMapfn as string | undefined));

			return new Buffer(bytes.buffer as ArrayBuffer, bytes.byteOffset, bytes.byteLength);
		}

		// The mapfn overload inherited from Uint8Array
		if (typeof encodingOrOffsetOrMapfn === 'function') {
			const mapped = Uint8Array.from(
				value as Iterable<never>,
				encodingOrOffsetOrMapfn as (v: never, k: number) => number,
				lengthOrThisArg,
			);

			return new Buffer(mapped.buffer as ArrayBuffer, mapped.byteOffset, mapped.byteLength);
		}

		if (
			value instanceof ArrayBuffer ||
			(typeof SharedArrayBuffer !== 'undefined' && value instanceof SharedArrayBuffer)
		) {
			const offset = (encodingOrOffsetOrMapfn as number) ?? 0;
			const length = (lengthOrThisArg as number) ?? value.byteLength - offset;

			// A view onto the same memory, not a copy, as in Node.js
			return new Buffer(value as ArrayBuffer, offset, length);
		}

		// The { type: 'Buffer', data: [...] } shape produced by toJSON
		const source =
			value && typeof value === 'object' && 'data' in value && Array.isArray(value.data)
				? value.data
				: (value as ArrayLike<number> | Iterable<number>);

		const bytes = Uint8Array.from(source as ArrayLike<number>);

		return new Buffer(bytes.buffer as ArrayBuffer, bytes.byteOffset, bytes.byteLength);
	}

	/**
	 * Allocate a zero-filled buffer
	 */
	static alloc(size: number, fill?: string | number | Uint8Array, encoding?: BufferEncoding): Buffer {
		assertSize(size);

		const buffer = new Buffer(size);

		if (fill !== undefined && fill !== 0) {
			buffer.fill(fill, 0, size, encoding);
		}

		return buffer;
	}

	/**
	 * Allocate a buffer without zeroing it
	 *
	 * There is no uninitialised allocation available here, so this is an alias
	 * for alloc. That is slower than Node.js but never less safe.
	 */
	static allocUnsafe(size: number): Buffer {
		assertSize(size);

		return new Buffer(size);
	}

	static allocUnsafeSlow(size: number): Buffer {
		return Buffer.allocUnsafe(size);
	}

	static concat(list: readonly Uint8Array[], totalLength?: number): Buffer {
		const length = totalLength ?? list.reduce((sum, item) => sum + item.length, 0);
		const result = new Buffer(length);
		let offset = 0;

		for (const item of list) {
			if (offset >= length) break;

			result.set(item.subarray(0, length - offset), offset);
			offset += item.length;
		}

		return result;
	}

	// --------------------------------------------------------------------------
	// Static helpers
	// --------------------------------------------------------------------------

	static isBuffer(value: unknown): value is Buffer {
		return value instanceof Buffer;
	}

	static isEncoding(encoding: string): boolean {
		return typeof encoding === 'string' && encoding.toLowerCase() in encodingAliases;
	}

	/**
	 * Number of bytes needed to encode a string
	 *
	 * Node.js estimates this from the string length rather than encoding it, so
	 * for hex and base64 the answer can exceed what Buffer.from actually
	 * produces from malformed input. That discrepancy is reproduced here on
	 * purpose, because packages size their buffers with it.
	 */
	static byteLength(value: string | Uint8Array | ArrayBufferLike, encoding?: BufferEncoding): number {
		if (typeof value !== 'string') {
			return 'byteLength' in value ? value.byteLength : (value as Uint8Array).length;
		}

		switch (normalizeEncoding(encoding)) {
			case 'latin1':
			case 'ascii':
				return value.length;

			case 'utf16le':
				return value.length * 2;

			case 'hex':
				return value.length >>> 1;

			case 'base64':
			case 'base64url': {
				let length = value.length;

				if (value.charCodeAt(length - 1) === 0x3d) length--;
				if (length > 1 && value.charCodeAt(length - 1) === 0x3d) length--;

				return (length * 3) >>> 2;
			}

			default:
				return encodeUtf8(value).length;
		}
	}

	static compare(a: Uint8Array, b: Uint8Array): -1 | 0 | 1 {
		return compareBytes(a, b);
	}

	// --------------------------------------------------------------------------
	// Conversion
	// --------------------------------------------------------------------------

	override toString(encoding?: BufferEncoding, start = 0, end = this.length): string {
		return encodeBytes(this.subarray(start, end), normalizeEncoding(encoding));
	}

	toJSON(): { type: 'Buffer'; data: number[] } {
		return { type: 'Buffer', data: Array.from(this) };
	}

	// --------------------------------------------------------------------------
	// Comparison
	// --------------------------------------------------------------------------

	equals(other: Uint8Array): boolean {
		return compareBytes(this, other) === 0;
	}

	compare(
		target: Uint8Array,
		targetStart = 0,
		targetEnd = target.length,
		sourceStart = 0,
		sourceEnd = this.length,
	): -1 | 0 | 1 {
		return compareBytes(this.subarray(sourceStart, sourceEnd), target.subarray(targetStart, targetEnd));
	}

	// --------------------------------------------------------------------------
	// Copying and searching
	// --------------------------------------------------------------------------

	copy(target: Uint8Array, targetStart = 0, sourceStart = 0, sourceEnd = this.length): number {
		const source = this.subarray(sourceStart, sourceEnd).subarray(0, target.length - targetStart);

		target.set(source, targetStart);

		return source.length;
	}

	/**
	 * Node.js buf.slice returns a view onto the same memory, unlike the copy
	 * that Uint8Array.prototype.slice makes
	 */
	override slice(start?: number, end?: number): Buffer {
		return this.subarray(start, end);
	}

	override subarray(start?: number, end?: number): Buffer {
		return super.subarray(start, end) as Buffer;
	}

	override fill(value: string | number | Uint8Array, offset = 0, end = this.length, encoding?: BufferEncoding): this {
		if (typeof value === 'number') {
			return super.fill(value & 0xff, offset, end);
		}

		const bytes = typeof value === 'string' ? decodeString(value, normalizeEncoding(encoding)) : value;

		if (bytes.length === 0) {
			return super.fill(0, offset, end);
		}

		for (let index = offset; index < end; index++) {
			this[index] = bytes[(index - offset) % bytes.length] as number;
		}

		return this;
	}

	override indexOf(value: string | number | Uint8Array, byteOffset = 0, encoding?: BufferEncoding): number {
		return search(this, value, byteOffset, encoding, false);
	}

	override lastIndexOf(value: string | number | Uint8Array, byteOffset?: number, encoding?: BufferEncoding): number {
		return search(this, value, byteOffset ?? this.length, encoding, true);
	}

	override includes(value: string | number | Uint8Array, byteOffset = 0, encoding?: BufferEncoding): boolean {
		return this.indexOf(value, byteOffset, encoding) !== -1;
	}

	write(
		value: string,
		offset: number | BufferEncoding = 0,
		length?: number | BufferEncoding,
		encoding?: BufferEncoding,
	): number {
		// Node.js also accepts write(string, encoding) and write(string, offset, encoding)
		const start = typeof offset === 'number' ? offset : 0;
		const limit = typeof length === 'number' ? length : undefined;
		const chosen = typeof offset === 'string' ? offset : typeof length === 'string' ? length : encoding;

		const bytes = decodeString(value, normalizeEncoding(chosen));
		const writable = Math.min(limit ?? bytes.length, bytes.length, this.length - start);

		this.set(bytes.subarray(0, writable), start);

		return writable;
	}

	// --------------------------------------------------------------------------
	// Numeric accessors
	//
	// Delegated to a DataView over the same memory, which enforces the bounds
	// and byte order for us.
	// --------------------------------------------------------------------------

	readUInt8(offset = 0): number {
		return this.#data.getUint8(offset);
	}

	readUInt16LE(offset = 0): number {
		return this.#data.getUint16(offset, true);
	}

	readUInt16BE(offset = 0): number {
		return this.#data.getUint16(offset, false);
	}

	readUInt32LE(offset = 0): number {
		return this.#data.getUint32(offset, true);
	}

	readUInt32BE(offset = 0): number {
		return this.#data.getUint32(offset, false);
	}

	readInt8(offset = 0): number {
		return this.#data.getInt8(offset);
	}

	readInt16LE(offset = 0): number {
		return this.#data.getInt16(offset, true);
	}

	readInt16BE(offset = 0): number {
		return this.#data.getInt16(offset, false);
	}

	readInt32LE(offset = 0): number {
		return this.#data.getInt32(offset, true);
	}

	readInt32BE(offset = 0): number {
		return this.#data.getInt32(offset, false);
	}

	readFloatLE(offset = 0): number {
		return this.#data.getFloat32(offset, true);
	}

	readFloatBE(offset = 0): number {
		return this.#data.getFloat32(offset, false);
	}

	readDoubleLE(offset = 0): number {
		return this.#data.getFloat64(offset, true);
	}

	readDoubleBE(offset = 0): number {
		return this.#data.getFloat64(offset, false);
	}

	readBigUInt64LE(offset = 0): bigint {
		return this.#data.getBigUint64(offset, true);
	}

	readBigUInt64BE(offset = 0): bigint {
		return this.#data.getBigUint64(offset, false);
	}

	readBigInt64LE(offset = 0): bigint {
		return this.#data.getBigInt64(offset, true);
	}

	readBigInt64BE(offset = 0): bigint {
		return this.#data.getBigInt64(offset, false);
	}

	writeUInt8(value: number, offset = 0): number {
		this.#data.setUint8(offset, value);

		return offset + 1;
	}

	writeUInt16LE(value: number, offset = 0): number {
		this.#data.setUint16(offset, value, true);

		return offset + 2;
	}

	writeUInt16BE(value: number, offset = 0): number {
		this.#data.setUint16(offset, value, false);

		return offset + 2;
	}

	writeUInt32LE(value: number, offset = 0): number {
		this.#data.setUint32(offset, value, true);

		return offset + 4;
	}

	writeUInt32BE(value: number, offset = 0): number {
		this.#data.setUint32(offset, value, false);

		return offset + 4;
	}

	writeInt8(value: number, offset = 0): number {
		this.#data.setInt8(offset, value);

		return offset + 1;
	}

	writeInt16LE(value: number, offset = 0): number {
		this.#data.setInt16(offset, value, true);

		return offset + 2;
	}

	writeInt16BE(value: number, offset = 0): number {
		this.#data.setInt16(offset, value, false);

		return offset + 2;
	}

	writeInt32LE(value: number, offset = 0): number {
		this.#data.setInt32(offset, value, true);

		return offset + 4;
	}

	writeInt32BE(value: number, offset = 0): number {
		this.#data.setInt32(offset, value, false);

		return offset + 4;
	}

	writeFloatLE(value: number, offset = 0): number {
		this.#data.setFloat32(offset, value, true);

		return offset + 4;
	}

	writeFloatBE(value: number, offset = 0): number {
		this.#data.setFloat32(offset, value, false);

		return offset + 4;
	}

	writeDoubleLE(value: number, offset = 0): number {
		this.#data.setFloat64(offset, value, true);

		return offset + 8;
	}

	writeDoubleBE(value: number, offset = 0): number {
		this.#data.setFloat64(offset, value, false);

		return offset + 8;
	}

	writeBigUInt64LE(value: bigint, offset = 0): number {
		this.#data.setBigUint64(offset, value, true);

		return offset + 8;
	}

	writeBigUInt64BE(value: bigint, offset = 0): number {
		this.#data.setBigUint64(offset, value, false);

		return offset + 8;
	}

	writeBigInt64LE(value: bigint, offset = 0): number {
		this.#data.setBigInt64(offset, value, true);

		return offset + 8;
	}

	writeBigInt64BE(value: bigint, offset = 0): number {
		this.#data.setBigInt64(offset, value, false);

		return offset + 8;
	}
}

// ============================================================================
// Internals
// ============================================================================

function assertSize(size: number): void {
	if (typeof size !== 'number' || !Number.isInteger(size) || size < 0) {
		const error = new RangeError(`The value of "size" is out of range. Received ${size}`) as RangeError & {
			code: string;
		};

		error.code = 'ERR_OUT_OF_RANGE';

		throw error;
	}
}

function compareBytes(a: Uint8Array, b: Uint8Array): -1 | 0 | 1 {
	const shared = Math.min(a.length, b.length);

	for (let index = 0; index < shared; index++) {
		const left = a[index] as number;
		const right = b[index] as number;

		if (left !== right) {
			return left < right ? -1 : 1;
		}
	}

	if (a.length === b.length) return 0;

	return a.length < b.length ? -1 : 1;
}

function search(
	haystack: Buffer,
	value: string | number | Uint8Array,
	byteOffset: number,
	encoding: BufferEncoding | undefined,
	last: boolean,
): number {
	const needle =
		typeof value === 'number'
			? Uint8Array.of(value & 0xff)
			: typeof value === 'string'
				? decodeString(value, normalizeEncoding(encoding))
				: value;

	if (needle.length === 0) {
		return last ? haystack.length : 0;
	}

	const start = byteOffset < 0 ? Math.max(0, haystack.length + byteOffset) : byteOffset;
	const first = last ? Math.min(start, haystack.length - needle.length) : start;

	// ponytail: naive scan, fine for the buffer sizes an editor extension sees
	for (let index = first; last ? index >= 0 : index <= haystack.length - needle.length; index += last ? -1 : 1) {
		let found = true;

		for (let step = 0; step < needle.length; step++) {
			if (haystack[index + step] !== needle[step]) {
				found = false;
				break;
			}
		}

		if (found) return index;
	}

	return -1;
}

// ============================================================================
// Module surface
// ============================================================================

/** The largest size a buffer can be allocated with */
export const kMaxLength = 4294967296;

export const constants = {
	MAX_LENGTH: kMaxLength,
	MAX_STRING_LENGTH: 536870888,
};

export default {
	Buffer,
	constants,
	kMaxLength,
	atob,
	btoa,
};
