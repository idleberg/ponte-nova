/**
 * The url shim, compared against node:url
 *
 * Every expectation is Node's own output rather than a fixture, so the suite
 * fails if the shim and Node ever disagree, whichever of the two moved.
 */

import assert from 'node:assert';
import nodeUrl from 'node:url';
import { installNova } from './nova.js';

installNova();

// The shim's classes shadow the globals of the same name for the rest of the
// file, so Node's are captured under a different name to compare against
const NativeURL = globalThis.URL;
const NativeParams = globalThis.URLSearchParams;

const url = await import('./url.ts');

const { URL, URLSearchParams } = url;

// The value bindings above shadow the globals, but the *types* of those names
// still resolve to Node's, so the shim's are named explicitly
type ShimURL = InstanceType<typeof URL>;
type ShimParams = InstanceType<typeof URLSearchParams>;

function eq(actual: unknown, expected: unknown, label: string): void {
	assert.deepStrictEqual(actual, expected, `${label}\n  shim: ${actual}\n  node: ${expected}`);
}

const properties = [
	'href',
	'protocol',
	'username',
	'password',
	'host',
	'hostname',
	'port',
	'pathname',
	'search',
	'hash',
	'origin',
] as const;

describe('URL', () => {
	it('is the shim, not the one Node provides', () => {
		assert.notStrictEqual(URL, NativeURL);
	});

	it.each<[string, string?]>([
		['http://example.com'],
		['http://example.com/'],
		['HTTP://Example.COM/PaTh'],
		['https://example.com:443/x'],
		['https://example.com:8443/x'],
		['http://example.com:80/'],
		['http://user:pass@example.com:8080/a/b?c=d#e'],
		['http://user@example.com/'],
		['http://example.com/a/b/../c'],
		['http://example.com/a/b/..'],
		['http://example.com/a/./b/'],
		['http://example.com/../..'],
		['http://example.com/a//b'],
		['http://example.com/a b'],
		['http://example.com/a%20b'],
		['http://example.com/a%b'],
		['http://example.com/ä'],
		['http://example.com/?q=a b&r=1'],
		['http://example.com/#frag ment'],
		['http://example.com?q'],
		['http://example.com#h'],
		['http:example.com/x'],
		['http:/example.com/x'],
		['http:///example.com/x'],
		['http://example.com\\a\\b'],
		['file:///Users/jan/x.txt'],
		['file://localhost/tmp'],
		['file:///a/../b'],
		['mailto:someone@example.com'],
		['data:text/plain;base64,SGVsbG8='],
		['urn:isbn:0451450523'],
		['ws://example.com/socket'],
		['wss://example.com:443/socket'],
		['ftp://example.com/pub'],
		['http://[::1]:8080/x'],
		['http://[2001:db8::1]/'],
		['http://example.com/a?b=c?d'],
		['http://example.com/a#b#c'],
		['  http://example.com/x  '],
		['http://example.com/x\ty'],
		['about:blank'],
		['view-source:http://example.com/'],
		// relative references, resolved against a base
		['/b/c', 'http://example.com/a/d'],
		['b/c', 'http://example.com/a/d'],
		['../b', 'http://example.com/a/d/e'],
		['?q=1', 'http://example.com/a/d?old=1'],
		['#h', 'http://example.com/a/d?q=1'],
		['', 'http://example.com/a/d?q=1#h'],
		['//other.com/x', 'http://example.com/a'],
		['http://other.com/x', 'http://example.com/a'],
		['https:relative', 'https://example.com/a/b'],
		['./', 'http://example.com/a/b'],
		['..', 'http://example.com/a/b/c'],
		['x', 'file:///a/b'],
	])('parses %s the way Node does', (input, base) => {
		const expected = new NativeURL(input, base);
		const actual = new URL(input, base);

		for (const key of properties) {
			eq(actual[key], expected[key], `.${key}`);
		}

		eq(actual.toString(), expected.toString(), 'toString');
		eq(actual.toJSON(), expected.toJSON(), 'toJSON');
		eq(JSON.stringify({ u: actual }), JSON.stringify({ u: expected }), 'JSON.stringify');
	});

	it.each([
		'example.com',
		'http://',
		'http://exa mple.com/',
		'https://example.com:99999/',
		'/relative',
		'http://a b.com/',
		'',
	])('rejects %s exactly when Node does', (input) => {
		const threw = (make: () => unknown) => {
			try {
				make();

				return false;
			} catch {
				return true;
			}
		};

		eq(
			threw(() => new URL(input)),
			threw(() => new NativeURL(input)),
			'throwing',
		);
	});

	it('throws a TypeError carrying the code Node uses', () => {
		let nodeCode: string | undefined;

		try {
			new NativeURL('nope');
		} catch (error) {
			nodeCode = (error as NodeJS.ErrnoException).code;
		}

		assert.throws(
			() => new URL('nope'),
			(error: NodeJS.ErrnoException) => {
				assert.ok(error instanceof TypeError);
				eq(error.code, nodeCode, 'error code');

				return true;
			},
		);
	});

	it('exposes the static parse helpers', () => {
		eq(URL.canParse('http://example.com/'), true, 'canParse valid');
		eq(URL.canParse('nonsense'), false, 'canParse invalid');
		eq(URL.parse('nonsense'), null, 'parse invalid');
		eq(URL.parse('http://example.com/')?.href, 'http://example.com/', 'parse valid');
	});

	it.each([
		['protocol', 'https'],
		['protocol', 'https:'],
		['protocol', 'ftp:'],
		['username', 'me'],
		['password', 'secret'],
		['host', 'other.com:81'],
		['hostname', 'other.com'],
		['port', '8080'],
		['port', ''],
		['pathname', '/new/path'],
		['pathname', 'no-slash'],
		['pathname', '/a/../b'],
		['search', 'a=1&b=2'],
		['search', '?a=1'],
		['search', ''],
		['hash', 'top'],
		['hash', '#top'],
		['hash', ''],
		['href', 'https://elsewhere.org/z?y=1#w'],
	])('assigning %s = %s matches Node', (key, value) => {
		const input = 'http://user:pw@example.com:8080/a/b?q=1#h';
		const expected = new NativeURL(input);
		const actual = new URL(input);

		(expected as unknown as Record<string, string>)[key] = value;
		(actual as unknown as Record<string, string>)[key] = value;

		eq(actual.href, expected.href, 'href after assignment');
	});
});

