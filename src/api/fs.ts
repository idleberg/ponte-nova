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
	RmDirOptions,
	RmOptions,
	StatOptions,
	Stats,
} from 'node:fs';
import * as compatPath from './path.js';

// Extended error type for file system operations with dest property
interface FileSystemError extends NodeJS.ErrnoException {
	dest?: string;
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
	O_RDONLY: 0,
	O_WRONLY: 1,
	O_RDWR: 2,
	O_CREAT: 64,
	O_EXCL: 128,
	O_NOCTTY: 256,
	O_TRUNC: 512,
	O_APPEND: 1024,
	O_DIRECTORY: 65536,
	O_NOATIME: 262144,
	O_NOFOLLOW: 131072,
	O_SYNC: 1052672,
	O_DSYNC: 4096,
	O_SYMLINK: 200000,
	O_DIRECT: 16384,
	O_NONBLOCK: 2048,

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
 * Convert Nova FileStats to Node.js Stats object
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
	};
}

/**
 * Normalize encoding option
 */
function getEncoding(options?: string | ObjectEncodingOptions | null): string {
	if (!options) return 'utf8';
	if (typeof options === 'string') return options;

	return options.encoding || 'utf8';
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
 */
export function existsSync(path: string): boolean {
	const resolvedPath = compatPath.resolve(path);

	try {
		nova.fs.access(resolvedPath, constants.F_OK);

		return true;
	} catch {
		return false;
	}
}

/**
 * Read entire file
 */
export function readFileSync(path: string, options?: ObjectEncodingOptions | BufferEncoding | null): string {
	const resolvedPath = compatPath.resolve(path);
	const encoding = getEncoding(options);

	try {
		const file = nova.fs.open(resolvedPath, 'r', encoding as Encoding) as FileTextMode;
		const content = file.read();

		file.close();

		// If encoding is null/buffer, we'd need to return a buffer
		// Nova returns strings, so we'll just return the string
		if (encoding === null || encoding === 'buffer') {
			console.warn('Buffer encoding not fully supported in Nova, returning string');
		}

		return content ?? '';
	} catch {
		const error = new Error(`ENOENT: no such file or directory, open '${path}'`) as NodeJS.ErrnoException;

		error.code = 'ENOENT';
		error.errno = -2;
		error.path = path;

		throw error;
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
	const resolvedPath = compatPath.resolve(path);
	const encoding = getEncoding(options);

	try {
		const file = nova.fs.open(resolvedPath, 'w', encoding as Encoding) as FileTextMode;

		file.write(String(data), encoding as Encoding);
		file.close();
	} catch {
		const error = new Error(`EACCES: permission denied, open '${path}'`) as NodeJS.ErrnoException;

		error.code = 'EACCES';
		error.errno = -13;
		error.path = path;

		throw error;
	}
}

/**
 * Append to file
 */
export function appendFileSync(
	path: string,
	data: string | NodeJS.ArrayBufferView,
	options?: ObjectEncodingOptions | BufferEncoding | null,
): void {
	const resolvedPath = compatPath.resolve(path);
	const encoding = getEncoding(options);

	try {
		const file = nova.fs.open(resolvedPath, 'a', encoding as Encoding) as FileTextMode;

		file.write(String(data), encoding as Encoding);
		file.close();
	} catch {
		const error = new Error(`EACCES: permission denied, open '${path}'`) as NodeJS.ErrnoException;

		error.code = 'EACCES';
		error.errno = -13;
		error.path = path;

		throw error;
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
			const error = new Error(`ENOENT: no such file or directory, stat '${path}'`) as NodeJS.ErrnoException;

			error.code = 'ENOENT';
			error.errno = -2;
			error.path = path;

			throw error;
		}

		return convertStats(novaStats);
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code) throw e;

		const error = new Error(`ENOENT: no such file or directory, stat '${path}'`) as NodeJS.ErrnoException;

		error.code = 'ENOENT';
		error.errno = -2;
		error.path = path;

		throw error;
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
		const error = new Error(`EEXIST: file already exists, mkdir '${path}'`) as NodeJS.ErrnoException;

		error.code = 'EEXIST';
		error.errno = -17;
		error.path = path;

		throw error;
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
		const error = new Error(`ENOENT: no such file or directory, scandir '${path}'`) as NodeJS.ErrnoException;

		error.code = 'ENOENT';
		error.errno = -2;
		error.path = path;

		throw error;
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
		const error = new Error(`ENOENT: no such file or directory, unlink '${path}'`) as NodeJS.ErrnoException;

		error.code = 'ENOENT';
		error.errno = -2;
		error.path = path;

		throw error;
	}
}

/**
 * Remove directory
 */
