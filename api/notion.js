const NOTION_TOKEN = process.env.NOTION_TOKEN;
const DATABASE_ID = '41d4df128c834c17963bfab567deca2e';

const NOTION_HEADERS = {
  'Authorization': `Bearer ${NOTION_TOKEN}`,
  'Content-Type': 'application/json',
  'Notion-Version': '2022-06-28',
};

// Crude per-warm-instance rate limit (serverless: resets on cold start; catches bursts/bots, not targeted attacks)
const RL = new Map();

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-secret');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const secret = req.headers['x-api-secret'];
  if (secret !== process.env.API_SECRET) return res.status(403).json({ error: 'Forbidden' });

  try {
    if (req.method !== 'POST') return res.status(405).end();

    // Rate limit: max 8 requests/min per IP (per warm instance)
    const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
    const now = Date.now();
    const rl = RL.get(ip);
    if (rl && now - rl.t < 60000) { if (++rl.n > 8) return res.status(429).json({ error: 'Too many requests' }); }
    else RL.set(ip, { n: 1, t: now });
    if (RL.size > 5000) RL.clear();

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
      // Source of truth = the bookings themselves. Count prior non-archived
      // All-In-One bookings for this customer (by email), then add this one.
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

        const total = priorCount + 1;                 // include this booking
        const pos = total % 5 === 0 ? 5 : total % 5;   // 1..5 within current card
        const rewardEarned = total % 5 === 0;          // hit a multiple of 5
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
      if (rewardEarned) pkgIcon = '🎁'; // reward booking — make it pop in Notion list view

      const response = await fetch('https://api.notion.com/v1/pages', {
        method: 'POST', headers: NOTION_HEADERS,
        body: JSON.stringify({ parent: { database_id: DATABASE_ID }, icon: { type: 'emoji', emoji: pkgIcon }, properties })
      });
      const result = await response.json();
      if (!response.ok) { console.error('Notion create error:', JSON.stringify(result)); return res.status(400).json({ error: result }); }

      // --- Mirror booking to TickTick as a task (for Pomodoro + per-task time tracking) ---
      // No-op unless TICKTICK_ACCESS_TOKEN is set, so this never blocks a booking.
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

      // --- Confirmation email to customer via Gmail (non-blocking) ---
      // No-op unless GMAIL_USER + GMAIL_APP_PASSWORD are set; never blocks a booking.
      const toAddr = String(booking.email || '').trim();
      if (process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(toAddr) && toAddr.length < 200) {
        try {
          const nodemailer = (await import('nodemailer')).default;
          const transporter = nodemailer.createTransport({
            service: 'gmail',
            auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD }
          });
          const escH = (s) => String(s == null ? '' : s).replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
          const firstName = escH(String(booking.name || '').trim().split(' ')[0] || 'there');

          const delivery = [];
          if (pkgStr.startsWith('All-In-One') || pkgStr.startsWith('Photo + iGUIDE')) delivery.push('Photos &amp; iGUIDE: next day');
          else if (pkgStr.startsWith('Listing Photos')) delivery.push('Photos: next day');
          else if (pkgStr.startsWith('iGUIDE')) delivery.push('iGUIDE: next day');
          if (pkgStr.startsWith('All-In-One') || pkgStr.startsWith('Listing Video')) delivery.push('Video: 2&ndash;3 business days');

          const rows = [
            ['Package', booking.pkg],
            ['Date', booking.dateD || booking.date],
            ['Time', booking.slot],
            ['Address', booking.addr],
            booking.sqft ? ['Size', booking.sqft] : null,
            booking.orientation ? ['Video', booking.orientation] : null,
          ].filter(Boolean);
          const rowsHtml = rows.map(([k, v]) =>
            `<tr><td style="width:84px;padding:5px 12px 5px 0;font-size:11px;letter-spacing:1px;text-transform:uppercase;color:#8a8a85;vertical-align:top;white-space:nowrap">${k}</td><td style="padding:5px 0;font-size:14px;color:#f0efed;line-height:1.5">${escH(v)}</td></tr>`
          ).join('') + (delivery.length
            ? `<tr><td style="width:84px;padding:5px 12px 5px 0;font-size:11px;letter-spacing:1px;text-transform:uppercase;color:#8a8a85;vertical-align:top;white-space:nowrap">Delivery</td><td style="padding:5px 0;font-size:14px;color:#f0efed;line-height:1.5">${delivery.join('<br>')}</td></tr>`
            : '');

          let loyaltyLine = '';
          if (loyalty) {
            const starsHtml = `<span style="font-size:16px;letter-spacing:2px"><span style="color:#7E8C54">${'\u2605\uFE0E'.repeat(loyalty.pos)}</span><span style="color:#4a4a46">${'\u2605\uFE0E'.repeat(5 - loyalty.pos)}</span></span>`;
            const inner = loyalty.rewardEarned
              ? `<div style="padding:14px 16px;background:#242a1c;border:1px solid #7E8C54;border-radius:10px;font-size:14px;color:#f0efed;line-height:1.5"><b>You just earned a FREE 1-hour content shoot!</b> That&rsquo;s 5 All-In-One bookings &mdash; I&rsquo;ll reach out to schedule it. &#127881;</div>`
              : `<div style="font-size:13px;color:#b5b5b0;line-height:1.6">Loyalty: ${starsHtml} &mdash; ${loyalty.pos}/5 All-In-One shoots. ${5 - loyalty.pos} more for a free 1-hour content shoot.</div>`;
            loyaltyLine = `<div style="margin-top:20px;padding-top:16px;border-top:1px solid #33332f">${inner}</div>`;
          }

          // Price estimate (numbers validated server-side; skip section if payload is malformed)
          let priceHtml = '';
          const est = booking.estimate;
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
  <table cellpadding="0" cellspacing="0" style="border-collapse:collapse;width:100%">${pbody}<tr><td style="padding:9px 16px 0 0;font-size:14px;font-weight:600;color:#fff;border-top:1px solid #33332f">Estimated total</td><td style="padding:9px 0 0;font-size:14px;font-weight:700;color:#fff;text-align:right;border-top:1px solid #33332f">${amt}</td></tr></table>
  <p style="margin:10px 0 0;font-size:12px;color:#8a8a85">Estimate only &mdash; a travel fee applies for properties outside Kitchener-Waterloo${est.sizeUnknown ? ' (property size TBD)' : ''}</p>
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
  <h2 style="font-family:'Rubik','Arial Black',Arial,Helvetica,sans-serif;font-weight:600;font-size:20px;letter-spacing:-0.5px;margin:0 0 6px;color:#fff">Booking request received</h2>
  <p style="margin:0 0 18px;color:#9a9a95;font-size:14px;line-height:1.5">Thanks ${firstName}! Your request is pending &mdash; I&rsquo;ll reach out shortly to confirm the date and time. Here&rsquo;s what I have:</p>
  <table cellpadding="0" cellspacing="0" style="border-collapse:collapse;width:100%">${rowsHtml}</table>
  ${priceHtml}
  ${loyaltyLine}
  <div style="margin-top:22px;padding-top:18px;border-top:1px solid #33332f">
    <p style="margin:0;font-size:14px;color:#b5b5b0">Questions or changes? Just reply to this email.</p>
    <p style="margin:20px 0 0;font-size:14px;color:#b5b5b0">Ciao ciao,</p>
    <div style="margin-top:14px;font-family:'Rubik','Arial Black',Arial,sans-serif;font-weight:900;font-size:20px;color:#f0ede8;letter-spacing:-0.05em">SEMIH SENTURK</div>
    <div style="margin-top:3px;font-size:13px;color:#7E8C54">Videographer &middot; Photographer</div>
  </div>
</div>
</body>
</html>`;

          await transporter.sendMail({
            from: `"Semih Senturk" <${process.env.GMAIL_USER}>`,
            to: toAddr,
            subject: booking.addr ? `Booking request received — ${String(booking.addr).slice(0, 120)}` : 'Booking request received',
            html
          });
        } catch (e) { console.error('Confirmation email failed:', e.message); }
      }

      return res.status(200).json({ pageId: result.id, loyalty });
    }

    if (action === 'loyalty_check') {
      // Pre-submit count of prior non-archived All-In-One bookings for this customer
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
