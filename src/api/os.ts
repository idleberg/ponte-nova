/**
 * OS module compatibility layer for Nova extensions
 * Maps Node.js os API to Nova-compatible implementations
 *
 * Nova only runs on macOS, so all values are macOS-specific.
 *
 * The Node.js os API is entirely synchronous, but the only way to obtain most
 * of these values in Nova is the Process API, which is async-only. Values that
 * describe the machine rather than its current state (arch, hostname, cpus,
 * total memory, boot time) don't change between extension activations, so they
 * are persisted to disk and read back synchronously on the next launch. A
 * background refresh, started the first time any of these values is read,
 * keeps that file current.
 *
 * The consequence is a cold start: on the very first activation - before the
 * file exists - these methods return the fallbacks defined below. Values that
 * change from moment to moment (freemem, loadavg, networkInterfaces) can't be
 * cached at all and remain unsupported.
 */

// ============================================================================
// Static System Info Cache
// ============================================================================

interface SystemInfo {
	arch: string;
	hostname: string;
	release: string;
	version: string;
	machine: string;
	totalmem: number;
	cpuModel: string;
	cpuSpeed: number;
	cpuCount: number;
	bootTimestamp: number;
}

/** Values used until the cache file has been written for the first time */
const fallbacks: SystemInfo = {
	arch: 'arm64',
	hostname: '',
	release: '',
	version: '',
	machine: '',
	totalmem: 0,
	cpuModel: 'Unknown',
	cpuSpeed: 0,
	cpuCount: 1,
	bootTimestamp: 0,
};

const cacheDir = nova.extension.globalStoragePath;
const cachePath = `${cacheDir}/os-cache.json`;

/**
 * Read the persisted system information
 *
 * Deliberately uses nova.fs rather than the fs compatibility layer: no path
 * resolution or Node.js error semantics are wanted here, just a synchronous
 * read that falls back silently when the file is absent or unreadable.
 */
function readCache(): SystemInfo {
	try {
		const file = nova.fs.open(cachePath, 'r') as FileTextMode;
		const contents = file.read();

		file.close();

		return { ...fallbacks, ...JSON.parse(contents ?? '') };
	} catch {
		return { ...fallbacks };
	}
}

function writeCache(info: SystemInfo): void {
	try {
		if (!nova.fs.access(cacheDir, nova.fs.F_OK)) {
			nova.fs.mkdir(cacheDir);
		}

		const file = nova.fs.open(cachePath, 'w') as FileTextMode;

		file.write(JSON.stringify(info));
		file.close();
	} catch {
		// A missing cache only costs accuracy on the next launch, never correctness
	}
}

let refreshRequested = false;

/**
 * Cached system information, refreshed the first time any of it is read
 *
 * The refresh costs a subprocess, so it is deferred until something actually
 * asks for a value rather than run at import. That matters because the process
 * shim imports this module for arch alone, and an extension that only reads
 * process.env should not be spawning a shell.
 */
const cache = new Proxy(readCache(), {
	get(target, key: string) {
		if (!refreshRequested) {
			refreshRequested = true;
			refreshCache();
		}

		return target[key as keyof SystemInfo];
	},
});

/**
 * Collect system information in a single subprocess
 *
 * Every value is emitted as a `key=value` line so that a sysctl which doesn't
 * exist on this hardware (hw.cpufrequency on Apple Silicon, for one) yields an
 * empty value instead of shifting every subsequent line.
 */
function collect(): Promise<Record<string, string>> {
	const script = [
		'echo "translated=$(sysctl -in sysctl.proc_translated)"',
		'echo "unameM=$(uname -m)"',
		'echo "hostname=$(hostname)"',
		'echo "release=$(uname -r)"',
		'echo "version=$(uname -v)"',
		'echo "machine=$(sysctl -n hw.model 2>/dev/null)"',
		'echo "memsize=$(sysctl -n hw.memsize 2>/dev/null)"',
		'echo "cpuModel=$(sysctl -n machdep.cpu.brand_string 2>/dev/null)"',
		'echo "cpuFreq=$(sysctl -n hw.cpufrequency 2>/dev/null)"',
		'echo "cpuCount=$(sysctl -n hw.logicalcpu 2>/dev/null)"',
		'echo "boottime=$(sysctl -n kern.boottime 2>/dev/null)"',
	].join('\n');

	return new Promise((resolve) => {
		try {
			const process = new Process('/bin/sh', { args: ['-c', script] });
			const values: Record<string, string> = {};

			process.onStdout((line) => {
				const separator = line.indexOf('=');

				if (separator > 0) {
					values[line.slice(0, separator)] = line.slice(separator + 1).trim();
				}
			});

			process.onDidExit(() => resolve(values));
			process.start();
		} catch {
			resolve({});
		}
	});
}

