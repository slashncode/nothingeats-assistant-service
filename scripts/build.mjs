// Bundles the service into one ES module (dist/main.mjs) for the container image: no node_modules
// in the image, and every dependency is plain JavaScript, so the same file runs on amd64 and arm64.
import { copyFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { build } from 'esbuild';

await build({
    entryPoints: ['src/main.ts'],
    outfile: 'dist/main.mjs',
    bundle: true,
    platform: 'node',
    target: 'node24',
    format: 'esm',
    sourcemap: true,
    legalComments: 'linked',
    // Some dependencies are CommonJS and expect require and __dirname.
    banner: {
        js: [
            'import { createRequire as __createRequire } from \'node:module\';',
            'import { fileURLToPath as __fileURLToPath } from \'node:url\';',
            'const require = __createRequire(import.meta.url);',
            'const __filename = __fileURLToPath(import.meta.url);',
            'const __dirname = __fileURLToPath(new URL(\'.\', import.meta.url));',
        ].join('\n'),
    },
    logLevel: 'info',
});

// @platformatic/kafka's CRC32C and compression run in WebAssembly, loaded from "../dist/native.wasm"
// next to the module, which in the bundle means next to main.mjs.
const kafka = createRequire(createRequire(import.meta.url).resolve('@platformatic/kafka'));
copyFileSync(path.join(path.dirname(kafka.resolve('@platformatic/wasm-utils')), 'native.wasm'), 'dist/native.wasm');