describe('URLSearchParams', () => {
	const inits: Array<string | string[][] | Record<string, string>> = [
		'a=1&b=2',
		'?a=1&b=2',
		'a=1&a=2&b',
		'a',
		'',
		'a=%C3%A4&b=a+b',
		'a=1&=2&c=',
		[
			['x', '1'],
			['y', '2'],
		],
		{ x: '1', y: '2' },
	];

	it.each(inits)('is constructed from %j the way Node is', (init) => {
		const expected = new NativeParams(init as string);
		const actual = new URLSearchParams(init);

		eq(actual.toString(), expected.toString(), 'toString');
		eq(actual.size, expected.size, 'size');
		eq([...actual], [...expected], 'entries');
		eq([...actual.keys()], [...expected.keys()], 'keys');
		eq([...actual.values()], [...expected.values()], 'values');
		eq(actual.get('a'), expected.get('a'), 'get');
		eq(actual.getAll('a'), expected.getAll('a'), 'getAll');
		eq(actual.has('a'), expected.has('a'), 'has');
	});

	const mutations: Array<[string, (params: ShimParams | InstanceType<typeof NativeParams>) => void]> = [
		['append a new name', (p) => p.append('c', '3')],
		['append a repeated name', (p) => p.append('a', 'again')],
		['set an existing name', (p) => p.set('a', 'z')],
		['set a new name', (p) => p.set('new', 'v')],
		['delete by name', (p) => p.delete('a')],
		['delete by name and value', (p) => p.delete('a', '1')],
		['sort', (p) => p.sort()],
		['append characters needing encoding', (p) => p.set('sp ace', 'va&lue')],
		['append an emoji', (p) => p.append('emoji', '🎉')],
		['append a plus', (p) => p.append('plus', 'a+b')],
		['append the unreserved-but-encoded set', (p) => p.append('tilde', '~!*()')],
	];

	it.each(mutations)('%s serializes the way Node does', (_label, mutate) => {
		const expected = new NativeParams('a=1&a=2&b=3&c=0');
		const actual = new URLSearchParams('a=1&a=2&b=3&c=0');

		mutate(expected);
		mutate(actual);

		eq(actual.toString(), expected.toString(), 'toString');
		eq([...actual], [...expected], 'entries');
	});

	it('copies rather than aliases when constructed from another instance', () => {
		const source = new URLSearchParams('a=1&b=2');
		const copy = new URLSearchParams(source);

		copy.set('a', 'changed');

		eq(source.get('a'), '1', 'the source is untouched');
	});

	it('iterates in insertion order with forEach', () => {
		const seen: Array<[string, string]> = [];

		new URLSearchParams('a=1&b=2').forEach((value, name) => {
			seen.push([name, value]);
		});

		eq(
			seen,
			[
				['a', '1'],
				['b', '2'],
			],
			'forEach order',
		);
	});
});

