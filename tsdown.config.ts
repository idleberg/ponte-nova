import { defineConfig } from 'tsdown';

export default defineConfig((options) => {
	const isProduction = options.watch !== true;

	return {
		target: 'node20',
		clean: isProduction,
		dts: isProduction,
		// The specs and their Nova stubs live beside the sources, so they have to
		// be kept out of the build: without this they are emitted into dist/ and
		// published, and they drag the real modules into shared chunks
		entry: ['src/api/*.ts', '!src/api/*.spec.ts', '!src/api/nova.ts', 'src/plugin.ts'],
		format: 'esm',
		minify: isProduction,
		platform: 'node',
	};
});