export function rmdirSync(path: string, options?: RmDirOptions): void {
	const resolvedPath = compatPath.resolve(path);

	try {
		if (options?.recursive) {
			// Remove directory and all contents
			nova.fs.remove(resolvedPath);
		} else {
			// Nova's remove works on directories, but we should check if empty
			const contents = nova.fs.listdir(resolvedPath);
			if (contents.length > 0) {
				const error = new Error(`ENOTEMPTY: directory not empty, rmdir '${path}'`) as NodeJS.ErrnoException;

				error.code = 'ENOTEMPTY';
				error.errno = -39;
				error.path = path;

				throw error;
			}
			nova.fs.remove(resolvedPath);
		}
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code) throw e; // Re-throw if already formatted

		const error = new Error(`ENOENT: no such file or directory, rmdir '${path}'`) as NodeJS.ErrnoException;

		error.code = 'ENOENT';
		error.errno = -2;
		error.path = path;

		throw error;
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
		const error = new Error(
			`ENOENT: no such file or directory, rename '${oldPath}' -> '${newPath}'`,
		) as FileSystemError;

		error.code = 'ENOENT';
		error.errno = -2;
		error.path = oldPath;
		error.dest = newPath;

		throw error;
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
		if (mode && mode & constants.COPYFILE_EXCL) {
			if (existsSync(dest)) {
				const error = new Error(`EEXIST: file already exists, copyfile '${src}' -> '${dest}'`) as FileSystemError;

				error.code = 'EEXIST';
				error.errno = -17;
				error.path = src;
				error.dest = dest;

				throw error;
			}
		}

		nova.fs.copy(resolvedSrc, resolvedDest);
	} catch (e) {
		if ((e as FileSystemError).code) throw e;
		const error = new Error(`ENOENT: no such file or directory, copyfile '${src}' -> '${dest}'`) as FileSystemError;

		error.code = 'ENOENT';
		error.errno = -2;
		error.path = src;
		error.dest = dest;

		throw error;
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
				const error = new Error(`EISDIR: illegal operation on a directory, cp '${src}'`) as NodeJS.ErrnoException;

				error.code = 'EISDIR';
				error.errno = -21;
				error.path = src;

				throw error;
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

		const error = new Error(`ENOENT: no such file or directory, cp '${src}' -> '${dest}'`) as FileSystemError;

		error.code = 'ENOENT';
		error.errno = -2;
		error.path = src;
		error.dest = dest;

		throw error;
	}
}

/**
 * Test file permissions
 */
export function accessSync(path: string, mode: number = constants.F_OK): void {
	const resolvedPath = compatPath.resolve(path);

	try {
		nova.fs.access(resolvedPath, mode);
	} catch {
		const error = new Error(`ENOENT: no such file or directory, access '${path}'`) as NodeJS.ErrnoException;

		error.code = 'ENOENT';
		error.errno = -2;
		error.path = path;

		throw error;
	}
}

/**
 * Resolve real path (Nova doesn't support symlinks, so just resolve to absolute path)
 */
export function realpathSync(path: string, _options?: ObjectEncodingOptions | BufferEncoding | null): string {
	return compatPath.resolve(path);
}

/**
 * Create temporary directory
 * Creates temp directories in /tmp to match Node.js behavior
 */
