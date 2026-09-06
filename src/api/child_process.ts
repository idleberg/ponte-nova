/**
 * Child process compatibility layer for Nova extensions
 *
 * Nova's Process API can do almost everything Node.js child_process can, with
 * one structural exception: it is asynchronous throughout. There is no way to
 * block until a subprocess exits, so execSync, spawnSync and execFileSync
 * cannot be implemented at all and throw rather than pretend.
 *
 * The other difference worth knowing about is that Nova delivers output a line
 * at a time rather than as a byte stream, so a chunk boundary here always falls
 * on a newline. See the note on splitLine below for what that costs.
 */

import { Buffer } from './buffer.js';
import { EventEmitter } from './events.js';
import { cwd } from './path.js';

type Listener = (...args: never[]) => void;

// ============================================================================
// Streams
// ============================================================================

/**
 * Readable half of a child's stdout or stderr
 *
 * Emits 'data' with a Buffer, or with a string once setEncoding has been
 * called, which is the pair of behaviours Node.js code branches on.
 */
class ReadableStream extends EventEmitter {
	readable = true;
	#encoding: BufferEncoding | null = null;

	setEncoding(encoding: BufferEncoding): this {
		this.#encoding = encoding;

		return this;
	}

	/** @internal */
	push(chunk: string): void {
		this.emit('data', this.#encoding ? chunk : Buffer.from(chunk, 'utf8'));
	}

	/** @internal */
	finish(): void {
		this.readable = false;
		this.emit('end');
		this.emit('close');
	}

	pipe<T extends { write(chunk: unknown): unknown; end?(): unknown }>(destination: T, options?: { end?: boolean }): T {
		this.on('data', ((chunk: unknown) => destination.write(chunk)) as Listener);

		if (options?.end !== false) {
			this.on('end', (() => destination.end?.()) as Listener);
		}

		return destination;
	}

	// Nothing here is resumed or paused, but code calls these unconditionally
	resume(): this {
		return this;
	}

	pause(): this {
		return this;
	}
}

/**
 * Writable half of a child's stdin
 *
 * Nova exposes stdin as a WHATWG WritableStream on Process.stdio, which is
 * write-only from here. Writes are queued behind the writer's promise so that
 * ordering survives, and a failure surfaces as an 'error' event rather than an
 * unhandled rejection.
 */
class WritableStream extends EventEmitter {
	writable = true;
	#writer: WritableStreamDefaultWriter<string> | null = null;
	#queue: Promise<unknown> = Promise.resolve();

	constructor(private readonly open: () => WritableStreamDefaultWriter<string> | null) {
		super();
	}

	#acquire(): WritableStreamDefaultWriter<string> | null {
		this.#writer ??= this.open();

		return this.#writer;
	}

	write(chunk: string | Uint8Array, encoding?: BufferEncoding | (() => void), callback?: () => void): boolean {
		const done = typeof encoding === 'function' ? encoding : callback;
		const writer = this.#acquire();
		const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');

		if (!writer) {
			this.emit('error', new Error('The subprocess does not have a stdin pipe.'));

			return false;
		}

		this.#queue = this.#queue
			.then(() => writer.write(text))
			.then(() => done?.())
			.catch((error) => this.emit('error', error));

		return true;
	}

	end(chunk?: string | Uint8Array): this {
		if (chunk !== undefined) {
			this.write(chunk);
		}

		const writer = this.#acquire();

		this.writable = false;
		this.#queue = this.#queue.then(() => writer?.close()).catch(() => undefined);

		return this;
	}

	// stdin is never actually corked; the queue already preserves order
	cork(): void {}

	uncork(): void {}
}

// ============================================================================
// Spawning
// ============================================================================

export interface SpawnOptions {
	cwd?: string;
	env?: Record<string, string | undefined>;
	shell?: boolean | string;
	timeout?: number;
	killSignal?: string;
	encoding?: BufferEncoding | 'buffer';
	maxBuffer?: number;
	signal?: AbortSignal;
	/** Accepted and ignored; every child here is piped */
	stdio?: unknown;
	/** Accepted and ignored; Nova offers no detached processes */
	detached?: boolean;
	windowsHide?: boolean;
}