/**
 * Refresh the cache in the background
 *
 * Results are merged into the live cache as well as written to disk, so a
 * long-running session picks up correct values even on a cold start.
 */
async function refreshCache(): Promise<void> {
	const values = await collect();

	// Nothing was collected - keep whatever the cache already holds
	if (!values.unameM) {
		return;
	}

	// Under Rosetta, uname reports the translated architecture, not the hardware
	const arch =
		values.translated === '1' || values.unameM === 'arm64' || values.unameM === 'aarch64'
			? 'arm64'
			: values.unameM === 'x86_64'
				? 'x64'
				: fallbacks.arch;

	const bootTimestamp = values.boottime?.match(/sec\s*=\s*(\d+)/)?.[1];

	Object.assign(cache, {
		arch,
		hostname: values.hostname || '',
		release: values.release || '',
		version: values.version || '',
		machine: values.machine || '',
		totalmem: Number.parseInt(values.memsize ?? '', 10) || 0,
		cpuModel: values.cpuModel || 'Unknown',
		cpuSpeed: Math.round(Number.parseInt(values.cpuFreq ?? '', 10) / 1_000_000) || 0,
		cpuCount: Number.parseInt(values.cpuCount ?? '', 10) || 1,
		bootTimestamp: bootTimestamp ? Number.parseInt(bootTimestamp, 10) : 0,
	} satisfies SystemInfo);

	writeCache(cache);
}

// ============================================================================
// Constants
// ============================================================================

/** End-of-line marker - always \n on macOS */
export const EOL = '\n';

// ============================================================================
// Platform Information
// ============================================================================

/**
 * Returns the operating system platform
 * @returns 'darwin' - Nova only runs on macOS
 */
export function platform(): NodeJS.Platform {
	return 'darwin';
}

/**
 * Returns the operating system name
 * @returns 'Darwin' - macOS system name
 */
export function type(): string {
	return 'Darwin';
}

/**
 * Returns the operating system CPU architecture
 *
 * Read from the persisted cache; see the note at the top of this module.
 * Uses sysctl to detect if running under Rosetta translation.
 */
export function arch(): string {
	return cache.arch;
}

/**
 * Returns the operating system release version (kernel version)
 *
 * Read from the persisted cache; see the note at the top of this module.
 */
export function release(): string {
	return cache.release;
}

/**
 * Returns the system hostname
 *
 * Read from the persisted cache; see the note at the top of this module.
 */
export function hostname(): string {
	return cache.hostname;
}

// ============================================================================
// User and Directory Information
// ============================================================================

/**
 * Returns the home directory of the current user
 * Uses Nova's environment variables
 */
export function homedir(): string {
	// Try to get HOME from Nova's environment
	const home = nova.environment.HOME;

	if (home) {
		return home;
	}

	// Fallback to common macOS home directory pattern
	// This is not ideal but better than nothing
	return '/Users';
}

/**
 * Returns the operating system's default directory for temporary files
 * @returns '/tmp' - standard macOS temp directory
 */
export function tmpdir(): string {
	// Check for TMPDIR environment variable first (macOS convention)
	const tmpDir = nova.environment.TMPDIR;

	if (tmpDir) {
		// Remove trailing slash if present
		return tmpDir.endsWith('/') ? tmpDir.slice(0, -1) : tmpDir;
	}

	return '/tmp';
}

// ============================================================================
// System Information
// ============================================================================

/**
 * Returns the total amount of system memory in bytes
 *
 * Read from the persisted cache; see the note at the top of this module.
 */
export function totalmem(): number {
	return cache.totalmem;
}

/**
 * Returns the amount of free system memory in bytes
 *
 * NOT IMPLEMENTED: This value changes constantly and cannot be cached.
 * Nova's Process API is async-only, so there's no way to fetch this
 * value synchronously. Returns 0.
 */
export function freemem(): number {
	console.warn('os.freemem() is not supported in Nova - returns 0. Use totalmem() for total memory.');
	return 0;
}

/**
 * Returns an array of objects containing information about each CPU/core
 *
 * Read from the persisted cache; see the note at the top of this module.
 * Note: CPU times are always 0 as Nova doesn't expose this information.
 */
