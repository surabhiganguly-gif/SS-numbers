import { getMeta, setMeta } from '../db/db.js';
import { registerPasskey, deriveKeyPRF, deriveKeyDev, isDevEnvironment } from '../crypto/crypto.js';
import { unlockWith } from '../state/store.js';
import { navigate } from '../router.js';

export function render(container) {
  container.innerHTML = `
    <div class="auth-screen">
      <h1>Personal Finance Tracker</h1>
      <div id="auth-status" class="auth-status"></div>
      <div id="auth-actions"></div>
    </div>
  `;
  const statusEl = container.querySelector('#auth-status');
  const actionsEl = container.querySelector('#auth-actions');

  function setStatus(msg, isError) {
    statusEl.textContent = msg;
    statusEl.className = 'auth-status' + (isError ? ' error' : '');
  }

  async function boot() {
    const authMethod = await getMeta('authMethod');

    if (!authMethod) {
      if (isDevEnvironment()) {
        renderDevSetup();
      } else {
        renderPasskeySetup();
      }
      return;
    }

    if (authMethod === 'dev') {
      renderDevUnlock();
    } else if (authMethod === 'prf') {
      renderPasskeyUnlock();
    }
  }

  function renderDevSetup() {
    actionsEl.innerHTML = `
      <p class="hint">Running on localhost — using the dev bypass instead of real biometric auth. This path is disabled on the deployed app.</p>
      <button id="dev-continue" class="primary">Continue (dev)</button>
    `;
    actionsEl.querySelector('#dev-continue').addEventListener('click', async () => {
      try {
        await setMeta('authMethod', 'dev');
        const key = await deriveKeyDev();
        await unlockWith(key);
        navigate('/');
      } catch (e) {
        setStatus(e.message, true);
      }
    });
  }

  function renderDevUnlock() {
    actionsEl.innerHTML = `<button id="dev-continue" class="primary">Continue (dev)</button>`;
    actionsEl.querySelector('#dev-continue').addEventListener('click', async () => {
      try {
        const key = await deriveKeyDev();
        await unlockWith(key);
        navigate('/');
      } catch (e) {
        setStatus(e.message, true);
      }
    });
  }

  function renderPasskeySetup() {
    actionsEl.innerHTML = `
      <p class="hint">Set up biometric lock to encrypt your data. This uses your device's fingerprint/face unlock via a passkey — nothing leaves your device.</p>
      <button id="register" class="primary">Set up biometric lock</button>
    `;
    actionsEl.querySelector('#register').addEventListener('click', async () => {
      setStatus('Follow the biometric prompt…');
      try {
        const { credentialId } = await registerPasskey();
        await setMeta('credentialId', credentialId);
        await setMeta('authMethod', 'prf');
        const key = await deriveKeyPRF(credentialId);
        await unlockWith(key);
        navigate('/');
      } catch (e) {
        setStatus(e.message, true);
      }
    });
  }

  function renderPasskeyUnlock() {
    actionsEl.innerHTML = `<button id="unlock" class="primary">Unlock with biometric</button>`;
    actionsEl.querySelector('#unlock').addEventListener('click', async () => {
      setStatus('Follow the biometric prompt…');
      try {
        const credentialId = await getMeta('credentialId');
        const key = await deriveKeyPRF(credentialId);
        await unlockWith(key);
        navigate('/');
      } catch (e) {
        setStatus(e.message, true);
      }
    });
  }

  boot();
}