export interface ExecException extends Error {
	code?: number | string;
	killed?: boolean;
	signal?: string;
	cmd?: string;
	stdout?: string | Buffer;
	stderr?: string | Buffer;
}

/**
 * Nova reports output a line at a time, stripped of its terminator
 *
 * Node.js hands over raw bytes, so a command whose output ends without a
 * newline produces output ending without one. That distinction is lost before
 * this code sees anything, and the overwhelmingly common case is output that
 * did end in a newline, so one is added back to every line.
 *
 * ponytail: reinstate exact trailing bytes only if Nova gains a byte-level
 * stdout API.
 */
function splitLine(line: string): string {
	return line.endsWith('\n') ? line : `${line}\n`;
}

/**
 * Build the argument vector Nova should launch
 *
 * Two cases need help. A shell request has to become an explicit `sh -c`,
 * because Node.js defines it that way and the command string is written for a
 * shell. A bare command name has to go through env, which performs the PATH
 * lookup that Node.js does internally and Nova does not, without introducing
 * the quoting hazards of routing it through a shell.
 */
function resolveCommand(command: string, args: string[], shell?: boolean | string): [string, string[]] {
	if (shell) {
		const interpreter = typeof shell === 'string' ? shell : '/bin/sh';

		return [interpreter, ['-c', [command, ...args].join(' ')]];
	}

	return command.includes('/') ? [command, args] : ['/usr/bin/env', [command, ...args]];
}

export class ChildProcess extends EventEmitter {
	stdout: ReadableStream | null = new ReadableStream();
	stderr: ReadableStream | null = new ReadableStream();
	stdin: WritableStream;
	stdio: [WritableStream, ReadableStream | null, ReadableStream | null];

	pid: number | undefined;
	exitCode: number | null = null;
	signalCode: string | null = null;
	killed = false;
	connected = false;
	spawnfile: string;
	spawnargs: string[];

	#process: Process | null = null;

