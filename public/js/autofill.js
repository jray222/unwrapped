/** SSRF-safe product auto-fill trigger. */
import { state } from './state.js';
import { apiFetch } from './api.js';

function setStatus(el, text, kind) {
  el.textContent = text;
  el.className = `autofill-status ${kind ? `is-${kind}` : ''}`.trim();
}

export async function handleAutofill() {
  const urlInput = document.getElementById('input-autofill-url');
  const statusEl = document.getElementById('autofill-status');
  if (!urlInput || !statusEl) return;

  const url = urlInput.value.trim();
  if (!url) {
    setStatus(statusEl, 'Please enter a valid product link.', 'error');
    return;
  }

  setStatus(statusEl, 'Fetching product details...', '');

  try {
    const res = await apiFetch(`/api/families/${state.currentFamilyId}/autofill`, {
      method: 'POST',
      body: JSON.stringify({ url, fetchImage: true }),
    });

    if (!res || res.status !== 200) {
      const err = await res.json().catch(() => ({}));
      setStatus(statusEl, err.error || 'Could not fill in details. Please enter them by hand.', 'error');
      return;
    }

    const data = await res.json();
    if (data.name) document.getElementById('item-name').value = data.name;
    if (data.price_cents) document.getElementById('item-price').value = (data.price_cents / 100).toFixed(2);
    if (data.store_name) document.getElementById('item-store-name').value = data.store_name;
    if (data.image_url) document.getElementById('item-image-url').value = data.image_url;
    document.getElementById('item-store-url').value = url;

    setStatus(statusEl, 'Details filled in. Review them below.', 'ok');
  } catch (_e) {
    setStatus(statusEl, 'Could not fill in details. Please enter them by hand.', 'error');
  }
}
