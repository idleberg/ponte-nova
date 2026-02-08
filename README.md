<div align="center">
	<img width="320" src="resources/logo.png" title="Ponte Nova">
</div>

# ponte-nova

> Bridging the gap between Nova and Node.js

[![License](https://img.shields.io/github/license/idleberg/ponte-nova?color=blue&style=for-the-badge)](https://github.com/idleberg/ponte-nova/blob/main/LICENSE)
[![Version: npm](https://img.shields.io/npm/v/ponte-nova?style=for-the-badge)](https://www.npmjs.org/package/ponte-nova)
![GitHub branch check runs](https://img.shields.io/github/check-runs/idleberg/ponte-nova/main?style=for-the-badge)

## Installation 💿

```shell
npm install ponte-nova
```

## Usage 🚀

The plugin can be used with any bundler compatible with the Rollup plugin API. See the following examples for the most popular ones:

<details>
<summary><strong>Rollup</strong></summary>

```ts
import { ponteNova } from 'ponte-nova';

export default {
	input: 'src/main.ts',
	plugins: [
		ponteNova(),
	],
	output: {
		file: 'extension.js',
		format: 'cjs',
	},
};
```
</details>

<details>
<summary><strong>Vite</strong></summary>

```ts
import { defineConfig } from 'vite'
import { ponteNova } from 'ponte-nova';

export default defineConfig({
	build: {
    lib: {
      entry: ['src/main.ts'],
			fileName: 'extension',
      formats: ['cjs'],
    },
  },
	plugins: [
		ponteNova(),
	],
})
```
</details>

<details>
<summary><strong>tsdown</strong></summary>

```ts
import { defineConfig } from 'tsdown'
import { ponteNova } from 'ponte-nova';

export default defineConfig({
	entry: ['src/main.ts'],
	format: 'cjs',
	plugins: [
		ponteNova(),
	],
})
```
</details>

## License ©️

This work is licensed under [The MIT License](LICENSE).
