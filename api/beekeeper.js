// Vercel Serverless Function: /api/beekeeper
// Schickt eine Chat-Nachricht des HR BOT an eine Mitarbeiterin / einen Mitarbeiter in Beekeeper.
// Versand über die Beekeeper Chats 2.0 API (Chats 1.0 «conversations» liefert HTTP 410).
// Wird aus der Verwaltung der Fahrzeug-App aufgerufen (Kulanz / Busse beim Tankrechnungs-Abgleich, Testnachricht).
//
// Environment Variables in Vercel:
//   BEEKEEPER_TOKEN  (Pflicht)  API-Token des HR BOT
//   BEEKEEPER_URL    (optional) Standard: https://clean-service.ch.beekeeper.io
//
// Schutz: nur mit gültigem Verwaltungscode (geprüft über Supabase fz_admin_ok).
// Die Person wird zuerst über die Personalnummer (Tenant-User-ID) gesucht, sonst eindeutig über den Namen.

const SB_URL = 'https://yjnkaeplhxcsubwqpqkz.supabase.co';
const SB_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InlqbmthZXBsaHhjc3Vid3FwcWt6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODk2MjM5MzAsImV4cCI6MjEwNTE5OTkzMH0.nruDrgHbM2quYxo9MyjhMsDSC5gabTj6aO3R2YXmVZ8'; // öffentlicher Supabase-Schlüssel
const MAX_TEXT = 4000;

async function codeOk(code) {
  try {
    const r = await fetch(SB_URL + '/rest/v1/rpc/fz_admin_ok', {
      method: 'POST',
      headers: { apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_code: String(code || '') })
    });
    return r.ok && (await r.json()) === true;
  } catch (e) { return false; }
}

const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const nameOf = u => u.display_name || [u.first_name, u.last_name].filter(Boolean).join(' ') || u.name || '';

function bk(base, token) {
  return async (method, path, body) => {
    const r = await fetch(base + '/api/2/' + path, {
      method,
      headers: { Authorization: 'Token ' + token, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: body ? JSON.stringify(body) : undefined
    });
    const j = await r.json().catch(() => null);
    return { ok: r.ok, status: r.status, data: j };
  };
}

async function findUser(call, pn, name) {
  if (pn) {
    const r = await call('GET', 'users/by_tenant_user_id/' + encodeURIComponent(pn));
    if (r.ok && r.data && r.data.id) return { user: r.data, via: 'personalnummer' };
  }
  if (name) {
    const r = await call('GET', 'users?limit=20&include_bots=false&q=' + encodeURIComponent(name));
    if (!r.ok) return { error: 'Beekeeper-Suche fehlgeschlagen (HTTP ' + r.status + ')', status: r.status };
    const list = Array.isArray(r.data) ? r.data : [];
    const want = norm(name);
    let hits = list.filter(u => norm(nameOf(u)) === want);
    if (!hits.length) { const parts = want.split(' '); hits = list.filter(u => { const n = norm(nameOf(u)); return parts.every(p => n.includes(p)); }); }
    if (pn && hits.length > 1) { const byPn = hits.filter(u => String(u.tenantuserid || u.tenant_user_id || '') === String(pn)); if (byPn.length === 1) hits = byPn; }
    if (hits.length === 1) return { user: hits[0], via: 'name' };
    if (hits.length > 1) return { error: 'Mehrere Personen in Beekeeper heissen «' + name + '»', mehrdeutig: hits.slice(0, 5).map(nameOf) };
  }
  return { error: 'Person in Beekeeper nicht gefunden' + (pn ? ' (PN ' + pn + ')' : '') };
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Nur POST erlaubt' });
  const token = process.env.BEEKEEPER_TOKEN;
  if (!token) return res.status(500).json({ error: 'BEEKEEPER_TOKEN ist in Vercel nicht hinterlegt' });
  const base = String(process.env.BEEKEEPER_URL || 'https://clean-service.ch.beekeeper.io').replace(/\/+$/, '');

  let p = req.body;
  if (typeof p === 'string') { try { p = JSON.parse(p); } catch (e) { return res.status(400).json({ error: 'Ungültiges JSON' }); } }
  if (!p || !(await codeOk(p.code))) return res.status(403).json({ error: 'Kein Zugriff' });
  const text = String(p.text || '').trim();
  if (!text) return res.status(400).json({ error: 'Text fehlt' });
  if (text.length > MAX_TEXT) return res.status(413).json({ error: 'Text zu lang' });
  const pn = String(p.pn || '').replace(/\D/g, '').slice(0, 12);
  const name = String(p.name || '').trim().slice(0, 120);
  if (!pn && !name) return res.status(400).json({ error: 'Personalnummer oder Name fehlt' });

  const call = bk(base, token);
  try {
    const f = await findUser(call, pn, name);
    if (!f.user) return res.status(f.status === 401 || f.status === 403 ? 502 : 404).json({ error: f.error, mehrdeutig: f.mehrdeutig });
    // Chats 2.0: POST /api/2/chats/users/{userId}/messages  (öffnet den Einzelchat automatisch)
    const ids = [...new Set([f.user.id, f.user.uuid, f.user.user_id].filter(Boolean).map(String))];
    let last = null;
    for (const uid of ids) {
      const m = await call('POST', 'chats/users/' + encodeURIComponent(uid) + '/messages?apply_rich_text=false', { body: text });
      if (m.ok) return res.status(200).json({ success: true, an: nameOf(f.user), via: f.via });
      last = m;
      if (m.status === 401 || m.status === 403) break;
    }
    // Fallback: alte Chats-1.0-API (falls der Tenant noch darauf läuft)
    const c = await call('GET', 'conversations/by_user/' + encodeURIComponent(f.user.id));
    if (c.ok && c.data && c.data.id) {
      const m = await call('POST', 'conversations/' + encodeURIComponent(c.data.id) + '/messages', { text });
      if (m.ok) return res.status(200).json({ success: true, an: nameOf(f.user), via: f.via });
    }
    const why = last && last.data && (last.data.message || last.data.error || last.data.detail);
    return res.status(502).json({ error: 'Nachricht konnte nicht gesendet werden (HTTP ' + (last ? last.status : c.status) + (why ? ': ' + String(why).slice(0, 160) : '') + ')' });
  } catch (e) {
    return res.status(502).json({ error: 'Beekeeper nicht erreichbar' });
  }
};
