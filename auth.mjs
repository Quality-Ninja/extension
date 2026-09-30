import { createClerkClient } from '@clerk/chrome-extension/client';

// Extension-origin IndexedDB is separate from content scripts' page-origin databases.
// Unlike chrome.storage.local, it remains private on older supported Chrome versions too.
const storageCache = {
  createKey: (...parts) => ['clerk', ...parts].filter(Boolean).join('|'),
  get: async key => (await NinjaStore.get('settings', key)) || undefined,
  set: (key, value) => NinjaStore.put('settings', value, key),
  remove: key => NinjaStore.put('settings', null, key)
};

async function client(config) {
  return createClerkClient({ background: true, publishableKey: config.CLERK_PUBLISHABLE_KEY, syncHost: config.CLERK_SYNC_HOST, storageCache });
}

export async function getSession(config, fresh = false) {
  if (!config.CLERK_PUBLISHABLE_KEY) return null;
  try {
    const clerk = await client(config);
    if (!clerk.session || !clerk.user || clerk.session.status !== 'active') return null;
    const token = await clerk.session.getToken({ skipCache: fresh });
    if (!token) return null;
    return { subject: clerk.user.id, sessionId: clerk.session.id, token };
  } catch (error) {
    if ([401, 403].includes(error.status)) return null;
    throw Object.assign(new Error("Can't refresh sign-in. Check your connection and try again."), { status: 503 });
  }
}

export async function signOut(config) {
  if (config.CLERK_PUBLISHABLE_KEY) await (await client(config)).signOut();
}
