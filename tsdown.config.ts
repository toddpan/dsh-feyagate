import type { UserConfig } from 'tsdown'

const PLUGIN_ID = '@dsh-external/dsh-feyagate-gateway'

/**
 * Modules the web frontend seeds into `window.__ModuleLoader__` for every
 * plugin bundle. Only these may be left as bare `require(...)` calls; anything
 * else must be bundled in, or the factory throws at load time.
 *
 * The list matches the frontend's static module table (verified against the
 * shipped `dsh-web-frontend` bundle). Note that dynamic Cordis Package-only
 * globals (`styles`, `host`, `harness`) are NOT available to bundle plugins.
 */
const CLIENT_EXTERNALS = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
]

const clientBundle: UserConfig = {
  entry: { client: 'src/client/index.tsx' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  dts: false,
  sourcemap: true,
  clean: false,
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
  },
  deps: {
    neverBundle: [...CLIENT_EXTERNALS],
    alwaysBundle: (id: string) => !CLIENT_EXTERNALS.includes(id),
  },
  outputOptions: {
    // The lazy-CJS contract every browser half must satisfy: the platform
    // calls this factory with `require` and keeps the returned exports.
    entryFileNames: 'client.js',
    banner: 'window.__ModuleLoader__.load({ id: ' + JSON.stringify(PLUGIN_ID) + ', factory: (require) => {',
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
    codeSplitting: false,
  },
}

export default [clientBundle] satisfies UserConfig[]
