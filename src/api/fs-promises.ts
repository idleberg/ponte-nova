/**
 * File System Promises API compatibility layer for Nova extensions
 * Wraps synchronous fs operations in Promises
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
import {
	accessSync,
	appendFileSync,
	closeSync,
	constants,
	copyFileSync,
	cpSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readdirSync,
	readFileSync,
	readSync,
	realpathSync,
	renameSync,
	rmdirSync,
	rmSync,
	statSync,
	unlinkSync,
	writeFileSync,
	writeSync,
} from './fs.js';

// Re-export constants
export { constants };

// ============================================================================
// Promise-based Methods
// ============================================================================

export function readFile(path: string, options?: ObjectEncodingOptions | BufferEncoding | null): Promise<string> {
	return Promise.resolve(readFileSync(path, options));
}

export function writeFile(
	path: string,
	data: string | NodeJS.ArrayBufferView,
	options?: ObjectEncodingOptions | BufferEncoding | null,
): Promise<void> {
	return Promise.resolve(writeFileSync(path, data, options));
}

export function appendFile(
	path: string,
	data: string | NodeJS.ArrayBufferView,
	options?: ObjectEncodingOptions | BufferEncoding | null,
): Promise<void> {
	return Promise.resolve(appendFileSync(path, data, options));
}

export function stat(path: string, options?: StatOptions): Promise<Stats> {
	return Promise.resolve(statSync(path, options));
}

export function lstat(path: string, options?: StatOptions): Promise<Stats> {
	return Promise.resolve(lstatSync(path, options));
}

export function mkdir(path: string, options?: MakeDirectoryOptions | Mode | null): Promise<void> {
	return Promise.resolve(mkdirSync(path, options));
}

export function readdir(
	path: string,
	options?: { encoding?: BufferEncoding | null; withFileTypes?: false },
): Promise<string[]>;
export function readdir(
	path: string,
	options: { encoding?: BufferEncoding | null; withFileTypes: true },
): Promise<Dirent[]>;
export function readdir(
	path: string,
	options?: { encoding?: BufferEncoding | null; withFileTypes?: boolean },
): Promise<string[] | Dirent[]> {
	if (options?.withFileTypes === true) {
		return Promise.resolve(readdirSync(path, { encoding: options.encoding, withFileTypes: true }));
	}
	return Promise.resolve(readdirSync(path, { encoding: options?.encoding, withFileTypes: false }));
}

export function unlink(path: string): Promise<void> {
	return Promise.resolve(unlinkSync(path));
}

export function rmdir(path: string, options?: RmDirOptions): Promise<void> {
	return Promise.resolve(rmdirSync(path, options));
}

export function rm(path: string, options?: RmOptions): Promise<void> {
	return Promise.resolve(rmSync(path, options));
}

export function rename(oldPath: string, newPath: string): Promise<void> {
	return Promise.resolve(renameSync(oldPath, newPath));
}

export function copyFile(src: string, dest: string, mode?: number): Promise<void> {
	return Promise.resolve(copyFileSync(src, dest, mode));
}

export function cp(src: string, dest: string, options?: CopyOptions): Promise<void> {
	return Promise.resolve(cpSync(src, dest, options));
}

export function access(path: string, mode?: number): Promise<void> {
	return Promise.resolve(accessSync(path, mode));
}

export function realpath(path: string, options?: ObjectEncodingOptions | BufferEncoding | null): Promise<string> {
	return Promise.resolve(realpathSync(path, options));
}

export function mkdtemp(prefix: string, options?: ObjectEncodingOptions | BufferEncoding | null): Promise<string> {
	return Promise.resolve(mkdtempSync(prefix, options));
}

/**
 * FileHandle class for promise-based file operations
 */
class FileHandle {
	private fd: FileBinaryMode | FileTextMode;
	private path: string;

	constructor(fd: FileBinaryMode | FileTextMode, path: string) {
		this.fd = fd;
		this.path = path;
	}

