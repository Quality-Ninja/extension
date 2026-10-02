// Run secrets (passwords, one-time codes) stay in this browser. Remembered ones are encrypted with a non-extractable
// AES-GCM key kept in IndexedDB, scoped to the signed-in account and the test, and wiped when the account changes.
// Their values are never sent to QA Ninja or to any model; the agent only ever sees their names.
const KEY = 'secrets_key';

async function cryptoKey() {
  let key = await NinjaStore.get('settings', KEY);
  if (!key) {
    key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    await NinjaStore.put('settings', key, KEY);
  }
  return key;
}

const id = (subject, testId, name) => `${subject}|${testId}|${name}`;

export const vault = {
  async remember(subject, testId, name, value) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await cryptoKey(), new TextEncoder().encode(value));
    await NinjaStore.put('secrets', { id: id(subject, testId, name), scope: subject, testId: String(testId), name, iv, data, savedAt: Date.now() });
  },
  async recall(subject, testId, name) {
    const entry = await NinjaStore.get('secrets', id(subject, testId, name));
    if (!entry) return null;
    try { return new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: entry.iv }, await cryptoKey(), entry.data)); }
    catch { return null; }
  },
  async names(subject, testId) {
    return (await NinjaStore.all('secrets')).filter(entry => entry.scope === subject && entry.testId === String(testId)).map(entry => entry.name);
  },
  async forget(subject, testId) {
    for (const entry of await NinjaStore.all('secrets')) {
      if (entry.scope === subject && (testId === undefined || entry.testId === String(testId))) await NinjaStore.del('secrets', entry.id);
    }
  },
  // Called when the account changes: secrets belong to the account that saved them.
  async keepOnly(subject) {
    for (const entry of await NinjaStore.all('secrets')) if (entry.scope !== subject) await NinjaStore.del('secrets', entry.id);
  },
};

// Replaces any secret value typed during a run with its name, in every form it might be echoed in.
export function redactor(values) {
  const forms = [];
  for (const [name, value] of values) {
    if (!value || value.length < 3) continue;
    for (const form of new Set([value, encodeURIComponent(value), JSON.stringify(value).slice(1, -1)])) forms.push([form, `<secret:${name}>`]);
  }
  forms.sort((a, b) => b[0].length - a[0].length);
  return text => {
    let result = String(text ?? '');
    for (const [form, label] of forms) result = result.split(form).join(label);
    return result;
  };
}
