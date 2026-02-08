/**
 * OS module compatibility layer for Nova extensions
 * Maps Node.js os API to Nova-compatible implementations
 *
 * Nova only runs on macOS, so all values are macOS-specific
 */

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Execute a shell command and return its output
 * @param command - The shell command to execute
 * @returns The command output, trimmed
 */
function execSync(command: string): string {
	try {
		const process = new Process('/usr/bin/env', {
			args: ['sh', '-c', command],
			shell: true,
		});

		let output = '';
		process.onStdout((line) => {
			output += line;
		});

		process.start();

		// Wait for process to complete (with timeout)
		let attempts = 0;
		while (process.pid && attempts < 100) {
			// Process is still running, wait a bit
			attempts++;
		}

		return output.trim();
	} catch {
		return '';
	}
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
 * Uses sysctl to detect if running under Rosetta translation
 */
export function arch(): string {
	// Check if running under Rosetta (Intel binary on Apple Silicon)
	const rosettaArm = execSync('sysctl -in sysctl.proc_translated') === '1';

	if (rosettaArm) {
		return 'arm64';
	}

	// Get the actual architecture
	const archOutput = execSync('uname -m');

	// Map macOS architecture names to Node.js conventions
	if (archOutput === 'arm64' || archOutput === 'aarch64') {
		return 'arm64';
	}

	if (archOutput === 'x86_64') {
		return 'x64';
	}

	// Fallback to arm64 for modern Macs
	return 'arm64';
}

/**
 * Returns the operating system release version (kernel version)
 * Uses uname -r to get the Darwin kernel version
 */
export function release(): string {
	return execSync('uname -r');
}

/**
 * Returns the system hostname
 * Uses hostname command or constructs from LocalHostName
 */
export function hostname(): string {
	// Try hostname command first (returns full hostname like "MacBook-Pro.local")
	let name = execSync('hostname');

	if (name) {
		return name;
	}

	// Fallback to LocalHostName (Bonjour name) + .local
	// LocalHostName is guaranteed to be hostname-safe (no spaces)
	name = execSync('scutil --get LocalHostName');

	if (name) {
		return `${name}.local`;
	}

	// Last resort: empty string
	return '';
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
 * Uses sysctl to get hardware memory size
 */
export function totalmem(): number {
	const memSize = execSync('sysctl -n hw.memsize');

	return memSize ? Number.parseInt(memSize, 10) : 0;
}

/**
 * Returns the amount of free system memory in bytes
 * Uses vm_stat to get free and inactive memory pages
 */
export function freemem(): number {
	const vmStat = execSync('vm_stat');

	if (!vmStat) {
		return 0;
	}

	// Extract page size and free pages from vm_stat output
	const pageSizeMatch = vmStat.match(/page size of (\d+) bytes/);
	const freeMatch = vmStat.match(/Pages free:\s+(\d+)/);
	const inactiveMatch = vmStat.match(/Pages inactive:\s+(\d+)/);

	if (!pageSizeMatch?.[1] || !freeMatch?.[1]) {
		return 0;
	}

	const pageSize = Number.parseInt(pageSizeMatch[1], 10);
	const freePages = Number.parseInt(freeMatch[1], 10);
	const inactivePages = inactiveMatch?.[1] ? Number.parseInt(inactiveMatch[1], 10) : 0;

	// Free memory = (free pages + inactive pages) * page size
	return (freePages + inactivePages) * pageSize;
}

/**
 * Returns an array of objects containing information about each CPU/core
 * Uses sysctl to get CPU information
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
	const model = execSync('sysctl -n machdep.cpu.brand_string') || 'Unknown';
	const cpuFreqStr = execSync('sysctl -n hw.cpufrequency');
	const logicalCpuStr = execSync('sysctl -n hw.logicalcpu');

	// Convert frequency from Hz to MHz
	const speed = cpuFreqStr ? Math.round(Number.parseInt(cpuFreqStr, 10) / 1_000_000) : 0;
	const count = logicalCpuStr ? Number.parseInt(logicalCpuStr, 10) : 1;

	// Create an entry for each logical CPU
	// Note: CPU times (user, nice, sys, idle, irq) are set to 0
	// Getting accurate CPU time statistics would require parsing complex system tools
	const cpuInfo = {
		model: model.trim(),
		speed,
		times: {
			user: 0,
			nice: 0,
			sys: 0,
			idle: 0,
			irq: 0,
		},
	};

	return Array.from({ length: count }, () => ({ ...cpuInfo }));
}

/**
 * Returns the system uptime in seconds
 * Uses sysctl to get boot time and calculates uptime
 */
export function uptime(): number {
	const bootTime = execSync('sysctl -n kern.boottime');

	if (!bootTime) {
		return 0;
	}

	// kern.boottime returns format like "{ sec = 1234567890, usec = 0 } ..."
	const match = bootTime.match(/sec\s*=\s*(\d+)/);

	if (!match?.[1]) {
		return 0;
	}

	const bootTimestamp = Number.parseInt(match[1], 10);
	const now = Math.floor(Date.now() / 1000);

	return now - bootTimestamp;
}

/**
 * Returns an array of objects containing information about network interfaces
 * Uses ifconfig to parse network interface information
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
	const ifconfigOutput = execSync('ifconfig');

	if (!ifconfigOutput) {
		return {};
	}

	const interfaces: Record<
		string,
		Array<{
			address: string;
			netmask: string;
			family: string;
			mac: string;
			internal: boolean;
			cidr: string | null;
		}>
	> = {};

	// Split by interface (lines that don't start with whitespace or tab)
	const lines = ifconfigOutput.split('\n');
	let currentInterface = '';
	let currentMac = '';

	for (const line of lines) {
		// New interface starts (no leading whitespace)
		if (line && !line.startsWith('\t') && !line.startsWith(' ')) {
			const match = line.match(/^([^:]+):/);

			if (match?.[1]) {
				currentInterface = match[1];
				currentMac = '';

				if (!interfaces[currentInterface]) {
					interfaces[currentInterface] = [];
				}
			}
		} else if (currentInterface) {
			// Parse MAC address (ether line)
			const macMatch = line.match(/ether\s+([0-9a-f:]+)/i);
			if (macMatch?.[1]) {
				currentMac = macMatch[1];
			}

			// Parse IPv4 address
			const inet4Match = line.match(/inet\s+(\d+\.\d+\.\d+\.\d+)\s+netmask\s+0x([0-9a-f]+)/i);
			const interfaceArray = interfaces[currentInterface];

			if (inet4Match?.[1] && inet4Match?.[2] && interfaceArray) {
				const address = inet4Match[1];
				const netmaskHex = inet4Match[2];

				// Convert hex netmask to dotted decimal
				const netmask =
					netmaskHex
						.match(/.{2}/g)
						?.map((hex) => Number.parseInt(hex, 16))
						.join('.') || '0.0.0.0';

				// Calculate CIDR
				const cidrBits = netmask.split('.').reduce((sum, octet) => {
					return sum + Number.parseInt(octet, 10).toString(2).split('1').length - 1;
				}, 0);
				const cidr = `${address}/${cidrBits}`;

				interfaceArray.push({
					address,
					netmask,
					family: 'IPv4',
					mac: currentMac || '00:00:00:00:00:00',
					internal: currentInterface === 'lo0' || address.startsWith('127.'),
					cidr,
				});
			}

			// Parse IPv6 address
			const inet6Match = line.match(/inet6\s+([0-9a-f:]+)(?:%\w+)?\s+prefixlen\s+(\d+)/i);
			const interfaceArray6 = interfaces[currentInterface];

			if (inet6Match?.[1] && inet6Match?.[2] && interfaceArray6) {
				const address = inet6Match[1];
				const prefixLen = inet6Match[2];
				const cidr = `${address}/${prefixLen}`;

				interfaceArray6.push({
					address,
					netmask: 'ffff:ffff:ffff:ffff::',
					family: 'IPv6',
					mac: currentMac || '00:00:00:00:00:00',
					internal: currentInterface === 'lo0' || address === '::1' || address.startsWith('fe80:'),
					cidr,
				});
			}
		}
	}

	return interfaces;
}

/**
 * Returns an array containing the 1, 5, and 15 minute load averages
 * Uses sysctl to get system load averages
 */
export function loadavg(): [number, number, number] {
	const loadavgStr = execSync('sysctl -n vm.loadavg');
	if (!loadavgStr) {
		return [0, 0, 0];
	}

	// vm.loadavg returns format like "{ 1.23 2.34 3.45 }"
	const match = loadavgStr.match(/\{\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)/);

	if (!match) {
		return [0, 0, 0];
	}

	return [Number.parseFloat(match[1] || '0'), Number.parseFloat(match[2] || '0'), Number.parseFloat(match[3] || '0')];
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
 * Uses id command to get uid/gid and environment variables for other info
 */
export function userInfo(_options?: { encoding: BufferEncoding }): {
	uid: number;
	gid: number;
	username: string;
	homedir: string;
	shell: string | null;
} {
	// Get UID and GID from id command
	const uidStr = execSync('id -u');
	const gidStr = execSync('id -g');

	const uid = uidStr ? Number.parseInt(uidStr, 10) : -1;
	const gid = gidStr ? Number.parseInt(gidStr, 10) : -1;

	return {
		uid,
		gid,
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
 * Uses uname -v to get the full kernel version string
 */
export function version(): string {
	return execSync('uname -v');
}

/**
 * Returns the machine type (hardware model)
 * Uses sysctl to get the hardware model identifier
 */
export function machine(): string {
	return execSync('sysctl -n hw.model');
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
