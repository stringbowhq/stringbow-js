import { defineConfig } from 'tsup';

// Publishable build. The SDK part of the private @stringbow/core (its ./sdk entry) is bundled in, with its types;
// real dependencies stay external.
export default defineConfig({
  entry: ['src/index.ts'],
  outDir: 'dist',
  format: ['esm', 'cjs'],
  platform: 'browser',
  target: 'es2022',
  clean: true,
  noExternal: [/^@stringbow\/core(\/|$)/],
  external: ['@simplewebauthn/browser'],
  dts: { resolve: [/^@stringbow\/core(\/|$)/] },
  tsconfig: '../../tsconfig.sdk.json',
});
