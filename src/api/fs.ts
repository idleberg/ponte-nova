/**
 * File System module compatibility layer for Nova extensions
 * Maps Node.js fs API to Nova's FileSystem API where possible
 */

import type {
	CopyOptions,
	Dirent,
	MakeDirectoryOptions,
	Mode,
	ObjectEncodingOptions,
	OpenMode,
	RmOptions,
	StatOptions,
	Stats,
} from 'node:fs';
import { Buffer } from './buffer.js';
import * as compatPath from './path.js';

// Extended error type for file system operations with dest property
interface FileSystemError extends NodeJS.ErrnoException {
	dest?: string;
}

/**
 * Options for rmdir
 *
 * Declared here rather than imported, because @types/node now types it as an
 * empty interface: `recursive` is deprecated in favour of `rm`, but Node.js
 * still honours it and packages still pass it.
 */
interface RmDirOptions {
	maxRetries?: number;
	recursive?: boolean;
	retryDelay?: number;
}

// ============================================================================
// Constants
// ============================================================================

export const constants = {
	// File Access Constants
	F_OK: 0, // File exists
	R_OK: 4, // File is readable
	W_OK: 2, // File is writable
	X_OK: 1, // File is executable

	// File Open Constants
	//
	// These are the Darwin values from <sys/fcntl.h>, matching what Node.js
	// exposes on macOS. O_NOATIME and O_DIRECT are Linux-only and therefore
	// absent here, just as they are absent from Node.js on macOS.
	O_RDONLY: 0,
	O_WRONLY: 1,
	O_RDWR: 2,
	O_NONBLOCK: 4,
	O_APPEND: 8,
	O_SYNC: 128,
	O_NOFOLLOW: 256,
	O_CREAT: 512,
	O_TRUNC: 1024,
	O_EXCL: 2048,
	O_NOCTTY: 131072,
	O_DIRECTORY: 1048576,
	O_SYMLINK: 2097152,
	O_DSYNC: 4194304,

	// File Type Constants (for stats mode)
	S_IFMT: 61440, // Bit mask for file type
	S_IFREG: 32768, // Regular file
	S_IFDIR: 16384, // Directory
	S_IFCHR: 8192, // Character device
	S_IFBLK: 24576, // Block device
	S_IFIFO: 4096, // FIFO/pipe
	S_IFLNK: 40960, // Symbolic link
	S_IFSOCK: 49152, // Socket

	// File Mode Constants (permissions)
	S_IRWXU: 448, // Owner: RWX
	S_IRUSR: 256, // Owner: read
	S_IWUSR: 128, // Owner: write
	S_IXUSR: 64, // Owner: execute
	S_IRWXG: 56, // Group: RWX
	S_IRGRP: 32, // Group: read
	S_IWGRP: 16, // Group: write
	S_IXGRP: 8, // Group: execute
	S_IRWXO: 7, // Others: RWX
	S_IROTH: 4, // Others: read
	S_IWOTH: 2, // Others: write
	S_IXOTH: 1, // Others: execute

	// File Copy Constants
	COPYFILE_EXCL: 1, // Fail if destination exists
	COPYFILE_FICLONE: 2, // Copy-on-write clone
	COPYFILE_FICLONE_FORCE: 4, // Force copy-on-write

	// UV Constants (libuv error codes - included for compatibility)
	UV_FS_SYMLINK_DIR: 1,
	UV_FS_SYMLINK_JUNCTION: 2,
	UV_FS_COPYFILE_EXCL: 1,
	UV_FS_COPYFILE_FICLONE: 2,
	UV_FS_COPYFILE_FICLONE_FORCE: 4,
};

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Defer a callback to the next tick of the event loop
 *
 * Node.js uses setImmediate to invoke fs callbacks asynchronously, but Nova
 * only provides setTimeout/setInterval. A zero-delay timeout is the closest
 * equivalent: like setImmediate, it runs as a macrotask after the current
 * synchronous execution completes.
 */
function defer(callback: () => void): void {
	setTimeout(callback, 0);
}

/**
 * Darwin errno values, as reported by Node.js on macOS
 */
const errnos: Record<string, [number, string]> = {
	EACCES: [-13, 'permission denied'],
	EPERM: [-1, 'operation not permitted'],
	EEXIST: [-17, 'file already exists'],
	EISDIR: [-21, 'illegal operation on a directory'],
	ENOENT: [-2, 'no such file or directory'],
	ENOTDIR: [-20, 'not a directory'],
	ENOTEMPTY: [-66, 'directory not empty'],
};

/**
 * Build an error matching the shape Node.js throws for file system failures
 */
function fsError(code: keyof typeof errnos, syscall: string, path: string, dest?: string): FileSystemError {
	const [errno, message] = errnos[code] as [number, string];
	const target = dest ? `'${path}' -> '${dest}'` : `'${path}'`;
	const error = new Error(`${code}: ${message}, ${syscall} ${target}`) as FileSystemError;

	error.code = code;
	error.errno = errno;
	error.syscall = syscall;
	error.path = path;

	if (dest) {
		error.dest = dest;
	}

	return error;
}

/**
 * Determine why an operation on an existing-or-not path failed
 *
 * Nova throws opaque errors, so the cause is reconstructed by inspecting the
 * path afterwards. This is what keeps a missing file from being reported as a
 * permission problem, and a directory from being reported as missing.
 */
function classify(path: string, syscall: string, writing = false): FileSystemError {
	const resolvedPath = compatPath.resolve(path);
	const stats = existsSync(resolvedPath) ? nova.fs.stat(resolvedPath) : null;

	if (stats?.isDirectory()) {
		return fsError('EISDIR', syscall, path);
	}

	if (!stats) {
		// A write only needs its parent to exist; anything else is missing outright
		if (!writing || !existsSync(compatPath.dirname(resolvedPath))) {
			return fsError('ENOENT', syscall, path);
		}
	}

	return fsError('EACCES', syscall, path);
}

/**
 * Convert Nova FileStats to Node.js Stats object
 *
 * The cast covers the four Temporal.Instant timestamps Node.js added, which
 * JavaScriptCore cannot produce: it has no Temporal. The millisecond and Date
 * timestamps are the ones packages read, and those are real.
 */
