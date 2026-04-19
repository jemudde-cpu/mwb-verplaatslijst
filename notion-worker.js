// ══════════════════════════════════════════════════════
//  MWB Verplaatslijst v2 – Cloudflare Worker
//  Bindings vereist:
//    - MWB_KLUSSEN  (KV namespace)
//    - MWB_FOTOS    (R2 bucket)
//    - NOTION_TOKEN (secret)
//    - NOTION_DB_ID (env var)
// ══════════════════════════════════════════════════════

export default {
  async fetch(request, env) {

    const CORS = {
      'Access-Control-Allow-Origin':  '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS });
    }

    // ── GET ──────────────────────────────────────────
    if (request.method === 'GET') {
      const url    = new URL(request.url);
      const action = url.searchParams.get('action');

      // Klussen ophalen uit KV
      if (action === 'klussen') {
        try {
          const raw     = await env.MWB_KLUSSEN.get('klussen');
          const klussen = raw ? JSON.parse(raw) : [];
          return new Response(JSON.stringify({ ok: true, klussen }), {
            headers: { ...CORS, 'Content-Type': 'application/json' },
          });
        } catch (e) {
          return new Response(JSON.stringify({ ok: false, error: e.message }), {
            status: 500, headers: { ...CORS, 'Content-Type': 'application/json' },
          });
        }
      }

      // Inzendingen ophalen uit Notion
      if (action === 'inzendingen') {
        try {
          const res = await fetch(
            `https://api.notion.com/v1/databases/${env.NOTION_DB_ID}/query`,
            {
              method: 'POST',
              headers: {
                'Authorization':  `Bearer ${env.NOTION_TOKEN}`,
                'Notion-Version': '2022-06-28',
                'Content-Type':   'application/json',
              },
              body: JSON.stringify({
                sorts: [{ property: 'Datum', direction: 'descending' }],
                page_size: 100,
              }),
            }
          );
          if (!res.ok) {
            const err = await res.text();
            return new Response(JSON.stringify({ ok: false, error: err }), {
              status: 500, headers: { ...CORS, 'Content-Type': 'application/json' },
            });
          }
          const data = await res.json();
          return new Response(JSON.stringify({ ok: true, results: data.results }), {
            headers: { ...CORS, 'Content-Type': 'application/json' },
          });
        } catch (e) {
          return new Response(JSON.stringify({ ok: false, error: e.message }), {
            status: 500, headers: { ...CORS, 'Content-Type': 'application/json' },
          });
        }
      }

      // Foto serveren vanuit R2
      if (action === 'foto') {
        try {
          const naam = url.searchParams.get('naam');
          if (!naam) return new Response('Missing naam', { status: 400, headers: CORS });
          const obj = await env.MWB_FOTOS.get(naam);
          if (!obj) return new Response('Not found', { status: 404, headers: CORS });
          const data = await obj.arrayBuffer();
          return new Response(data, {
            headers: {
              ...CORS,
              'Content-Type':  obj.httpMetadata?.contentType || 'image/jpeg',
              'Cache-Control': 'public, max-age=31536000',
            },
          });
        } catch (e) {
          return new Response(JSON.stringify({ ok: false, error: e.message }), {
            status: 500, headers: { ...CORS, 'Content-Type': 'application/json' },
          });
        }
      }

      return new Response('Not found', { status: 404, headers: CORS });
    }

    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405, headers: CORS });
    }

    // ── POST ─────────────────────────────────────────
    try {
      const data = await request.json();

      // Klussen opslaan in KV
      if (data.action === 'klussen_opslaan') {
        await env.MWB_KLUSSEN.put('klussen', JSON.stringify(data.klussen || []));
        return new Response(JSON.stringify({ ok: true }), {
          headers: { ...CORS, 'Content-Type': 'application/json' },
        });
      }

      // Foto uploaden naar R2
      if (data.action === 'foto_upload') {
        const { bestandsnaam, data: b64, contentType = 'image/jpeg' } = data;
        if (!bestandsnaam || !b64) {
          return new Response(JSON.stringify({ ok: false, error: 'Missing bestandsnaam or data' }), {
            status: 400, headers: { ...CORS, 'Content-Type': 'application/json' },
          });
        }
        const rawB64   = b64.replace(/^data:[^;]+;base64,/, '');
        const binStr   = atob(rawB64);
        const bytes    = new Uint8Array(binStr.length);
        for (let i = 0; i < binStr.length; i++) bytes[i] = binStr.charCodeAt(i);

        await env.MWB_FOTOS.put(bestandsnaam, bytes.buffer, {
          httpMetadata: { contentType },
        });

        const workerBase = new URL(request.url).origin;
        const fotoUrl    = `${workerBase}?action=foto&naam=${encodeURIComponent(bestandsnaam)}`;
        return new Response(JSON.stringify({ ok: true, url: fotoUrl }), {
          headers: { ...CORS, 'Content-Type': 'application/json' },
        });
      }

      // Verplaatsing opslaan in Notion
      const typeLabel = {
        zaak_klus: 'Van zaak → Klus',
        klus_klus: 'Klus → Klus',
        klus_zaak: 'Klus → Zaak',
      }[data.beweging_type] || data.beweging_type || '';

      let details = '';
      if (data.onderdelen) {
        for (const item of Object.values(data.onderdelen)) {
          if (item.aantal && parseInt(item.aantal) > 0) {
            details += `${item.naam}: ${item.aantal}`;
            if (item.nummers) details += ` (nr. ${item.nummers})`;
            if (item.types)   details += ` [${item.types}]`;
            if (item.stuk && parseInt(item.stuk) > 0) details += ` (${item.stuk} stuk/weggegooid)`;
            if (item.opm)     details += ` – ${item.opm}`;
            details += '\n';
          }
        }
      }

      // Foto URLs toevoegen aan details
      if (data.foto_urls && data.foto_urls.length > 0) {
        details += `\nFoto's (${data.foto_urls.length}):\n` + data.foto_urls.map(f => f.url).join('\n');
      }

      const naarNaam  = data.naar_naam   || '';
      const vanNaam   = data.van_naam    || '';
      const naarNr    = data.naar_werknr || '';
      const vanNr     = data.van_werknr  || '';
      const naamTitle = `${naarNaam || vanNaam} – ${data.datum || '?'}`;

      const notionBody = {
        parent: { database_id: env.NOTION_DB_ID },
        properties: {
          'Naam':          { title:     [{ text: { content: naamTitle } }] },
          'Bouwplaats':    { rich_text: [{ text: { content: naarNaam } }] },
          'Werknr. Van':   { rich_text: [{ text: { content: vanNr  || vanNaam  } }] },
          'Werknr. Naar':  { rich_text: [{ text: { content: naarNr || naarNaam } }] },
          'Opslag / Zaak': { rich_text: [{ text: { content: typeLabel } }] },
          'Ingevuld door': { rich_text: [{ text: { content: data.naam || '' } }] },
          'Details':       { rich_text: [{ text: { content: details.slice(0, 2000) } }] },
          'Opmerkingen':   { rich_text: [{ text: { content: data.algemeen_opmerking || '' } }] },
          'Status':        { select:    { name: 'Nieuw' } },
        },
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
          status: 500, headers: { ...CORS, 'Content-Type': 'application/json' },
        });
      }

      return new Response(JSON.stringify({ ok: true }), {
        headers: { ...CORS, 'Content-Type': 'application/json' },
      });

    } catch (e) {
      return new Response(JSON.stringify({ ok: false, error: e.message }), {
        status: 500, headers: { ...CORS, 'Content-Type': 'application/json' },
      });
    }
  },
};
