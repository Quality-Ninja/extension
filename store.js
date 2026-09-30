/* Durable recording data shared by the worker and extension pages. */
(() => {
  let opening;
  function open() {
    if (!opening) opening = new Promise((resolve, reject) => {
      const req = indexedDB.open('qaninja', 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore('drafts', { keyPath: 'id' });
        req.result.createObjectStore('steps', { keyPath: 'id' }).createIndex('recording', 'recordingId');
        req.result.createObjectStore('settings');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return opening;
  }
  async function transaction(names, mode, run) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(names, mode);
      let value;
      tx.oncomplete = () => resolve(value);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('Local storage transaction was interrupted.'));
      run(tx, result => { value = result; });
    });
  }
  const get = (table, key) => transaction([table], 'readonly', (tx, done) => {
    tx.objectStore(table).get(key).onsuccess = e => done(e.target.result);
  });
  const put = (table, value, key) => transaction([table], 'readwrite', tx => tx.objectStore(table).put(value, key));
  async function append(recordingId, step) {
    return transaction(['drafts', 'steps'], 'readwrite', (tx, done) => {
      const drafts = tx.objectStore('drafts'), steps = tx.objectStore('steps');
      steps.get(step.id).onsuccess = found => {
        if (found.target.result) { done(found.target.result); return; }
        drafts.get(recordingId).onsuccess = e => {
          const draft = e.target.result;
          if (!draft || !['recording', 'pausing', 'finishing'].includes(draft.status)) { tx.abort(); return; }
          const sequence = (draft.sequence || 0) + 1;
          const saved = { ...step, recordingId, sequence };
          steps.put(saved); drafts.put({ ...draft, sequence }); done(saved);
        };
      };
    });
  }
  const steps = recordingId => transaction(['steps'], 'readonly', (tx, done) => {
    tx.objectStore('steps').index('recording').getAll(recordingId).onsuccess = e => done(e.target.result.sort((a, b) => a.sequence - b.sequence));
  });
  const list = () => transaction(['drafts'], 'readonly', (tx, done) => {
    tx.objectStore('drafts').getAll().onsuccess = e => done(e.target.result.sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
  });
  const remove = recordingId => transaction(['drafts', 'steps'], 'readwrite', tx => {
    tx.objectStore('drafts').delete(recordingId);
    const req = tx.objectStore('steps').index('recording').openCursor(recordingId);
    req.onsuccess = () => { const cursor = req.result; if (cursor) { cursor.delete(); cursor.continue(); } };
  });
  globalThis.NinjaStore = { get, put, append, steps, list, remove };
})();