function convertStats(novaStats: FileStats): Stats {
	const isFile = novaStats.isFile();
	const isDir = novaStats.isDirectory();

	return {
		dev: 0,
		ino: 0,
		mode: isDir ? constants.S_IFDIR : constants.S_IFREG,
		nlink: 1,
		uid: 0,
		gid: 0,
		rdev: 0,
		size: novaStats.size || 0,
		blksize: 4096,
		blocks: Math.ceil((novaStats.size || 0) / 512),
		atimeMs: novaStats.atime?.getTime() || 0,
		mtimeMs: novaStats.mtime?.getTime() || 0,
		ctimeMs: novaStats.ctime?.getTime() || 0,
		birthtimeMs: novaStats.birthtime?.getTime() || 0,
		atime: novaStats.atime || new Date(0),
		mtime: novaStats.mtime || new Date(0),
		ctime: novaStats.ctime || new Date(0),
		birthtime: novaStats.birthtime || new Date(0),

		// Methods
		isFile: () => isFile,
		isDirectory: () => isDir,
		isBlockDevice: () => false,
		isCharacterDevice: () => false,
		isSymbolicLink: () => false,
		isFIFO: () => false,
		isSocket: () => false,
	} as unknown as Stats;
}

/**
 * Normalize encoding option
 *
 * Returns null when no encoding was given, which is Node.js asking for a
 * Buffer rather than a string
 */
function getEncoding(options?: string | ObjectEncodingOptions | null): string | null {
	if (!options) return null;
	if (typeof options === 'string') return options;

	return options.encoding || null;
}

/**
 * Get file mode for Nova from Node.js-style flags
 */
function getNovaMode(flags?: OpenMode): string {
	if (!flags || flags === 'r') return 'r';
	if (flags === 'w' || flags === 'wx') return 'w';
	if (flags === 'a') return 'a';

	if (typeof flags === 'string') {
		if (flags.includes('w')) return 'w';
		if (flags.includes('a')) return 'a';
		if (flags.includes('r+')) return 'r+';
	}

	return 'r';
}

// ============================================================================
// Implemented Methods (Synchronous)
// ============================================================================

/**
 * Check if file exists
 *
 * Note that nova.fs.access returns a boolean rather than throwing, unlike its
 * Node.js counterpart.
 */
export function existsSync(path: string): boolean {
	return nova.fs.access(compatPath.resolve(path), constants.F_OK);
}

/**
 * Read entire file
 *
 * Without an encoding, Node.js hands back a Buffer, which is what packages
 * reading binary files expect. That case is served by opening the file in
 * Nova's binary mode; an encoding opens it in text mode as before.
 */
export function readFileSync(path: string, options?: null): Buffer;
export function readFileSync(path: string, options: ObjectEncodingOptions | BufferEncoding): string;
export function readFileSync(path: string, options?: ObjectEncodingOptions | BufferEncoding | null): string | Buffer;
export function readFileSync(path: string, options?: ObjectEncodingOptions | BufferEncoding | null): string | Buffer {
	const resolvedPath = compatPath.resolve(path);
	const encoding = getEncoding(options);

	try {
		if (encoding === null) {
			const file = nova.fs.open(resolvedPath, 'rb') as FileBinaryMode;
			const content = file.read();

			file.close();

			return content ? Buffer.from(content) : Buffer.alloc(0);
		}

		const file = nova.fs.open(resolvedPath, 'r', encoding as Encoding) as FileTextMode;
		const content = file.read();

		file.close();

		return content ?? '';
	} catch {
		throw classify(path, 'open');
	}
}

/**
 * Write entire file
 */
export function writeFileSync(
	path: string,
	data: string | NodeJS.ArrayBufferView,
	options?: ObjectEncodingOptions | BufferEncoding | null,
): void {
	writeOrAppend(path, data, options, 'w');
}

/**
 * Append to file
 */
export function appendFileSync(
	path: string,
	data: string | NodeJS.ArrayBufferView,
	options?: ObjectEncodingOptions | BufferEncoding | null,
): void {
	writeOrAppend(path, data, options, 'a');
}

/**
 * Shared body of writeFileSync and appendFileSync
 *
 * Binary data is written through Nova's binary mode rather than being coerced
 * to a string, which used to turn a Uint8Array into its comma-separated digits.
 */
function writeOrAppend(
	path: string,
	data: string | NodeJS.ArrayBufferView,
	options: ObjectEncodingOptions | BufferEncoding | null | undefined,
	mode: 'a' | 'w',
): void {
	const resolvedPath = compatPath.resolve(path);
	const encoding = getEncoding(options);

	try {
		if (typeof data === 'string') {
			const file = nova.fs.open(resolvedPath, mode, (encoding ?? 'utf8') as Encoding) as FileTextMode;

			file.write(data, (encoding ?? 'utf8') as Encoding);
			file.close();

			return;
		}

		const file = nova.fs.open(resolvedPath, `${mode}b`) as FileBinaryMode;
		const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);

		file.write(bytes.slice().buffer as ArrayBuffer);
		file.close();
	} catch {
		throw classify(path, 'open', true);
	}
}

/**
 * Get file stats
 */
export function statSync(path: string, _options?: StatOptions): Stats {
	const resolvedPath = compatPath.resolve(path);

	try {
		const novaStats = nova.fs.stat(resolvedPath);

		if (!novaStats) {
			throw fsError('ENOENT', 'stat', path);
		}

		return convertStats(novaStats);
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code) throw e;

		throw fsError('ENOENT', 'stat', path);
	}
}

/**
 * Get file stats (without following symlinks)
 * Note: Nova doesn't distinguish, so this is the same as statSync
 */
export function lstatSync(path: string, options?: StatOptions): Stats {
	return statSync(path, options);
}

/**
 * Create directory
 *
 * Uses nova.fs.mkdir internally but implements recursive directory creation manually
 * because Nova's mkdir doesn't support the recursive option. When recursive is true,
 * this function walks up the path to find the first existing directory, then creates
 * each missing directory in order.
 */
