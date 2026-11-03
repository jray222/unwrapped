/** Item card rendering. */
import { state } from './state.js';
import { openModal } from './ui.js';
import { handleClaimItem, handleReleaseClaim } from './gifts.js';

export function createItemCard(item, { isTaken, isSurpriseProtected }) {
  const card = document.createElement('article');
  card.className = `item-card ${item.priority === 'really_want' ? 'card-featured' : ''}`;

  // Image
  const imgWrapper = document.createElement('div');
  imgWrapper.className = 'item-image-wrapper';
  if (item.image_url) {
    const img = document.createElement('img');
    img.src = item.image_url;
    img.alt = item.name;
    img.className = 'item-image';
    img.loading = 'lazy';
    img.onerror = () => {
      imgWrapper.innerHTML = '<span class="item-image-placeholder" aria-hidden="true">🎁</span>';
    };
    imgWrapper.appendChild(img);
  } else {
    imgWrapper.innerHTML = '<span class="item-image-placeholder" aria-hidden="true">🎁</span>';
  }
  card.appendChild(imgWrapper);

  // Details
  const details = document.createElement('div');
  details.className = 'item-details';

  const header = document.createElement('div');
  header.className = 'item-header';

  const title = document.createElement('h3');
  title.className = 'item-name';
  title.textContent = item.name;
  header.appendChild(title);
  details.appendChild(header);

  // Badges
  const badges = document.createElement('div');
  badges.className = 'item-badges';

  if (item.priority === 'really_want') {
    const pBadge = document.createElement('span');
    pBadge.className = 'badge badge-really-want';
    pBadge.textContent = '⭐ Really Want';
    badges.appendChild(pBadge);
  }

  if (item.allow_duplicates) {
    const dBadge = document.createElement('span');
    dBadge.className = 'badge badge-nice-to-have';
    dBadge.textContent = 'Duplicates Welcome';
    badges.appendChild(dBadge);
  }

  if (isTaken && item.taken_label) {
    const tBadge = document.createElement('span');
    tBadge.className = 'badge badge-taken';
    tBadge.textContent = `🎁 ${item.taken_label}`;
    badges.appendChild(tBadge);
  }

  details.appendChild(badges);

  // Meta (Price & Store)
  const meta = document.createElement('div');
  meta.className = 'item-meta';
  const priceStr = item.price_cents ? `$${(item.price_cents / 100).toFixed(2)}` : '';
  const storeStr = item.store_name || (item.store_url ? 'Online Store' : '');
  meta.textContent = [priceStr, storeStr].filter(Boolean).join(' • ');
  details.appendChild(meta);

  // Notes
  if (item.notes) {
    const notes = document.createElement('div');
    notes.className = 'item-notes';
    notes.textContent = item.notes;
    details.appendChild(notes);
  }

  // Group Gift Pledge Progress Bar (Only visible if not surprise-protected and pledges exist)
  if (!isSurpriseProtected && item.price_cents && (item.total_pledged_cents > 0 || (item.pledges && item.pledges.length > 0))) {
    const pledgeBox = document.createElement('div');
    pledgeBox.className = 'pledge-bar-container';

    const track = document.createElement('div');
    track.className = 'pledge-progress-track';

    const fill = document.createElement('div');
    fill.className = 'pledge-progress-fill';
    fill.style.width = `${Math.min(100, item.pledge_progress_percent || 0)}%`;
    track.appendChild(fill);
    pledgeBox.appendChild(track);

    const stats = document.createElement('div');
    stats.className = 'pledge-stats';
    stats.innerHTML = `<span>🤝 $${((item.total_pledged_cents || 0) / 100).toFixed(0)} of $${(item.price_cents / 100).toFixed(0)} pledged</span><span>${item.pledge_progress_percent || 0}%</span>`;
    pledgeBox.appendChild(stats);

    details.appendChild(pledgeBox);
  }

  // Action Buttons
  const actions = document.createElement('div');
  actions.className = 'item-actions';

  // 1. Store Link button (With "Are you getting this?" modal for givers, or "Buy anyway?" for taken)
  if (item.store_url) {
    const btnStore = document.createElement('button');
    btnStore.type = 'button';
    btnStore.className = 'btn btn-secondary btn-sm';
    btnStore.textContent = '🛒 View in Store';
    btnStore.addEventListener('click', () => {
      if (isSurpriseProtected) {
        window.open(item.store_url, '_blank', 'noopener,noreferrer');
        return;
      }
      if (isTaken) {
        openModal('modal-already-taken', { item });
      } else {
        openModal('modal-store-prompt', { item });
      }
    });
    actions.appendChild(btnStore);
  }

  // Giver Actions (Claim, Pledge, Assign) — ONLY when NOT Surprise Protected!
  if (!isSurpriseProtected) {
    // Claim Button
    const myClaim = (item.claims || []).find((c) => c.is_mine);
    if (myClaim) {
      const btnRelease = document.createElement('button');
      btnRelease.type = 'button';
      btnRelease.className = 'btn btn-secondary btn-sm';
      btnRelease.textContent = '↩️ Release Claim';
      btnRelease.addEventListener('click', () => handleReleaseClaim(myClaim.id));
      actions.appendChild(btnRelease);
    } else if (!isTaken || item.allow_duplicates) {
      const btnClaim = document.createElement('button');
      btnClaim.type = 'button';
      btnClaim.className = 'btn btn-primary btn-sm';
      btnClaim.textContent = '🎁 Claim Gift';
      btnClaim.addEventListener('click', () => handleClaimItem(item.id));
      actions.appendChild(btnClaim);
    }

    // Group Pledge Button
    const btnPledge = document.createElement('button');
    btnPledge.type = 'button';
    btnPledge.className = 'btn btn-gold btn-sm';
    btnPledge.textContent = '🤝 Pledge $';
    btnPledge.addEventListener('click', () => openModal('modal-pledge', { item }));
    actions.appendChild(btnPledge);

    // Assign to Relative Button
    const btnAssign = document.createElement('button');
    btnAssign.type = 'button';
    btnAssign.className = 'btn btn-festive btn-sm';
    btnAssign.textContent = '👤 Assign to Relative';
    btnAssign.addEventListener('click', () => openModal('modal-assign', { item }));
    actions.appendChild(btnAssign);
  }

  // Static Shopping Card Download Buttons (Available to everyone for offline shopping!)
  const btnCardPdf = document.createElement('a');
  btnCardPdf.href = `/api/families/${state.currentFamilyId}/shopping-card.pdf?itemIds=${item.id}`;
  btnCardPdf.className = 'btn btn-secondary btn-sm';
  btnCardPdf.textContent = '📄 PDF Card';
  btnCardPdf.download = `${item.name.replace(/[^a-zA-Z0-9]/g, '_')}_card.pdf`;
  actions.appendChild(btnCardPdf);

  const btnCardPng = document.createElement('a');
  btnCardPng.href = `/api/families/${state.currentFamilyId}/shopping-card.png?itemIds=${item.id}`;
  btnCardPng.className = 'btn btn-secondary btn-sm';
  btnCardPng.textContent = '🖼️ PNG Card';
  btnCardPng.download = `${item.name.replace(/[^a-zA-Z0-9]/g, '_')}_card.png`;
  actions.appendChild(btnCardPng);

  details.appendChild(actions);
  card.appendChild(details);
  return card;
}
