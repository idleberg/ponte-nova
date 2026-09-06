/**
 * The Rollup plugin, exercised by building a fixture with it
 *
 * This is the only suite that runs against dist/ rather than src/, because the
 * aliases point at the built shims. `npm test` builds first; running vitest on
 * its own after a source change needs a build to match.
 */

import assert from 'node:assert';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rollup } from 'rollup';
import { extensionPath, installInertProcess, installNova } from './api/nova.ts';

installNova({
	environment: { HOME: '/Users/example', PATH: '/usr/bin' },
});
installInertProcess();

// The built plugin, not the source: its aliases resolve relative to its own
// location, so loaded from src/ they would point at src/api/*.mjs, which are
// .ts files there and do not exist under that name
const distributed = join(import.meta.dirname, '../dist/plugin.mjs');

assert.ok(existsSync(distributed), 'dist/plugin.mjs is missing: run `npm run build` before this suite');

const ponteNova = (await import(distributed)).default;

/** Build a fixture with the plugin and import the result */
async function build(source: string, options?: Record<string, unknown>): Promise<Record<string, unknown>> {
	const directory = mkdtempSync(join(tmpdir(), 'ponte-nova-'));

	writeFileSync(join(directory, 'input.js'), source);

	const bundle = await rollup({
		input: join(directory, 'input.js'),
		plugins: ponteNova(options),
		onwarn() {},
	});

	const { output } = await bundle.generate({ format: 'es' });
	const code = (output[0] as { code: string }).code;

	writeFileSync(join(directory, 'out.mjs'), code);

	const built = (await import(join(directory, 'out.mjs'))) as Record<string, unknown>;

	return { ...built, __code: code };
}

describe('module aliases', () => {
	it('replaces every built-in it claims to support', async () => {
		const built = await build(`
			import buffer from 'node:buffer';
			import child_process from 'node:child_process';
			import crypto from 'node:crypto';
			import events from 'node:events';
			import fs from 'node:fs';
			import promises from 'node:fs/promises';
			import os from 'node:os';
			import path from 'node:path';
			import processModule from 'node:process';
			import url from 'node:url';
			import util from 'node:util';

			export const loaded = [buffer, child_process, crypto, events, fs, promises, os, path, processModule, url, util]
				.every((module) => module !== undefined);
		`);

		assert.strictEqual(built.loaded, true, 'every built-in resolved to a shim');
		assert.ok(!/from ['"]node:/.test(built.__code as string), 'no node: import should survive the build');
	});

	it('replaces the bare specifiers too, not just the node: ones', async () => {
		const built = await build(`
			import { fileURLToPath } from 'url';
			import { basename } from 'path';
			export const path = fileURLToPath('file:///tmp/x.txt');
			export const base = basename('/a/b.txt');
		`);

		assert.strictEqual(built.path, '/tmp/x.txt');
		assert.strictEqual(built.base, 'b.txt');
	});

	it('lets a custom alias override a built-in one', async () => {
		const directory = mkdtempSync(join(tmpdir(), 'ponte-nova-custom-'));
		const replacement = join(directory, 'my-path.mjs');

		writeFileSync(replacement, 'export const basename = () => "replaced";\nexport default { basename };\n');

		const built = await build(`import { basename } from 'node:path';\nexport const result = basename('/a/b.txt');`, {
			customAliases: [{ find: /^(?:node:)?path$/, replacement }],
		});

		assert.strictEqual(built.result, 'replaced', 'the custom alias won over the built-in one');
	});
});

describe('injected globals', () => {
	it('wires a bare Buffer to the shim', async () => {
		const built = await build(`
			export const fromGlobal = Buffer.from('hi', 'utf8').toString('hex');
			import { Buffer as Imported } from 'node:buffer';
			export const fromImport = Imported.from('hi').toString('base64');
		`);

		assert.strictEqual(built.fromGlobal, '6869');
		assert.strictEqual(built.fromImport, 'aGk=');
	});

	it('wires a bare process to the shim', async () => {
		const built = await build(`
			export const home = process.env.HOME;
			export const cwd = process.cwd();
			export const platform = process.platform;
			export const guard = typeof process === 'undefined' ? 'undefined' : 'object';
		`);

		assert.strictEqual(built.home, '/Users/example');
		assert.strictEqual(built.cwd, extensionPath);
		assert.strictEqual(built.platform, 'darwin');
		assert.strictEqual(built.guard, 'object', 'typeof process must not report undefined');
	});

	it('wires bare URL and URLSearchParams to the shim', async () => {
		const built = await build(`
			export const resolved = new URL('/a/../b?q=1', 'https://example.com').href;
			export const params = new URLSearchParams({ a: '1', b: '2' }).toString();
		`);

		assert.strictEqual(built.resolved, 'https://example.com/b?q=1');
		assert.strictEqual(built.params, 'a=1&b=2');
	});

	it.each(['Buffer', 'process', 'URL', 'URLSearchParams'])('leaves a local %s binding alone', async (name) => {
		const built = await build(`
			export function shadowed() {
				const ${name} = { marker: 'local' };
				return ${name}.marker;
			}
			export const property = { ${name}: 'plain' }.${name};
		`);

		assert.strictEqual((built.shadowed as () => string)(), 'local', 'a local binding was rewritten');
		assert.strictEqual(built.property, 'plain', 'a property name was rewritten');
	});
});

describe('bundling', () => {
	it('inlines the shims rather than leaving them as imports', async () => {
		const built = await build(`import { createHash } from 'node:crypto';\nexport const has = typeof createHash;`);
		const code = built.__code as string;

		assert.ok(!/^\s*import .* from/m.test(code), 'nothing should be left as an external import');
	});
});