export function mkdirSync(path: string, options?: MakeDirectoryOptions | Mode | null): void {
	const resolvedPath = compatPath.resolve(path);
	const recursive = options && typeof options === 'object' ? options.recursive || false : false;

	try {
		if (recursive) {
			// Find the first parent directory that exists
			const dirsToCreate: string[] = [];
			let currentPath = resolvedPath;

			// Work backwards to find the first existing directory
			while (currentPath !== '/' && !existsSync(currentPath)) {
				dirsToCreate.unshift(currentPath);
				currentPath = compatPath.dirname(currentPath);
			}

			// Create directories from the first non-existent one
			for (const dir of dirsToCreate) {
				nova.fs.mkdir(dir);
			}
		} else {
			nova.fs.mkdir(resolvedPath);
		}
	} catch {
		// An existing target is EEXIST, a missing parent is ENOENT
		throw existsSync(resolvedPath)
			? fsError('EEXIST', 'mkdir', path)
			: fsError(existsSync(compatPath.dirname(resolvedPath)) ? 'EACCES' : 'ENOENT', 'mkdir', path);
	}
}

/**
 * Read directory contents
 */
export function readdirSync(
	path: string,
	options?: { encoding?: BufferEncoding | null; withFileTypes?: false },
): string[];
export function readdirSync(path: string, options: { encoding?: BufferEncoding | null; withFileTypes: true }): Dirent[];
export function readdirSync(
	path: string,
	options?: { encoding?: BufferEncoding | null; withFileTypes?: boolean },
): string[] | Dirent[] {
	const resolvedPath = compatPath.resolve(path);

	try {
		const entries = nova.fs.listdir(resolvedPath);

		// If withFileTypes option, return Dirent objects
		if (options?.withFileTypes) {
			return entries.map(
				(name) =>
					({
						name,
						// parentPath supersedes the deprecated path property in Node.js 20.12+,
						// but both are populated because packages still read either one
						parentPath: resolvedPath,
						path: resolvedPath,
						isFile: () => {
							try {
								const stats = nova.fs.stat(compatPath.join(resolvedPath, name));

								return stats ? stats.isFile() : false;
							} catch {
								return false;
							}
						},
						isDirectory: () => {
							try {
								const stats = nova.fs.stat(compatPath.join(resolvedPath, name));

								return stats ? stats.isDirectory() : false;
							} catch {
								return false;
							}
						},
						isBlockDevice: () => false,
						isCharacterDevice: () => false,
						isSymbolicLink: () => false,
						isFIFO: () => false,
						isSocket: () => false,
					}) as Dirent,
			);
		}

		return entries;
	} catch {
		// Listing a file rather than a directory is ENOTDIR, not ENOENT
		throw fsError(existsSync(resolvedPath) ? 'ENOTDIR' : 'ENOENT', 'scandir', path);
	}
}

/**
 * Remove file
 */
export function unlinkSync(path: string): void {
	const resolvedPath = compatPath.resolve(path);

	try {
		nova.fs.remove(resolvedPath);
	} catch {
		if (!existsSync(resolvedPath)) {
			throw fsError('ENOENT', 'unlink', path);
		}

		// Unlinking a directory is EPERM on Darwin, unlike the EISDIR of Linux
		throw fsError(nova.fs.stat(resolvedPath)?.isDirectory() ? 'EPERM' : 'EACCES', 'unlink', path);
	}
}

/**
 * Remove directory
 */
export function rmdirSync(path: string, options?: RmDirOptions): void {
	const resolvedPath = compatPath.resolve(path);

	try {
		if (options?.recursive) {
			// Only nova.fs.remove deletes a directory along with its contents
			nova.fs.remove(resolvedPath);
		} else {
			// nova.fs.rmdir refuses to delete a non-empty directory, which is
			// what rmdirSync is supposed to do. The listing only exists to
			// report the failure with the code Node.js would use.
			if (nova.fs.listdir(resolvedPath).length > 0) {
				throw fsError('ENOTEMPTY', 'rmdir', path);
			}

			nova.fs.rmdir(resolvedPath);
		}
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code) throw e; // Re-throw if already formatted

		if (!existsSync(resolvedPath)) {
			throw fsError('ENOENT', 'rmdir', path);
		}

		// rmdir on a file is ENOTDIR
		throw fsError(nova.fs.stat(resolvedPath)?.isDirectory() ? 'EACCES' : 'ENOTDIR', 'rmdir', path);
	}
}

/**
 * Remove file or directory (alias for rmSync in newer Node versions)
 */
export function rmSync(path: string, options?: RmOptions): void {
	try {
		const stats = statSync(path);
		if (stats.isDirectory()) {
			rmdirSync(path, options);
		} else {
			unlinkSync(path);
		}
	} catch (e) {
		if (options?.force) return; // Ignore errors if force option
		throw e;
	}
}

/**
 * Rename/move file
 */
export function renameSync(oldPath: string, newPath: string): void {
	const resolvedOldPath = compatPath.resolve(oldPath);
	const resolvedNewPath = compatPath.resolve(newPath);

	try {
		nova.fs.move(resolvedOldPath, resolvedNewPath);
	} catch {
		// A missing source is ENOENT, so is a destination whose parent is missing
		const missing = !existsSync(resolvedOldPath) || !existsSync(compatPath.dirname(resolvedNewPath));

		throw fsError(missing ? 'ENOENT' : 'EACCES', 'rename', oldPath, newPath);
	}
}

/**
 * Copy file
 */
export function copyFileSync(src: string, dest: string, mode?: number): void {
	const resolvedSrc = compatPath.resolve(src);
	const resolvedDest = compatPath.resolve(dest);

	try {
		// Check if COPYFILE_EXCL flag is set
		if (mode && mode & constants.COPYFILE_EXCL && existsSync(dest)) {
			throw fsError('EEXIST', 'copyfile', src, dest);
		}

		nova.fs.copy(resolvedSrc, resolvedDest);
	} catch (e) {
		if ((e as FileSystemError).code) throw e;

		const missing = !existsSync(resolvedSrc) || !existsSync(compatPath.dirname(resolvedDest));

		throw fsError(missing ? 'ENOENT' : 'EACCES', 'copyfile', src, dest);
	}
}

