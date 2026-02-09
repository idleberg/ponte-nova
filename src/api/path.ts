/**
 * Path module compatibility layer for Nova extensions
 * Maps Node.js path API to Nova's path API
 */

import type { FormatInputPathObject, ParsedPath } from 'node:path';

// Path separator - Nova runs on macOS, so always '/'
export const sep = '/';
export const delimiter = ':';

/**
 * Join path segments
 *
 * Uses nova.path.join internally but adds pre-processing to match Node.js behavior:
 * - Filters out empty strings and null/undefined values before joining
 * - Returns '.' when no valid paths are provided
 *
 * Nova's join doesn't filter these values, which would produce different results
 * for edge cases like join('', 'foo') or join().
 */
export function join(...paths: string[]): string {
	// Filter out empty strings and undefined/null values like Node.js does
	const validPaths = paths.filter((p) => p != null && p !== '');

	// If no valid paths, return '.'
	if (validPaths.length === 0) {
		return '.';
	}

	const joined = nova.path.join(...validPaths);
	return nova.path.normalize(joined);
}

/**
 * Resolve path segments to an absolute path
 *
 * Custom implementation because Node.js and Nova have different resolution semantics:
 * - Node.js resolves right-to-left until an absolute path is found, then uses cwd as base
 * - This implementation uses nova.extension.path as the base instead of cwd, which is
 *   more appropriate for extension code (similar to how Node.js modules resolve from
 *   their location)
 *
 * Uses nova.path.isAbsolute and nova.path.normalize internally.
 */
export function resolve(...paths: string[]): string {
	if (paths.length === 0) {
		return nova.extension.path || '/';
	}

	// Process paths from right to left until we get an absolute path
	let resolvedPath = '';
	let resolvedAbsolute = false;

	for (let i = paths.length - 1; i >= 0 && !resolvedAbsolute; i--) {
		const path = paths[i];
		if (!path) continue;

		if (resolvedPath === '') {
			resolvedPath = path;
		} else {
			resolvedPath = `${path}/${resolvedPath}`;
		}

		resolvedAbsolute = nova.path.isAbsolute(resolvedPath);
	}

	// If still not absolute, prepend the extension path
	if (!resolvedAbsolute) {
		resolvedPath = `${nova.extension.path || '/'}/${resolvedPath}`;
	}

	// Normalize and return
	return nova.path.normalize(resolvedPath);
}

/**
 * Get the directory name of a path
 *
 * Custom implementation instead of nova.path.dirname to match Node.js edge case behavior:
 * - Returns '.' for empty string or '.' input (Nova may differ)
 * - Strips trailing slashes before processing (e.g., '/foo/bar/' → '/foo')
 * - Returns '/' for root-only paths
 *
 * These edge cases ensure compatibility with Node.js code that relies on specific
 * dirname behavior for path manipulation.
 */
export function dirname(path: string): string {
	// Handle edge cases
	if (path === '' || path === '.') {
		return '.';
	}
	if (path === '/') {
		return '/';
	}

	// Remove trailing slashes
	let cleanPath = path;
	while (cleanPath.length > 1 && cleanPath.endsWith('/')) {
		cleanPath = cleanPath.slice(0, -1);
	}

	// Find the last separator
	const lastSlash = cleanPath.lastIndexOf('/');

	// No slash found - return '.' for relative paths
	if (lastSlash === -1) {
		return '.';
	}

	// Slash at position 0 - return root
	if (lastSlash === 0) {
		return '/';
	}

	// Return everything before the last slash
	return cleanPath.slice(0, lastSlash);
}

/**
 * Get the last portion of a path (filename)
 *
 * Uses nova.path.basename internally but adds Node.js-specific behavior:
 * - Strips trailing slashes before processing (Node.js behavior)
 * - Supports optional extension removal (nova.path.basename doesn't accept ext parameter)
 */
export function basename(path: string, ext?: string): string {
	// Remove trailing slashes first (Node.js behavior)
	let cleanPath = path;
	while (cleanPath.length > 1 && cleanPath.endsWith('/')) {
		cleanPath = cleanPath.slice(0, -1);
	}

	let base = nova.path.basename(cleanPath);

	// Only remove extension if it's provided and matches exactly
	// Node.js removes the suffix if the basename ends with it
	if (ext && ext.length > 0 && base.endsWith(ext)) {
		base = base.slice(0, -ext.length);
	}

	return base;
}

