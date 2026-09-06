/**
 * Process module compatibility layer for Nova extensions
 *
 * Nova extensions run inside the editor rather than as a standalone program,
 * so a good deal of what process describes simply has no counterpart: there is
 * no process to exit, no argument vector, no standard input. What does map is
 * the environment, the working directory, the platform, and the microtask
 * queue, and those are wired up for real. The rest either reports a benign
 * placeholder or throws, and each case says which below.
 */

import { arch } from './os.js';
import { cwd as getWorkingDirectory, chdir as setWorkingDirectory } from './path.js';

// ============================================================================
// Environment
// ============================================================================

/**
 * Environment variables
 *
 * nova.environment is read-only, but Node.js code assigns to process.env
 * routinely, so this is a mutable copy. Assignments are visible to the rest of
 * the extension and nowhere else; they do not reach the editor or any
 * subprocess. Values are coerced to strings, as Node.js does.
 */
export const env: Record<string, string | undefined> = new Proxy({ ...nova.environment } as Record<string, string>, {
	set(target, key: string, value) {
		// Node.js stringifies whatever it is given, undefined included
		target[key] = String(value);

		return true;
	},
});

// ============================================================================
// Working directory
// ============================================================================

/**
 * Current working directory
 *
 * Reports the same directory that path.resolve and the fs methods treat as
 * their base, so that resolving against process.cwd() agrees with resolving
 * against nothing at all.
 */
export function cwd(): string {
	return getWorkingDirectory();
}

/**
 * Change the current working directory
 *
 * Changes the base directory used by path and fs too, which is the only way
 * for this to mean anything.
 */
export function chdir(directory: string): void {
	setWorkingDirectory(directory);
}

// ============================================================================
// Scheduling
// ============================================================================

/**
 * Queue a callback ahead of the next macrotask
 *
 * Node.js runs nextTick callbacks before promise continuations. Nova has no
 * queueMicrotask, so a resolved promise provides the microtask, which lands in
 * the right place relative to timers even if not relative to other promises.
 */
export function nextTick<T extends unknown[]>(callback: (...args: T) => void, ...args: T): void {
	Promise.resolve().then(() => callback(...args));
}

// ============================================================================
// Standard streams
// ============================================================================

/**
 * Build a console-backed stand-in for a standard stream
 *
 * Output is buffered until a newline arrives, because Node.js code writes
 * partial lines and Nova's console emits one message per call.
 */
function createStream(write: (line: string) => void) {
	let pending = '';

	return {
		writable: true,
		isTTY: false,
		columns: 80,
		rows: 24,

		write(chunk: string | Uint8Array): boolean {
			pending += typeof chunk === 'string' ? chunk : String.fromCharCode(...chunk);

			const lines = pending.split('\n');

			// Whatever follows the last newline stays buffered
			pending = lines.pop() ?? '';

			for (const line of lines) {
				write(line);
			}

			return true;
		},

		end(): void {
			if (pending) {
				write(pending);
				pending = '';
			}
		},

		// Nothing here emits stream events, but registering for them is harmless
		on() {
			return this;
		},
		once() {
			return this;
		},
		removeListener() {
			return this;
		},
		setEncoding() {
			return this;
		},
	};
}

export const stdout = createStream((line) => console.log(line));

export const stderr = createStream((line) => console.error(line));

/**
 * Standard input, which an extension does not have
 *
 * Reads return null rather than throwing, so that code draining stdin sees an
 * immediately empty stream instead of crashing.
 */
export const stdin = {
	readable: false,
	isTTY: false,
	read: () => null,
	setEncoding() {
		return stdin;
	},
	resume() {
		return stdin;
	},
	pause() {
		return stdin;
	},
	on() {
		return stdin;
	},
	once() {
		return stdin;
	},
	removeListener() {
		return stdin;
	},
};

// ============================================================================
// Events
// ============================================================================

const listeners = new Map<string, Array<(...args: unknown[]) => void>>();

/**
 * Register a process event listener
 *
 * Nothing in the runtime emits 'exit', 'beforeExit' or 'uncaughtException',
 * so handlers for those are stored and never called. They are accepted anyway
 * because packages register them on import and would otherwise fail to load.
 */
export function on(event: string, listener: (...args: unknown[]) => void): typeof processExport {
	listeners.set(event, [...(listeners.get(event) ?? []), listener]);

	return processExport;
}

export function once(event: string, listener: (...args: unknown[]) => void): typeof processExport {
	const wrapped = (...args: unknown[]) => {
		off(event, wrapped);
		listener(...args);
	};

	return on(event, wrapped);
}

export function off(event: string, listener: (...args: unknown[]) => void): typeof processExport {
	listeners.set(
		event,
		(listeners.get(event) ?? []).filter((candidate) => candidate !== listener),
	);

	return processExport;
}

export const removeListener = off;

export function removeAllListeners(event?: string): typeof processExport {
	if (event === undefined) {
		listeners.clear();
	} else {
		listeners.delete(event);
	}

	return processExport;
}

export function emit(event: string, ...args: unknown[]): boolean {
	const registered = listeners.get(event) ?? [];

	for (const listener of registered) {
		listener(...args);
	}

	return registered.length > 0;
}

