<div align="center">
	<img width="320" src="resources/logo.png" title="Ponte Nova">
</div>

# ponte-nova

> Bridging the gap between Node.js and Nova

[![License](https://img.shields.io/github/license/idleberg/ponte-nova?color=blue&style=for-the-badge)](https://github.com/idleberg/ponte-nova/blob/main/LICENSE)
[![Version: npm](https://img.shields.io/npm/v/ponte-nova?style=for-the-badge)](https://www.npmjs.org/package/ponte-nova)
![GitHub branch check runs](https://img.shields.io/github/check-runs/idleberg/ponte-nova/main?style=for-the-badge)

## Description 🤓

**/ˈpõtʃi ˈnɔvɐ/** – *”new bridge”*

> [!IMPORTANT]
>
> This package is currently in an experimental state and likely not ready for use in production.

NodeJS provides a rich eco-system of packages, many of them useful when developing extensions for [Nova](https://nova.app/), the text-editor by Panic. However, NodeJS and the Nova API aren't fully compatible. Packages relying on built-in modules will not work in Nova. Ponte Nova tries to change that by mapping NodeJS built-ins to their Nova counterparts.

This package provides a Rollup plugin that transforms your code to achieve that. However, the full NodeJS API cannot be covered and some methods have their own caveats. I would love to get feedback from extension developers to improve it, please see the [known issues](#known-issues-) below.

**Supported Built-ins**

- `node:fs`
- `node:fs/promises`
- `node:os`
- `node:path`

## Installation 💿

```shell
npm install ponte-nova
```

## Usage 🚀

The plugin can be used with any bundler supporting the [Rollup](https://rollupjs.org/) plugin API, including [Vite](https://vite.dev/), [Rolldown](https://rolldown.rs/), [Farm](https://farm-fe.github.io/) and others.

<details>
<summary><strong>Rollup</strong></summary>

```ts
import ponteNova from 'ponte-nova';

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
import ponteNova from 'ponte-nova';

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
});
```
</details>

<details>
<summary><strong>tsdown</strong></summary>

```ts
import { defineConfig } from 'tsdown'
import ponteNova from 'ponte-nova';

export default defineConfig({
	entry: ['src/main.ts'],
	format: 'cjs',
	plugins: [
		ponteNova(),
	],
});
```
</details>

## Known Issues 🐞

> [!NOTE]
>
> I'd like to go into dialog with extension developers about some of the decisions described below. You are welcome to challenge this decision by opening an [issue](issues).

### Base Directory

In NodeJS, methods such as `path.resolve` or `fs.mkdir` use `process.cwd()` to determine a base directory. In Ponte Nova, we use `nova.extension.path` instead.

### Unsupported Path methods

Since Nova is Macintosh-only, all methods in `path.win32` are not supported.

### Unsupported FileSystem methods

Due to limitations of the Nova Extension API, the following `node:fs` methods are currently not supported:

`chmod`, `chmodSync`, `chown`, `chownSync`, `createReadStream`, `createWriteStream`, `fchmod`, `fchmodSync`, `fchown`, `fchownSync`, `fdatasync`, `fdatasyncSync`, `fstat`, `fstatSync`, `fsync`, `fsyncSync`, `ftruncate`, `ftruncateSync`, `futimes`, `futimesSync`, `lchmod`, `lchmodSync`, `lchown`, `lchownSync`, `link`, `linkSync`, `lutimes`, `lutimesSync`, `readlink`, `readlinkSync`, `symlink`, `symlinkSync`, `truncate`, `truncateSync`, `unwatchFile`, `utimes`, `utimesSync`, `watch`, `watchFile`

### Unsupported OS methods

`getPriority`, `setPriority`

## License ©️

This work is licensed under [The MIT License](LICENSE).