describe('URL and its searchParams', () => {
	it.each([
		['append', (u: ShimURL | InstanceType<typeof NativeURL>) => u.searchParams.append('b', '2')],
		['set', (u: ShimURL | InstanceType<typeof NativeURL>) => u.searchParams.set('a', '9')],
		['delete', (u: ShimURL | InstanceType<typeof NativeURL>) => u.searchParams.delete('a')],
		['sort', (u: ShimURL | InstanceType<typeof NativeURL>) => u.searchParams.sort()],
	])('writes a %s back to the URL', (_label, mutate) => {
		const input = 'http://example.com/x?a=1&c=0';
		const expected = new NativeURL(input);
		const actual = new URL(input);

		mutate(expected);
		mutate(actual);

		eq(actual.href, expected.href, 'href');
		eq(actual.search, expected.search, 'search');
	});

	it('refreshes the params when search or href is assigned', () => {
		const expected = new NativeURL('http://example.com/x?a=1');
		const actual = new URL('http://example.com/x?a=1');

		expected.search = 'z=9';
		actual.search = 'z=9';

		eq(actual.searchParams.get('z'), expected.searchParams.get('z'), 'the new parameter is visible');
		eq(actual.searchParams.get('a'), expected.searchParams.get('a'), 'the old one is gone');

		expected.href = 'http://example.com/y?k=v';
		actual.href = 'http://example.com/y?k=v';

		eq(actual.searchParams.get('k'), expected.searchParams.get('k'), 'href assignment refreshes too');
	});
});

describe('file URLs', () => {
	it.each(['/tmp/x.txt', '/a b/c.txt', '/a#b/c?d.txt', '/ä/ö.txt', '/a%b', '/'])(
		'converts %s to a URL and back',
		(path) => {
			eq(url.pathToFileURL(path).href, nodeUrl.pathToFileURL(path).href, 'pathToFileURL');
			eq(url.fileURLToPath(url.pathToFileURL(path).href), path, 'round trip');
		},
	);

	it.each(['file:///tmp/x.txt', 'file://localhost/tmp/x.txt', 'file:///a%20b/c', 'file:///%C3%A4'])(
		'converts %s to a path',
		(input) => {
			eq(url.fileURLToPath(input), nodeUrl.fileURLToPath(input), 'fileURLToPath');
		},
	);

	it.each(['http://example.com/x', 'file://host/tmp', 'file:///a%2Fb'])("rejects %s with Node's code", (input) => {
		const code = (convert: () => unknown) => {
			try {
				convert();

				return null;
			} catch (error) {
				return (error as NodeJS.ErrnoException).code;
			}
		};

		eq(
			code(() => url.fileURLToPath(input)),
			code(() => nodeUrl.fileURLToPath(input)),
			'error code',
		);
	});
});

describe('urlToHttpOptions', () => {
	it.each([
		'http://example.com/a?b=1#c',
		'https://user:pw@example.com:8443/a',
		'http://[::1]:8080/x',
		'http://example.com',
	])('describes %s the way Node does', (input) => {
		const expected = nodeUrl.urlToHttpOptions(new NativeURL(input)) as unknown as Record<string, unknown>;
		const actual = url.urlToHttpOptions(new URL(input));

		for (const key of ['protocol', 'hostname', 'hash', 'search', 'pathname', 'path', 'href', 'port', 'auth']) {
			eq(actual[key], expected[key], key);
		}
	});
});

