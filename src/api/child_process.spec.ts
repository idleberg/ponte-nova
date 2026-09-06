/**
 * The child_process shim, run against a stub of Nova's Process API
 *
 * The stub is backed by real subprocesses, so exit codes, PATH lookup, cwd, env
 * and stdin are genuine. What it reproduces deliberately is Nova's lossy
 * delivery: one line at a time, with the terminator stripped.
 */

import assert from 'node:assert';
import { spawn as nodeSpawn } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { promisify } from 'node:util';
import { installNova } from './nova.js';

installNova({ environment: { ...process.env } as Record<string, string> });

Object.assign(globalThis, {
	Process: class {
		#callbacks: Record<string, ((value: string | number) => void) | undefined> = {};
		#child: ReturnType<typeof nodeSpawn> | null = null;

		command: string;
		args: string[];
		options: Record<string, never>;
		pid?: number;

		constructor(command: string, options: Record<string, never> = {} as Record<string, never>) {
			this.command = command;
			this.args = (options as { args?: string[] }).args ?? [];
			this.options = options;
		}

		onStdout(callback: (line: string) => void): void {
			this.#callbacks.stdout = callback as (value: string | number) => void;
		}

		onStderr(callback: (line: string) => void): void {
			this.#callbacks.stderr = callback as (value: string | number) => void;
		}

		onDidExit(callback: (status: number) => void): void {
			this.#callbacks.exit = callback as (value: string | number) => void;
		}

		start(): void {
			// Nova refuses to launch a missing executable by throwing from start()
			if (this.command.startsWith('/')) {
				accessSync(this.command, constants.X_OK);
			}

			const options = this.options as { cwd?: string; env?: Record<string, string> };

			this.#child = nodeSpawn(this.command, this.args, {
				// The stub's cwd is this repository, not the fictional extension path
				cwd: options.cwd?.startsWith('/Users/example') ? process.cwd() : options.cwd,
				env: options.env,
			});

			this.pid = this.#child.pid;

			for (const name of ['stdout', 'stderr'] as const) {
				let pending = '';
				const stream = this.#child[name];

				stream?.setEncoding('utf8');
				stream?.on('data', (chunk: string) => {
					pending += chunk;

					const lines = pending.split('\n');

					pending = lines.pop() ?? '';

					for (const line of lines) {
						this.#callbacks[name]?.(line);
					}
				});
				stream?.on('end', () => {
					if (pending) {
						this.#callbacks[name]?.(pending);
					}
				});
			}

			this.#child.on('close', (code, signal) => this.#callbacks.exit?.(signal ? 128 + 15 : (code ?? 0)));
		}

		get stdio(): [WritableStream, null, null] {
			const stdin = this.#child?.stdin;

			return [
				new WritableStream({
					write: (chunk) => new Promise((resolve) => stdin?.write(chunk, () => resolve())),
					close: () => new Promise((resolve) => stdin?.end(() => resolve())),
				}),
				null,
				null,
			];
		}

		terminate(): void {
			this.#child?.kill('SIGTERM');
		}

		signal(value: string): void {
			this.#child?.kill(value as NodeJS.Signals);
		}
	},
});

const { Buffer: NovaBuffer } = await import('./buffer.ts');
const { exec, execFile, execSync, spawnSync, fork, spawn } = await import('./child_process.ts');

/**
 * The promisified forms, typed by the result their custom symbol produces
 *
 * node:util cannot infer that from a plain callback signature, so it is stated
 * here rather than left as the `string | Buffer` the callback declares.
 */
type Output = { stdout: string; stderr: string };
type Options = Record<string, unknown>;

const execAsync = promisify(exec) as unknown as (command: string, options?: Options) => Promise<Output>;
const execFileAsync = promisify(execFile) as unknown as (file: string, args?: string[]) => Promise<Output>;

function eq(actual: unknown, expected: unknown, label: string): void {
	assert.deepStrictEqual(actual, expected, label);
}

