// Packages the extension for the Chrome Web Store: only the files it runs, with production settings.
// The store sees nothing but this zip. Settings come from the environment or .env.local (see .env.example):
//   API_BASE_URL, APP_BASE_URL, CLERK_SYNC_HOST  HTTPS origins (API, web app, Clerk Frontend API)
//   CLERK_PUBLISHABLE_KEY                        the live publishable key (pk_live_…)
//   CHROME_WEB_STORE_PUBLIC_KEY                  the store item's public key (Developer Dashboard > Package)
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { zipSync } = require('fflate');

// Variables already in the environment win over .env.local.
const envFile = path.join(__dirname, '.env.local');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

// The files the extension loads at run time; tests/extension.spec.cjs installs the same set.
const RUNTIME = ['manifest.json', 'background.js', 'session.js', 'store.js', 'xpath.js', 'inspector.js', 'content.js',
  'sidebar.js', 'sidebar.css', 'sidebar.html', 'login.js', 'login.html', 'browser-polyfill.min.js', 'icons', 'fonts', 'dist'];

const setting = name => (process.env[name] || '').trim().replace(/\/+$/, '');
const config = {
  API_BASE_URL: setting('API_BASE_URL'),
  APP_BASE_URL: setting('APP_BASE_URL'),
  CLERK_PUBLISHABLE_KEY: setting('CLERK_PUBLISHABLE_KEY'),
  CLERK_SYNC_HOST: setting('CLERK_SYNC_HOST'),
};
const storeKey = setting('CHROME_WEB_STORE_PUBLIC_KEY');
const problems = [
  ...['API_BASE_URL', 'APP_BASE_URL', 'CLERK_SYNC_HOST'].filter(name => !/^https:\/\/[A-Za-z0-9.-]+(:\d+)?$/.test(config[name])).map(name => `${name} must be an HTTPS origin, with no path.`),
  ...(/^pk_live_[A-Za-z0-9_-]+$/.test(config.CLERK_PUBLISHABLE_KEY) ? [] : ['CLERK_PUBLISHABLE_KEY must be a live publishable key (pk_live_…).']),
  // Shipping the dev key would publish a new identity instead of updating the existing listing.
  ...(/^[A-Za-z0-9+/]{200,}={0,2}$/.test(storeKey) ? [] : ["CHROME_WEB_STORE_PUBLIC_KEY must be the store item's public key."]),
];
if (problems.length) {
  console.error('Cannot package the extension:\n- ' + problems.join('\n- '));
  process.exit(1);
}

execFileSync(process.execPath, [path.join(__dirname, 'build.js')], { cwd: __dirname, stdio: 'inherit' });

const files = {};
function add(relative) {
  const full = path.join(__dirname, relative);
  if (fs.statSync(full).isDirectory()) {
    for (const name of fs.readdirSync(full)) if (!name.startsWith('.')) add(path.join(relative, name));
  } else {
    files[relative.split(path.sep).join('/')] = new Uint8Array(fs.readFileSync(full));
  }
}
RUNTIME.forEach(add);
const manifest = JSON.parse(Buffer.from(files['manifest.json']).toString('utf8'));
manifest.key = storeKey;
files['manifest.json'] = new Uint8Array(Buffer.from(JSON.stringify(manifest, null, 2) + '\n'));
files['config.js'] = new Uint8Array(Buffer.from(`const CONFIG = ${JSON.stringify(config, null, 4)};\n`));

const out = path.join(__dirname, 'release', `qaninja-extension-${manifest.version}.zip`);
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, zipSync(files, { level: 9 }));
console.log(`Packaged ${Object.keys(files).length} files into ${path.relative(__dirname, out)}.`);
