// Runs only in the service worker. Tokens stay in memory and trusted extension pages.
let authState = { signedIn: false, subject: null, sessionId: null, epoch: null };
let authRefresh = null;
let authGeneration = 0;
const authReady = (async () => {
  // Credentials live in extension IndexedDB, never here. Also limit metadata access where supported.
  await chrome.storage.local.setAccessLevel?.({ accessLevel: 'TRUSTED_CONTEXTS' });
  await chrome.storage.sync.setAccessLevel?.({ accessLevel: 'TRUSTED_CONTEXTS' });
  const stored = await chrome.storage.local.get(['auth_state', 'auth_version']);
  if (stored.auth_version === 1 && stored.auth_state) authState = stored.auth_state;
  else await chrome.storage.local.remove(['capabilities', 'finder_quota']);
  await chrome.storage.local.remove(['ninja_token', 'ninja_plan']);
  await chrome.storage.sync.remove(['ninja_token', 'ninja_plan', 'isRecording', 'session_id']);
  await chrome.storage.local.set({ auth_version: 1 });
})();
const sameAuth = snapshot => snapshot?.epoch === authState.epoch && snapshot?.subject === authState.subject;
const changedAccount = () => Object.assign(new Error('The account changed. Your draft is preserved; retry with its original account.'), { status: 409 });

async function applyAuth(session) {
  if ((session?.subject || null) === authState.subject && (session?.sessionId || null) === authState.sessionId) return;
  const generation = ++authGeneration;
  await serialized(async () => {
    if (generation !== authGeneration) return;
    if ((session?.subject || null) === authState.subject && (session?.sessionId || null) === authState.sessionId) return;
    try { await pause(); } catch (error) { emit({ event: 'error', message: error.message }); }
    if (generation !== authGeneration) return;
    authState = { signedIn: !!session, subject: session?.subject || null, sessionId: session?.sessionId || null, epoch: crypto.randomUUID() };
    await chrome.storage.local.remove(['capabilities', 'finder_quota']);
    await chrome.storage.local.set({ auth_state: authState });
    emit({ event: 'auth', auth: authState });
    emit({ event: 'quota', quota: deviceQuota((await chrome.storage.local.get('finder_usage')).finder_usage) });
  });
}

async function refreshAuth(fresh = false) {
  if (authRefresh && !fresh) return authRefresh;
  // Queue forced refreshes too: older Clerk responses must never overwrite a newer identity.
  const task = (authRefresh ? authRefresh.catch(() => {}) : Promise.resolve()).then(async () => {
    await authReady;
    const generation = authGeneration;
    const session = await NinjaClerk.getSession(CONFIG, fresh);
    if (generation !== authGeneration) throw changedAccount();
    await applyAuth(session);
    if ((session?.subject || null) !== authState.subject || (session?.sessionId || null) !== authState.sessionId) throw changedAccount();
    return { ...authState, token: session?.token || null };
  });
  authRefresh = task;
  try { return await task; } finally { if (authRefresh === task) authRefresh = null; }
}

async function api(endpoint, method = 'GET', body, session) {
  const initial = session || await refreshAuth();
  if (!initial.token) throw Object.assign(new Error('Sign in to continue.'), { status: 401 });
  const send = async current => {
    if (!sameAuth(initial) || !sameAuth(current)) throw changedAccount();
    return fetch(CONFIG.API_BASE_URL + endpoint, {
      method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${current.token}` },
      ...(body ? { body: JSON.stringify(body) } : {})
    }).catch(() => { throw Object.assign(new Error("Can't reach QA Ninja. Check your connection and try again."), { status: 503 }); });
  };
  let response = await send(initial);
  if (response.status === 401) response = await send(await refreshAuth(true));
  const data = await response.json().catch(() => ({}));
  if (!sameAuth(initial)) throw changedAccount();
  if (!response.ok) {
    if (response.status === 401) await applyAuth(null);
    throw Object.assign(new Error(typeof data.detail === 'string' ? data.detail : `Request failed (${response.status}).`), { status: response.status });
  }
  return data;
}

async function capabilities(refresh = false) {
  await authReady;
  const { capabilities: cached } = await chrome.storage.local.get('capabilities');
  const usable = () => authState.signedIn && sameAuth(cached) && cached.valid_until * 1000 > Date.now();
  try {
    const session = await refreshAuth();
    if (!session.signedIn) return { recording: false, signedIn: false };
    if (!refresh && usable()) return cached;
    const result = await api('/me/capabilities', 'GET', undefined, session);
    if (!sameAuth(session)) throw changedAccount();
    const current = { ...result, subject: session.subject, epoch: session.epoch, signedIn: true };
    await chrome.storage.local.set({ capabilities: current });
    return current;
  } catch (error) {
    if ((!error.status || error.status >= 500) && usable()) return { ...cached, offline: true };
    if (error.status === 401) await chrome.storage.local.remove('capabilities');
    throw error;
  }
}

async function uploadToken(ownerId, ownerSubject, fresh = false) {
  const session = await refreshAuth(fresh);
  if (!session.signedIn) throw Object.assign(new Error('Log in to save to your dashboard.'), { status: 401 });
  if (session.subject !== ownerSubject) throw changedAccount();
  const caps = await api('/me/capabilities', 'GET', undefined, session);
  if (caps.user_id !== ownerId || !sameAuth(session)) throw changedAccount();
  if (!caps.cloud_save) throw Object.assign(new Error('An active paid plan is required to save to your dashboard.'), { status: 403 });
  return { token: session.token, subject: session.subject, epoch: session.epoch };
}
