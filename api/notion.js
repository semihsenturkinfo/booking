const NOTION_TOKEN = process.env.NOTION_TOKEN;
const DATABASE_ID = '41d4df128c834c17963bfab567deca2e';

const NOTION_HEADERS = {
  'Authorization': `Bearer ${NOTION_TOKEN}`,
  'Content-Type': 'application/json',
  'Notion-Version': '2022-06-28',
};

// Crude per-warm-instance rate limit (serverless: resets on cold start; catches bursts/bots, not targeted attacks)
const RL = new Map();

const esc = (s) => String(s == null ? '' : s).replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));

// Rebuild the confirmation email purely from data already stored on the Notion page.
function pageToEmailData(P) {
  const getT = (k) => (P[k]?.rich_text || P[k]?.title || []).map(t => t.plain_text).join('');
  const emailRaw = getT('E-mail');
  const email = emailRaw.split(',')[0].trim();            // customer is first; ignore any CC
  const pkg = getT('What services do you need?');
  const sqft = getT('Approximate square footage');
  const orientation = getT('Video Orientation');
  const addr = getT('Property Address');
  const slot = getT('Time');
  const name = getT('Agent');
  const loyText = getT('Loyalty');
  const dateISO = P['Preferred Shoot Date']?.date?.start || '';

  let dateD = dateISO;
  if (dateISO) { try { dateD = new Date(dateISO + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric', year: 'numeric' }); } catch (e) {} }

  const money = (s, re) => { const m = String(s).match(re); return m ? Number(m[1]) : 0; };
  const base = money(pkg, /CA\$(\d+)/);
  const sizeUnknown = /not sure/i.test(sqft) || sqft.trim() === '';
  const size = sizeUnknown ? 0 : money(sqft, /\+CA\$(\d+)/);
  const orient = money(orientation, /\+CA\$(\d+)/);
  const estimate = base ? { base, size, orient, ai: 0, total: base + size + orient, sizeUnknown } : null;

  let loyalty = null;
  const lm = loyText.match(/(\d)\/5/);
  if (lm) loyalty = { pos: Number(lm[1]), rewardEarned: /FREE SHOOT|EARNED/i.test(loyText) };

  return { name, email, pkg, date: dateISO, dateD, slot, addr, sqft, orientation, estimate, loyalty };
}

// Build the "Booking confirmed" email HTML from a normalized data object.
function buildBookingEmail(d) {
  const firstName = esc(String(d.name || '').trim().split(' ')[0] || 'there');
  const pkgStr = String(d.pkg || '');

  const delivery = [];
  if (pkgStr.startsWith('All-In-One') || pkgStr.startsWith('Photo + iGUIDE')) delivery.push('Photos &amp; iGUIDE: next day');
  else if (pkgStr.startsWith('Listing Photos')) delivery.push('Photos: next day');
  else if (pkgStr.startsWith('iGUIDE')) delivery.push('iGUIDE: next day');
  if (pkgStr.startsWith('All-In-One') || pkgStr.startsWith('Listing Video')) delivery.push('Video: 2&ndash;3 business days');

  const rows = [
    ['Package', d.pkg],
    ['Date', d.dateD || d.date],
    ['Time', d.slot],
    ['Address', d.addr],
    d.sqft ? ['Size', d.sqft] : null,
    d.orientation ? ['Video', d.orientation] : null,
  ].filter(Boolean);
  const rowsHtml = rows.map(([k, v]) =>
    `<tr><td style="width:84px;padding:5px 12px 5px 0;font-size:11px;letter-spacing:1px;text-transform:uppercase;color:#8a8a85;vertical-align:middle;white-space:nowrap">${k}</td><td style="padding:5px 0;font-size:14px;color:#f0efed;line-height:1.5;vertical-align:middle">${esc(v)}</td></tr>`
  ).join('') + (delivery.length
    ? `<tr><td style="width:84px;padding:5px 12px 5px 0;font-size:11px;letter-spacing:1px;text-transform:uppercase;color:#8a8a85;vertical-align:middle;white-space:nowrap">Delivery</td><td style="padding:5px 0;font-size:14px;color:#f0efed;line-height:1.5;vertical-align:middle">${delivery.join('<br>')}</td></tr>`
    : '');

  let loyaltyLine = '';
  const loyalty = d.loyalty;
  if (loyalty && Number.isFinite(Number(loyalty.pos))) {
    const pos = Math.min(5, Math.max(1, Number(loyalty.pos)));
    const starsHtml = `<span style="font-size:16px;letter-spacing:2px"><span style="color:#7E8C54">${'\u2605\uFE0E'.repeat(pos)}</span><span style="color:#4a4a46">${'\u2605\uFE0E'.repeat(5 - pos)}</span></span>`;
    const inner = loyalty.rewardEarned
      ? `<div style="padding:14px 16px;background:#242a1c;border:1px solid #7E8C54;border-radius:10px;font-size:14px;color:#f0efed;line-height:1.5"><div style="font-size:16px;letter-spacing:2px;color:#7E8C54;margin-bottom:6px">${'\u2605\uFE0E'.repeat(5)}</div><b>You just earned a FREE 1-hour content shoot!</b> That&rsquo;s 5 All-In-One bookings &mdash; I&rsquo;ll reach out to schedule it! &#127881;</div>`
      : `<div style="font-size:13px;color:#b5b5b0;line-height:1.6">Loyalty: ${starsHtml} &mdash; ${pos}/5 All-In-One shoots. ${5 - pos} more for a free 1-hour content shoot!</div>`;
    loyaltyLine = `<div style="margin-top:20px;padding-top:16px;border-top:1px solid #33332f">${inner}</div>`;
  }

  let priceHtml = '';
  const est = d.estimate;
  const nums = est && [est.base, est.size, est.orient, est.ai, est.total].map(Number);
  if (est && nums.every(v => Number.isFinite(v) && v >= 0 && v < 100000)) {
    const [pBase, pSize, pOrient, pAi, pTotal] = nums;
    const prows = [['Base package', 'CA$' + pBase]];
    prows.push(['Property size', est.sizeUnknown ? 'TBD' : (pSize > 0 ? '+$' + pSize : 'Included')]);
    if (pOrient > 0) prows.push(['Video orientation (both)', '+$' + pOrient]);
    if (pAi > 0) prows.push(['AI animations', '+$' + pAi]);
    const pbody = prows.map(([k, v]) =>
      `<tr><td style="padding:4px 16px 4px 0;font-size:13px;color:#9a9a95">${k}</td><td style="padding:4px 0;font-size:13px;color:#f0efed;text-align:right">${v}</td></tr>`
    ).join('');
    const amt = (est.sizeUnknown ? 'from ' : '') + 'CA$' + pTotal + ' + HST';
    priceHtml = `<div style="margin-top:20px;padding-top:16px;border-top:1px solid #33332f">
  <div style="font-size:11px;font-weight:700;letter-spacing:1px;color:#8a8a85;text-transform:uppercase;margin-bottom:8px">Price estimate</div>
  <table cellpadding="0" cellspacing="0" style="border-collapse:collapse;width:100%">${pbody}<tr><td style="padding:14px 16px 0 0;font-size:14px;font-weight:700;color:#fff">Estimated total</td><td style="padding:14px 0 0;font-size:14px;font-weight:700;color:#fff;text-align:right">${amt}</td></tr></table>
  <p style="margin:10px 0 0;font-size:12px;color:#8a8a85">Estimate only &mdash; a travel fee applies beyond 50 km from Kitchener${est.sizeUnknown ? ' (property size TBD)' : ''}</p>
</div>`;
  }

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="color-scheme" content="dark">
<meta name="supported-color-schemes" content="dark">
<style>@import url('https://fonts.googleapis.com/css2?family=Rubik:wght@600;900&display=swap');:root{color-scheme:dark;supported-color-schemes:dark}</style>
</head>
<body style="margin:0;padding:12px;background:#111110;background-image:linear-gradient(#111110,#111110)">
<div style="max-width:560px;margin:0 auto;background:#1a1a19;background-image:linear-gradient(#1a1a19,#1a1a19);border-radius:12px;padding:28px 24px;font-family:Arial,Helvetica,sans-serif;color:#f0efed">
  <h2 style="font-family:'Rubik','Arial Black',Arial,Helvetica,sans-serif;font-weight:600;font-size:20px;letter-spacing:-0.5px;margin:0 0 6px;color:#fff">Booking confirmed</h2>
  <p style="margin:0 0 18px;color:#9a9a95;font-size:14px;line-height:1.5">Thanks ${firstName}! You&rsquo;re all set &mdash; here are the details:</p>
  <table cellpadding="0" cellspacing="0" style="border-collapse:collapse;width:100%">${rowsHtml}</table>
  ${priceHtml}
  ${loyaltyLine}
  <div style="margin-top:22px;padding-top:18px;border-top:1px solid #33332f">
    <p style="margin:0;font-size:14px;color:#b5b5b0">Questions or changes? Just reply to this email.</p>
    <p style="margin:20px 0 0;font-size:14px;color:#b5b5b0">Ciao ciao,</p>
    <img src="https://semihs.vercel.app/wordmark.png" width="159" alt="SEMIH SENTURK" style="display:block;margin-top:14px;border:0;font-family:'Rubik','Arial Black',Arial,sans-serif;font-weight:900;font-size:20px;color:#f0ede8;letter-spacing:-0.05em">
    <div style="margin-top:3px;font-size:13px;color:#7E8C54">Videographer &middot; Photographer</div>
  </div>
</div>
</body>
</html>`;

  const subject = d.addr ? `Booking confirmed — ${String(d.addr).slice(0, 120)}` : 'Booking confirmed';
  return { subject, html };
}

async function sendGmail(to, subject, html) {
  const nodemailer = (await import('nodemailer')).default;
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD }
  });
  await transporter.sendMail({ from: `"Semih Senturk" <${process.env.GMAIL_USER}>`, to, subject, html });
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-secret');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    // Rate limit: max 8 requests/min per IP (per warm instance)
    const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
    const now = Date.now();
    const rl = RL.get(ip);
    if (rl && now - rl.t < 60000) { if (++rl.n > 8) return res.status(429).json({ error: 'Too many requests' }); }
    else RL.set(ip, { n: 1, t: now });
    if (RL.size > 5000) RL.clear();

    // --- GET: Confirm link clicked from inside the Notion page (sends the ONE booking email) ---
    if (req.method === 'GET') {
      const q = req.query || {};
      const page = (msg) => {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        return res.status(200).send(`<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;background:#1a1a19;color:#f0efed;font-family:Arial,Helvetica,sans-serif"><div style="max-width:420px;margin:18vh auto 0;padding:0 20px;text-align:center;font-size:16px;line-height:1.7">${msg}</div></body></html>`);
      };
      if (q.action !== 'confirm') return res.status(404).end();
      if (!process.env.CONFIRM_SECRET || q.k !== process.env.CONFIRM_SECRET) return res.status(403).send('Forbidden');
      if (!q.id) return page('&#10060; Missing booking id.');

      const pgRes = await fetch(`https://api.notion.com/v1/pages/${q.id}`, { headers: NOTION_HEADERS });
      const pg = await pgRes.json();
      if (!pgRes.ok) return page('&#10060; Booking not found in Notion.');

      const title = (pg.properties?.['Full Name (1)']?.title || []).map(t => t.plain_text).join('');
      if (title.startsWith('\u2705')) return page('This booking was <b>already confirmed</b> &mdash; no new email sent.');

      const d = pageToEmailData(pg.properties || {});
      const toAddr = String(d.email || '').trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(toAddr) || toAddr.length >= 200) return page('&#10060; No valid customer email on this booking.');

      const { subject, html } = buildBookingEmail(d);
      try {
        await sendGmail(toAddr, subject, html);
      } catch (e) {
        console.error('Confirm email failed:', e.message);
        return page('&#10060; Email failed to send: ' + esc(e.message));
      }

      try {
        await fetch(`https://api.notion.com/v1/pages/${q.id}`, {
          method: 'PATCH', headers: NOTION_HEADERS,
          body: JSON.stringify({ properties: { 'Full Name (1)': { title: [{ text: { content: '\u2705 ' + title } }] } } })
        });
      } catch (e) { console.error('Mark confirmed failed:', e.message); }

      return page(`&#9989; <b>Confirmed!</b><br>Email sent to ${esc(toAddr)}.`);
    }

    const secret = req.headers['x-api-secret'];
    if (secret !== process.env.API_SECRET) return res.status(403).json({ error: 'Forbidden' });
    if (req.method !== 'POST') return res.status(405).end();

    const { action, booking } = req.body;

    if (action === 'create') {
      // Honeypot: hidden field bots fill — pretend success, do nothing
      if (String(booking?.website || '').trim()) return res.status(200).json({ pageId: null, loyalty: null });

      const properties = {};
      if (booking.addr) properties['Property Address'] = { rich_text: [{ text: { content: String(booking.addr) } }] };
      if (booking.date) properties['Preferred Shoot Date'] = { date: { start: String(booking.date) } };
      if (booking.slot) properties['Time'] = { rich_text: [{ text: { content: String(booking.slot) } }] };
      if (booking.name) properties['Agent'] = { rich_text: [{ text: { content: String(booking.name) } }] };
      const teamCC = /\b(kaius|tyson|brandon)\b/i.test(String(booking.name || '')) ? 'sevde@teammosaic.ca' : '';
      const emailVal = [String(booking.email || ''), teamCC].filter(Boolean).join(', ');
      if (emailVal) properties['E-mail'] = { rich_text: [{ text: { content: emailVal } }] };
      if (booking.phone) properties['Phone'] = { rich_text: [{ text: { content: String(booking.phone) } }] };
      if (booking.pkg) properties['What services do you need?'] = { rich_text: [{ text: { content: String(booking.pkg) } }] };
      if (booking.sqft) properties['Approximate square footage'] = { rich_text: [{ text: { content: String(booking.sqft).replace(/,/g,'') } }] };
      if (booking.lockbox) properties['Lockbox code or access instructions'] = { rich_text: [{ text: { content: String(booking.lockbox) } }] };
      if (booking.orientation) properties['Video Orientation'] = { rich_text: [{ text: { content: String(booking.orientation) } }] };
      if (booking.notes) properties['Additional Notes'] = { rich_text: [{ text: { content: String(booking.notes) } }] };
      if (booking.shootDateText) properties['shootDateText'] = { rich_text: [{ text: { content: String(booking.shootDateText) } }] };
      const isLarge = booking.sqft && !String(booking.sqft).startsWith('Up to') && String(booking.sqft) !== 'Not sure';
      const nameStr = String(booking.name || 'New Booking');
      const lockIguide = /\b(ashley|greg)\b/i.test(nameStr);
      const pkgStr = String(booking.pkg || '');

      // --- Loyalty stars: 1 star per All-In-One purchase, free shoot at 5 ---
      let loyalty = null;
      if (pkgStr.startsWith('All-In-One')) {
        const custEmail = String(booking.email || '').trim().toLowerCase();
        let priorCount = 0;
        try {
          const conds = [{ property: 'What services do you need?', rich_text: { starts_with: 'All-In-One' } }];
          if (custEmail) conds.push({ property: 'E-mail', rich_text: { contains: custEmail } });
          else conds.push({ property: 'Agent', rich_text: { equals: nameStr } });
          const countRes = await fetch(`https://api.notion.com/v1/databases/${DATABASE_ID}/query`, {
            method: 'POST', headers: NOTION_HEADERS,
            body: JSON.stringify({ filter: { and: conds }, page_size: 100 })
          });
          const countData = await countRes.json();
          if (countRes.ok) priorCount = (countData.results || []).length;
          else console.error('Loyalty count error:', JSON.stringify(countData));
        } catch (e) { console.error('Loyalty count failed:', e.message); }

        const total = priorCount + 1;
        const pos = total % 5 === 0 ? 5 : total % 5;
        const rewardEarned = total % 5 === 0;
        const stars = '⭐'.repeat(pos) + '⚪'.repeat(5 - pos);
        loyalty = { pos, total, rewardEarned };
        properties['Loyalty'] = { rich_text: [{ text: { content: `${stars} (${pos}/5)${rewardEarned ? ' 🎁 FREE SHOOT EARNED' : ''}` } }] };
      }

      const rewardEarned = loyalty?.rewardEarned || false;
      let titleName = (rewardEarned ? '🎁 ' : '') + nameStr + (lockIguide ? ' (LOCK THE IGUIDE)' : '');
      if (isLarge) titleName = '⚠️ ' + titleName + ' ⚠️';
      properties['Full Name (1)'] = { title: [{ text: { content: titleName } }] };

      // Package-based colored icon for quick visual scanning in Notion
      let pkgIcon = '⚪';
      if (pkgStr.startsWith('All-In-One')) pkgIcon = '🟢';
      else if (pkgStr.startsWith('Photo + iGUIDE')) pkgIcon = '🔵';
      else if (pkgStr.startsWith('Listing Video')) pkgIcon = '🟣';
      else if (pkgStr.startsWith('Listing Photos')) pkgIcon = '🟠';
      else if (pkgStr.startsWith('iGUIDE Virtual Tour')) pkgIcon = '🟡';
      if (rewardEarned) pkgIcon = '🎁';

      const response = await fetch('https://api.notion.com/v1/pages', {
        method: 'POST', headers: NOTION_HEADERS,
        body: JSON.stringify({ parent: { database_id: DATABASE_ID }, icon: { type: 'emoji', emoji: pkgIcon }, properties })
      });
      const result = await response.json();
      if (!response.ok) { console.error('Notion create error:', JSON.stringify(result)); return res.status(400).json({ error: result }); }

      // Add a one-click Confirm link INSIDE the page body (no extra property needed)
      if (process.env.CONFIRM_SECRET) {
        try {
          const confirmUrl = `https://semihs.vercel.app/api/notion?action=confirm&id=${result.id}&k=${process.env.CONFIRM_SECRET}`;
          await fetch(`https://api.notion.com/v1/blocks/${result.id}/children`, {
            method: 'PATCH', headers: NOTION_HEADERS,
            body: JSON.stringify({ children: [
              { object: 'block', type: 'paragraph', paragraph: { rich_text: [
                { type: 'text', text: { content: '✅ Confirm & send email', link: { url: confirmUrl } },
                  annotations: { bold: true, color: 'green' } }
              ] } }
            ] })
          });
        } catch (e) { console.error('Confirm link write failed:', e.message); }
      }

      // --- Mirror booking to TickTick (Pomodoro + per-task time tracking); no-op without token ---
      if (process.env.TICKTICK_ACCESS_TOKEN) {
        try {
          const title = (booking.addr || nameStr) + (booking.slot ? ' — ' + booking.slot : '');
          const lines = [
            pkgStr && `Package: ${pkgStr}`,
            nameStr && `Agent: ${nameStr}`,
            booking.sqft && `Size: ${booking.sqft}`,
            booking.orientation && `Video: ${booking.orientation}`,
            booking.phone && `Phone: ${booking.phone}`,
          ].filter(Boolean);
          const ttBody = { title, content: lines.join('\n'), isAllDay: true };
          if (booking.date) { ttBody.dueDate = `${booking.date}T00:00:00+0000`; ttBody.timeZone = 'America/Toronto'; }
          if (process.env.TICKTICK_PROJECT_ID) ttBody.projectId = process.env.TICKTICK_PROJECT_ID;
          const ttRes = await fetch('https://api.ticktick.com/open/v1/task', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${process.env.TICKTICK_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(ttBody)
          });
          if (!ttRes.ok) console.error('TickTick task error:', ttRes.status, await ttRes.text());
        } catch (e) { console.error('TickTick task failed:', e.message); }
      }

      return res.status(200).json({ pageId: result.id, loyalty });
    }

    if (action === 'loyalty_check') {
      const email = String(req.body.email || '').trim().toLowerCase();
      const name = String(req.body.name || '').trim();
      let priorCount = 0;
      try {
        const conds = [{ property: 'What services do you need?', rich_text: { starts_with: 'All-In-One' } }];
        if (email) conds.push({ property: 'E-mail', rich_text: { contains: email } });
        else if (name) conds.push({ property: 'Agent', rich_text: { equals: name } });
        else return res.status(200).json({ priorCount: 0 });
        const r = await fetch(`https://api.notion.com/v1/databases/${DATABASE_ID}/query`, {
          method: 'POST', headers: NOTION_HEADERS,
          body: JSON.stringify({ filter: { and: conds }, page_size: 100 })
        });
        const d = await r.json();
        if (r.ok) priorCount = (d.results || []).length;
        else console.error('loyalty_check error:', JSON.stringify(d));
      } catch (e) { console.error('loyalty_check failed:', e.message); }
      return res.status(200).json({ priorCount });
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (err) {
    console.error('Handler error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
