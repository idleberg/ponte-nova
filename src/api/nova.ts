/**
 * Stubs of the Nova globals the shims read
 *
 * Vitest isolates each spec file, so installing these at the top of a file
 * affects only that file, and the module under test has to be imported after
 * the install for anything it reads at load time to see them.
 */

import { posix } from 'node:path';

interface NovaStub {
	extension?: Record<string, unknown>;
	environment?: Record<string, string>;
	versionString?: string;
	path?: Record<string, unknown>;
	fs?: Record<string, unknown>;
	crypto?: Record<string, unknown>;
	[key: string]: unknown;
}

/** The extension directory the shims resolve relative paths against */
export const extensionPath = '/Users/example/.nova/Extensions/demo';

/**
 * Install a stubbed `nova` global
 *
 * The path methods are the real POSIX ones rather than approximations, since
 * that is what Nova provides on the only platform it runs on.
 */
export function installNova(overrides: NovaStub = {}): void {
	const stub: NovaStub = {
		extension: { path: extensionPath, globalStoragePath: '/nonexistent/nova-storage' },
		environment: {},
		versionString: '11.5',
		path: {
			isAbsolute: posix.isAbsolute,
			normalize: posix.normalize,
			join: posix.join,
			basename: posix.basename,
			dirname: posix.dirname,
			extname: posix.extname,
		},
		// Enough for the os cache to conclude that it has nothing stored
		fs: {
			access: () => false,
			open: () => {
				throw new Error('no cache file in this test');
			},
		},
		...overrides,
	};

	Object.assign(globalThis, { nova: stub });
}

/**
 * Install a `Process` stub that never actually launches anything
 *
 * Returns a counter, so a test can assert that a shim did not fork a shell.
 */
export function installInertProcess(): { spawned: number } {
	const counter = { spawned: 0 };

	Object.assign(globalThis, {
		Process: class {
			constructor() {
				counter.spawned++;
			}
			onStdout(): void {}
			onStderr(): void {}
			onDidExit(callback: (status: number) => void): void {
				setTimeout(() => callback(1), 0);
			}
			start(): void {}
		},
	});

	return counter;
}
