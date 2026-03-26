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
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    if (req.method === 'GET') {
      // Query all pages, filter by date in app
      const response = await fetch(`https://api.notion.com/v1/databases/${DATABASE_ID}/query`, {
        method: 'POST',
        headers: NOTION_HEADERS,
        body: JSON.stringify({ page_size: 100 })
      });
      const data = await response.json();
      if (!response.ok) {
        console.error('Notion error:', JSON.stringify(data));
        return res.status(400).json({ error: data });
      }

      const results = data.results || [];
      const full = req.query?.full === '1';

      if (full) {
        const bookings = results.map(p => {
          const props = p.properties;
          const getText = (k) => props[k]?.rich_text?.[0]?.text?.content || props[k]?.title?.[0]?.text?.content || '';
          return {
            pageId: p.id,
            date: props['Preferred Shoot Date']?.date?.start || '',
            slot: getText('Time'),
            name: getText('Agent'),
            email: props['E-mail']?.email || '',
            phone: props['Phone']?.phone_number || '',
            addr: props['Property Address']?.title?.[0]?.text?.content || getText('Property Address'),
            pkg: getText('What services do you need?'),
            sqft: getText('Approximate square footage'),
            lockbox: getText('Lockbox code or access instructions'),
            orientation: getText('Video Orientation'),
            notes: getText('Additional Notes'),
          };
        }).filter(b => b.date && b.slot);
        return res.status(200).json({ bookings });
      } else {
        const bookings = results.map(p => ({
          date: p.properties['Preferred Shoot Date']?.date?.start || '',
          slot: p.properties['Time']?.rich_text?.[0]?.text?.content || '',
        })).filter(b => b.date && b.slot);
        return res.status(200).json({ bookings });
      }
    }

    const { action, booking } = req.body;

    if (action === 'create') {
      // Title = address, everything else in body as plain text
      const body = [
        `Date: ${booking.date}`,
        `Time: ${booking.slot}`,
        `Name: ${booking.name}`,
        `Email: ${booking.email}`,
        `Phone: ${booking.phone}`,
        `Package: ${booking.pkg}`,
        `Sq Ft: ${booking.sqft || '—'}`,
        `Orientation: ${booking.orientation || '—'}`,
        `Lockbox: ${booking.lockbox || '—'}`,
        `Notes: ${booking.notes || '—'}`,
      ].join('\n');

      const response = await fetch('https://api.notion.com/v1/pages', {
        method: 'POST',
        headers: NOTION_HEADERS,
        body: JSON.stringify({
          parent: { database_id: DATABASE_ID },
          properties: {
            'Property Address': {
              title: [{ text: { content: booking.addr || 'New Booking' } }]
            },
            'Preferred Shoot Date': { date: { start: booking.date } },
            'Time': { rich_text: [{ text: { content: booking.slot || '' } }] },
            'Agent': { rich_text: [{ text: { content: booking.name || '' } }] },
            'E-mail': { email: booking.email || '' },
            'Phone': { phone_number: booking.phone || '' },
          },
          children: [{
            object: 'block',
            type: 'paragraph',
            paragraph: {
              rich_text: [{ type: 'text', text: { content: body } }]
            }
          }]
        })
      });
      const data = await response.json();
      if (!response.ok) {
        console.error('Notion create error:', JSON.stringify(data));
        return res.status(400).json({ error: data });
      }
      return res.status(200).json({ pageId: data.id });
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (err) {
    console.error('Handler error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
