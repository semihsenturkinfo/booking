const NOTION_TOKEN = process.env.NOTION_TOKEN;
const DATABASE_ID = '41d4df128c834c17963bfab567deca2e';

const NOTION_HEADERS = {
  'Authorization': `Bearer ${NOTION_TOKEN}`,
  'Content-Type': 'application/json',
  'Notion-Version': '2022-06-28',
};

function getText(prop){return prop?.rich_text?.[0]?.text?.content||''}
function getTitle(prop){return prop?.title?.[0]?.text?.content||''}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    if (req.method === 'GET') {
      const full = req.query?.full === '1';
      const response = await fetch(`https://api.notion.com/v1/databases/${DATABASE_ID}/query`, {
        method: 'POST',
        headers: NOTION_HEADERS,
        body: JSON.stringify({
          filter: {
            and: [
              { property: 'Preferred Shoot Date', date: { is_not_empty: true } },
              { property: 'Time', rich_text: { is_not_empty: true } },
            ]
          },
          sorts: [{ property: 'Preferred Shoot Date', direction: 'ascending' }],
          page_size: 100
        })
      });
      const data = await response.json();
      if (!response.ok) { console.error('Notion error:', JSON.stringify(data)); return res.status(400).json({ error: data }); }

      const results = data.results || [];

      if (full) {
        const bookings = results.map(p => ({
          pageId: p.id,
          date: p.properties['Preferred Shoot Date']?.date?.start || '',
          slot: getText(p.properties['Time']),
          name: getText(p.properties['Agent']),
          email: p.properties['E-mail']?.email || '',
          phone: p.properties['Phone']?.phone_number || '',
          addr: getTitle(p.properties['Property Address']),
          pkg: getText(p.properties['What services do you need?']),
          sqft: getText(p.properties['Approximate square footage']),
          lockbox: getText(p.properties['Lockbox code or access instructions']),
          orientation: getText(p.properties['Video Orientation']),
          notes: getText(p.properties['Additional Notes']),
        }));
        return res.status(200).json({ bookings });
      } else {
        const bookings = results.map(p => ({
          date: p.properties['Preferred Shoot Date']?.date?.start || '',
          slot: getText(p.properties['Time']),
        })).filter(b => b.date && b.slot);
        return res.status(200).json({ bookings });
      }
    }

    const { action, booking } = req.body;

    if (action === 'create') {
      const response = await fetch('https://api.notion.com/v1/pages', {
        method: 'POST',
        headers: NOTION_HEADERS,
        body: JSON.stringify({
          parent: { database_id: DATABASE_ID },
          properties: {
            'Property Address': { title: [{ text: { content: booking.addr || '' } }] },
            'Agent': { rich_text: [{ text: { content: booking.name || '' } }] },
            'E-mail': { email: booking.email || '' },
            'Phone': { phone_number: booking.phone || '' },
            'Preferred Shoot Date': { date: { start: booking.date } },
            'Time': { rich_text: [{ text: { content: booking.slot || '' } }] },
            'What services do you need?': { rich_text: [{ text: { content: booking.pkg || '' } }] },
            'Approximate square footage': { rich_text: [{ text: { content: booking.sqft || '' } }] },
            'Lockbox code or access instructions': { rich_text: [{ text: { content: booking.lockbox || '' } }] },
            'Video Orientation': { rich_text: [{ text: { content: booking.orientation || '' } }] },
            'Additional Notes': { rich_text: [{ text: { content: booking.notes || '' } }] },
          }
        })
      });
      const data = await response.json();
      if (!response.ok) { console.error('Notion error:', JSON.stringify(data)); return res.status(400).json({ error: data }); }
      return res.status(200).json({ pageId: data.id });
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
