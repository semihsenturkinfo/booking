const NOTION_TOKEN = process.env.NOTION_TOKEN;
const DATABASE_ID = '41d4df128c834c17963bfab567deca2e';

const NOTION_HEADERS = {
  'Authorization': `Bearer ${NOTION_TOKEN}`,
  'Content-Type': 'application/json',
  'Notion-Version': '2022-06-28',
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-secret');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const secret = req.headers['x-api-secret'];
  if (secret !== process.env.API_SECRET) return res.status(403).json({ error: 'Forbidden' });

  try {
    if (req.method !== 'POST') return res.status(405).end();

    const { action, booking } = req.body;

    if (action === 'create') {
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
