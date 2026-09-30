const { build } = require('esbuild');
const fs = require('fs');
const vm = require('vm');
const common = { bundle: true, platform: 'browser', target: 'chrome122', minify: true, legalComments: 'eof' };
if (process.env.NODE_ENV === 'production') {
  const config = vm.runInNewContext(fs.readFileSync('config.js', 'utf8') + '\nCONFIG');
  if (!config.CLERK_PUBLISHABLE_KEY?.startsWith('pk_live_') || !config.CLERK_SYNC_HOST?.startsWith('https://') || !config.APP_BASE_URL.startsWith('https://') || !config.API_BASE_URL.startsWith('https://')) {
    throw new Error('Configure live Clerk and HTTPS app/API URLs before a production build.');
  }
}
Promise.all([
  build({ ...common, entryPoints: ['exports.mjs'], outfile: 'dist/exports.js', format: 'esm' }),
  build({ ...common, entryPoints: ['auth.mjs'], outfile: 'dist/auth.js', format: 'iife', globalName: 'NinjaClerk' })
]).catch(() => process.exit(1));