export function mkdtempSync(prefix: string, _options?: ObjectEncodingOptions | BufferEncoding | null): string {
	const randomSuffix = Math.random().toString(36).substring(2, 8);
	const tmpPath = compatPath.join('/tmp', '.ponte-nova', prefix + randomSuffix);

	mkdirSync(tmpPath, { recursive: true });

	return tmpPath;
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
		const error = new Error(`ENOENT: no such file or directory, open '${path}'`) as NodeJS.ErrnoException;

		error.code = 'ENOENT';
		error.errno = -2;
		error.path = path;

		throw error;
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
 */
export function readSync(
	fd: FileBinaryMode | FileTextMode | number,
	_buffer?: NodeJS.ArrayBufferView,
	_offset?: number | null,
	_length?: number | null,
	_position?: number | null,
): number {
	if (!fd || typeof fd === 'number' || !('read' in fd) || typeof fd.read !== 'function') {
		throw new Error('Invalid file descriptor');
	}

	// Nova's read doesn't support buffer/offset/length/position
	// This is a simplified implementation
	const content = fd.read();

	if (content === null) return 0;

	return typeof content === 'string' ? content.length : content.byteLength;
}

/**
 * Write to file handle
 */
export function writeSync(
	fd: FileBinaryMode | FileTextMode | number,
	buffer: NodeJS.ArrayBufferView | string,
	_offset?: number | null,
	_length?: number | null,
	_position?: number | null,
): number {
	if (!fd || typeof fd === 'number' || !('write' in fd) || typeof fd.write !== 'function') {
		throw new Error('Invalid file descriptor');
	}

	// Nova's write doesn't support buffer/offset/length/position
	const content = String(buffer);

	fd.write(content);

	return content.length;
}

// ============================================================================
// Async Methods (Callback-based)
// ============================================================================

export function readFile(path: string, callback: (err: NodeJS.ErrnoException | null, data?: string) => void): void;
export function readFile(
	path: string,
	options: ObjectEncodingOptions | BufferEncoding | null,
	callback: (err: NodeJS.ErrnoException | null, data?: string) => void,
): void;
export function readFile(
	path: string,
	options: ObjectEncodingOptions | BufferEncoding | null | ((err: NodeJS.ErrnoException | null, data?: string) => void),
	callback?: (err: NodeJS.ErrnoException | null, data?: string) => void,
): void {
	let cb: (err: NodeJS.ErrnoException | null, data?: string) => void;
	let opts: ObjectEncodingOptions | BufferEncoding | null;

	if (typeof options === 'function') {
		cb = options;
		opts = null;
	} else {
		cb = callback as (err: NodeJS.ErrnoException | null, data?: string) => void;
		opts = options;
	}

	try {
		const result = readFileSync(path, opts);

		setImmediate(() => cb(null, result));
	} catch (err) {
		setImmediate(() => cb(err as NodeJS.ErrnoException));
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
		setImmediate(() => cb(null));
	} catch (err) {
		setImmediate(() => cb(err as NodeJS.ErrnoException));
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
		setImmediate(() => cb(null));
	} catch (err) {
		setImmediate(() => cb(err as NodeJS.ErrnoException));
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

		setImmediate(() => cb(null, result));
	} catch (err) {
		setImmediate(() => cb(err as NodeJS.ErrnoException));
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
		setImmediate(() => cb(null, result));
	} catch (err) {
		setImmediate(() => cb(err as NodeJS.ErrnoException));
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
		setImmediate(() => cb(null));
	} catch (err) {
		setImmediate(() => cb(err as NodeJS.ErrnoException));
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
		setImmediate(() => cb(null, result));
	} catch (err) {
		setImmediate(() => cb(err as NodeJS.ErrnoException));
	}
}

export function unlink(path: string, callback: (err: NodeJS.ErrnoException | null) => void): void {
	try {
		unlinkSync(path);
		setImmediate(() => callback(null));
	} catch (err) {
		setImmediate(() => callback(err as NodeJS.ErrnoException));
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
		setImmediate(() => cb(null));
	} catch (err) {
		setImmediate(() => cb(err as NodeJS.ErrnoException));
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
		setImmediate(() => cb(null));
	} catch (err) {
		setImmediate(() => cb(err as NodeJS.ErrnoException));
	}
}

export function rename(oldPath: string, newPath: string, callback: (err: NodeJS.ErrnoException | null) => void): void {
	try {
		renameSync(oldPath, newPath);
		setImmediate(() => callback(null));
	} catch (err) {
		setImmediate(() => callback(err as NodeJS.ErrnoException));
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
		setImmediate(() => cb(null));
	} catch (err) {
		setImmediate(() => cb(err as NodeJS.ErrnoException));
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
		setImmediate(() => cb(null));
	} catch (err) {
		setImmediate(() => cb(err as NodeJS.ErrnoException));
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
		setImmediate(() => cb(null));
	} catch (err) {
		setImmediate(() => cb(err as NodeJS.ErrnoException));
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
		setImmediate(() => cb(null, result));
	} catch (err) {
		setImmediate(() => cb(err as NodeJS.ErrnoException));
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
		setImmediate(() => cb(null, result));
	} catch (err) {
		setImmediate(() => cb(err as NodeJS.ErrnoException));
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
		setImmediate(() => cb(null, result));
	} catch (err) {
		setImmediate(() => cb(err as NodeJS.ErrnoException));
	}
}

export function close(
	fd: FileBinaryMode | FileTextMode | number,
	callback: (err: NodeJS.ErrnoException | null) => void,
): void {
	try {
		closeSync(fd);
		setImmediate(() => callback(null));
	} catch (err) {
		setImmediate(() => callback(err as NodeJS.ErrnoException));
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
		setImmediate(() => callback(null, bytesRead, buffer));
	} catch (err) {
		setImmediate(() => callback(err as NodeJS.ErrnoException));
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
		setImmediate(() => callback(null, bytesWritten, buffer));
	} catch (err) {
		setImmediate(() => callback(err as NodeJS.ErrnoException));
	}
}

// ============================================================================
// Unsupported Methods (Throw helpful errors)
// ============================================================================

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