	read(
		buffer: NodeJS.ArrayBufferView,
		offset?: number | null,
		length?: number | null,
		position?: number | null,
	): Promise<{ bytesRead: number; buffer: NodeJS.ArrayBufferView }> {
		return Promise.resolve(readSync(this.fd, buffer, offset, length, position)).then((bytesRead) => ({
			bytesRead,
			buffer,
		}));
	}

	write(
		buffer: NodeJS.ArrayBufferView | string,
		offset?: number | null,
		length?: number | null,
		position?: number | null,
	): Promise<{ bytesWritten: number; buffer: NodeJS.ArrayBufferView | string }> {
		return Promise.resolve(writeSync(this.fd, buffer, offset, length, position)).then((bytesWritten) => ({
			bytesWritten,
			buffer,
		}));
	}

	readFile(options?: ObjectEncodingOptions | BufferEncoding | null): Promise<string> {
		return readFile(this.path, options);
	}

	writeFile(
		data: string | NodeJS.ArrayBufferView,
		options?: ObjectEncodingOptions | BufferEncoding | null,
	): Promise<void> {
		return writeFile(this.path, data, options);
	}

	close(): Promise<void> {
		return Promise.resolve(closeSync(this.fd));
	}

	stat(options?: StatOptions): Promise<Stats> {
		return stat(this.path, options);
	}

	truncate(_len?: number): Promise<void> {
		return Promise.reject(new Error('FileHandle.truncate is not supported in Nova extensions.'));
	}

	utimes(_atime: Date | number, _mtime: Date | number): Promise<void> {
		return Promise.reject(new Error('FileHandle.utimes is not supported in Nova extensions.'));
	}

	chmod(_mode: Mode): Promise<void> {
		return Promise.reject(new Error('FileHandle.chmod is not supported in Nova extensions.'));
	}

	chown(_uid: number, _gid: number): Promise<void> {
		return Promise.reject(new Error('FileHandle.chown is not supported in Nova extensions.'));
	}

	datasync(): Promise<void> {
		return Promise.reject(new Error('FileHandle.datasync is not supported in Nova extensions.'));
	}

	sync(): Promise<void> {
		return Promise.reject(new Error('FileHandle.sync is not supported in Nova extensions.'));
	}
}

export function open(path: string, flags?: OpenMode, mode?: Mode | null): Promise<FileHandle> {
	return Promise.resolve(openSync(path, flags, mode)).then((fd) => new FileHandle(fd, path));
}

// ============================================================================
// Unsupported Methods (Return rejected promises with helpful errors)
// ============================================================================

const unsupportedError = (method: string, reason: string) => () => {
	return Promise.reject(new Error(`fs.promises.${method} is not supported in Nova extensions. ${reason}`));
};

export const chmod = unsupportedError('chmod', 'Nova does not expose permission modification APIs.');

export const chown = unsupportedError('chown', 'Nova does not expose ownership modification APIs.');

export const lchmod = unsupportedError('lchmod', 'Nova does not expose permission modification APIs.');

export const lchown = unsupportedError('lchown', 'Nova does not expose ownership modification APIs.');

export const link = unsupportedError('link', 'Nova does not expose hard link creation APIs.');

export const symlink = unsupportedError('symlink', 'Nova does not expose symbolic link creation APIs.');

export const readlink = unsupportedError('readlink', 'Nova does not expose symbolic link reading APIs.');

export const truncate = unsupportedError(
	'truncate',
	'Nova does not expose file truncation APIs. Read, slice, and write instead.',
);

export const utimes = unsupportedError('utimes', 'Nova does not expose timestamp modification APIs.');

export const lutimes = unsupportedError('lutimes', 'Nova does not expose timestamp modification APIs.');

export const watch = unsupportedError('watch', 'Nova does not expose file watching APIs.');

export const opendir = unsupportedError('opendir', 'Use fs.promises.readdir() instead.');

// ============================================================================
// Default Export
// ============================================================================

export default {
	constants,
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
	// Unsupported
	chmod,
	chown,
	lchmod,
	lchown,
	link,
	symlink,
	readlink,
	truncate,
	utimes,
	lutimes,
	watch,
	opendir,
};