	constructor(command: string, args: string[], options: SpawnOptions) {
		super();

		const [file, argv] = resolveCommand(command, args, options.shell);

		this.spawnfile = command;
		this.spawnargs = [command, ...args];

		// Node.js treats an explicit env as a replacement, not an addition
		const env = Object.fromEntries(
			Object.entries(options.env ?? nova.environment).filter(([, value]) => value !== undefined),
		) as Record<string, string>;

		this.stdin = new WritableStream(() => {
			try {
				return (this.#process?.stdio?.[0] as globalThis.WritableStream<string> | undefined)?.getWriter() ?? null;
			} catch {
				return null;
			}
		});

		this.stdio = [this.stdin, this.stdout, this.stderr];

		let subprocess: Process;

		try {
			subprocess = new Process(file, { args: argv, cwd: options.cwd ?? cwd(), env });
		} catch (error) {
			// Node.js reports a failed launch as an event, not a throw
			queueError(this, error, command);

			return;
		}

		this.#process = subprocess;

		subprocess.onStdout((line) => this.stdout?.push(splitLine(line)));
		subprocess.onStderr((line) => this.stderr?.push(splitLine(line)));

		subprocess.onDidExit((status) => {
			// Nova folds a signal death into the status the way a shell does
			const signalled = status > 128;

			this.exitCode = signalled ? null : status;
			this.signalCode = signalled || this.killed ? (options.killSignal ?? 'SIGTERM') : null;

			this.stdout?.finish();
			this.stderr?.finish();

			this.emit('exit', this.exitCode, this.signalCode);
			this.emit('close', this.exitCode, this.signalCode);
		});

		try {
			subprocess.start();
			this.pid = subprocess.pid;
		} catch (error) {
			queueError(this, error, command);

			return;
		}

		if (options.timeout) {
			const timer = setTimeout(() => this.kill(options.killSignal), options.timeout);

			this.once('exit', (() => clearTimeout(timer)) as Listener);
		}

		options.signal?.addEventListener('abort', () => this.kill(options.killSignal));

		// 'spawn' has to arrive after the caller has had a chance to subscribe
		Promise.resolve().then(() => this.emit('spawn'));
	}

	kill(signal?: string | number): boolean {
		if (!this.#process) {
			return false;
		}

		this.killed = true;

		try {
			if (signal !== undefined && signal !== 'SIGTERM' && signal !== 15) {
				this.#process.signal(signal);
			} else {
				this.#process.terminate();
			}

			return true;
		} catch {
			return false;
		}
	}

	// Nova has no detached processes, so there is no reference to drop
	unref(): this {
		return this;
	}

	ref(): this {
		return this;
	}

	disconnect(): void {}

	send(): boolean {
		throw new Error('child.send is not supported in Nova extensions, which have no IPC channel to a subprocess.');
	}
}

/**
 * Report a launch failure the way Node.js does
 *
 * Deferred so that a caller assigning an 'error' handler on the next line still
 * sees it, which is how every spawn call site is written.
 */
function queueError(child: ChildProcess, cause: unknown, command: string): void {
	const error = new Error(`spawn ${command} ENOENT`) as ExecException;

	error.code = -2;
	(error as ExecException & { syscall?: string; path?: string }).syscall = `spawn ${command}`;
	(error as ExecException & { path?: string }).path = command;

	if (cause instanceof Error) {
		error.message = `spawn ${command} failed: ${cause.message}`;
	}

	Promise.resolve().then(() => {
		child.emit('error', error);
		child.stdout?.finish();
		child.stderr?.finish();
		child.emit('close', null, null);
	});
}

/**
 * Launch a subprocess
 *
 * The returned object emits 'spawn', 'exit', 'close' and 'error', and carries
 * stdout, stderr and stdin, as in Node.js. Everything is piped: Nova offers no
 * equivalent of inherit or ignore.
 */
export function spawn(command: string, args?: string[] | SpawnOptions, options?: SpawnOptions): ChildProcess {
	const argv = Array.isArray(args) ? args : [];
	const settings = (Array.isArray(args) ? options : args) ?? {};

	return new ChildProcess(command, argv, settings);
}

// ============================================================================
// Buffered execution
// ============================================================================

type ExecCallback = (error: ExecException | null, stdout: string | Buffer, stderr: string | Buffer) => void;

const defaultMaxBuffer = 1024 * 1024;

/**
 * Collect a child's output and hand it over once it exits
 *
 * Shared by exec and execFile, which differ only in whether the command goes
 * through a shell.
 */
function buffered(
	child: ChildProcess,
	label: string,
	options: SpawnOptions,
	callback?: ExecCallback,
): Promise<{ stdout: string | Buffer; stderr: string | Buffer }> {
	const limit = options.maxBuffer ?? defaultMaxBuffer;
	const asBuffer = options.encoding === 'buffer';
	const encoding = (asBuffer ? 'utf8' : (options.encoding ?? 'utf8')) as BufferEncoding;

	let out = '';
	let err = '';
	let overflowed = false;

	const collect = (stream: ReadableStream | null, append: (chunk: string) => void) => {
		stream?.setEncoding(encoding);
		stream?.on('data', ((chunk: string) => {
			append(chunk);

			if (out.length + err.length > limit && !overflowed) {
				overflowed = true;
				child.kill(options.killSignal);
			}
		}) as Listener);
	};

	collect(child.stdout, (chunk) => {
		out += chunk;
	});
	collect(child.stderr, (chunk) => {
		err += chunk;
	});

	return new Promise((resolve, reject) => {
		const settle = (failure: ExecException | null) => {
			const stdout = asBuffer ? Buffer.from(out, 'utf8') : out;
			const stderr = asBuffer ? Buffer.from(err, 'utf8') : err;

			if (failure) {
				failure.cmd = label;
				failure.stdout = stdout;
				failure.stderr = stderr;
			}

			callback?.(failure, stdout, stderr);

			if (failure) {
				// A callback consumer has already been told; nothing awaits this
				if (!callback) {
					reject(failure);
				}
			} else {
				resolve({ stdout, stderr });
			}
		};

		child.on('error', ((error: ExecException) => settle(error)) as Listener);

		child.on('close', ((code: number | null, signal: string | null) => {
			if (overflowed) {
				const error = new Error('stdout maxBuffer length exceeded') as ExecException;
				error.code = 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';

				return settle(error);
			}

			if (code === 0) {
				return settle(null);
			}

			const error = new Error(`Command failed: ${label}\n${err}`) as ExecException;

			error.code = code ?? undefined;
			error.killed = child.killed;
			error.signal = signal ?? undefined;

			settle(error);
		}) as Listener);
	});
}

/** Promise form used by util.promisify, which packages apply to exec routinely */
const promisifyCustom = Symbol.for('nodejs.util.promisify.custom');

/**
 * Run a command through a shell and buffer its output
 */
export function exec(
	command: string,
	options?: SpawnOptions | ExecCallback,
	callback?: ExecCallback,
): ChildProcess & { then?: never } {
	const settings = (typeof options === 'function' ? {} : options) ?? {};
	const done = typeof options === 'function' ? options : callback;
	const child = new ChildProcess(command, [], { ...settings, shell: settings.shell ?? true });

	const promise = buffered(child, command, settings, done);

	// Nothing awaits the plain callback form; a rejection there is already reported
	promise.catch(() => undefined);

	return child;
}

Object.defineProperty(exec, promisifyCustom, {
	value: (command: string, options?: SpawnOptions) => {
		const settings = options ?? {};
		const child = new ChildProcess(command, [], { ...settings, shell: settings.shell ?? true });

		return buffered(child, command, settings);
	},
});

/**
 * Run a command without a shell and buffer its output
 */
export function execFile(
	file: string,
	args?: string[] | SpawnOptions | ExecCallback,
	options?: SpawnOptions | ExecCallback,
	callback?: ExecCallback,
): ChildProcess {
	const argv = Array.isArray(args) ? args : [];
	const rest = Array.isArray(args) ? options : args;
	const settings = (typeof rest === 'function' ? {} : rest) ?? {};
	const done = typeof rest === 'function' ? rest : typeof options === 'function' ? options : callback;
	const child = new ChildProcess(file, argv, settings);

	const promise = buffered(child, [file, ...argv].join(' '), settings, done);

	promise.catch(() => undefined);

	return child;
}

Object.defineProperty(execFile, promisifyCustom, {
	value: (file: string, args?: string[], options?: SpawnOptions) => {
		const argv = args ?? [];
		const settings = options ?? {};

		return buffered(new ChildProcess(file, argv, settings), [file, ...argv].join(' '), settings);
	},
});

// ============================================================================
// Unsupported Operations
// ============================================================================

/**
 * The synchronous family, which cannot exist here
 *
 * Nova's Process API delivers output and exit status through callbacks, and
 * JavaScript has no way to block until they arrive. There is no approximation
 * worth shipping, so these throw with an explanation of what to use instead.
 */
const noSyncEquivalent = (method: string, alternative: string) => () => {
	throw new Error(
		`child_process.${method} is not supported in Nova extensions, because Nova's Process API is asynchronous and cannot be awaited synchronously. Use child_process.${alternative} instead.`,
	);
};

export const execSync = noSyncEquivalent('execSync', 'exec');

export const execFileSync = noSyncEquivalent('execFileSync', 'execFile');

export const spawnSync = noSyncEquivalent('spawnSync', 'spawn');

export function fork(): never {
	throw new Error(
		'child_process.fork is not supported in Nova extensions, because there is no Node.js runtime to fork into.',
	);
}

// ============================================================================
// Default Export
// ============================================================================

export default {
	ChildProcess,
	exec,
	execFile,
	execFileSync,
	execSync,
	fork,
	spawn,
	spawnSync,
};
