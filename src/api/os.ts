/**
 * OS module compatibility layer for Nova extensions
 * Maps Node.js os API to Nova-compatible implementations
 *
 * Nova only runs on macOS, so all values are macOS-specific.
 *
 * Static system information (arch, hostname, cpus, etc.) is cached at module
 * load time because Nova's Process API is async-only. The cache is populated
 * eagerly when the module loads, so values are available synchronously.
 */

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Execute a shell command asynchronously
 *
 * Nova's Process API is async-only - there's no way to synchronously wait
 * for process completion. This function properly uses onDidExit to wait
 * for the process to finish.
 */
function exec(command: string): Promise<string> {
	return new Promise((resolve) => {
		try {
			const process = new Process('/usr/bin/env', {
				args: ['sh', '-c', command],
				shell: true,
			});

			let output = '';

			process.onStdout((line) => {
				output += line;
			});

			process.onDidExit(() => {
				resolve(output.trim());
			});

			process.start();
		} catch {
			resolve('');
		}
	});
}

// ============================================================================
// Static System Info Cache
// ============================================================================

/**
 * Cache for static system information that doesn't change during runtime.
 * Populated eagerly at module load time.
 */
const cache = {
	arch: 'arm64', // Default fallback
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

/**
 * Initialize the cache with static system information.
 * Called at module load time.
 */
async function initializeCache(): Promise<void> {
	// Run all commands in parallel for faster initialization
	const [
		rosettaCheck,
		unameM,
		hostnameResult,
		release,
		version,
		machine,
		memsize,
		cpuModel,
		cpuFreq,
		cpuCount,
		bootTime,
	] = await Promise.all([
		exec('sysctl -in sysctl.proc_translated'),
		exec('uname -m'),
		exec('hostname'),
		exec('uname -r'),
		exec('uname -v'),
		exec('sysctl -n hw.model'),
		exec('sysctl -n hw.memsize'),
		exec('sysctl -n machdep.cpu.brand_string'),
		exec('sysctl -n hw.cpufrequency'),
		exec('sysctl -n hw.logicalcpu'),
		exec('sysctl -n kern.boottime'),
	]);

	// Determine architecture
	if (rosettaCheck === '1') {
		cache.arch = 'arm64';
	} else if (unameM === 'arm64' || unameM === 'aarch64') {
		cache.arch = 'arm64';
	} else if (unameM === 'x86_64') {
		cache.arch = 'x64';
	}

	cache.hostname = hostnameResult || '';
	cache.release = release;
	cache.version = version;
	cache.machine = machine;
	cache.totalmem = memsize ? Number.parseInt(memsize, 10) : 0;
	cache.cpuModel = cpuModel || 'Unknown';
	cache.cpuSpeed = cpuFreq ? Math.round(Number.parseInt(cpuFreq, 10) / 1_000_000) : 0;
	cache.cpuCount = cpuCount ? Number.parseInt(cpuCount, 10) : 1;

	// Parse boot timestamp for uptime calculation
	const bootMatch = bootTime.match(/sec\s*=\s*(\d+)/);
	if (bootMatch?.[1]) {
		cache.bootTimestamp = Number.parseInt(bootMatch[1], 10);
	}
}

// Start cache initialization immediately when module loads
initializeCache();

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
 * Returns cached value populated at module load time.
 * Uses sysctl to detect if running under Rosetta translation.
 */
export function arch(): string {
	return cache.arch;
}

/**
 * Returns the operating system release version (kernel version)
 *
 * Returns cached value populated at module load time.
 */
export function release(): string {
	return cache.release;
}

/**
 * Returns the system hostname
 *
 * Returns cached value populated at module load time.
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
 * Returns cached value populated at module load time.
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
 * Returns cached values populated at module load time.
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
 * Calculates uptime from cached boot timestamp (fetched at module load)
 * and current time. This allows the value to update without async calls.
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
 * Returns cached value populated at module load time.
 */
export function version(): string {
	return cache.version;
}

/**
 * Returns the machine type (hardware model)
 *
 * Returns cached value populated at module load time.
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