describe('exec', () => {
	it('runs a command through a shell', async () => {
		const { stdout, stderr } = await execAsync('echo hello');

		eq(stdout, 'hello\n', 'stdout carries the trailing newline');
		eq(stderr, '', 'stderr is empty');
	});

	it('reports a failure in the shape Node uses', async () => {
		const error = await execAsync('echo oops >&2; exit 3').then(
			() => null,
			(failure) => failure,
		);

		eq(error.code, 3, 'a non-zero exit becomes error.code');
		eq(error.stderr, 'oops\n', 'stderr is attached to the error');
		eq(error.cmd, 'echo oops >&2; exit 3', 'the command is attached to the error');
		assert.match(error.message, /^Command failed: /);
	});

	it('calls back with a null error on success', async () => {
		const result = await new Promise<{ error: unknown; stdout: unknown }>((resolve) => {
			exec('printf abc', (error, stdout) => resolve({ error, stdout }));
		});

		eq(result.error, null, 'a successful callback receives a null error');
		// printf writes no newline; Nova's line-at-a-time delivery adds one
		eq(result.stdout, 'abc\n', 'stdout arrives, with the newline Nova implies');
	});

	it("returns a Buffer for encoding: 'buffer'", async () => {
		const { stdout } = await execAsync('echo bytes', { encoding: 'buffer' });

		eq(NovaBuffer.isBuffer(stdout), true, 'the result is a Buffer');
		eq(stdout.toString(), 'bytes\n', 'holding the right bytes');
	});

	it('replaces the environment rather than extending it', async () => {
		const { stdout } = await execAsync('echo "$ONLY_THIS:$PATH"', {
			env: { ONLY_THIS: 'yes', PATH: '/bin:/usr/bin' },
		});

		eq(stdout, 'yes:/bin:/usr/bin\n', 'an explicit env replaces the inherited one');
	});

	it('kills a child that outlives its timeout', async () => {
		const error = await execAsync('sleep 5', { timeout: 100 }).then(
			() => null,
			(failure) => failure,
		);

		eq(error.killed, true, 'the child is reported as killed');
	});

	it('fails the way Node does when maxBuffer is exceeded', async () => {
		const error = await execAsync('yes hello | head -10000', { maxBuffer: 64 }).then(
			() => null,
			(failure) => failure,
		);

		eq(error.code, 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', 'the documented code');
	});
});

describe('execFile', () => {
	it('passes arguments through without shell expansion', async () => {
		const { stdout } = await execFileAsync('echo', ['a', '>b']);

		eq(stdout, 'a >b\n', 'the metacharacter stayed a literal argument');
	});
});

describe('spawn', () => {
	it('finds a bare command name on PATH', async () => {
		const child = spawn('echo', ['from-path']);
		const chunks: Uint8Array[] = [];

		assert.ok(child.stdout, 'the child has a piped stdout');
		child.stdout.on('data', (chunk: Uint8Array) => chunks.push(chunk));

		const [code] = await new Promise<unknown[]>((resolve) => child.on('close', (...args) => resolve(args)));

		eq(NovaBuffer.isBuffer(chunks[0]), true, "'data' carries Buffers until setEncoding is called");
		eq(NovaBuffer.concat(chunks).toString(), 'from-path\n', 'the command was found on PATH');
		eq(code, 0, 'the close event carries the exit code');
		eq(typeof child.pid, 'number', 'the child reports a pid');
	});

	it('writes to stdin in order', async () => {
		const child = spawn('cat', []);
		let out = '';

		assert.ok(child.stdout, 'the child has a piped stdout');
		child.stdout.setEncoding('utf8');
		child.stdout.on('data', (chunk: string) => {
			out += chunk;
		});

		child.stdin.write('one\n');
		child.stdin.end('two\n');

		await new Promise((resolve) => child.on('close', resolve));

		eq(out, 'one\ntwo\n', 'both writes arrived, in order');
	});

	it("emits 'spawn' late enough for a handler assigned after the call", async () => {
		const child = spawn('true', []);

		eq(await new Promise((resolve) => child.on('spawn', () => resolve(true))), true, "'spawn' was observed");

		await new Promise((resolve) => child.on('close', resolve));
	});

	it("reports a missing binary as an 'error' event rather than a throw", async () => {
		const child = spawn('/nonexistent/binary', []);
		const error = await new Promise<Error>((resolve) => child.on('error', resolve));

		assert.match(error.message, /nonexistent/);
	});
});

describe('the synchronous family', () => {
	it.each([
		['execSync', execSync],
		['spawnSync', spawnSync],
		['fork', fork],
	] as const)('%s explains itself rather than pretending', (method, fn) => {
		assert.throws(() => (fn as () => unknown)(), new RegExp(`child_process.${method} is not supported`));
	});
});
