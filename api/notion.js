const NOTION_TOKEN = process.env.NOTION_TOKEN;
const DATABASE_ID = '41d4df128c834c17963bfab567deca2e';

const NOTION_HEADERS = {
  'Authorization': `Bearer ${NOTION_TOKEN}`,
  'Content-Type': 'application/json',
  'Notion-Version': '2022-06-28',
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-secret');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const secret = req.headers['x-api-secret'];
  if (secret !== process.env.API_SECRET) return res.status(403).json({ error: 'Forbidden' });

  try {
    if (req.method === 'GET') {
      const response = await fetch(`https://api.notion.com/v1/databases/${DATABASE_ID}/query`, {
        method: 'POST', headers: NOTION_HEADERS,
        body: JSON.stringify({
          filter: { property: 'Preferred Shoot Date', date: { on_or_after: new Date().toISOString().split('T')[0] } },
          sorts: [{ property: 'Preferred Shoot Date', direction: 'ascending' }],
          page_size: 100
        })
      });
      const data = await response.json();
      if (!response.ok) { console.error('Notion GET error:', JSON.stringify(data)); return res.status(400).json({ error: data }); }

      const full = req.query?.full === '1';
      const results = data.results || [];

      const getAddr = (p) => p.properties['Property Address']?.rich_text?.[0]?.text?.content || p.properties['Property Address']?.title?.[0]?.text?.content || '';
      const getText = (p, k) => p.properties[k]?.rich_text?.[0]?.text?.content || p.properties[k]?.title?.[0]?.text?.content || p.properties[k]?.multi_select?.map(x=>x.name).join(', ') || p.properties[k]?.email || p.properties[k]?.phone_number || '';

      if (full) {
        const bookings = results.map(p => {
          const addr = getAddr(p);
          const isBlocked = addr === 'BLOCKED';
          const isWeekendOpen = addr === 'WEEKEND_OPEN';
          return { pageId: p.id, date: p.properties['Preferred Shoot Date']?.date?.start||'', slot: getText(p,'Time'), name: getText(p,'Agent'), email: getText(p,'E-mail'), phone: getText(p,'Phone'), addr, pkg: getText(p,'What services do you need?'), sqft: getText(p,'Approximate square footage'), lockbox: getText(p,'Lockbox code or access instructions'), orientation: getText(p,'Video Orientation'), notes: getText(p,'Additional Notes'), isBlocked, isWeekendOpen };
        }).filter(b => b.date);
        return res.status(200).json({ bookings });
      } else {
        const bookings = [];
        const weekendOpen = [];
        for (const p of results) {
          const addr = getAddr(p);
          const date = p.properties['Preferred Shoot Date']?.date?.start || '';
          if (!date) continue;
          if (addr === 'WEEKEND_OPEN') { weekendOpen.push(date); continue; }
          const rawSlot = getText(p,'Time');
          const slots = rawSlot.includes(', ') ? rawSlot.split(', ') : [rawSlot];
          for (const slot of slots) {
            if (slot) bookings.push({ date, slot, pageId: p.id });
          }
        }
        return res.status(200).json({ bookings, weekendOpen });
      }
    }

    const { action, booking, date, slot, pageId } = req.body;

    if (action === 'create') {
      const properties = {};
      if (booking.addr) properties['Property Address'] = { rich_text: [{ text: { content: String(booking.addr) } }] };
      if (booking.date) properties['Preferred Shoot Date'] = { date: { start: String(booking.date) } };
      if (booking.slot) properties['Time'] = { rich_text: [{ text: { content: String(booking.slot) } }] };
      if (booking.name) properties['Agent'] = { rich_text: [{ text: { content: String(booking.name) } }] };
      if (booking.email) properties['E-mail'] = { rich_text: [{ text: { content: String(booking.email) } }] };
      if (booking.phone) properties['Phone'] = { rich_text: [{ text: { content: String(booking.phone) } }] };
      if (booking.pkg) properties['What services do you need?'] = { rich_text: [{ text: { content: String(booking.pkg) } }] };
      if (booking.sqft) properties['Approximate square footage'] = { rich_text: [{ text: { content: String(booking.sqft).replace(/,/g,'') } }] };
      if (booking.lockbox) properties['Lockbox code or access instructions'] = { rich_text: [{ text: { content: String(booking.lockbox) } }] };
      if (booking.orientation) properties['Video Orientation'] = { rich_text: [{ text: { content: String(booking.orientation) } }] };
      if (booking.notes) properties['Additional Notes'] = { rich_text: [{ text: { content: String(booking.notes) } }] };
      properties['Full Name (1)'] = { title: [{ text: { content: String(booking.name || 'New Booking') } }] };
      const response = await fetch('https://api.notion.com/v1/pages', {
        method: 'POST', headers: NOTION_HEADERS,
        body: JSON.stringify({ parent: { database_id: DATABASE_ID }, properties })
      });
      const result = await response.json();
      if (!response.ok) { console.error('Notion create error:', JSON.stringify(result)); return res.status(400).json({ error: result }); }
      return res.status(200).json({ pageId: result.id });
    }

    if (action === 'block') {
      const slots = Array.isArray(slot) ? slot : [slot];
      const response = await fetch('https://api.notion.com/v1/pages', {
        method: 'POST', headers: NOTION_HEADERS,
        body: JSON.stringify({
          parent: { database_id: DATABASE_ID },
          properties: {
            'Full Name (1)': { title: [{ text: { content: 'BLOCKED' } }] },
            'Property Address': { rich_text: [{ text: { content: 'BLOCKED' } }] },
            'Preferred Shoot Date': { date: { start: String(date) } },
            'Time': { rich_text: [{ text: { content: slots.join(', ') } }] },
            'Agent': { rich_text: [{ text: { content: 'BLOCKED' } }] },
          }
        })
      });
      const result = await response.json();
      return res.status(200).json({ pageIds: result.id ? [result.id] : [] });
    }

    if (action === 'weekend_open') {
      // Add a WEEKEND_OPEN marker for this date
      const response = await fetch('https://api.notion.com/v1/pages', {
        method: 'POST', headers: NOTION_HEADERS,
        body: JSON.stringify({
          parent: { database_id: DATABASE_ID },
          properties: {
            'Full Name (1)': { title: [{ text: { content: 'WEEKEND_OPEN' } }] },
            'Property Address': { rich_text: [{ text: { content: 'WEEKEND_OPEN' } }] },
            'Preferred Shoot Date': { date: { start: String(date) } },
            'Agent': { rich_text: [{ text: { content: 'WEEKEND_OPEN' } }] },
          }
        })
      });
      const result = await response.json();
      return res.status(200).json({ pageId: result.id });
    }

    if (action === 'weekend_close') {
      // Archive the WEEKEND_OPEN marker
      await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
        method: 'PATCH', headers: NOTION_HEADERS,
        body: JSON.stringify({ archived: true })
      });
      return res.status(200).json({ ok: true });
    }

    if (action === 'unblock') {
      const ids = Array.isArray(pageId) ? pageId : [pageId];
      for (const id of ids) {
        await fetch(`https://api.notion.com/v1/pages/${id}`, {
          method: 'PATCH', headers: NOTION_HEADERS,
          body: JSON.stringify({ archived: true })
        });
      }
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (err) {
    console.error('Handler error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
