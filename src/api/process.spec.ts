/**
 * The process shim
 *
 * What maps onto Nova is checked against Node's semantics; what cannot exist in
 * an extension is checked to fail in a way that says so.
 */

import assert from 'node:assert';
import { extensionPath, installInertProcess, installNova } from './nova.js';

installNova({
	environment: { HOME: '/Users/example', PATH: '/usr/bin', USER: 'example', SHELL: '/bin/zsh' },
});
installInertProcess();

const processShim = (await import('./process.ts')).default;
const { resolve: novaResolve } = await import('./path.ts');

function eq(actual: unknown, expected: unknown, label: string): void {
	assert.deepStrictEqual(actual, expected, label);
}

describe('environment', () => {
	it('reads nova.environment', () => {
		eq(processShim.env.HOME, '/Users/example', 'env reads through to Nova');
		eq(processShim.env.NOPE_NOT_SET, undefined, 'a missing variable is undefined, as in Node');
	});

	it('stores assignments as strings, as Node does', () => {
		(processShim.env as Record<string, unknown>).PORT = 3000;

		eq(typeof processShim.env.PORT, 'string', 'a number is coerced');
	});

	it('deletes variables', () => {
		processShim.env.TEMPORARY = 'x';
		delete processShim.env.TEMPORARY;

		eq(processShim.env.TEMPORARY, undefined, 'the variable is gone');
	});
});

describe('identity', () => {
	it('describes the platform the way an extension needs', () => {
		eq(processShim.platform, 'darwin', 'Nova is macOS-only');
		eq(/^v\d+\.\d+\.\d+$/.test(processShim.version), true, 'version parses as a Node.js version');
		eq(processShim.argv.length, 2, 'argv has the two entries Node guarantees');
		eq(typeof processShim.pid, 'number', 'pid is a number');
	});

	it('omits the identity calls it cannot answer honestly', () => {
		// A stub reporting uid 0 would tell a package it is running as root
		eq(typeof (processShim as Record<string, unknown>).getuid, 'undefined', 'getuid is absent');
		eq(typeof (processShim as Record<string, unknown>).getgid, 'undefined', 'getgid is absent');
		eq(typeof (processShim as Record<string, unknown>).umask, 'undefined', 'umask is absent');
	});
});

describe('the working directory', () => {
	it('starts at the extension path and moves with chdir', () => {
		eq(processShim.cwd(), extensionPath, 'cwd starts at the extension path');

		processShim.chdir('/tmp/somewhere');

		eq(processShim.cwd(), '/tmp/somewhere', 'chdir moves it');
	});

	it('shares its directory with path.resolve', () => {
		processShim.chdir(extensionPath);

		eq(novaResolve('relative'), `${extensionPath}/relative`, 'resolve starts where cwd is');

		processShim.chdir('/tmp/elsewhere');

		eq(novaResolve('relative'), '/tmp/elsewhere/relative', 'and follows chdir');
		eq(processShim.cwd(), '/tmp/elsewhere', 'the two agree');
	});
});

describe('nextTick', () => {
	it('invokes the callback with its extra arguments', async () => {
		eq(await new Promise((resolve) => processShim.nextTick(resolve, 'ticked')), 'ticked', 'the argument arrives');
	});

	it('runs before timers and after synchronous code', async () => {
		const order: string[] = [];

		const result = await new Promise<string[]>((resolve) => {
			setTimeout(() => {
				order.push('timeout');
				resolve(order);
			}, 1);
			processShim.nextTick(() => order.push('tick'));
			order.push('sync');
		});

		eq(result, ['sync', 'tick', 'timeout'], 'the ordering matches Node');
	});
});

describe('events', () => {
	it('supports on, emit and off', () => {
		const seen: unknown[] = [];
		const handler = (value: unknown) => seen.push(value);

		processShim.on('custom', handler);
		processShim.emit('custom', 'a');
		processShim.off('custom', handler);
		processShim.emit('custom', 'b');

		eq(seen, ['a'], 'the removed handler stopped hearing');
	});

	it("accepts an 'exit' handler rather than throwing, though nothing emits it", () => {
		processShim.on('exit', () => {});

		eq(processShim.listenerCount('exit'), 1, 'the handler was stored');
	});

	it("does not throw on an unhandled 'error', unlike an EventEmitter", () => {
		eq(processShim.emit('error', new Error('ignored')), false, 'emit reports that nothing listened');
	});
});

describe('what an extension cannot do', () => {
	it('throws from exit, explaining why', () => {
		assert.throws(() => processShim.exit(1), /cannot terminate the editor/);
	});
});

describe('stdout', () => {
	it('emits whole lines and holds the remainder', () => {
		const logged: string[] = [];
		const original = console.log;

		console.log = (line: string) => logged.push(line);
		processShim.stdout.write('par');
		processShim.stdout.write('tial\ncomplete\nrest');
		console.log = original;

		eq(logged, ['partial', 'complete'], 'only complete lines were written');
	});

	it('reports no TTY, so colour libraries disable their codes', () => {
		eq(processShim.stdout.isTTY, false, 'isTTY is false');
	});
});