export function listenerCount(event: string): number {
	return (listeners.get(event) ?? []).length;
}

export function setMaxListeners(): typeof processExport {
	return processExport;
}

export function emitWarning(warning: string | Error): void {
	console.warn(warning instanceof Error ? warning.message : warning);
}

// ============================================================================
// Timing
// ============================================================================

const startedAt = Date.now();

/**
 * Seconds the extension has been running
 */
export function uptime(): number {
	return (Date.now() - startedAt) / 1000;
}

/**
 * High resolution time as [seconds, nanoseconds]
 *
 * Nova exposes no high resolution clock, so this is derived from Date.now and
 * is therefore only accurate to the millisecond. Code that measures durations
 * still works; code that expects sub-millisecond precision will see zeroes.
 */
export const hrtime = Object.assign(
	(previous?: [number, number]): [number, number] => {
		const elapsed = Date.now() - startedAt;
		const current: [number, number] = [Math.floor(elapsed / 1000), (elapsed % 1000) * 1e6];

		if (!previous) {
			return current;
		}

		const seconds = current[0] - previous[0];
		const nanoseconds = current[1] - previous[1];

		return nanoseconds < 0 ? [seconds - 1, nanoseconds + 1e9] : [seconds, nanoseconds];
	},
	{
		bigint: (): bigint => BigInt(Date.now() - startedAt) * 1000000n,
	},
);

// ============================================================================
// Resource usage
// ============================================================================

/**
 * Memory usage, which Nova does not report
 */
export function memoryUsage(): {
	rss: number;
	heapTotal: number;
	heapUsed: number;
	external: number;
	arrayBuffers: number;
} {
	return { rss: 0, heapTotal: 0, heapUsed: 0, external: 0, arrayBuffers: 0 };
}

/**
 * CPU usage, which Nova does not report
 */
export function cpuUsage(): { user: number; system: number } {
	return { user: 0, system: 0 };
}

// ============================================================================
// Identity
// ============================================================================

/** Nova runs on macOS only */
export const platform: NodeJS.Platform = 'darwin';

/** Reported by the os shim, which resolves it once per activation */
export { arch };

/**
 * Node.js version claimed by this shim
 *
 * This is a fiction: no Node.js runtime is involved. It is reported anyway
 * because packages parse it to decide which language features to use, and an
 * empty or nonsense value makes them fail outright rather than degrade. The
 * version named here is the one whose feature set JavaScriptCore in Nova comes
 * closest to.
 */
export const version = 'v20.0.0';

export const versions: Record<string, string> = {
	node: '20.0.0',
	nova: nova.versionString,
};

export const release = { name: 'node' };

/**
 * Argument vector
 *
 * There is no command line, but Node.js guarantees at least two entries and
 * plenty of code indexes into them without checking.
 */
export const argv = ['node', nova.extension.path];

export const argv0 = 'node';

export const execPath = 'node';

export const execArgv: string[] = [];

export const title = 'nova';

/**
 * Process identifier
 *
 * Nova does not expose one. A value is invented at load so that code using the
 * pid to build unique names still gets uniqueness, which is what that code is
 * usually after.
 */
export const pid = 1 + Math.floor(Math.random() * 65535);

export const ppid = 0;

/** Set by code that would have exited with a status */
export let exitCode: number | undefined;

// ============================================================================
// Unsupported Operations
// ============================================================================

/**
 * Terminate the process
 *
 * An extension cannot end the editor it runs in. Throwing is the closest
 * available behaviour, because it stops execution at the same point Node.js
 * would have, rather than letting code that assumed it was unreachable
 * continue to run.
 */
export function exit(code?: number): never {
	exitCode = code ?? exitCode;

	throw new Error(
		`process.exit(${code ?? ''}) is not supported in Nova extensions, because an extension cannot terminate the editor.`,
	);
}

const unsupportedError = (method: string) => () => {
	throw new Error(`process.${method} is not supported in Nova extensions.`);
};

export const abort = unsupportedError('abort');

export const kill = unsupportedError('kill');

export const binding = unsupportedError('binding');

export const dlopen = unsupportedError('dlopen');

// getuid, getgid, setuid, setgid and umask are deliberately absent rather than
// stubbed. Node.js code feature-detects them, and a stub reporting uid 0 would
// tell a package it is running as root.

// ============================================================================
// Default Export
// ============================================================================

const processExport = {
	abort,
	arch,
	argv,
	argv0,
	binding,
	chdir,
	cpuUsage,
	cwd,
	dlopen,
	emit,
	emitWarning,
	env,
	execArgv,
	execPath,
	exit,
	get exitCode() {
		return exitCode;
	},
	set exitCode(code: number | undefined) {
		exitCode = code;
	},
	hrtime,
	kill,
	listenerCount,
	memoryUsage,
	nextTick,
	off,
	on,
	once,
	pid,
	platform,
	ppid,
	release,
	removeAllListeners,
	removeListener,
	setMaxListeners,
	stderr,
	stdin,
	stdout,
	title,
	uptime,
	version,
	versions,
};

export default processExport;
