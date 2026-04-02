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

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS });
    }

    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405, headers: CORS });
    }

    try {
      const data = await request.json();

      // ── Bewegingstype label ──
      const typeLabel = {
        zaak_klus: 'Van zaak → Klus',
        klus_klus: 'Klus → Klus',
        klus_zaak: 'Klus → Zaak',
      }[data.beweging_type] || data.beweging_type || '';

      // ── Details tekst opbouwen ──
      let details = '';
      if (data.onderdelen) {
        for (const item of Object.values(data.onderdelen)) {
          if (item.aantal && parseInt(item.aantal) > 0) {
            details += `${item.naam}: ${item.aantal}`;
            if (item.nummer) details += ` (nr. ${item.nummer})`;
            if (item.types)  details += ` [${item.types}]`;
            if (item.opm)    details += ` – ${item.opm}`;
            details += '\n';
          }
        }
      }

      // ── Notion pagina aanmaken ──
      const naar     = data.naar_naam  || '';
      const van      = data.van_naam   || '';
      const naarNr   = data.naar_werknr || '';
      const vanNr    = data.van_werknr  || '';
      const naamTitle = `${naar || van} – ${data.datum || '?'}`;

      const notionBody = {
        parent: { database_id: env.NOTION_DB_ID },
        properties: {
          'Naam': {
            title: [{ text: { content: naamTitle } }]
          },
          'Bouwplaats':    { rich_text: [{ text: { content: naar } }] },
          'Werknr. Van':   { rich_text: [{ text: { content: vanNr  || (van  ? `${van}`  : '') } }] },
          'Werknr. Naar':  { rich_text: [{ text: { content: naarNr || (naar ? `${naar}` : '') } }] },
          'Opslag / Zaak': { rich_text: [{ text: { content: typeLabel } }] },
          'Ingevuld door': { rich_text: [{ text: { content: data.naam || '' } }] },
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
