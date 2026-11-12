import { getMeta, setMeta } from '../db/db.js';
import {
  isDevEnvironment,
  encryptWithPassphrase,
  decryptWithPassphrase,
  decryptJSON,
  deriveKeyPRF,
  deriveKeyDev,
} from '../crypto/crypto.js';
import { getState, importRecords } from '../state/store.js';
import { CATEGORY_GROUPS } from '../lib/categories.js';
import { APP_VERSION } from '../lib/version.js';

const MIN_PASSPHRASE_LENGTH = 8;

async function decryptLegacyBackup(payload) {
  const oldKey = payload.authMethod === 'dev' ? await deriveKeyDev() : await deriveKeyPRF(payload.credentialId);
  const records = [];
  for (const row of payload.records) {
    const entity = await decryptJSON(oldKey, row);
    records.push({ ...entity, id: row.id, type: row.type });
  }
  return records;
}

export function render(container) {
  container.innerHTML = `
    <h1>Settings</h1>

    <h2>Authentication</h2>
    <div class="card" id="auth-info"></div>

    <h2>Backup &amp; move to a new phone</h2>
    <div class="card">
      <p class="hint">Your data lives only on this phone, locked to its fingerprint passkey. To move it, export a backup protected by a passphrase you choose, then import it on the new phone. The passphrase can't be recovered if you forget it.</p>
      <label>Passphrase (min ${MIN_PASSPHRASE_LENGTH} characters)<input type="password" id="export-pass" autocomplete="new-password" /></label>
      <label>Confirm passphrase<input type="password" id="export-pass2" autocomplete="new-password" /></label>
      <div class="actions"><button id="export-btn" class="primary">Create backup</button></div>
      <div id="export-status" class="hint"></div>
      <div id="export-ready" class="actions" style="display:none">
        <button id="share-btn" class="primary">Save to Drive / share</button>
        <button id="download-btn">Download file</button>
      </div>
      <p class="hint">"Save to Drive / share" opens your phone's share sheet — pick Google Drive there. The file is encrypted with your passphrase, so Drive only ever holds scrambled data.</p>
    </div>

    <div class="card">
      <label>Backup file<input type="file" id="import-file" /></label>
      <label>Passphrase (only for backups exported with one)<input type="password" id="import-pass" autocomplete="off" /></label>
      <div class="actions"><button id="import-btn">Import backup</button></div>
      <div id="import-status" class="hint"></div>
      <p class="hint">Importing adds or updates records from the file; it never deletes what's already here.</p>
    </div>

    <h2>About</h2>
    <div class="card"><div class="row"><span>App version</span><span id="app-version">${APP_VERSION}</span></div></div>

    <h2>Category taxonomy</h2>
    <div class="card">
      ${Object.values(CATEGORY_GROUPS)
        .filter((g) => g.categories.length > 0)
        .map((g) => `<div><strong>${g.label}</strong><div class="hint">${g.categories.join(', ')}</div></div>`)
        .join('<br/>')}
    </div>
  `;

  getMeta('authMethod').then((authMethod) => {
    container.querySelector('#auth-info').innerHTML =
      authMethod === 'prf'
        ? '<div class="pill success">Biometric passkey (WebAuthn PRF)</div>'
        : isDevEnvironment()
        ? '<div class="pill warning">Dev bypass (localhost only — not real auth)</div>'
        : '<div class="hint">Not set up.</div>';
  });

  let backupFile = null;

  function setStatus(selector, message, kind) {
    const el = container.querySelector(selector);
    el.textContent = message;
    el.className = `hint${kind ? ' ' + kind : ''}`;
  }

  container.querySelector('#export-btn').addEventListener('click', async () => {
    const pass = container.querySelector('#export-pass').value;
    const pass2 = container.querySelector('#export-pass2').value;
    if (pass.length < MIN_PASSPHRASE_LENGTH) {
      setStatus('#export-status', `Passphrase must be at least ${MIN_PASSPHRASE_LENGTH} characters.`, 'error');
      return;
    }
    if (pass !== pass2) {
      setStatus('#export-status', "Passphrases don't match.", 'error');
      return;
    }
    try {
      container.querySelector('#export-ready').style.display = 'none';
      setStatus('#export-status', 'Encrypting… this takes a few seconds.');
      const records = Object.entries(getState().collections).flatMap(([type, items]) =>
        items.map((entity) => ({ ...entity, type }))
      );
      const encrypted = await encryptWithPassphrase(pass, { exportedAt: new Date().toISOString(), records });
      const payload = { app: 'finance-tracker', version: 2, ...encrypted };
      backupFile = new File([JSON.stringify(payload)], `finance-tracker-backup-${new Date().toISOString().slice(0, 10)}.json`, {
        type: 'application/json',
      });
      container.querySelector('#export-ready').style.display = 'flex';
      setStatus('#export-status', `Backup ready (${records.length} records). Now save it to Drive, or download it.`, 'success');
    } catch (err) {
      setStatus('#export-status', `Export failed: ${err.message}`, 'error');
    }
  });

  async function markBackedUp() {
    await setMeta('lastBackupAt', new Date().toISOString());
  }

  container.querySelector('#share-btn').addEventListener('click', async () => {
    if (!backupFile) return;
    if (!(navigator.canShare && navigator.canShare({ files: [backupFile] }))) {
      setStatus('#export-status', "This browser can't share files. Use \"Download file\", then upload it to Drive yourself.", 'error');
      return;
    }
    try {
      await navigator.share({ files: [backupFile], title: 'Finance Tracker backup' });
      await markBackedUp();
      setStatus('#export-status', `Shared as ${backupFile.name}. If you picked Drive, it's in My Drive — search "finance-tracker-backup".`, 'success');
    } catch (err) {
      if (err.name === 'AbortError') setStatus('#export-status', 'Share cancelled — nothing was saved.');
      else setStatus('#export-status', `Share failed: ${err.message}`, 'error');
    }
  });

  container.querySelector('#download-btn').addEventListener('click', async () => {
    if (!backupFile) return;
    const url = URL.createObjectURL(backupFile);
    const a = document.createElement('a');
    a.href = url;
    a.download = backupFile.name;
    a.click();
    URL.revokeObjectURL(url);
    await markBackedUp();
    setStatus('#export-status', `Downloaded ${backupFile.name} — check your Downloads folder, then upload it to Drive.`, 'success');
  });

  container.querySelector('#import-btn').addEventListener('click', async () => {
    const file = container.querySelector('#import-file').files[0];
    const pass = container.querySelector('#import-pass').value;
    if (!file) {
      setStatus('#import-status', 'Choose a backup file first.', 'error');
      return;
    }
    try {
      const payload = JSON.parse(await file.text());
      let records;

      if (payload.version === 1 && Array.isArray(payload.records)) {
        // Older backup: rows are locked with the original passkey's key, not a
        // passphrase. Decrypt everything first so a failure writes nothing.
        setStatus('#import-status', 'Confirm with your fingerprint to open the old backup…');
        try {
          records = await decryptLegacyBackup(payload);
        } catch {
          setStatus(
            '#import-status',
            "Couldn't open this backup. It can only be opened by the same passkey it was made with — if that passkey isn't on this phone, it can't be recovered.",
            'error'
          );
          return;
        }
      } else if (payload.version === 2 && payload.ciphertext) {
        if (!pass) {
          setStatus('#import-status', 'Enter the backup passphrase.', 'error');
          return;
        }
        setStatus('#import-status', 'Decrypting… this takes a few seconds.');
        try {
          records = (await decryptWithPassphrase(pass, payload)).records;
        } catch {
          setStatus('#import-status', 'Wrong passphrase, or the file is damaged.', 'error');
          return;
        }
      } else {
        setStatus('#import-status', "This doesn't look like a backup file from this app.", 'error');
        return;
      }

      const count = await importRecords(records);
      setStatus('#import-status', `Imported ${count} records. Everything is now on this phone.`, 'success');
    } catch (err) {
      setStatus('#import-status', `Import failed: ${err.message}`, 'error');
    }
  });
}
