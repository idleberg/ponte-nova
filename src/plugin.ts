import path from 'node:path';
import { fileURLToPath } from 'node:url';
import alias from '@rollup/plugin-alias';
import commonjs from '@rollup/plugin-commonjs';
import inject from '@rollup/plugin-inject';
import { nodeResolve } from '@rollup/plugin-node-resolve';
import { consola } from 'consola';
import type { Plugin } from 'rollup';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

interface PonteNovaOptions {
	customAliases?: Array<{ find: string | RegExp; replacement: string }>;
	skipCommonJS: boolean;
	skipNodeResolve: boolean;
}

/**
 * Rollup plugin for Node.js API compatibility in Nova extensions
 *
 * Automatically replaces Node.js built-in modules (fs, path, etc.) with
 * Nova-compatible implementations.
 *
 * @param options - Plugin options
 * @param options.customAliases - Additional aliases to apply
 * @param options.skipCommonJS - Skips using @rollup/plugin-commonjs (not recommended)
 * @param options.skipNodeResolve - Skips using @rollup/plugin-node-resolve (not recommended)
 * @returns Array of Rollup plugins
 */
export default function ponteNova(
	options: PonteNovaOptions = {
		skipCommonJS: false,
		skipNodeResolve: false,
	},
): Plugin[] {
	const apiPath = path.resolve(__dirname, './api');

	const builtinAliases = [
		{ find: /^(?:node:)?buffer$/, replacement: `${apiPath}/buffer.mjs` },
		{ find: /^(?:node:)?crypto$/, replacement: `${apiPath}/crypto.mjs` },
		{ find: /^(?:node:)?fs\/promises$/, replacement: `${apiPath}/fs-promises.mjs` },
		{ find: /^(?:node:)?fs$/, replacement: `${apiPath}/fs.mjs` },
		{ find: /^(?:node:)?os$/, replacement: `${apiPath}/os.mjs` },
		{ find: /^(?:node:)?path$/, replacement: `${apiPath}/path.mjs` },
		{ find: /^(?:node:)?process$/, replacement: `${apiPath}/process.mjs` },
	];

	const plugins: Plugin[] = [];

	if (options.skipNodeResolve) {
		consola.warn(
			'When skipping @rollup/plugin-node-resolve, you need to add it yourself to the plugins array of your build configuration. It must be added before the ponte-nova plugin and set preferBuiltins to false.',
		);
	} else {
		plugins.push(
			nodeResolve({
				// Don't prefer built-ins since we're replacing them
				preferBuiltins: false,
			}),
		);
	}

	if (options.skipCommonJS) {
		consola.warn(
			'When skipping @rollup/plugin-commonjs, you need to add it yourself to the plugins array of your build configuration. It must be added before the ponte-nova plugin.',
		);
	} else {
		// @ts-expect-error - @rollup/plugin-commonjs has mismatched ESM/type definitions with verbatimModuleSyntax
		plugins.push(commonjs());
	}

	// Apply aliases
	plugins.push(
		alias({
			entries: [...builtinAliases, ...(options.customAliases || [])],
		}),
	);

	// Buffer and process are globals in Node.js, so packages use them without
	// importing anything. Nova has no such globals, which means every reference
	// has to be rewritten into an import of the corresponding shim.
	plugins.push(
		// @ts-expect-error - @rollup/plugin-inject has mismatched ESM/type definitions with verbatimModuleSyntax
		inject({
			Buffer: [`${apiPath}/buffer.mjs`, 'Buffer'],
			process: [`${apiPath}/process.mjs`, 'default'],
		}),
	);

	return plugins;
}
