/**
 * When the os shim refreshes its cache
 *
 * Nova can only read most os values through its async-only Process API, so they
 * are cached and refreshed in the background. The refresh must not happen just
 * because something imported the module - the process shim imports os for arch,
 * and an extension reading process.env should not fork a shell.
 */

import assert from 'node:assert';
import { installInertProcess, installNova } from './nova.js';

installNova({ environment: { HOME: '/Users/example' } });

const spawns = installInertProcess();

const processShim = (await import('./process.ts')).default;

describe('the deferred refresh', () => {
	it('does not run on import, or on reading env and cwd', () => {
		assert.strictEqual(spawns.spawned, 0, 'importing the process shim must not spawn anything');

		assert.strictEqual(processShim.env.HOME, '/Users/example');
		processShim.cwd();

		assert.strictEqual(spawns.spawned, 0, 'reading env and cwd must not spawn a subprocess');
	});

	it('runs once, when an os-backed value is first read', async () => {
		assert.strictEqual(typeof processShim.arch(), 'string', 'arch still returns a value');
		assert.strictEqual(spawns.spawned, 1, 'reading arch triggers exactly one refresh');

		const os = (await import('./os.ts')).default;

		processShim.arch();
		os.hostname();
		os.totalmem();

		assert.strictEqual(spawns.spawned, 1, 'and no further reads trigger another');
	});
});