/**
 * Copy file or directory
 */
export function cpSync(src: string, dest: string, options?: CopyOptions): void {
	const resolvedSrc = compatPath.resolve(src);
	const resolvedDest = compatPath.resolve(dest);

	try {
		const stats = statSync(resolvedSrc);

		if (stats.isDirectory()) {
			// Recursive directory copy
			if (!options?.recursive) {
				throw fsError('EISDIR', 'cp', src);
			}

			// Create destination directory
			if (!existsSync(resolvedDest)) {
				mkdirSync(resolvedDest);
			}

			// Copy contents
			const entries = readdirSync(resolvedSrc);
			for (const entry of entries) {
				const srcPath = compatPath.join(resolvedSrc, entry);
				const destPath = compatPath.join(resolvedDest, entry);

				cpSync(srcPath, destPath, options);
			}
		} else {
			// Copy file
			copyFileSync(resolvedSrc, resolvedDest, options?.mode);
		}
	} catch (e) {
		if ((e as FileSystemError).code) throw e;

		throw fsError('ENOENT', 'cp', src, dest);
	}
}

/**
 * Test file permissions
 *
 * nova.fs.access returns a boolean rather than throwing, so the Node.js error
 * is constructed here. The requested mode is tested against F_OK first to tell
 * a missing file (ENOENT) apart from an inaccessible one (EACCES).
 */
export function accessSync(path: string, mode: number = constants.F_OK): void {
	const resolvedPath = compatPath.resolve(path);

	if (nova.fs.access(resolvedPath, mode)) {
		return;
	}

	const exists = nova.fs.access(resolvedPath, constants.F_OK);

	const error = (
		exists
			? new Error(`EACCES: permission denied, access '${path}'`)
			: new Error(`ENOENT: no such file or directory, access '${path}'`)
	) as NodeJS.ErrnoException;

	error.code = exists ? 'EACCES' : 'ENOENT';
	error.errno = exists ? -13 : -2;
	error.path = path;

	throw error;
}

/**
 * Resolve real path
 *
 * Returns the resolved absolute path. Nova doesn't expose symlink resolution APIs,
 * so this simply returns the normalized absolute path without following symlinks.
 * This differs from Node.js which would resolve symlinks to their target.
 */
export function realpathSync(path: string, _options?: ObjectEncodingOptions | BufferEncoding | null): string {
	return compatPath.resolve(path);
}

/**
 * Create temporary directory
 *
 * Custom implementation because Nova doesn't provide a mkdtemp equivalent.
 * The prefix is a path prefix, not just a name, so `/tmp/build-` has to yield
 * `/tmp/build-XXXXXX` rather than a directory somewhere else. As in Node.js,
 * the parent directory has to exist already.
 */
export function mkdtempSync(prefix: string, _options?: ObjectEncodingOptions | BufferEncoding | null): string {
	const characters = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
	const random = Array.from(nova.crypto.getRandomValues(new Uint8Array(6)), (byte) =>
		characters.charAt(byte % characters.length),
	).join('');

	const tempPath = prefix + random;

	mkdirSync(tempPath);

	// Node.js returns the path as constructed, leaving a relative prefix relative
	return tempPath;
}

/**
 * Open file (returns Nova File object, not a file descriptor)
 */
export function openSync(path: string, flags?: OpenMode, _mode?: Mode | null): FileBinaryMode | FileTextMode {
	const resolvedPath = compatPath.resolve(path);

	try {
		const novaMode = getNovaMode(flags);

		return nova.fs.open(resolvedPath, novaMode);
	} catch {
		throw classify(path, 'open', getNovaMode(flags) !== 'r');
	}
}

/**
 * Close file handle
 */
export function closeSync(fd: FileBinaryMode | FileTextMode | number): void {
	if (fd && typeof fd === 'object' && 'close' in fd && typeof fd.close === 'function') {
		fd.close();
	}
}

/**
 * Read from file handle
 *
 * Nova's read takes only a size, but its files also expose seek, so position
 * is honoured by seeking first. Text-mode handles hand back a string, which is
 * encoded to UTF-8 so that the byte count returned means what Node.js means.
 */
export function readSync(
	fd: FileBinaryMode | FileTextMode | number,
	buffer?: NodeJS.ArrayBufferView,
	offset?: number | null,
	length?: number | null,
	position?: number | null,
): number {
	if (!fd || typeof fd === 'number' || !('read' in fd) || typeof fd.read !== 'function') {
		throw new Error('Invalid file descriptor');
	}

	const target = buffer ? new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength) : null;
	const start = offset ?? 0;
	const size = length ?? (target ? target.length - start : undefined);

	if (start < 0 || (size !== undefined && size < 0) || (target && start + (size ?? 0) > target.length)) {
		throw new RangeError('The value of "offset" is out of range');
	}

	if (typeof position === 'number' && position >= 0) {
		fd.seek(position);
	}

	const content = fd.read(size);

	if (content === null || content === undefined) {
		return 0;
	}

	const bytes = typeof content === 'string' ? Buffer.from(content, 'utf8') : new Uint8Array(content);
	const bytesRead = target ? Math.min(bytes.length, target.length - start) : bytes.length;

	target?.set(bytes.subarray(0, bytesRead), start);

	return bytesRead;
}

/**
 * Write to file handle
 *
 * Node.js overloads this as writeSync(fd, buffer, offset, length, position) and
 * writeSync(fd, string, position, encoding), so the meaning of the third
 * argument depends on what is being written.
 */
