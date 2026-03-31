// ══════════════════════════════════════════════════════
//  MWB Verplaatslijst – Cloudflare Worker
//  Ontvangt formulierdata en stuurt naar Notion
// ══════════════════════════════════════════════════════

export default {
  async fetch(request, env) {

    const CORS = {
      'Access-Control-Allow-Origin':  '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    // Preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS });
    }

    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405, headers: CORS });
    }

    try {
      const data = await request.json();

      // ── Details tekst opbouwen uit onderdelen ──
      let details = '';
      if (data.onderdelen) {
        for (const item of Object.values(data.onderdelen)) {
          if (item.aantal && parseInt(item.aantal) > 0) {
            details += `${item.naam}: ${item.aantal}`;
            if (item.nummer) details += ` (nr. ${item.nummer})`;
            if (item.van)    details += ` | van: ${item.van}`;
            if (item.naar)   details += ` | naar: ${item.naar}`;
            if (item.opslag) details += ` | opslag: ${item.opslag}`;
            if (item.opm)    details += ` – ${item.opm}`;
            details += '\n';
          }
        }
      }

      // ── Notion pagina aanmaken ──
      const notionBody = {
        parent: { database_id: env.NOTION_DB_ID },
        properties: {
          'Naam': {
            title: [{
              text: {
                content: `${data.bouwplaats || 'Onbekend'} – ${data.datum || '?'}`
              }
            }]
          },
          'Bouwplaats':    { rich_text: [{ text: { content: data.bouwplaats    || '' } }] },
          'Werknr. Van':   { rich_text: [{ text: { content: data.glob_van      || '' } }] },
          'Werknr. Naar':  { rich_text: [{ text: { content: data.glob_naar     || '' } }] },
          'Opslag / Zaak': { rich_text: [{ text: { content: data.glob_opslag   || '' } }] },
          'Ingevuld door': { rich_text: [{ text: { content: data.naam          || '' } }] },
          'Details':       { rich_text: [{ text: { content: details.slice(0, 2000) } }] },
          'Opmerkingen':   { rich_text: [{ text: { content: data.algemeen_opmerking || '' } }] },
          'Status':        { select: { name: 'Nieuw' } },
        }
      };

      if (data.datum) {
        notionBody.properties['Datum'] = { date: { start: data.datum } };
      }

      const res = await fetch('https://api.notion.com/v1/pages', {
        method: 'POST',
        headers: {
          'Authorization':  `Bearer ${env.NOTION_TOKEN}`,
          'Notion-Version': '2022-06-28',
          'Content-Type':   'application/json',
        },
        body: JSON.stringify(notionBody),
      });

      if (!res.ok) {
        const err = await res.text();
        return new Response(JSON.stringify({ ok: false, error: err }), {
          status: 500,
          headers: { ...CORS, 'Content-Type': 'application/json' }
        });
      }

      return new Response(JSON.stringify({ ok: true }), {
        headers: { ...CORS, 'Content-Type': 'application/json' }
      });

    } catch (e) {
      return new Response(JSON.stringify({ ok: false, error: e.message }), {
        status: 500,
        headers: { ...CORS, 'Content-Type': 'application/json' }
      });
    }
  }
};