export function cpus(): Array<{
	model: string;
	speed: number;
	times: {
		user: number;
		nice: number;
		sys: number;
		idle: number;
		irq: number;
	};
}> {
	const cpuInfo = {
		model: cache.cpuModel.trim(),
		speed: cache.cpuSpeed,
		times: {
			user: 0,
			nice: 0,
			sys: 0,
			idle: 0,
			irq: 0,
		},
	};

	return Array.from({ length: cache.cpuCount }, () => ({ ...cpuInfo }));
}

/**
 * Returns the system uptime in seconds
 *
 * Derived from the cached boot timestamp and the current time, so the value
 * stays accurate as the session goes on without needing an async call. A boot
 * timestamp cached before the last restart is corrected by the background
 * refresh; see the note at the top of this module.
 */
export function uptime(): number {
	if (cache.bootTimestamp === 0) {
		return 0;
	}

	const now = Math.floor(Date.now() / 1000);
	return now - cache.bootTimestamp;
}

/**
 * Returns an array of objects containing information about network interfaces
 *
 * NOT IMPLEMENTED: Network interfaces can change during runtime and cannot
 * be reliably cached. Nova's Process API is async-only, so there's no way
 * to fetch this value synchronously. Returns empty object.
 */
export function networkInterfaces(): Record<
	string,
	Array<{
		address: string;
		netmask: string;
		family: string;
		mac: string;
		internal: boolean;
		cidr: string | null;
	}>
> {
	console.warn('os.networkInterfaces() is not supported in Nova - returns empty object.');
	return {};
}

/**
 * Returns an array containing the 1, 5, and 15 minute load averages
 *
 * NOT IMPLEMENTED: Load averages change constantly and cannot be cached.
 * Nova's Process API is async-only, so there's no way to fetch this
 * value synchronously. Returns [0, 0, 0].
 */
export function loadavg(): [number, number, number] {
	console.warn('os.loadavg() is not supported in Nova - returns [0, 0, 0].');
	return [0, 0, 0];
}

/**
 * Returns the scheduling priority for the process specified by pid
 * Nova doesn't support this operation
 */
export function getPriority(_pid?: number): number {
	throw new Error('os.getPriority is not supported in Nova extensions. Nova does not expose process priority APIs.');
}

/**
 * Sets the scheduling priority for the process specified by pid
 * Nova doesn't support this operation
 */
export function setPriority(_priority: number): void;
export function setPriority(_pid: number, _priority: number): void;
export function setPriority(_pidOrPriority: number, _priority?: number): void {
	throw new Error('os.setPriority is not supported in Nova extensions. Nova does not expose process priority APIs.');
}

/**
 * Returns information about the currently effective user
 *
 * Uses Nova's environment variables for username, homedir, and shell.
 * UID and GID return -1 as they require async process execution.
 */
export function userInfo(_options?: { encoding: BufferEncoding }): {
	uid: number;
	gid: number;
	username: string;
	homedir: string;
	shell: string | null;
} {
	return {
		uid: -1,
		gid: -1,
		username: nova.environment.USER || '',
		homedir: homedir(),
		shell: nova.environment.SHELL || null,
	};
}

// ============================================================================
// Path Separators
// ============================================================================

/**
 * The platform-specific path segment separator
 * @returns ':' on macOS
 */
export const devNull = '/dev/null';

// ============================================================================
// Endianness
// ============================================================================

/**
 * Returns the endianness of the CPU
 * Modern Macs (both Intel and Apple Silicon) are little-endian
 */
export function endianness(): 'BE' | 'LE' {
	return 'LE';
}

// ============================================================================
// Machine and Version
// ============================================================================

/**
 * Returns a string identifying the kernel version
 *
 * Read from the persisted cache; see the note at the top of this module.
 */
export function version(): string {
	return cache.version;
}

/**
 * Returns the machine type (hardware model)
 *
 * Read from the persisted cache; see the note at the top of this module.
 */
export function machine(): string {
	return cache.machine;
}

// ============================================================================
// Default Export
// ============================================================================

export default {
	EOL,
	arch,
	cpus,
	devNull,
	endianness,
	freemem,
	getPriority,
	homedir,
	hostname,
	loadavg,
	machine,
	networkInterfaces,
	platform,
	release,
	setPriority,
	tmpdir,
	totalmem,
	type,
	uptime,
	userInfo,
	version,
};
