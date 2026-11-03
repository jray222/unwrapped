import PDFDocument from 'pdfkit';
import sharp from 'sharp';
import { escapeHtml } from '../security/crypto.js';

export interface ShoppingCardItem {
  name: string;
  store_name: string;
  price_cents: number | null;
  notes: string;
  priority: string;
  quantity: number;
}

export interface ShoppingCardParams {
  familyName: string;
  listName: string;
  assigneeFirstName: string;
  eventDate?: string | null;
  items: ShoppingCardItem[];
}

function formatPrice(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return 'Price not specified';
  return `$${(cents / 100).toFixed(2)}`;
}

function formatPriority(priority: string): string {
  if (priority === 'really_want') return 'Really Want';
  if (priority === 'nice_to_have') return 'Nice to Have';
  return priority || 'Standard';
}

/**
 * Generates a high-contrast, large-print, multi-page offline PDF shopping card.
 * Includes header with family, list, assignee, event date, item cards with prices/notes,
 * and standard security disclaimers on all pages.
 */
export async function generateShoppingCardPdf(params: {
  familyName: string;
  listName: string;
  assigneeFirstName: string;
  eventDate?: string | null;
  items: ShoppingCardItem[];
}): Promise<Buffer> {
  const { familyName, listName, assigneeFirstName, eventDate, items } = params;

  return new Promise<Buffer>((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: 'A4',
        margin: 40,
        bufferPages: true,
      });

      const chunks: Buffer[] = [];
      doc.on('data', chunk => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const pageWidth = doc.page.width;
      const contentWidth = pageWidth - 80;

      // Header Banner
      doc
        .fontSize(22)
        .font('Helvetica-Bold')
        .fillColor('#0f172a')
        .text(`Shopping Card for ${assigneeFirstName || 'Assignee'}`, 40, 40);

      doc.moveDown(0.3);

      doc
        .fontSize(12)
        .font('Helvetica')
        .fillColor('#475569')
        .text(`Family: ${familyName}    •    List: ${listName}`);

      if (eventDate) {
        doc.moveDown(0.2);
        doc
          .fontSize(11)
          .font('Helvetica')
          .fillColor('#64748b')
          .text(`Event Date: ${eventDate}`);
      }

      doc.moveDown(0.6);
      doc
        .strokeColor('#cbd5e1')
        .lineWidth(1)
        .moveTo(40, doc.y)
        .lineTo(pageWidth - 40, doc.y)
        .stroke();

      doc.moveDown(0.8);

      if (!items || items.length === 0) {
        doc
          .fontSize(14)
          .font('Helvetica-Oblique')
          .fillColor('#64748b')
          .text('No items currently assigned to this shopping card.', { align: 'center' });
      } else {
        for (let i = 0; i < items.length; i++) {
          const item = items[i];

          // Check for page overflow
          if (doc.y > 680) {
            doc.addPage();
          }

          const startY = doc.y;

          // Priority badge / indicator
          const isReallyWant = item.priority === 'really_want';
          const priorityText = isReallyWant ? '★ REALLY WANT' : 'NICE TO HAVE';
          const priorityColor = isReallyWant ? '#b91c1c' : '#475569';

          doc
            .fontSize(10)
            .font('Helvetica-Bold')
            .fillColor(priorityColor)
            .text(priorityText, 45, startY);

          // Item Name
          doc
            .fontSize(14)
            .font('Helvetica-Bold')
            .fillColor('#0f172a')
            .text(item.name || 'Untitled Item', 45, startY + 14, {
              width: contentWidth - 10,
            });

          // Metadata line: Store, Price, Quantity
          const storeName = item.store_name ? item.store_name : 'Any Store';
          const priceText = formatPrice(item.price_cents);
          const qtyText = `Qty: ${item.quantity || 1}`;

          doc.moveDown(0.2);
          doc
            .fontSize(11)
            .font('Helvetica')
            .fillColor('#334155')
            .text(`Store: ${storeName}   |   ${priceText}   |   ${qtyText}`, 45, doc.y);

          // Notes
          if (item.notes && item.notes.trim()) {
            doc.moveDown(0.2);
            doc
              .fontSize(10)
              .font('Helvetica-Oblique')
              .fillColor('#64748b')
              .text(`Notes: ${item.notes.trim()}`, 45, doc.y, {
                width: contentWidth - 10,
              });
          }

          doc.moveDown(0.6);
          // Separator line between items
          if (i < items.length - 1) {
            doc
              .strokeColor('#f1f5f9')
              .lineWidth(1)
              .moveTo(45, doc.y)
              .lineTo(pageWidth - 45, doc.y)
              .stroke();
            doc.moveDown(0.6);
          }
        }
      }

      // Add footer disclaimer to ALL buffered pages
      const range = doc.bufferedPageRange();
      for (let p = range.start; p < range.start + range.count; p++) {
        doc.switchToPage(p);
        doc
          .fontSize(9)
          .font('Helvetica')
          .fillColor('#64748b')
          .text(
            'Static Offline Shopping Card — Grants no online account access.',
            40,
            doc.page.height - 35,
            { align: 'center', width: contentWidth }
          );
      }

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

function truncate(str: string, maxLen: number): string {
  if (!str) return '';
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 1) + '…';
}

/**
 * Builds a clean, high-contrast SVG card layout (escaping all dynamic text)
 * and renders it to a PNG buffer via sharp.
 */
export async function generateShoppingCardPng(params: {
  familyName: string;
  listName: string;
  assigneeFirstName: string;
  eventDate?: string | null;
  items: ShoppingCardItem[];
}): Promise<Buffer> {
  const { familyName, listName, assigneeFirstName, eventDate, items } = params;

  const width = 800;
  const headerHeight = eventDate ? 140 : 120;
  let totalHeight = 40 + headerHeight + 20;

  const itemHeights: number[] = [];
  if (items && items.length > 0) {
    for (const item of items) {
      const h = item.notes && item.notes.trim() ? 120 : 95;
      itemHeights.push(h);
      totalHeight += h + 14;
    }
  } else {
    totalHeight += 100;
  }
  totalHeight += 60; // footer space

  // Ensure minimum comfortable card height
  totalHeight = Math.max(500, totalHeight);

  let currentY = 30;

  // Header SVG Card
  let svg = `<svg width="${width}" height="${totalHeight}" viewBox="0 0 ${width} ${totalHeight}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <style>
      .title { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; font-size: 22px; font-weight: bold; fill: #0f172a; }
      .meta { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; font-size: 13px; fill: #475569; }
      .badge-label { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; font-size: 10px; font-weight: bold; letter-spacing: 0.5px; }
      .item-name { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; font-size: 16px; font-weight: bold; fill: #0f172a; }
      .item-meta { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; font-size: 13px; fill: #334155; }
      .item-notes { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; font-size: 12px; font-style: italic; fill: #64748b; }
      .footer-text { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; font-size: 12px; fill: #64748b; }
    </style>
  </defs>
  <rect width="100%" height="100%" fill="#f8fafc"/>

  <!-- Header Card -->
  <rect x="30" y="${currentY}" width="740" height="${headerHeight}" rx="12" fill="#ffffff" stroke="#cbd5e1" stroke-width="1.5"/>
  <rect x="50" y="${currentY + 16}" width="160" height="20" rx="4" fill="#f1f5f9"/>
  <text x="130" y="${currentY + 30}" class="badge-label" text-anchor="middle" fill="#475569">OFFLINE SHOPPING CARD</text>
  <text x="50" y="${currentY + 62}" class="title">Shopping Card for ${escapeHtml(assigneeFirstName || 'Assignee')}</text>
  <text x="50" y="${currentY + 88}" class="meta">Family: ${escapeHtml(familyName)}   •   List: ${escapeHtml(listName)}</text>`;

  if (eventDate) {
    svg += `
  <text x="50" y="${currentY + 110}" class="meta">Event Date: ${escapeHtml(eventDate)}</text>`;
  }

  svg += `\n`;
  currentY += headerHeight + 20;

  // Items
  if (!items || items.length === 0) {
    svg += `  <rect x="30" y="${currentY}" width="740" height="80" rx="10" fill="#ffffff" stroke="#e2e8f0" stroke-width="1"/>
  <text x="400" y="${currentY + 45}" class="item-meta" text-anchor="middle" fill="#64748b">No items currently assigned to this shopping card.</text>\n`;
    currentY += 95;
  } else {
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const cardH = itemHeights[i];
      const isReallyWant = item.priority === 'really_want';
      const badgeBg = isReallyWant ? '#fee2e2' : '#f1f5f9';
      const badgeText = isReallyWant ? '#991b1b' : '#475569';
      const priorityLabel = isReallyWant ? 'REALLY WANT' : 'NICE TO HAVE';

      const storeText = item.store_name ? item.store_name : 'Any Store';
      const priceText = formatPrice(item.price_cents);
      const qtyText = `Qty: ${item.quantity || 1}`;

      svg += `  <!-- Item ${i + 1} -->
  <rect x="30" y="${currentY}" width="740" height="${cardH}" rx="10" fill="#ffffff" stroke="#e2e8f0" stroke-width="1.5"/>
  <rect x="45" y="${currentY + 14}" width="105" height="20" rx="4" fill="${badgeBg}"/>
  <text x="97.5" y="${currentY + 28}" class="badge-label" text-anchor="middle" fill="${badgeText}">${priorityLabel}</text>
  <text x="165" y="${currentY + 29}" class="item-name">${escapeHtml(truncate(item.name || 'Untitled Item', 55))}</text>
  <text x="45" y="${currentY + 58}" class="item-meta">Store: ${escapeHtml(truncate(storeText, 35))}   |   ${escapeHtml(priceText)}   |   ${escapeHtml(qtyText)}</text>`;

      if (item.notes && item.notes.trim()) {
        svg += `
  <text x="45" y="${currentY + 84}" class="item-notes">Notes: ${escapeHtml(truncate(item.notes.trim(), 85))}</text>`;
      }

      svg += `\n`;
      currentY += cardH + 14;
    }
  }

  // Footer Disclaimer
  svg += `
  <text x="400" y="${totalHeight - 25}" class="footer-text" text-anchor="middle">Static Offline Shopping Card — Grants no online account access.</text>
</svg>`;

  const pngBuffer = await sharp(Buffer.from(svg, 'utf8')).png().toBuffer();
  return pngBuffer;
}
