const NOTION_TOKEN = process.env.NOTION_TOKEN;
const DATABASE_ID = '41d4df128c834c17963bfab567deca2e';

const NOTION_HEADERS = {
  'Authorization': `Bearer ${NOTION_TOKEN}`,
  'Content-Type': 'application/json',
  'Notion-Version': '2022-06-28',
};

const rt = (val) => ({ rich_text: [{ text: { content: String(val || '') } }] });

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    if (req.method === 'GET') {
      const response = await fetch(`https://api.notion.com/v1/databases/${DATABASE_ID}/query`, {
        method: 'POST', headers: NOTION_HEADERS,
        body: JSON.stringify({
          sorts: [{ property: 'Preferred Shoot Date', direction: 'ascending' }],
          page_size: 100
        })
      });
      const data = await response.json();
      if (!response.ok) { console.error('Notion GET error:', JSON.stringify(data)); return res.status(400).json({ error: data }); }

      const full = req.query?.full === '1';
      const debug = req.query?.debug === '1';
      const results = data.results || [];

      if (debug) { return res.status(200).json({ raw: results.slice(0,3).map(p=>({id:p.id,props:Object.fromEntries(Object.entries(p.properties).map(([k,v])=>[k,v]))})) }); }
      if (full) {
        const bookings = results.map(p => {
          const g = (k) => p.properties[k]?.rich_text?.[0]?.text?.content || p.properties[k]?.title?.[0]?.text?.content || p.properties[k]?.multi_select?.map(x=>x.name).join(', ') || p.properties[k]?.email || p.properties[k]?.phone_number || '';
          return { pageId: p.id, date: p.properties['Preferred Shoot Date']?.date?.start||'', slot: g('Time'), name: g('Agent'), email: g('E-mail'), phone: g('Phone'), addr: g('Property Address'), pkg: g('What services do you need?'), sqft: g('Approximate square footage'), lockbox: g('Lockbox code or access instructions'), orientation: g('Video Orientation'), notes: g('Additional Notes') };
        }).filter(b => b.date && b.slot);
        return res.status(200).json({ bookings });
      } else {
        const bookings = results.map(p => ({
          date: p.properties['Preferred Shoot Date']?.date?.start || '',
          slot: (p.properties['Time']?.multi_select?.[0]?.name) || (p.properties['Time']?.rich_text?.[0]?.text?.content) || '',
        })).filter(b => b.date && b.slot);
        return res.status(200).json({ bookings });
      }
    }

    const { action, booking } = req.body;

    if (action === 'create') {
      // Hardcode property types based on actual Notion database schema
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

      // Title field (required by Notion)
      properties['Full Name (1)'] = { title: [{ text: { content: String(booking.name || 'New Booking') } }] };

      const response = await fetch('https://api.notion.com/v1/pages', {
        method: 'POST', headers: NOTION_HEADERS,
        body: JSON.stringify({ parent: { database_id: DATABASE_ID }, properties })
      });
      const result = await response.json();
      if (!response.ok) { console.error('Notion create error:', JSON.stringify(result)); return res.status(400).json({ error: result }); }
      return res.status(200).json({ pageId: result.id });
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (err) {
    console.error('Handler error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