export function writeSync(
	fd: FileBinaryMode | FileTextMode | number,
	buffer: NodeJS.ArrayBufferView | string,
	offset?: number | null,
	length?: number | null,
	position?: number | null,
): number {
	if (!fd || typeof fd === 'number' || !('write' in fd) || typeof fd.write !== 'function') {
		throw new Error('Invalid file descriptor');
	}

	if (typeof buffer === 'string') {
		// Third argument is the position in the string overload
		if (typeof offset === 'number' && offset >= 0) {
			fd.seek(offset);
		}

		fd.write(buffer);

		// Node.js counts bytes written, which is not the string length
		return Buffer.byteLength(buffer, 'utf8');
	}

	const bytes = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
	const start = offset ?? 0;
	const size = length ?? bytes.length - start;

	if (start < 0 || size < 0 || start + size > bytes.length) {
		throw new RangeError('The value of "offset" is out of range');
	}

	if (typeof position === 'number' && position >= 0) {
		fd.seek(position);
	}

	// slice copies into a standalone buffer, which is what Nova's write accepts
	fd.write(bytes.slice(start, start + size).buffer as ArrayBuffer);

	return size;
}

// ============================================================================
// Async Methods (Callback-based)
// ============================================================================

export function readFile(
	path: string,
	callback: (err: NodeJS.ErrnoException | null, data?: string | Buffer) => void,
): void;
export function readFile(
	path: string,
	options: ObjectEncodingOptions | BufferEncoding | null,
	callback: (err: NodeJS.ErrnoException | null, data?: string | Buffer) => void,
): void;
export function readFile(
	path: string,
	options:
		| ObjectEncodingOptions
		| BufferEncoding
		| null
		| ((err: NodeJS.ErrnoException | null, data?: string | Buffer) => void),
	callback?: (err: NodeJS.ErrnoException | null, data?: string | Buffer) => void,
): void {
	let cb: (err: NodeJS.ErrnoException | null, data?: string | Buffer) => void;
	let opts: ObjectEncodingOptions | BufferEncoding | null;

	if (typeof options === 'function') {
		cb = options;
		opts = null;
	} else {
		cb = callback as (err: NodeJS.ErrnoException | null, data?: string | Buffer) => void;
		opts = options;
	}

	try {
		const result = readFileSync(path, opts);

		defer(() => cb(null, result));
	} catch (err) {
		defer(() => cb(err as NodeJS.ErrnoException));
	}
}

export function writeFile(
	path: string,
	data: string | NodeJS.ArrayBufferView,
	callback: (err: NodeJS.ErrnoException | null) => void,
): void;
export function writeFile(
	path: string,
	data: string | NodeJS.ArrayBufferView,
	options: ObjectEncodingOptions | BufferEncoding | null,
	callback: (err: NodeJS.ErrnoException | null) => void,
): void;
export function writeFile(
	path: string,
	data: string | NodeJS.ArrayBufferView,
	options: ObjectEncodingOptions | BufferEncoding | null | ((err: NodeJS.ErrnoException | null) => void),
	callback?: (err: NodeJS.ErrnoException | null) => void,
): void {
	let cb: (err: NodeJS.ErrnoException | null) => void;
	let opts: ObjectEncodingOptions | BufferEncoding | null;

	if (typeof options === 'function') {
		cb = options;
		opts = null;
	} else {
		cb = callback as (err: NodeJS.ErrnoException | null) => void;
		opts = options;
	}

	try {
		writeFileSync(path, data, opts);
		defer(() => cb(null));
	} catch (err) {
		defer(() => cb(err as NodeJS.ErrnoException));
	}
}

export function appendFile(
	path: string,
	data: string | NodeJS.ArrayBufferView,
	callback: (err: NodeJS.ErrnoException | null) => void,
): void;
export function appendFile(
	path: string,
	data: string | NodeJS.ArrayBufferView,
	options: ObjectEncodingOptions | BufferEncoding | null,
	callback: (err: NodeJS.ErrnoException | null) => void,
): void;
export function appendFile(
	path: string,
	data: string | NodeJS.ArrayBufferView,
	options: ObjectEncodingOptions | BufferEncoding | null | ((err: NodeJS.ErrnoException | null) => void),
	callback?: (err: NodeJS.ErrnoException | null) => void,
): void {
	let cb: (err: NodeJS.ErrnoException | null) => void;
	let opts: ObjectEncodingOptions | BufferEncoding | null;

	if (typeof options === 'function') {
		cb = options;
		opts = null;
	} else {
		cb = callback as (err: NodeJS.ErrnoException | null) => void;
		opts = options;
	}

	try {
		appendFileSync(path, data, opts);
		defer(() => cb(null));
	} catch (err) {
		defer(() => cb(err as NodeJS.ErrnoException));
	}
}

export function stat(path: string, callback: (err: NodeJS.ErrnoException | null, stats?: Stats) => void): void;
export function stat(
	path: string,
	options: StatOptions,
	callback: (err: NodeJS.ErrnoException | null, stats?: Stats) => void,
): void;
export function stat(
	path: string,
	options: StatOptions | ((err: NodeJS.ErrnoException | null, stats?: Stats) => void),
	callback?: (err: NodeJS.ErrnoException | null, stats?: Stats) => void,
): void {
	let cb: (err: NodeJS.ErrnoException | null, stats?: Stats) => void;
	let opts: StatOptions | undefined;

	if (typeof options === 'function') {
		cb = options;
		opts = undefined;
	} else {
		cb = callback as (err: NodeJS.ErrnoException | null, stats?: Stats) => void;
		opts = options;
	}

	try {
		const result = statSync(path, opts);

		defer(() => cb(null, result));
	} catch (err) {
		defer(() => cb(err as NodeJS.ErrnoException));
	}
}

export function lstat(path: string, callback: (err: NodeJS.ErrnoException | null, stats?: Stats) => void): void;
export function lstat(
	path: string,
	options: StatOptions,
	callback: (err: NodeJS.ErrnoException | null, stats?: Stats) => void,
): void;
export function lstat(
	path: string,
	options: StatOptions | ((err: NodeJS.ErrnoException | null, stats?: Stats) => void),
	callback?: (err: NodeJS.ErrnoException | null, stats?: Stats) => void,
): void {
	let cb: (err: NodeJS.ErrnoException | null, stats?: Stats) => void;
	let opts: StatOptions | undefined;

	if (typeof options === 'function') {
		cb = options;
		opts = undefined;
	} else {
		cb = callback as (err: NodeJS.ErrnoException | null, stats?: Stats) => void;
		opts = options;
	}

	try {
		const result = lstatSync(path, opts);
		defer(() => cb(null, result));
	} catch (err) {
		defer(() => cb(err as NodeJS.ErrnoException));
	}
}

