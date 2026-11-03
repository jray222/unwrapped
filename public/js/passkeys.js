/** Base64URL helpers, WebAuthn passkeys, and TOTP enrollment. */
import { state } from './state.js';
import { apiFetch } from './api.js';
import { openModal, showToast } from './ui.js';
import { checkCurrentSession, initUserInterface } from './session.js';

export function bufferToBase64URL(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export function base64URLToBuffer(base64url) {
  let base64 = base64url.replace(/-/g, '+').replace(/_/g, '/');
  while (base64.length % 4) {
    base64 += '=';
  }
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

export async function handlePasskeyLogin() {
  if (!window.PublicKeyCredential) {
    showToast('Passkeys are not supported on this browser.');
    return;
  }

  try {
    const optRes = await apiFetch('/api/auth/passkey/login-options', { method: 'POST' });
    if (!optRes || optRes.status !== 200) {
      showToast('Could not retrieve passkey options.');
      return;
    }
    const options = await optRes.json();

    // Decode challenge and credentials
    options.challenge = base64URLToBuffer(options.challenge);
    if (options.allowCredentials) {
      options.allowCredentials.forEach((c) => {
        c.id = base64URLToBuffer(c.id);
      });
    }

    const assertion = await navigator.credentials.get({ publicKey: options });
    if (!assertion) return;

    const payload = {
      id: assertion.id,
      rawId: bufferToBase64URL(assertion.rawId),
      type: assertion.type,
      response: {
        clientDataJSON: bufferToBase64URL(assertion.response.clientDataJSON),
        authenticatorData: bufferToBase64URL(assertion.response.authenticatorData),
        signature: bufferToBase64URL(assertion.response.signature),
        userHandle: assertion.response.userHandle ? bufferToBase64URL(assertion.response.userHandle) : null,
      },
    };

    const verifyRes = await apiFetch('/api/auth/passkey/login-verify', {
      method: 'POST',
      body: JSON.stringify(payload),
    });

    if (verifyRes && verifyRes.status === 200) {
      const userRes = await verifyRes.json();
      state.sessionKind = 'user';
      state.currentUser = userRes.user;
      state.csrfToken = userRes.csrfToken || '';
      state.memberships = userRes.memberships || [];
      showToast(`Welcome back, ${userRes.user.first_name}!`);
      initUserInterface();
    } else {
      showToast('Passkey verification failed. Please try again.');
    }
  } catch (err) {
    if (err.name !== 'NotAllowedError') {
      showToast('Passkey sign-in cancelled or failed.');
    }
  }
}

export async function handlePasskeyRegister(deviceName = 'My Device') {
  if (!window.PublicKeyCredential) {
    showToast('Passkeys are not supported on this browser. Opening Authenticator App setup...');
    startTotpEnrollment();
    return;
  }

  try {
    const optRes = await apiFetch('/api/auth/mfa/passkey/register-options', { method: 'POST' });
    if (!optRes || !optRes.ok) {
      startTotpEnrollment();
      return;
    }
    const options = await optRes.json();

    options.challenge = base64URLToBuffer(options.challenge);
    options.user.id = base64URLToBuffer(options.user.id);
    if (options.excludeCredentials) {
      options.excludeCredentials.forEach((c) => {
        c.id = base64URLToBuffer(c.id);
      });
    }

    const credential = await navigator.credentials.create({ publicKey: options });
    if (!credential) return;

    const payload = {
      credentialId: credential.id,
      publicKey: bufferToBase64URL(credential.rawId),
      deviceName,
      attestationResponse: {
        id: credential.id,
        rawId: bufferToBase64URL(credential.rawId),
        type: credential.type,
        response: {
          clientDataJSON: bufferToBase64URL(credential.response.clientDataJSON),
          attestationObject: bufferToBase64URL(credential.response.attestationObject),
        },
      },
    };

    const verifyRes = await apiFetch('/api/auth/mfa/passkey/register-verify', {
      method: 'POST',
      body: JSON.stringify(payload),
    });

    if (verifyRes && verifyRes.ok) {
      showToast('🎉 Passkey successfully set up! You can now sign in with 1 tap.');
      checkCurrentSession();
    } else {
      startTotpEnrollment();
    }
  } catch (_e) {
    showToast('Passkey enrollment cancelled or error occurred.');
  }
}

export async function startTotpEnrollment() {
  try {
    const res = await apiFetch('/api/auth/mfa/totp/setup', { method: 'POST' });
    if (!res || !res.ok) {
      showToast('Could not initialize 2FA setup.');
      return;
    }
    const data = await res.json();
    const qrImg = document.getElementById('totp-qr-img');
    const secretInput = document.getElementById('totp-secret-text');
    const step1 = document.getElementById('totp-setup-step-1');
    const step2 = document.getElementById('totp-setup-step-2');

    if (qrImg) qrImg.src = data.qrCodeDataUrl;
    if (secretInput) secretInput.value = data.secret;
    if (step1) step1.style.display = 'block';
    if (step2) step2.style.display = 'none';

    openModal('modal-totp-enrollment');
  } catch (_e) {
    showToast('Error setting up 2FA.');
  }
}