describe('the legacy API', () => {
	const legacy = [
		'http://example.com/a/b?c=1#d',
		'http://user:pw@example.com:8080/a?b=1',
		'/just/a/path',
		'/path?with=query#andhash',
		'relative/path',
		'//protocol-relative/x',
		'http://example.com',
		'mailto:me@example.com',
		'HTTP://EXAMPLE.COM/PaTh',
		'',
		'?only=query',
		'#only-hash',
	];

	it.each(legacy)('parses %s into the same object Node does', (input) => {
		const expected = nodeUrl.parse(input) as unknown as Record<string, unknown>;
		const actual = url.parse(input) as unknown as Record<string, unknown>;

		for (const key of [
			'protocol',
			'slashes',
			'auth',
			'host',
			'port',
			'hostname',
			'hash',
			'search',
			'query',
			'pathname',
			'path',
			'href',
		]) {
			eq(actual[key], expected[key], key);
		}
	});

	it.each(legacy)('formats its own parse of %s the way Node does', (input) => {
		eq(url.format(url.parse(input)), nodeUrl.format(nodeUrl.parse(input)), 'format(parse(input))');
	});

	it.each(['http://example.com/a?b=1&b=2&c=3', '/x?a=1', '/x'])('parses the query of %s into an object', (input) => {
		eq(
			{ ...(url.parse(input, true).query as Record<string, unknown>) },
			{ ...(nodeUrl.parse(input, true).query as Record<string, unknown>) },
			'query',
		);
	});

	it('honours slashesDenoteHost', () => {
		eq(url.parse('//host/x', false, true).hostname, nodeUrl.parse('//host/x', false, true).hostname, 'hostname');
	});

	it.each([
		['http://example.com/a/b', 'c'],
		['http://example.com/a/b', '/c'],
		['http://example.com/a/b', '../c'],
		['http://example.com/a/b?q=1', '#h'],
		['http://example.com/a/b', 'http://other.com/z'],
		['http://example.com/a/b', '//other.com/z'],
		['file:///a/b', 'c'],
	])('resolves %s against %s', (from, to) => {
		eq(url.resolve(from, to), nodeUrl.resolve(from, to), 'resolve');
	});

	it.each([
		{ protocol: 'http', hostname: 'example.com', pathname: '/a', search: '?b=1', hash: '#c' },
		{ protocol: 'http:', host: 'example.com:8080', pathname: '/a' },
		{ protocol: 'https', hostname: 'example.com', query: { a: '1', b: '2' } },
		{ protocol: 'http', hostname: 'example.com', auth: 'user:pw', pathname: '/x' },
		{ pathname: '/just/path' },
		{ protocol: 'mailto', pathname: 'me@example.com' },
	])('formats %j the way Node does', (object) => {
		eq(url.format(object), nodeUrl.format(object), 'format');
	});

	it.each([
		undefined,
		{ auth: false },
		{ fragment: false },
		{ search: false },
		{ auth: false, fragment: false, search: false },
	])('formats a WHATWG URL with %j', (options) => {
		const input = 'http://user:pw@example.com/a?b=1#c';

		eq(url.format(new URL(input), options), nodeUrl.format(new NativeURL(input), options), 'format');
	});

	it('resolves into a parsed object', () => {
		eq(
			url.resolveObject('http://example.com/a/b', 'c').href,
			nodeUrl.parse(nodeUrl.resolve('http://example.com/a/b', 'c')).href,
			'resolveObject',
		);
	});
});

describe('domain names', () => {
	it.each(['example.com', 'EXAMPLE.com', 'sub.example.co.uk'])('converts the ASCII domain %s', (domain) => {
		eq(url.domainToASCII(domain), nodeUrl.domainToASCII(domain), 'domainToASCII');
		eq(url.domainToUnicode(domain), nodeUrl.domainToUnicode(domain), 'domainToUnicode');
	});
});

describe('the module surface', () => {
	it.each([
		'URL',
		'URLSearchParams',
		'Url',
		'format',
		'parse',
		'resolve',
		'fileURLToPath',
		'pathToFileURL',
		'urlToHttpOptions',
		'domainToASCII',
		'domainToUnicode',
	])('exports %s, as node:url does', (key) => {
		assert.ok((url.default as unknown as Record<string, unknown>)[key], `the shim exports ${key}`);
		assert.ok((nodeUrl as unknown as Record<string, unknown>)[key], `node:url exports ${key}`);
	});
});