export function mkdir(path: string, callback: (err: NodeJS.ErrnoException | null) => void): void;
export function mkdir(
	path: string,
	options: MakeDirectoryOptions | Mode | null,
	callback: (err: NodeJS.ErrnoException | null) => void,
): void;
export function mkdir(
	path: string,
	options: MakeDirectoryOptions | Mode | null | ((err: NodeJS.ErrnoException | null) => void),
	callback?: (err: NodeJS.ErrnoException | null) => void,
): void {
	let cb: (err: NodeJS.ErrnoException | null) => void;
	let opts: MakeDirectoryOptions | Mode | null | undefined;

	if (typeof options === 'function') {
		cb = options;
		opts = undefined;
	} else {
		cb = callback as (err: NodeJS.ErrnoException | null) => void;
		opts = options;
	}

	try {
		mkdirSync(path, opts);
		defer(() => cb(null));
	} catch (err) {
		defer(() => cb(err as NodeJS.ErrnoException));
	}
}

export function readdir(
	path: string,
	options:
		| { encoding?: BufferEncoding | null; withFileTypes?: boolean }
		| ((err: NodeJS.ErrnoException | null, files?: string[] | Dirent[]) => void),
	callback?: (err: NodeJS.ErrnoException | null, files?: string[] | Dirent[]) => void,
): void {
	let cb: (err: NodeJS.ErrnoException | null, files?: string[] | Dirent[]) => void;
	let opts: { encoding?: BufferEncoding | null; withFileTypes?: boolean } | undefined;

	if (typeof options === 'function') {
		cb = options;
		opts = undefined;
	} else {
		cb = callback as (err: NodeJS.ErrnoException | null, files?: string[] | Dirent[]) => void;
		opts = options;
	}

	try {
		let result: string[] | Dirent[];
		if (opts?.withFileTypes === true) {
			result = readdirSync(path, { encoding: opts.encoding, withFileTypes: true });
		} else {
			result = readdirSync(path, { encoding: opts?.encoding, withFileTypes: false });
		}
		defer(() => cb(null, result));
	} catch (err) {
		defer(() => cb(err as NodeJS.ErrnoException));
	}
}

export function unlink(path: string, callback: (err: NodeJS.ErrnoException | null) => void): void {
	try {
		unlinkSync(path);
		defer(() => callback(null));
	} catch (err) {
		defer(() => callback(err as NodeJS.ErrnoException));
	}
}

export function rmdir(path: string, callback: (err: NodeJS.ErrnoException | null) => void): void;
export function rmdir(path: string, options: RmDirOptions, callback: (err: NodeJS.ErrnoException | null) => void): void;
export function rmdir(
	path: string,
	options: RmDirOptions | ((err: NodeJS.ErrnoException | null) => void),
	callback?: (err: NodeJS.ErrnoException | null) => void,
): void {
	let cb: (err: NodeJS.ErrnoException | null) => void;
	let opts: RmDirOptions | undefined;

	if (typeof options === 'function') {
		cb = options;
		opts = undefined;
	} else {
		cb = callback as (err: NodeJS.ErrnoException | null) => void;
		opts = options;
	}

	try {
		rmdirSync(path, opts);
		defer(() => cb(null));
	} catch (err) {
		defer(() => cb(err as NodeJS.ErrnoException));
	}
}

export function rm(path: string, callback: (err: NodeJS.ErrnoException | null) => void): void;
export function rm(path: string, options: RmOptions, callback: (err: NodeJS.ErrnoException | null) => void): void;
export function rm(
	path: string,
	options: RmOptions | ((err: NodeJS.ErrnoException | null) => void),
	callback?: (err: NodeJS.ErrnoException | null) => void,
): void {
	let cb: (err: NodeJS.ErrnoException | null) => void;
	let opts: RmOptions | undefined;

	if (typeof options === 'function') {
		cb = options;
		opts = undefined;
	} else {
		cb = callback as (err: NodeJS.ErrnoException | null) => void;
		opts = options;
	}

	try {
		rmSync(path, opts);
		defer(() => cb(null));
	} catch (err) {
		defer(() => cb(err as NodeJS.ErrnoException));
	}
}

export function rename(oldPath: string, newPath: string, callback: (err: NodeJS.ErrnoException | null) => void): void {
	try {
		renameSync(oldPath, newPath);
		defer(() => callback(null));
	} catch (err) {
		defer(() => callback(err as NodeJS.ErrnoException));
	}
}

export function copyFile(src: string, dest: string, callback: (err: NodeJS.ErrnoException | null) => void): void;
export function copyFile(
	src: string,
	dest: string,
	mode: number,
	callback: (err: NodeJS.ErrnoException | null) => void,
): void;
export function copyFile(
	src: string,
	dest: string,
	mode: number | ((err: NodeJS.ErrnoException | null) => void),
	callback?: (err: NodeJS.ErrnoException | null) => void,
): void {
	let cb: (err: NodeJS.ErrnoException | null) => void;
	let flags: number;

	if (typeof mode === 'function') {
		cb = mode;
		flags = 0;
	} else {
		cb = callback as (err: NodeJS.ErrnoException | null) => void;
		flags = mode;
	}

	try {
		copyFileSync(src, dest, flags);
		defer(() => cb(null));
	} catch (err) {
		defer(() => cb(err as NodeJS.ErrnoException));
	}
}

