/** SSRF-safe product auto-fill trigger. */
import { state } from './state.js';
import { apiFetch } from './api.js';

export async function handleAutofill() {
  const urlInput = document.getElementById('input-autofill-url');
  const statusEl = document.getElementById('autofill-status');
  if (!urlInput || !statusEl) return;

  const url = urlInput.value.trim();
  if (!url) {
    statusEl.textContent = 'Please enter a valid product URL.';
    statusEl.style.color = 'var(--berry-700)';
    return;
  }

  statusEl.textContent = '⏳ Safely fetching product details...';
  statusEl.style.color = 'var(--pine-800)';

  try {
    const res = await apiFetch(`/api/families/${state.currentFamilyId}/autofill`, {
      method: 'POST',
      body: JSON.stringify({ url }),
    });

    if (!res || res.status !== 200) {
      const err = await res.json().catch(() => ({}));
      statusEl.textContent = `❌ ${err.error || 'Could not auto-fill. Please enter details manually.'}`;
      statusEl.style.color = 'var(--berry-700)';
      return;
    }

    const data = await res.json();
    if (data.name) document.getElementById('item-name').value = data.name;
    if (data.price_cents) document.getElementById('item-price').value = (data.price_cents / 100).toFixed(2);
    if (data.store_name) document.getElementById('item-store-name').value = data.store_name;
    if (data.image_url) document.getElementById('item-image-url').value = data.image_url;
    document.getElementById('item-store-url').value = url;

    statusEl.textContent = '✅ Auto-fill complete! Review and adjust details below.';
    statusEl.style.color = 'var(--pine-700)';
  } catch (_e) {
    statusEl.textContent = '❌ Auto-fill error. Please fill in details manually.';
    statusEl.style.color = 'var(--berry-700)';
  }
}
