// Saved.js — each user's last state, kept in this browser (IndexedDB), restored on the next visit.
// Keys: 'state' (collectState JSON), 'mask' (full-precision mask snapshot), 'image' (the picture
// as a Blob, absent for the default duck). Every call fails quietly: no storage, no restore.

const DB = 'orbipix', STORE = 'kv';
let dbp = null;
function db() {
  if (!dbp) dbp = new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return dbp;
}
async function tx(mode, fn) {
  const d = await db();
  return new Promise((res, rej) => {
    const t = d.transaction(STORE, mode), st = t.objectStore(STORE);
    const r = fn(st);
    t.oncomplete = () => res(r && 'result' in r ? r.result : undefined);
    t.onerror = () => rej(t.error);
  });
}
export const get = key => tx('readonly', st => st.get(key)).catch(() => undefined);
export const set = (key, v) => tx('readwrite', st => st.put(v, key)).catch(() => {});
export const del = key => tx('readwrite', st => st.delete(key)).catch(() => {});