export function cp(src: string, dest: string, callback: (err: NodeJS.ErrnoException | null) => void): void;
export function cp(
	src: string,
	dest: string,
	options: CopyOptions,
	callback: (err: NodeJS.ErrnoException | null) => void,
): void;
export function cp(
	src: string,
	dest: string,
	options: CopyOptions | ((err: NodeJS.ErrnoException | null) => void),
	callback?: (err: NodeJS.ErrnoException | null) => void,
): void {
	let cb: (err: NodeJS.ErrnoException | null) => void;
	let opts: CopyOptions | undefined;

	if (typeof options === 'function') {
		cb = options;
		opts = undefined;
	} else {
		cb = callback as (err: NodeJS.ErrnoException | null) => void;
		opts = options;
	}

	try {
		cpSync(src, dest, opts);
		defer(() => cb(null));
	} catch (err) {
		defer(() => cb(err as NodeJS.ErrnoException));
	}
}

export function access(path: string, callback: (err: NodeJS.ErrnoException | null) => void): void;
export function access(path: string, mode: number, callback: (err: NodeJS.ErrnoException | null) => void): void;
export function access(
	path: string,
	mode: number | ((err: NodeJS.ErrnoException | null) => void),
	callback?: (err: NodeJS.ErrnoException | null) => void,
): void {
	let cb: (err: NodeJS.ErrnoException | null) => void;
	let accessMode: number;

	if (typeof mode === 'function') {
		cb = mode;
		accessMode = constants.F_OK;
	} else {
		cb = callback as (err: NodeJS.ErrnoException | null) => void;
		accessMode = mode;
	}

	try {
		accessSync(path, accessMode);
		defer(() => cb(null));
	} catch (err) {
		defer(() => cb(err as NodeJS.ErrnoException));
	}
}

export function realpath(
	path: string,
	callback: (err: NodeJS.ErrnoException | null, resolvedPath?: string) => void,
): void;
export function realpath(
	path: string,
	options: ObjectEncodingOptions | BufferEncoding | null,
	callback: (err: NodeJS.ErrnoException | null, resolvedPath?: string) => void,
): void;
export function realpath(
	path: string,
	options:
		| ObjectEncodingOptions
		| BufferEncoding
		| null
		| ((err: NodeJS.ErrnoException | null, resolvedPath?: string) => void),
	callback?: (err: NodeJS.ErrnoException | null, resolvedPath?: string) => void,
): void {
	let cb: (err: NodeJS.ErrnoException | null, resolvedPath?: string) => void;
	let opts: ObjectEncodingOptions | BufferEncoding | null | undefined;

	if (typeof options === 'function') {
		cb = options;
		opts = undefined;
	} else {
		cb = callback as (err: NodeJS.ErrnoException | null, resolvedPath?: string) => void;
		opts = options;
	}

	try {
		const result = realpathSync(path, opts);
		defer(() => cb(null, result));
	} catch (err) {
		defer(() => cb(err as NodeJS.ErrnoException));
	}
}

export function mkdtemp(prefix: string, callback: (err: NodeJS.ErrnoException | null, folder?: string) => void): void;
export function mkdtemp(
	prefix: string,
	options: ObjectEncodingOptions | BufferEncoding | null,
	callback: (err: NodeJS.ErrnoException | null, folder?: string) => void,
): void;
export function mkdtemp(
	prefix: string,
	options:
		| ObjectEncodingOptions
		| BufferEncoding
		| null
		| ((err: NodeJS.ErrnoException | null, folder?: string) => void),
	callback?: (err: NodeJS.ErrnoException | null, folder?: string) => void,
): void {
	let cb: (err: NodeJS.ErrnoException | null, folder?: string) => void;
	let opts: ObjectEncodingOptions | BufferEncoding | null | undefined;

	if (typeof options === 'function') {
		cb = options;
		opts = undefined;
	} else {
		cb = callback as (err: NodeJS.ErrnoException | null, folder?: string) => void;
		opts = options;
	}

	try {
		const result = mkdtempSync(prefix, opts);
		defer(() => cb(null, result));
	} catch (err) {
		defer(() => cb(err as NodeJS.ErrnoException));
	}
}

export function open(
	path: string,
	flags: OpenMode,
	callback: (err: NodeJS.ErrnoException | null, fd?: FileBinaryMode | FileTextMode) => void,
): void;
export function open(
	path: string,
	flags: OpenMode,
	mode: Mode | null,
	callback: (err: NodeJS.ErrnoException | null, fd?: FileBinaryMode | FileTextMode) => void,
): void;
export function open(
	path: string,
	flags: OpenMode,
	mode: Mode | null | ((err: NodeJS.ErrnoException | null, fd?: FileBinaryMode | FileTextMode) => void),
	callback?: (err: NodeJS.ErrnoException | null, fd?: FileBinaryMode | FileTextMode) => void,
): void {
	let cb: (err: NodeJS.ErrnoException | null, fd?: FileBinaryMode | FileTextMode) => void;
	let fileMode: Mode | null;

	if (typeof mode === 'function') {
		cb = mode;
		fileMode = 0o666;
	} else {
		cb = callback as (err: NodeJS.ErrnoException | null, fd?: FileBinaryMode | FileTextMode) => void;
		fileMode = mode;
	}

	try {
		const result = openSync(path, flags, fileMode);
		defer(() => cb(null, result));
	} catch (err) {
		defer(() => cb(err as NodeJS.ErrnoException));
	}
}

export function close(
	fd: FileBinaryMode | FileTextMode | number,
	callback: (err: NodeJS.ErrnoException | null) => void,
): void {
	try {
		closeSync(fd);
		defer(() => callback(null));
	} catch (err) {
		defer(() => callback(err as NodeJS.ErrnoException));
	}
}

export function read(
	fd: FileBinaryMode | FileTextMode | number,
	buffer: NodeJS.ArrayBufferView,
	offset: number,
	length: number,
	position: number | null,
	callback: (err: NodeJS.ErrnoException | null, bytesRead?: number, buffer?: NodeJS.ArrayBufferView) => void,
): void {
	try {
		const bytesRead = readSync(fd, buffer, offset, length, position);
		defer(() => callback(null, bytesRead, buffer));
	} catch (err) {
		defer(() => callback(err as NodeJS.ErrnoException));
	}
}

