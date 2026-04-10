// ── storage.js ────────────────────────────────────────────────────────────────
// The I/O Engine: File System Access API + IndexedDB persistence.
// Responsibilities:
//   • Let the user pick (or reuse a persisted) save directory.
//   • Verify / re-request write permission when the page reloads.
//   • Expose ensureAccess() so the recording flow gets a guaranteed-writable
//     directory handle before it creates any files.
//   • Persist the chosen directory handle across sessions via IndexedDB so
//     the user does not have to re-pick the folder on every visit.

// ── IndexedDB helpers (module-private) ───────────────────────────────────────

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('captura-db', 1);
    req.onupgradeneeded = e => e.target.result.createObjectStore('settings');
    req.onsuccess = e => resolve(e.target.result);
    req.onerror   = e => reject(e.target.error);
  });
}

function idbGet(db, key) {
  return new Promise((resolve, reject) => {
    const req = db.transaction('settings', 'readonly').objectStore('settings').get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

function idbPut(db, key, value) {
  return new Promise((resolve, reject) => {
    const req = db.transaction('settings', 'readwrite').objectStore('settings').put(value, key);
    req.onsuccess = () => resolve();
    req.onerror   = () => reject(req.error);
  });
}

// ── Utility ──────────────────────────────────────────────────────────────────

// Returns an ISO-8601-like timestamp safe for use in file names.
export function dateStamp() {
  const parts = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(new Date());

  const byType = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${byType.year}-${byType.month}-${byType.day}T${byType.hour}-${byType.minute}-${byType.second}`;
}

// ── StorageManager ────────────────────────────────────────────────────────────

export class StorageManager {
  #dirHandle = null;
  #idbDb     = null;
  #dirNameEl;
  #onError;  // (title, message) callback — keeps UI coupling out of this module

  constructor(dirNameEl, onError) {
    this.#dirNameEl = dirNameEl;
    this.#onError   = onError;
  }

  // The currently selected (and permitted) directory handle, or null.
  get dirHandle() { return this.#dirHandle; }

  // Opens IndexedDB and restores the previously persisted directory handle.
  // Call once at startup (safe to call even if IndexedDB is unavailable).
  async init() {
    try {
      this.#idbDb  = await openDB();
      const handle = await idbGet(this.#idbDb, 'dir-handle');
      if (handle) { this.#dirHandle = handle; this.#updateDirUI(); }
    } catch (_) {
      // IndexedDB unavailable (e.g. private browsing); proceed without persistence.
    }
  }

  // Shows the directory picker and persists the chosen handle.
  async pickDirectory() {
    try {
      this.#dirHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
      this.#updateDirUI();
      await this.#persistHandle();
      return true;
    } catch (err) {
      if (err.name !== 'AbortError') {
        this.#onError('Erro de pasta', 'Não foi possível selecionar a pasta: ' + err.message);
      }
      return false;
    }
  }

  // Ensures a writable directory is available, prompting if needed.
  // Returns true when the caller may proceed, false when access was denied or
  // the user cancelled the picker.
  async ensureAccess({ mode = 'readwrite', silent = false, requestIfNeeded = true } = {}) {
    if (!this.#dirHandle) {
      try {
        this.#dirHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
        this.#updateDirUI();
        await this.#persistHandle();
      } catch (err) {
        if (!silent && err.name !== 'AbortError') {
          this.#onError('Erro de pasta', 'Não foi possível selecionar a pasta de gravação: ' + err.message);
        }
        return false;
      }
    }

    let perm = await this.#dirHandle.queryPermission({ mode });
    if (perm !== 'granted' && requestIfNeeded) {
      try { perm = await this.#dirHandle.requestPermission({ mode }); }
      catch (_) { perm = 'denied'; }
    }
    if (perm !== 'granted') {
      if (!silent) {
        this.#onError(
          'Permissão negada',
          mode === 'readwrite'
            ? 'A permissão de escrita para a pasta foi negada. Escolha outra pasta usando o botão "Escolher pasta".'
            : 'A permissão de leitura para a pasta selecionada foi negada. Escolha uma pasta que possa ser lida.'
        );
      }
      return false;
    }
    return true;
  }

  async listDirectoryFileHandles() {
    if (!this.#dirHandle) return [];

    const files = [];
    for await (const [name, handle] of this.#dirHandle.entries()) {
      if (handle.kind === 'file') files.push({ name, handle });
    }
    return files.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  }

  async readTextFile(handle) {
    const file = await handle.getFile();
    return file.text();
  }

  async writeTextFile(fileName, contents) {
    if (!this.#dirHandle) throw new Error('Nenhuma pasta selecionada.');
    const fileHandle = await this.#dirHandle.getFileHandle(fileName, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(contents);
    await writable.close();
    return fileHandle;
  }

  // ── Private helpers ──────────────────────────────────────────────────────────

  #updateDirUI() {
    this.#dirNameEl.textContent = this.#dirHandle ? this.#dirHandle.name : '(nenhuma pasta selecionada)';
  }

  async #persistHandle() {
    if (!this.#idbDb) return;
    try { await idbPut(this.#idbDb, 'dir-handle', this.#dirHandle); }
    catch (e) { console.warn('IndexedDB put failed:', e); }
  }
}
