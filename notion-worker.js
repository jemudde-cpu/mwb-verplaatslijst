// ══════════════════════════════════════════════════════
//  MWB Verplaatslijst v3 – Cloudflare Worker
//  Bindings vereist:
//    - MWB_KLUSSEN  (KV namespace)
//    - MWB_FOTOS    (R2 bucket)
//    - NOTION_TOKEN (secret)
//    - NOTION_DB_ID (env var)
//    - JWT_SECRET   (secret)  ← nieuw, stel in via Cloudflare dashboard
// ══════════════════════════════════════════════════════

const ALLOWED_ORIGINS = [
  'https://jemudde-cpu.github.io',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
];

export default {
  async fetch(request, env) {
    const origin     = request.headers.get('Origin') || '';
    const corsOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];

    const CORS = {
      'Access-Control-Allow-Origin':  corsOrigin,
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Vary': 'Origin',
    };

    const json = (data, status = 200) =>
      new Response(JSON.stringify(data), {
        status,
        headers: { ...CORS, 'Content-Type': 'application/json' },
      });

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS });
    }

    // ── CRYPTO HELPERS ───────────────────────────────
    const te         = new TextEncoder();
    const JWT_SECRET = env.JWT_SECRET || 'dev-secret-vervang-mij-in-productie';

    function b64url(str) {
      return btoa(str).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
    }
    function b64urlBuf(buf) {
      return btoa(String.fromCharCode(...new Uint8Array(buf)))
        .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
    }
    function b64urlDec(s) {
      return atob(s.replace(/-/g, '+').replace(/_/g, '/'));
    }

    async function signJWT(payload) {
      const h   = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
      const p   = b64url(JSON.stringify(payload));
      const msg = `${h}.${p}`;
      const key = await crypto.subtle.importKey(
        'raw', te.encode(JWT_SECRET),
        { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
      );
      const sig = await crypto.subtle.sign('HMAC', key, te.encode(msg));
      return `${msg}.${b64urlBuf(sig)}`;
    }

    async function verifyJWT(token) {
      if (!token || typeof token !== 'string') return null;
      const parts = token.split('.');
      if (parts.length !== 3) return null;
      const [h, p, s] = parts;
      try {
        const key   = await crypto.subtle.importKey(
          'raw', te.encode(JWT_SECRET),
          { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']
        );
        const sig   = Uint8Array.from(b64urlDec(s), c => c.charCodeAt(0));
        const valid = await crypto.subtle.verify('HMAC', key, sig, te.encode(`${h}.${p}`));
        if (!valid) return null;
        const payload = JSON.parse(b64urlDec(p));
        if (payload.exp < Math.floor(Date.now() / 1000)) return null;
        return payload;
      } catch { return null; }
    }

    async function hashPw(password, salt) {
      const key  = await crypto.subtle.importKey('raw', te.encode(password), 'PBKDF2', false, ['deriveBits']);
      const bits = await crypto.subtle.deriveBits(
        { name: 'PBKDF2', salt: te.encode(salt), iterations: 100000, hash: 'SHA-256' },
        key, 256
      );
      return btoa(String.fromCharCode(...new Uint8Array(bits)));
    }

    // ── USER HELPERS ─────────────────────────────────
    async function getUsers() {
      const raw = await env.MWB_KLUSSEN.get('mwb_users');
      return raw ? JSON.parse(raw) : [];
    }
    async function saveUsers(users) {
      await env.MWB_KLUSSEN.put('mwb_users', JSON.stringify(users));
    }

    // ── REQUEST HELPERS ──────────────────────────────
    function getToken(req, body = null) {
      const auth = req.headers.get('Authorization') || '';
      if (auth.startsWith('Bearer ')) return auth.slice(7).trim();
      const url = new URL(req.url);
      return url.searchParams.get('token') || body?.token || null;
    }

    function sanitize(s, max = 500) {
      if (typeof s !== 'string') return '';
      return s.replace(/[<>"']/g, '').trim().slice(0, max);
    }

    // ── GET ──────────────────────────────────────────
    if (request.method === 'GET') {
      const url    = new URL(request.url);
      const action = url.searchParams.get('action');

      // Klussen ophalen (publiek – niet gevoelig)
      if (action === 'klussen') {
        try {
          const raw     = await env.MWB_KLUSSEN.get('klussen');
          const klussen = raw ? JSON.parse(raw) : [];
          return json({ ok: true, klussen });
        } catch (e) {
          return json({ ok: false, error: e.message }, 500);
        }
      }

      // Setup status (publiek)
      if (action === 'setup_status') {
        const users = await getUsers();
        return json({ ok: true, hasUsers: users.length > 0 });
      }

      // Mijn inzendingen (ingelogde gebruiker, gefilterd op naam)
      if (action === 'mijn_inzendingen') {
        const token   = getToken(request);
        const payload = await verifyJWT(token);
        if (!payload) return json({ ok: false, error: 'Niet ingelogd' }, 401);
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
                filter: { property: 'Ingevuld door', rich_text: { equals: payload.naam } },
                sorts:  [{ property: 'Datum', direction: 'descending' }],
                page_size: 100,
              }),
            }
          );
          if (!res.ok) { const err = await res.text(); return json({ ok: false, error: err }, 500); }
          const data = await res.json();
          return json({ ok: true, results: data.results, has_more: data.has_more });
        } catch (e) {
          return json({ ok: false, error: e.message }, 500);
        }
      }

      // Inzendingen (alle ingelogde gebruikers) — met paginering
      if (action === 'inzendingen') {
        const token   = getToken(request);
        const payload = await verifyJWT(token);
        if (!payload) {
          return json({ ok: false, error: 'Niet ingelogd' }, 401);
        }
        try {
          const alleResultaten = [];
          let cursor = undefined;
          do {
            const body = {
              sorts: [{ property: 'Datum', direction: 'descending' }],
              page_size: 100,
            };
            if (cursor) body.start_cursor = cursor;
            const res = await fetch(
              `https://api.notion.com/v1/databases/${env.NOTION_DB_ID}/query`,
              {
                method: 'POST',
                headers: {
                  'Authorization':  `Bearer ${env.NOTION_TOKEN}`,
                  'Notion-Version': '2022-06-28',
                  'Content-Type':   'application/json',
                },
                body: JSON.stringify(body),
              }
            );
            if (!res.ok) {
              const err = await res.text();
              return json({ ok: false, error: err }, 500);
            }
            const data = await res.json();
            alleResultaten.push(...data.results);
            cursor = data.has_more ? data.next_cursor : undefined;
          } while (cursor);
          return json({ ok: true, results: alleResultaten });
        } catch (e) {
          return json({ ok: false, error: e.message }, 500);
        }
      }

      // Foto serveren vanuit R2 (publiek – URLs zijn uniek en onraadbaar)
      if (action === 'foto') {
        try {
          const naam = url.searchParams.get('naam') || '';
          if (!naam || naam.length > 200) {
            return new Response('Bad request', { status: 400, headers: CORS });
          }
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
          return json({ ok: false, error: e.message }, 500);
        }
      }

      // Gebruikers ophalen (admin)
      if (action === 'gebruikers') {
        const token   = getToken(request);
        const payload = await verifyJWT(token);
        if (!payload || payload.role !== 'admin') {
          return json({ ok: false, error: 'Geen toegang' }, 401);
        }
        const users = await getUsers();
        return json({
          ok: true,
          gebruikers: users.map(u => ({
            gebruikersnaam: u.gebruikersnaam,
            naam:           u.naam || u.gebruikersnaam,
            role:           u.role || 'user',
          })),
        });
      }

      return new Response('Not found', { status: 404, headers: CORS });
    }

    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405, headers: CORS });
    }

    // ── POST ─────────────────────────────────────────
    let data;
    try {
      data = await request.json();
    } catch {
      return json({ ok: false, error: 'Ongeldige JSON' }, 400);
    }

    // ── LOGIN ─────────────────────────────────────────
    if (data.action === 'login') {
      const gebruikersnaam = sanitize(data.gebruikersnaam || '', 50).toLowerCase();
      const wachtwoord     = typeof data.wachtwoord === 'string' ? data.wachtwoord.slice(0, 200) : '';
      if (!gebruikersnaam || !wachtwoord) {
        return json({ ok: false, error: 'Vul gebruikersnaam en wachtwoord in' }, 400);
      }
      const users = await getUsers();
      const user  = users.find(u => u.gebruikersnaam === gebruikersnaam);
      if (!user) {
        // Zelfde foutmelding als verkeerd wachtwoord (timing-attack preventie)
        await hashPw('dummy', 'dummy-salt');
        return json({ ok: false, error: 'Onjuiste inloggegevens' }, 401);
      }
      const hash = await hashPw(wachtwoord, user.salt);
      if (hash !== user.wachtwoord_hash) {
        return json({ ok: false, error: 'Onjuiste inloggegevens' }, 401);
      }
      const token = await signJWT({
        sub:  user.gebruikersnaam,
        naam: user.naam || user.gebruikersnaam,
        role: user.role || 'user',
        exp:  Math.floor(Date.now() / 1000) + 8 * 3600,
      });
      return json({ ok: true, token, naam: user.naam || user.gebruikersnaam, role: user.role || 'user' });
    }

    // ── REGISTREREN (publiek, altijd rol user) ───────────
    if (data.action === 'registreren') {
      const gebruikersnaam = sanitize(data.gebruikersnaam || '', 50).toLowerCase();
      const naam           = sanitize(data.naam || data.gebruikersnaam || '', 100);
      const wachtwoord     = typeof data.wachtwoord === 'string' ? data.wachtwoord : '';
      if (!gebruikersnaam || wachtwoord.length < 6) {
        return json({ ok: false, error: 'Gebruikersnaam vereist en wachtwoord minimaal 6 tekens' }, 400);
      }
      if (!/^[a-z0-9._\- ]+$/.test(gebruikersnaam)) {
        return json({ ok: false, error: 'Gebruikersnaam: alleen letters, cijfers, punt, streepje of spatie' }, 400);
      }
      const users = await getUsers();
      if (users.find(u => u.gebruikersnaam === gebruikersnaam)) {
        return json({ ok: false, error: 'Gebruikersnaam al in gebruik' }, 409);
      }
      const salt = crypto.randomUUID();
      const hash = await hashPw(wachtwoord, salt);
      users.push({ gebruikersnaam, naam, wachtwoord_hash: hash, salt, role: 'user' });
      await saveUsers(users);
      const token = await signJWT({
        sub:  gebruikersnaam,
        naam: naam || gebruikersnaam,
        role: 'user',
        exp:  Math.floor(Date.now() / 1000) + 8 * 3600,
      });
      return json({ ok: true, token, naam: naam || gebruikersnaam, role: 'user' });
    }

    // ── SETUP (eerste admin, alleen als er nog geen gebruikers zijn) ──
    if (data.action === 'setup') {
      const users = await getUsers();
      if (users.length > 0) {
        return json({ ok: false, error: 'Setup al voltooid' }, 403);
      }
      const gebruikersnaam = sanitize(data.gebruikersnaam || '', 50).toLowerCase();
      const naam           = sanitize(data.naam || data.gebruikersnaam || '', 100);
      const wachtwoord     = typeof data.wachtwoord === 'string' ? data.wachtwoord : '';
      if (!gebruikersnaam || wachtwoord.length < 8) {
        return json({ ok: false, error: 'Gebruikersnaam vereist en wachtwoord minimaal 8 tekens' }, 400);
      }
      if (!/^[a-z0-9._\- ]+$/.test(gebruikersnaam)) {
        return json({ ok: false, error: 'Gebruikersnaam: alleen letters, cijfers, punt, streepje of spatie' }, 400);
      }
      const salt = crypto.randomUUID();
      const hash = await hashPw(wachtwoord, salt);
      await saveUsers([{ gebruikersnaam, naam, wachtwoord_hash: hash, salt, role: 'admin' }]);
      const token = await signJWT({
        sub:  gebruikersnaam,
        naam: naam || gebruikersnaam,
        role: 'admin',
        exp:  Math.floor(Date.now() / 1000) + 8 * 3600,
      });
      return json({ ok: true, token, naam: naam || gebruikersnaam, role: 'admin' });
    }

    // ── GEBRUIKER AANMAKEN (admin) ────────────────────
    if (data.action === 'gebruiker_aanmaken') {
      const token   = getToken(request, data);
      const payload = await verifyJWT(token);
      if (!payload || payload.role !== 'admin') {
        return json({ ok: false, error: 'Geen toegang' }, 401);
      }
      const gebruikersnaam = sanitize(data.gebruikersnaam || '', 50).toLowerCase();
      const naam           = sanitize(data.naam || data.gebruikersnaam || '', 100);
      const wachtwoord     = typeof data.wachtwoord === 'string' ? data.wachtwoord : '';
      const role           = data.role === 'admin' ? 'admin' : 'user';

      if (!gebruikersnaam || wachtwoord.length < 6) {
        return json({ ok: false, error: 'Gebruikersnaam vereist en wachtwoord minimaal 6 tekens' }, 400);
      }
      if (!/^[a-z0-9._\- ]+$/.test(gebruikersnaam)) {
        return json({ ok: false, error: 'Gebruikersnaam: alleen letters, cijfers, punt, streepje of spatie' }, 400);
      }
      const users = await getUsers();
      if (users.find(u => u.gebruikersnaam === gebruikersnaam)) {
        return json({ ok: false, error: 'Gebruikersnaam al in gebruik' }, 409);
      }
      const salt = crypto.randomUUID();
      const hash = await hashPw(wachtwoord, salt);
      users.push({ gebruikersnaam, naam, wachtwoord_hash: hash, salt, role });
      await saveUsers(users);
      return json({ ok: true });
    }

    // ── GEBRUIKER VERWIJDEREN (admin) ─────────────────
    if (data.action === 'gebruiker_verwijderen') {
      const token   = getToken(request, data);
      const payload = await verifyJWT(token);
      if (!payload || payload.role !== 'admin') {
        return json({ ok: false, error: 'Geen toegang' }, 401);
      }
      const gebruikersnaam = sanitize(data.gebruikersnaam || '', 50).toLowerCase();
      if (!gebruikersnaam) return json({ ok: false, error: 'Gebruikersnaam vereist' }, 400);
      if (gebruikersnaam === payload.sub) {
        return json({ ok: false, error: 'Je kunt jezelf niet verwijderen' }, 400);
      }
      const users = await getUsers();
      const idx   = users.findIndex(u => u.gebruikersnaam === gebruikersnaam);
      if (idx < 0) return json({ ok: false, error: 'Gebruiker niet gevonden' }, 404);
      users.splice(idx, 1);
      await saveUsers(users);
      return json({ ok: true });
    }

    // ── WACHTWOORD WIJZIGEN (ingelogde gebruiker) ─────
    if (data.action === 'wachtwoord_wijzigen') {
      const token   = getToken(request, data);
      const payload = await verifyJWT(token);
      if (!payload) return json({ ok: false, error: 'Niet ingelogd' }, 401);

      const wachtwoord_nieuw = typeof data.wachtwoord_nieuw === 'string' ? data.wachtwoord_nieuw : '';
      if (wachtwoord_nieuw.length < 6) {
        return json({ ok: false, error: 'Nieuw wachtwoord minimaal 6 tekens' }, 400);
      }
      const users = await getUsers();
      const idx   = users.findIndex(u => u.gebruikersnaam === payload.sub);
      if (idx < 0) return json({ ok: false, error: 'Gebruiker niet gevonden' }, 404);
      const salt = crypto.randomUUID();
      const hash = await hashPw(wachtwoord_nieuw, salt);
      users[idx].wachtwoord_hash = hash;
      users[idx].salt            = salt;
      await saveUsers(users);
      return json({ ok: true });
    }

    // ── KLUSSEN OPSLAAN (admin) ───────────────────────
    if (data.action === 'klussen_opslaan') {
      const token   = getToken(request, data);
      const payload = await verifyJWT(token);
      if (!payload || payload.role !== 'admin') {
        return json({ ok: false, error: 'Geen toegang' }, 401);
      }
      if (!Array.isArray(data.klussen)) return json({ ok: false, error: 'Ongeldige data' }, 400);
      const klussen = data.klussen.slice(0, 500).map(k => ({
        naam:   sanitize(k.naam   || '', 200),
        werknr: sanitize(k.werknr || '', 50),
      })).filter(k => k.naam && k.werknr);
      await env.MWB_KLUSSEN.put('klussen', JSON.stringify(klussen));
      return json({ ok: true });
    }

    // ── FOTO UPLOADEN (ingelogde gebruiker) ───────────
    if (data.action === 'foto_upload') {
      const token   = getToken(request, data);
      const payload = await verifyJWT(token);
      if (!payload) return json({ ok: false, error: 'Niet ingelogd' }, 401);

      const { bestandsnaam, data: b64 } = data;
      if (!bestandsnaam || !b64) {
        return json({ ok: false, error: 'Missing bestandsnaam or data' }, 400);
      }
      if (bestandsnaam.length > 200 || b64.length > 5_000_000) {
        return json({ ok: false, error: 'Bestand te groot (max 5MB)' }, 400);
      }
      const safeName = bestandsnaam.replace(/[^a-zA-Z0-9._\-]/g, '_');
      const rawB64   = b64.replace(/^data:[^;]+;base64,/, '');
      const binStr   = atob(rawB64);
      const bytes    = new Uint8Array(binStr.length);
      for (let i = 0; i < binStr.length; i++) bytes[i] = binStr.charCodeAt(i);

      await env.MWB_FOTOS.put(safeName, bytes.buffer, {
        httpMetadata: { contentType: 'image/jpeg' },
      });
      const fotoUrl = `${new URL(request.url).origin}?action=foto&naam=${encodeURIComponent(safeName)}`;
      return json({ ok: true, url: fotoUrl });
    }

    // ── STATUS WIJZIGEN (admin) ───────────────────────────
    if (data.action === 'status_wijzigen') {
      const token   = getToken(request, data);
      const payload = await verifyJWT(token);
      if (!payload || payload.role !== 'admin') {
        return json({ ok: false, error: 'Geen toegang' }, 401);
      }
      const pageId = (data.page_id || '').replace(/[^a-f0-9\-]/gi, '').slice(0, 36);
      const status = data.status === 'Verwerkt' ? 'Verwerkt' : 'Nieuw';
      if (!pageId) return json({ ok: false, error: 'page_id vereist' }, 400);
      try {
        const res = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
          method: 'PATCH',
          headers: {
            'Authorization':  `Bearer ${env.NOTION_TOKEN}`,
            'Notion-Version': '2022-06-28',
            'Content-Type':   'application/json',
          },
          body: JSON.stringify({ properties: { 'Status': { select: { name: status } } } }),
        });
        if (!res.ok) { const err = await res.text(); return json({ ok: false, error: err }, 500); }
        return json({ ok: true });
      } catch (e) {
        return json({ ok: false, error: e.message }, 500);
      }
    }

    // ── INZENDING VERWIJDEREN (admin) ────────────────────
    if (data.action === 'inzending_verwijderen') {
      const token   = getToken(request, data);
      const payload = await verifyJWT(token);
      if (!payload || payload.role !== 'admin') {
        return json({ ok: false, error: 'Geen toegang' }, 401);
      }
      const pageId = (data.page_id || '').replace(/[^a-f0-9\-]/gi, '').slice(0, 36);
      if (!pageId) return json({ ok: false, error: 'page_id vereist' }, 400);
      try {
        const res = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
          method: 'PATCH',
          headers: {
            'Authorization':  `Bearer ${env.NOTION_TOKEN}`,
            'Notion-Version': '2022-06-28',
            'Content-Type':   'application/json',
          },
          body: JSON.stringify({ archived: true }),
        });
        if (!res.ok) {
          const err = await res.text();
          return json({ ok: false, error: err }, 500);
        }
        return json({ ok: true });
      } catch (e) {
        return json({ ok: false, error: e.message }, 500);
      }
    }

    // ── VERPLAATSING OPSLAAN IN NOTION (ingelogde gebruiker) ──
    {
      const token   = getToken(request, data);
      const payload = await verifyJWT(token);
      if (!payload) return json({ ok: false, error: 'Niet ingelogd' }, 401);

      const typeLabel = {
        zaak_klus: 'Van zaak → Klus',
        klus_klus: 'Klus → Klus',
        klus_zaak: 'Klus → Zaak',
      }[data.beweging_type];
      if (!typeLabel) return json({ ok: false, error: 'Ongeldig beweging_type' }, 400);

      let details = '';
      if (data.onderdelen && typeof data.onderdelen === 'object') {
        for (const item of Object.values(data.onderdelen)) {
          const aantal = parseInt(item.aantal);
          if (!isNaN(aantal) && aantal > 0) {
            details += `${sanitize(item.naam || '', 100)}: ${aantal}`;
            if (item.nummers) details += ` (nr. ${sanitize(String(item.nummers), 200)})`;
            if (item.types)   details += ` [${sanitize(String(item.types), 100)}]`;
            const stuk = parseInt(item.stuk);
            if (!isNaN(stuk) && stuk > 0) details += ` (${stuk} stuk/weggegooid)`;
            if (item.opm)     details += ` – ${sanitize(item.opm, 200)}`;
            details += '\n';
          }
        }
      }

      if (Array.isArray(data.foto_urls) && data.foto_urls.length > 0) {
        details += `\nFoto's (${data.foto_urls.length}):\n`
          + data.foto_urls.slice(0, 20).map(f => sanitize(f.url || '', 500)).join('\n');
      }

      const naarNaam  = sanitize(data.naar_naam   || '', 200);
      const vanNaam   = sanitize(data.van_naam     || '', 200);
      const naarNr    = sanitize(data.naar_werknr  || '', 50);
      const vanNr     = sanitize(data.van_werknr   || '', 50);
      const naam      = payload.naam || sanitize(data.naam || '', 100);
      const datum     = /^\d{4}-\d{2}-\d{2}$/.test(data.datum || '') ? data.datum : null;
      const naamTitle = `${naarNaam || vanNaam} – ${datum || '?'}`.slice(0, 200);

      const notionBody = {
        parent: { database_id: env.NOTION_DB_ID },
        properties: {
          'Naam':          { title:     [{ text: { content: naamTitle } }] },
          'Bouwplaats':    { rich_text: [{ text: { content: naarNaam } }] },
          'Werknr. Van':   { rich_text: [{ text: { content: vanNr  || vanNaam  } }] },
          'Werknr. Naar':  { rich_text: [{ text: { content: naarNr || naarNaam } }] },
          'Opslag / Zaak': { rich_text: [{ text: { content: typeLabel } }] },
          'Ingevuld door': { rich_text: [{ text: { content: naam } }] },
          'Details':       { rich_text: [{ text: { content: details.slice(0, 2000) } }] },
          'Opmerkingen':   { rich_text: [{ text: { content: sanitize(data.algemeen_opmerking || '', 1000) } }] },
          'Status':        { select:    { name: 'Nieuw' } },
        },
      };

      if (datum) notionBody.properties['Datum'] = { date: { start: datum } };

      try {
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
          return json({ ok: false, error: err }, 500);
        }
        return json({ ok: true });
      } catch (e) {
        return json({ ok: false, error: e.message }, 500);
      }
    }
  },
};