export function write(
	fd: FileBinaryMode | FileTextMode | number,
	buffer: NodeJS.ArrayBufferView | string,
	offset: number,
	length: number,
	position: number | null,
	callback: (err: NodeJS.ErrnoException | null, written?: number, buffer?: NodeJS.ArrayBufferView | string) => void,
): void {
	try {
		const bytesWritten = writeSync(fd, buffer, offset, length, position);
		defer(() => callback(null, bytesWritten, buffer));
	} catch (err) {
		defer(() => callback(err as NodeJS.ErrnoException));
	}
}

// Unsupported Methods (Throw helpful errors)
const unsupportedError = (method: string, reason: string) => () => {
	throw new Error(`fs.${method} is not supported in Nova extensions. ${reason}`);
};

export const createReadStream = unsupportedError(
	'createReadStream',
	'Nova does not expose stream APIs. Use fs.readFile() to read entire files.',
);

export const createWriteStream = unsupportedError(
	'createWriteStream',
	'Nova does not expose stream APIs. Use fs.writeFile() to write entire files.',
);

export const watch = unsupportedError('watch', 'Nova does not expose file watching APIs.');

export const watchFile = unsupportedError('watchFile', 'Nova does not expose file watching APIs.');

export const unwatchFile = unsupportedError('unwatchFile', 'Nova does not expose file watching APIs.');

export const chmod = unsupportedError('chmod', 'Nova does not expose permission modification APIs.');

export const chmodSync = unsupportedError('chmodSync', 'Nova does not expose permission modification APIs.');

export const chown = unsupportedError('chown', 'Nova does not expose ownership modification APIs.');

export const chownSync = unsupportedError('chownSync', 'Nova does not expose ownership modification APIs.');

export const lchmod = unsupportedError('lchmod', 'Nova does not expose permission modification APIs.');

export const lchmodSync = unsupportedError('lchmodSync', 'Nova does not expose permission modification APIs.');

export const lchown = unsupportedError('lchown', 'Nova does not expose ownership modification APIs.');

export const lchownSync = unsupportedError('lchownSync', 'Nova does not expose ownership modification APIs.');

export const fchmod = unsupportedError('fchmod', 'Nova does not expose permission modification APIs.');

export const fchmodSync = unsupportedError('fchmodSync', 'Nova does not expose permission modification APIs.');

export const fchown = unsupportedError('fchown', 'Nova does not expose ownership modification APIs.');

export const fchownSync = unsupportedError('fchownSync', 'Nova does not expose ownership modification APIs.');

export const link = unsupportedError('link', 'Nova does not expose hard link creation APIs.');

export const linkSync = unsupportedError('linkSync', 'Nova does not expose hard link creation APIs.');

export const symlink = unsupportedError('symlink', 'Nova does not expose symbolic link creation APIs.');

export const symlinkSync = unsupportedError('symlinkSync', 'Nova does not expose symbolic link creation APIs.');

export const readlink = unsupportedError('readlink', 'Nova does not expose symbolic link reading APIs.');

export const readlinkSync = unsupportedError('readlinkSync', 'Nova does not expose symbolic link reading APIs.');

export const truncate = unsupportedError(
	'truncate',
	'Nova does not expose file truncation APIs. Read, slice, and write instead.',
);

export const truncateSync = unsupportedError(
	'truncateSync',
	'Nova does not expose file truncation APIs. Read, slice, and write instead.',
);

export const ftruncate = unsupportedError('ftruncate', 'Nova does not expose file truncation APIs.');

export const ftruncateSync = unsupportedError('ftruncateSync', 'Nova does not expose file truncation APIs.');

export const utimes = unsupportedError('utimes', 'Nova does not expose timestamp modification APIs.');

export const utimesSync = unsupportedError('utimesSync', 'Nova does not expose timestamp modification APIs.');

export const futimes = unsupportedError('futimes', 'Nova does not expose timestamp modification APIs.');

export const futimesSync = unsupportedError('futimesSync', 'Nova does not expose timestamp modification APIs.');

export const lutimes = unsupportedError('lutimes', 'Nova does not expose timestamp modification APIs.');

export const lutimesSync = unsupportedError('lutimesSync', 'Nova does not expose timestamp modification APIs.');

export const fsync = unsupportedError('fsync', 'Nova does not expose low-level file sync APIs.');

export const fsyncSync = unsupportedError('fsyncSync', 'Nova does not expose low-level file sync APIs.');

export const fdatasync = unsupportedError('fdatasync', 'Nova does not expose low-level file sync APIs.');

export const fdatasyncSync = unsupportedError('fdatasyncSync', 'Nova does not expose low-level file sync APIs.');

export const fstat = unsupportedError('fstat', 'Use fs.stat() instead with the file path.');

export const fstatSync = unsupportedError('fstatSync', 'Use fs.statSync() instead with the file path.');

// ============================================================================
// Default Export
// ============================================================================

export default {
	constants,
	// Sync methods
	existsSync,
	readFileSync,
	writeFileSync,
	appendFileSync,
	statSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	unlinkSync,
	rmdirSync,
	rmSync,
	renameSync,
	copyFileSync,
	cpSync,
	accessSync,
	realpathSync,
	mkdtempSync,
	openSync,
	closeSync,
	readSync,
	writeSync,
	// Async methods
	readFile,
	writeFile,
	appendFile,
	stat,
	lstat,
	mkdir,
	readdir,
	unlink,
	rmdir,
	rm,
	rename,
	copyFile,
	cp,
	access,
	realpath,
	mkdtemp,
	open,
	close,
	read,
	write,

	// Unsupported
	createReadStream,
	createWriteStream,
	watch,
	watchFile,
	unwatchFile,
	chmod,
	chmodSync,
	chown,
	chownSync,
	lchmod,
	lchmodSync,
	lchown,
	lchownSync,
	fchmod,
	fchmodSync,
	fchown,
	fchownSync,
	link,
	linkSync,
	symlink,
	symlinkSync,
	readlink,
	readlinkSync,
	truncate,
	truncateSync,
	ftruncate,
	ftruncateSync,
	utimes,
	utimesSync,
	futimes,
	futimesSync,
	lutimes,
	lutimesSync,
	fsync,
	fsyncSync,
	fdatasync,
	fdatasyncSync,
	fstat,
	fstatSync,
};