/**
 * Get the extension of a path
 *
 * Custom implementation instead of nova.path.extname to match Node.js edge case behavior:
 * - Returns '' for dotfiles without extensions (e.g., '.gitignore' → '')
 * - Returns '' for paths ending with a dot at position 0 (e.g., '.' or '..')
 * - Only considers the last dot in the basename, not in directory components
 *
 * Nova's extname may handle these edge cases differently, which would break
 * Node.js code that depends on specific extension parsing rules.
 */
export function extname(path: string): string {
	// Get the basename first
	const base = basename(path);

	// Handle edge cases
	if (base === '' || base === '.' || base === '..') {
		return '';
	}

	// Find the last dot in the basename
	const idx = base.lastIndexOf('.');

	// If no dot, or dot is first character (dotfile with no extension), return ''
	if (idx <= 0) {
		return '';
	}

	return base.slice(idx);
}

/**
 * Normalize a path (resolve . and ..)
 */
export function normalize(path: string): string {
	return nova.path.normalize(path);
}

/**
 * Check if a path is absolute
 */
export function isAbsolute(path: string): boolean {
	return nova.path.isAbsolute(path);
}

/**
 * Parse a path into components
 */
export function parse(pathString: string): ParsedPath {
	const ext = extname(pathString);
	const base = basename(pathString);
	const name = basename(pathString, ext);
	const dir = dirname(pathString);

	// Determine root (/ for absolute paths on Unix)
	const root = pathString.startsWith('/') ? '/' : '';

	return {
		root,
		dir,
		base,
		ext,
		name,
	};
}

/**
 * Format a path object into a path string
 */
export function format(pathObject: FormatInputPathObject): string {
	const dir = pathObject.dir || pathObject.root || '';
	const base = pathObject.base || (pathObject.name || '') + (pathObject.ext || '');

	if (!dir) {
		return base;
	}

	return dir === pathObject.root ? dir + base : dir + sep + base;
}

/**
 * Get relative path from 'from' to 'to'
 */
export function relative(from: string, to: string): string {
	const resolvedFrom = resolve(from);
	const resolvedTo = resolve(to);

	if (resolvedFrom === resolvedTo) {
		return '';
	}

	const fromParts = resolvedFrom.split(sep).filter(Boolean);
	const toParts = resolvedTo.split(sep).filter(Boolean);

	// Find common base
	let commonLength = 0;
	const minLength = Math.min(fromParts.length, toParts.length);

	for (let i = 0; i < minLength; i++) {
		if (fromParts[i] !== toParts[i]) {
			break;
		}
		commonLength++;
	}

	// Build relative path
	const upLevels = fromParts.length - commonLength;
	const downPath = toParts.slice(commonLength);

	const parts = [];
	for (let i = 0; i < upLevels; i++) {
		parts.push('..');
	}

	return parts.concat(downPath).join(sep) || '.';
}

/**
 * Resolve path to namespace (Windows UNC paths - not applicable in Nova)
 */
export function toNamespacedPath(path: string): string {
	// Nova runs on macOS only, no Windows UNC paths
	return path;
}

// POSIX-specific methods (Nova is POSIX-compliant)
export const posix = {
	sep,
	delimiter,
	join,
	resolve,
	dirname,
	basename,
	extname,
	normalize,
	isAbsolute,
	parse,
	format,
	relative,
	toNamespacedPath,
};

// Win32 stubs (Nova doesn't run on Windows)
export const win32 = {
	sep: '\\',
	delimiter: ';',
	join: () => {
		throw new Error('win32 paths not supported in Nova');
	},
	resolve: () => {
		throw new Error('Win32 paths not supported in Nova');
	},
	dirname: () => {
		throw new Error('Win32 paths not supported in Nova');
	},
	basename: () => {
		throw new Error('Win32 paths not supported in Nova');
	},
	extname: () => {
		throw new Error('Win32 paths not supported in Nova');
	},
	normalize: () => {
		throw new Error('Win32 paths not supported in Nova');
	},
	isAbsolute: () => {
		throw new Error('Win32 paths not supported in Nova');
	},
	parse: () => {
		throw new Error('Win32 paths not supported in Nova');
	},
	format: () => {
		throw new Error('Win32 paths not supported in Nova');
	},
	relative: () => {
		throw new Error('Win32 paths not supported in Nova');
	},
	toNamespacedPath: () => {
		throw new Error('Win32 paths not supported in Nova');
	},
};

// Default export
export default {
	sep,
	delimiter,
	join,
	resolve,
	dirname,
	basename,
	extname,
	normalize,
	isAbsolute,
	parse,
	format,
	relative,
	toNamespacedPath,
	posix,
	win32,
};
