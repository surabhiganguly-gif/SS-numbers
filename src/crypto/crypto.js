// Encryption-key derivation. WebAuthn PRF is the only real auth path (Android
// biometric passkey). The dev bypass exists solely so this app is testable in
// a desktop browser during development, and is hard-gated to localhost so it
// can never be reached on the deployed origin.

const PRF_SALT = new TextEncoder().encode('personal-finance-tracker-prf-v1');

export function isDevEnvironment() {
  return ['localhost', '127.0.0.1'].includes(location.hostname);
}

export function isPRFLikelySupported() {
  return typeof window.PublicKeyCredential !== 'undefined' && !!navigator.credentials;
}

async function importAesKey(rawBits) {
  return crypto.subtle.importKey('raw', rawBits, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

// --- Real path: WebAuthn PRF ---

export async function registerPasskey() {
  const challenge = crypto.getRandomValues(new Uint8Array(32));
  const userId = crypto.getRandomValues(new Uint8Array(16));

  const credential = await navigator.credentials.create({
    publicKey: {
      challenge,
      rp: { name: 'Personal Finance Tracker' },
      user: { id: userId, name: 'owner', displayName: 'Owner' },
      pubKeyCredParams: [
        { type: 'public-key', alg: -7 }, // ES256
        { type: 'public-key', alg: -257 }, // RS256
      ],
      authenticatorSelection: {
        authenticatorAttachment: 'platform',
        userVerification: 'required',
        residentKey: 'required',
      },
      extensions: { prf: {} },
      timeout: 60000,
    },
  });

  const prfResult = credential.getClientExtensionResults()?.prf;
  if (!prfResult?.enabled) {
    throw new Error('This device/browser does not support the WebAuthn PRF extension.');
  }

  const credentialId = bufferToBase64(credential.rawId);
  return { credentialId };
}

export async function deriveKeyPRF(credentialId) {
  const challenge = crypto.getRandomValues(new Uint8Array(32));
  const assertion = await navigator.credentials.get({
    publicKey: {
      challenge,
      allowCredentials: [{ id: base64ToBuffer(credentialId), type: 'public-key' }],
      userVerification: 'required',
      extensions: { prf: { eval: { first: PRF_SALT } } },
      timeout: 60000,
    },
  });

  const prfResult = assertion.getClientExtensionResults()?.prf;
  const prfOutput = prfResult?.results?.first;
  if (!prfOutput) {
    throw new Error('PRF extension did not return output — biometric unlock failed.');
  }

  const keyMaterial = await crypto.subtle.digest('SHA-256', prfOutput);
  return importAesKey(keyMaterial);
}

// --- Dev-only bypass (localhost) ---

const DEV_FIXED_SECRET = new TextEncoder().encode('dev-only-not-secure-do-not-ship');

export async function deriveKeyDev() {
  if (!isDevEnvironment()) {
    throw new Error('Dev key derivation is not available outside localhost.');
  }
  const keyMaterial = await crypto.subtle.digest('SHA-256', DEV_FIXED_SECRET);
  return importAesKey(keyMaterial);
}

// --- Row encryption helpers (used by the db layer) ---

export async function encryptJSON(key, obj) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(obj));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);
  return { iv: bufferToBase64(iv), ciphertext: bufferToBase64(ciphertext) };
}

export async function decryptJSON(key, { iv, ciphertext }) {
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: base64ToBuffer(iv) },
    key,
    base64ToBuffer(ciphertext)
  );
  return JSON.parse(new TextDecoder().decode(plaintext));
}

function bufferToBase64(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)));
}

function base64ToBuffer(b64) {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)).buffer;
}
