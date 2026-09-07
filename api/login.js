// api/login.js
// Zugang zum Admin-Bereich per Code.
//
// Der Code liegt als Umgebungsvariable in Vercel und ist damit im
// Seitenquelltext nicht einsehbar:
//   ADMIN_CODE = "euer Code"
//   SESSION_SECRET = eine lange, zufällige Zeichenfolge
//
// Nach erfolgreicher Anmeldung wird ein signiertes Sitzungsmerkmal ausgestellt.
// Es läuft nach 12 Stunden ab und lässt sich nicht fälschen, weil die
// Unterschrift nur mit SESSION_SECRET erzeugt werden kann.

import crypto from 'crypto';

function b64url(buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Stellt ein signiertes Sitzungsmerkmal aus. */
export function tokenErstellen(benutzer, stunden = 12) {
  const geheim = process.env.SESSION_SECRET;
  if (!geheim) throw new Error('SESSION_SECRET fehlt');
  const nutz = b64url(JSON.stringify({
    u: benutzer,
    exp: Date.now() + stunden * 3600 * 1000
  }));
  const sig = b64url(crypto.createHmac('sha256', geheim).update(nutz).digest());
  return nutz + '.' + sig;
}

/** Prüft ein Sitzungsmerkmal. Gibt den Benutzernamen zurück oder null. */
export function tokenPruefen(token) {
  try {
    const geheim = process.env.SESSION_SECRET;
    if (!geheim || !token) return null;
    const [nutz, sig] = String(token).split('.');
    if (!nutz || !sig) return null;

    const erwartet = b64url(crypto.createHmac('sha256', geheim).update(nutz).digest());
    // Zeitkonstanter Vergleich, damit die Unterschrift nicht erraten werden kann
    const a = Buffer.from(sig), b = Buffer.from(erwartet);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

    const daten = JSON.parse(Buffer.from(nutz.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString());
    if (!daten.exp || daten.exp < Date.now()) return null;
    return daten.u || null;
  } catch (e) {
    return null;
  }
}

/** Liest den Anmeldenachweis aus einer Anfrage. */
export function angemeldet(req) {
  const kopf = req.headers.authorization || '';
  if (kopf.startsWith('Bearer ')) return tokenPruefen(kopf.slice(7));
  // Auch aus dem Cookie lesen, falls kein Kopfzeilenwert gesetzt ist
  const cookie = req.headers.cookie || '';
  const treffer = cookie.match(/cs_session=([^;]+)/);
  return treffer ? tokenPruefen(decodeURIComponent(treffer[1])) : null;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { code } = req.body || {};
  if (!code) return res.status(400).json({ error: 'Bitte Code eingeben.' });

  const richtig = process.env.ADMIN_CODE;
  if (!richtig || !process.env.SESSION_SECRET) {
    return res.status(500).json({ error: 'Zugang ist noch nicht eingerichtet.' });
  }

  // Zeitkonstanter Vergleich, damit sich der Code nicht Zeichen für Zeichen erraten lässt
  const a = Buffer.from(String(code));
  const b = Buffer.from(richtig);
  const stimmt = a.length === b.length && crypto.timingSafeEqual(a, b);

  // Immer gleich lange antworten
  await new Promise(r => setTimeout(r, 300));

  if (!stimmt) return res.status(401).json({ error: 'Code ist nicht korrekt.' });

  const token = tokenErstellen('admin');
  res.setHeader('Set-Cookie',
    `cs_session=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${12 * 3600}`);
  return res.status(200).json({ ok: true, token });
}
