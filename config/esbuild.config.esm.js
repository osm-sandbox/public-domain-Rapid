import esbuild from 'esbuild';

esbuild
  .build({
    minify: true,
    bundle: true,
    sourcemap: false,
    format: 'esm',
    entryPoints: ['./modules/main_esm.js'],
    legalComments: 'none',
    logLevel: 'info',
    outfile: 'dist/rapid.esm.js',
    target: 'esnext'
  })
  .catch(() => process.exit(1));