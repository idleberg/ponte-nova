<div align="center">
	<img width="320" src="resources/logo.png" title="Ponte Nova">
</div>

# ponte-nova

> Bridging the gap between Node.js and Nova

[![License](https://img.shields.io/github/license/idleberg/ponte-nova?color=blue&style=for-the-badge)](https://github.com/idleberg/ponte-nova/blob/main/LICENSE)
[![Version: npm](https://img.shields.io/npm/v/ponte-nova?style=for-the-badge)](https://www.npmjs.org/package/ponte-nova)
![GitHub branch check runs](https://img.shields.io/github/check-runs/idleberg/ponte-nova/main?style=for-the-badge)

## Description 🤓

**/ˈpõtʃi ˈnɔvɐ/** – _”new bridge”_

> [!IMPORTANT]
>
> This package is currently in an experimental state and likely not ready for use in production.

NodeJS provides a rich eco-system of packages, many of them useful when developing extensions for [Nova](https://nova.app/), the text-editor by Panic. However, NodeJS and the Nova API aren't fully compatible. Packages relying on built-in modules will not work in Nova. Ponte Nova tries to change that by mapping NodeJS built-ins to their Nova counterparts.

This package provides a Rollup plugin that transforms your code to achieve that. However, the full NodeJS API cannot be covered and some methods have their own caveats. I would love to get feedback from extension developers to improve it, please see the [known issues](#known-issues-) below.

**Supported Built-ins**

- `node:buffer`
- `node:child_process`
- `node:crypto`
- `node:events`
- `node:fs`
- `node:fs/promises`
- `node:os`
- `node:path`
- `node:process`
- `node:util`

## Installation 💿

```shell
npm install ponte-nova
```

## Usage 🚀

The plugin can be used with any bundler supporting the [Rollup](https://rollupjs.org/) plugin API, including [Vite](https://vite.dev/), [Rolldown](https://rolldown.rs/), [Farm](https://farm-fe.github.io/) and others.

<details>
<summary><strong>Rollup</strong></summary>

```ts
import ponteNova from "ponte-nova";

export default {
  input: "src/main.ts",
  plugins: [ponteNova()],
  output: {
    file: "extension.js",
    format: "cjs",
  },
};
```

</details>

<details>
<summary><strong>Vite</strong></summary>

```ts
import { defineConfig } from "vite";
import ponteNova from "ponte-nova";

export default defineConfig({
  build: {
    lib: {
      entry: ["src/main.ts"],
      fileName: "extension",
      formats: ["cjs"],
    },
  },
  plugins: [ponteNova()],
});
```

</details>

<details>
<summary><strong>tsdown</strong></summary>

```ts
import { defineConfig } from "tsdown";
import ponteNova from "ponte-nova";

export default defineConfig({
  entry: ["src/main.ts"],
  format: "cjs",
  plugins: [ponteNova()],
});
```

</details>

### Options

| Option            | Type                                                     | Default | Description                                                                                   |
| ----------------- | -------------------------------------------------------- | ------- | --------------------------------------------------------------------------------------------- |
| `customAliases`   | `Array<{ find: string \| RegExp; replacement: string }>` | `[]`    | Applied before the built-in aliases, so an entry here overrides the shim for that module.     |
| `skipCommonJS`    | `boolean`                                                | `false` | Skips `@rollup/plugin-commonjs`, which you then have to add yourself, before this plugin.     |
| `skipNodeResolve` | `boolean`                                                | `false` | Skips `@rollup/plugin-node-resolve`, which you then have to add yourself, before this plugin. |

## Known Issues 🐞

> [!NOTE]
>
> I'd like to go into dialog with extension developers about some of the decisions described below. You are welcome to challenge this decision by opening an [issue](issues).

### Base Directory

In NodeJS, methods such as `path.resolve` or `fs.mkdir` use `process.cwd()` to determine a base directory. In Ponte Nova, we start from `nova.extension.path` instead. `process.cwd()` reports that same directory, and `process.chdir()` moves it for `path` and `fs` too.

### Reading files without an encoding

As in NodeJS, `fs.readFileSync(path)` without an encoding returns a `Buffer`, and only `fs.readFileSync(path, 'utf8')` returns a string. Earlier versions returned a string in both cases.

### Unsupported Path methods

Since Nova is Macintosh-only, all methods in `path.win32` are not supported.

### Hashing

Nova has no hashing API, so `createHash` and `createHmac` run on [hash-wasm](https://github.com/Daninet/hash-wasm). Their signatures are exactly the NodeJS ones — `createHash('sha256').update(data).digest('hex')` is synchronous and returns a string — and the output is verified against NodeJS for every supported algorithm, digest encoding and HMAC key length.

There is one thing to do first. The only way into hash-wasm is `WebAssembly.compile`, which is asynchronous, so the compile has to happen before the first digest rather than during it:

```js
const crypto = require('node:crypto');

exports.activate = async () => {
  await crypto.ready();
};
```

That takes a few milliseconds, and every hash afterwards is synchronous. `ready()` with no argument compiles every algorithm; pass a list, such as `ready(['sha256'])`, to compile only what you use. A digest attempted before then throws and says so, rather than returning something wrong. The case this does not cover is a bundled package that hashes while it is being imported, before your `activate` runs.

Supported algorithms: `blake2b512`, `blake2s256`, `md5`, `ripemd160`, `sha1`, `sha224`, `sha256`, `sha384`, `sha512`, `sha3-224`, `sha3-256`, `sha3-384`, `sha3-512`, `sm3`. `getHashes()` reports them.

Note that an extension using `createHash` grows by roughly 116 kB, which is hash-wasm's WebAssembly embedded as base64.

### Unsupported Crypto methods

Ciphers, key derivation and signing have no counterpart here and throw:

`createCipher`, `createCipheriv`, `createDecipher`, `createDecipheriv`, `createDiffieHellman`, `createSign`, `createVerify`, `generateKeyPair`, `generateKeyPairSync`, `pbkdf2`, `pbkdf2Sync`, `scrypt`, `scryptSync`

### Globals

`Buffer` and `process` are globals in NodeJS, so packages use them without importing anything. Nova has no such globals, and the plugin therefore rewrites every reference into an import of the corresponding shim. Importing `node:buffer` or `node:process` explicitly works too.

### Buffer

The implementation extends `Uint8Array`, as it does in NodeJS, and covers all eight encodings, the numeric accessors, and the usual static helpers. Two details differ:

- `allocUnsafe` zero-fills, because there is no uninitialised allocation available. That is slower than Node.js, never less safe.
- Decoding malformed UTF-8 produces `U+FFFD`, but not necessarily the same number of them as Node.js. Well-formed input always round-trips.

### Process

An extension runs inside the editor rather than as a standalone program, so parts of `process` have nothing to describe. What maps onto Nova works properly: `env` reads `nova.environment`, `cwd` and `chdir` share their directory with `path` and `fs`, `nextTick` uses the microtask queue, and `stdout`/`stderr` write whole lines to the console.

The rest is worth knowing about:

- `process.exit()` **throws**, because an extension cannot terminate the editor. It stops execution where NodeJS would have, rather than letting code that assumed it was unreachable keep running.
- `process.version` reports `v20.0.0`. No NodeJS runtime is involved, so this is a fiction, but packages parse it to pick a feature set and an empty value makes them fail outright.
- `process.env` is a mutable copy. Assignments are visible to the rest of the extension and to nothing else — not the editor, not a subprocess.
- `process.pid` is invented at load, so code using it to build unique names still gets uniqueness.
- `on('exit')` and friends are accepted and stored, but nothing ever emits them.
- `getuid`, `getgid` and `umask` are **absent** rather than stubbed, so that `typeof process.getuid === 'function'` gives the honest answer. A stub reporting uid 0 would tell a package it is running as root.
- `hrtime` is derived from `Date.now`, so it is accurate to the millisecond and no further.
- `abort`, `kill`, `binding` and `dlopen` throw.

### Child processes

`spawn`, `exec` and `execFile` run on Nova's Process API and behave as expected: events, piped `stdout`/`stderr`, a writable `stdin`, `cwd`, `env`, `timeout`, `maxBuffer`, `AbortSignal`, and the promisified forms of `exec` and `execFile`.

The synchronous family cannot exist. Nova reports output and exit status through callbacks and JavaScript cannot block until they arrive, so `execSync`, `execFileSync` and `spawnSync` throw and point at their asynchronous counterparts. `fork` throws too, since there is no NodeJS runtime to fork into.

Three smaller differences:

- Nova delivers output a line at a time rather than as a byte stream, so output that ended without a trailing newline gains one. Chunk boundaries always fall on newlines.
- `stdio` is accepted and ignored. Every child is piped; Nova offers no equivalent of `inherit` or `ignore`, and none of `detached`, IPC or `child.send()`.
- A command without a slash in it is launched through `/usr/bin/env`, which performs the `PATH` lookup that NodeJS does internally and Nova does not.

### Events

`EventEmitter` is plain JavaScript rather than anything Nova provides, so this is a real implementation and not an approximation: listener order, `once` unsubscribing before it fires, `prependListener`, `listeners` versus `rawListeners`, the `newListener` event, and an unhandled `'error'` throwing all behave as they do in NodeJS. `events.once(emitter, name)` returns a promise, rejecting if the emitter errors first.

The shims use it themselves — a child process and its streams are emitters.

### Util

`promisify` (including the `promisify.custom` protocol, which is how `promisify(exec)` returns a child process), `callbackify`, `inherits`, `format`, `isDeepStrictEqual`, `types.*`, `deprecate` and `debuglog` are all present and checked against NodeJS.

`TextEncoder` and `TextDecoder` live here too. JavaScriptCore provides neither, so they are built on the Buffer shim; `TextDecoder` handles UTF-8 only and throws for any other encoding rather than mis-decoding silently.

`inspect` is the one deliberate approximation. It covers the shapes that turn up in log output — objects, arrays, `Map`, `Set`, typed arrays, dates, regular expressions, circular references, depth limiting and the `inspect.custom` symbol — but it breaks lines at its own discretion, and shows a promise only as `<pending>`, because a promise's state cannot be read synchronously.

### Approximated FileSystem errors

Nova's FileSystem API throws opaque errors, so the Node.js error codes are reconstructed by inspecting the path after a failure. The common cases — `ENOENT`, `EEXIST`, `EISDIR`, `ENOTDIR`, `ENOTEMPTY`, `EACCES` — come out right, but a failure with an unusual cause will be reported as `EACCES`.

Constants and `errno` values follow macOS, matching what Node.js reports there rather than on Linux.

### Unsupported FileSystem methods

`chmod`, `chmodSync`, `chown`, `chownSync`, `createReadStream`, `createWriteStream`, `fchmod`, `fchmodSync`, `fchown`, `fchownSync`, `fdatasync`, `fdatasyncSync`, `fstat`, `fstatSync`, `fsync`, `fsyncSync`, `ftruncate`, `ftruncateSync`, `futimes`, `futimesSync`, `lchmod`, `lchmodSync`, `lchown`, `lchownSync`, `link`, `linkSync`, `lutimes`, `lutimesSync`, `readlink`, `readlinkSync`, `symlink`, `symlinkSync`, `truncate`, `truncateSync`, `unwatchFile`, `utimes`, `utimesSync`, `watch`, `watchFile`

### Stale OS information

The NodeJS `os` API is synchronous, but Nova can only read most of these values through its async-only Process API. Values describing the machine rather than its current state — `arch`, `hostname`, `release`, `version`, `machine`, `totalmem`, `cpus` and `uptime` — are therefore cached to disk and read back synchronously on the next activation.

On the very first activation, before that cache exists, these methods return fallback values (`arm64`, empty strings, zeroes). They become accurate once the background refresh completes, and on every activation thereafter.

### Unsupported OS methods

`getPriority`, `setPriority`

## License ©️

This work is licensed under [The MIT License](LICENSE).
