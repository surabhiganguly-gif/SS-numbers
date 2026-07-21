import { getMeta, getAllRawRecords, putRawRecord } from '../db/db.js';
import { isDevEnvironment } from '../crypto/crypto.js';
import { CATEGORY_GROUPS } from '../lib/categories.js';

export function render(container) {
  container.innerHTML = `
    <h1>Settings</h1>

    <h2>Authentication</h2>
    <div class="card" id="auth-info"></div>

    <h2>Backup</h2>
    <div class="card">
      <p class="hint">Your data is encrypted before it's ever written to disk. Export produces the same ciphertext — safe to store anywhere, but only readable by this app with your passkey.</p>
      <button id="export-btn" class="primary">Export encrypted backup</button>
      <div class="actions">
        <label style="flex:1">Import backup file<input type="file" id="import-file" accept="application/json" /></label>
      </div>
    </div>

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

  container.querySelector('#export-btn').addEventListener('click', async () => {
    const records = await getAllRawRecords();
    const credentialId = await getMeta('credentialId');
    const authMethod = await getMeta('authMethod');
    const payload = { version: 1, exportedAt: new Date().toISOString(), authMethod, credentialId, records };
    const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `finance-tracker-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  });

  container.querySelector('#import-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const text = await file.text();
    const payload = JSON.parse(text);
    for (const row of payload.records) {
      await putRawRecord(row);
    }
    alert('Backup imported. Reloading…');
    window.location.reload();
  });
}
