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
        body: JSON.stringify({ page_size: 100 })
      });
      const data = await response.json();
      if (!response.ok) { console.error('Notion GET error:', JSON.stringify(data)); return res.status(400).json({ error: data }); }

      const full = req.query?.full === '1';
      const results = data.results || [];

      if (full) {
        const bookings = results.map(p => {
          const g = (k) => p.properties[k]?.rich_text?.[0]?.text?.content || p.properties[k]?.title?.[0]?.text?.content || p.properties[k]?.multi_select?.map(x=>x.name).join(', ') || p.properties[k]?.email || p.properties[k]?.phone_number || '';
          return { pageId: p.id, date: p.properties['Preferred Shoot Date']?.date?.start||'', slot: g('Time'), name: g('Agent'), email: g('E-mail'), phone: g('Phone'), addr: g('Property Address'), pkg: g('What services do you need?'), sqft: g('Approximate square footage'), lockbox: g('Lockbox code or access instructions'), orientation: g('Video Orientation'), notes: g('Additional Notes') };
        }).filter(b => b.date && b.slot);
        return res.status(200).json({ bookings });
      } else {
        const bookings = results.map(p => ({
          date: p.properties['Preferred Shoot Date']?.date?.start || '',
          slot: p.properties['Time']?.rich_text?.[0]?.text?.content || p.properties['Time']?.multi_select?.map(x=>x.name).join(', ') || '',
        })).filter(b => b.date && b.slot);
        return res.status(200).json({ bookings });
      }
    }

    const { action, booking } = req.body;

    if (action === 'create') {
      // First get database schema to understand property types
      const schemaRes = await fetch(`https://api.notion.com/v1/databases/${DATABASE_ID}`, { headers: NOTION_HEADERS });
      const schema = await schemaRes.json();
      const props = schema.properties || {};

      // Build properties dynamically based on actual types
      const buildProp = (key, value) => {
        if (!props[key] || !value) return null;
        const type = props[key].type;
        if (type === 'title') return { title: [{ text: { content: String(value) } }] };
        if (type === 'rich_text') return { rich_text: [{ text: { content: String(value) } }] };
        if (type === 'email') return { email: String(value) };
        if (type === 'phone_number') return { phone_number: String(value) };
        if (type === 'date') return { date: { start: String(value) } };
        if (type === 'multi_select') return { multi_select: [{ name: String(value) }] };
        if (type === 'select') return { select: { name: String(value) } };
        return { rich_text: [{ text: { content: String(value) } }] };
      };

      const properties = {};
      const fields = {
        'Property Address': booking.addr,
        'Preferred Shoot Date': booking.date,
        'Time': booking.slot,
        'Agent': booking.name,
        'E-mail': booking.email,
        'Phone': booking.phone,
        'What services do you need?': booking.pkg,
        'Approximate square footage': booking.sqft,
        'Lockbox code or access instructions': booking.lockbox,
        'Video Orientation': booking.orientation,
        'Additional Notes': booking.notes,
      };
      for (const [key, value] of Object.entries(fields)) {
        const built = buildProp(key, value);
        if (built) properties[key] = built;
      }

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
