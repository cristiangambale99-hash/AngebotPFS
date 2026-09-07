// api/login.js
// Anmeldung für den Admin-Bereich.
//
// Die Zugangsdaten liegen als Umgebungsvariable in Vercel, nie im Seitenquelltext:
//   ADMIN_USERS = "cristian:GeheimesWort,fiorella:AnderesWort,tayron:DrittesWort"
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

  const { benutzer, passwort } = req.body || {};
  if (!benutzer || !passwort) {
    return res.status(400).json({ error: 'Benutzername und Passwort erforderlich.' });
  }

  const liste = process.env.ADMIN_USERS;
  if (!liste || !process.env.SESSION_SECRET) {
    return res.status(500).json({ error: 'Anmeldung ist noch nicht eingerichtet.' });
  }

  // Eintrag suchen, Vergleich zeitkonstant
  const eintraege = liste.split(',').map(s => s.trim()).filter(Boolean);
  let gefunden = false;
  let name = '';
  for (const e of eintraege) {
    const i = e.indexOf(':');
    if (i < 0) continue;
    const u = e.slice(0, i).trim();
    const p = e.slice(i + 1).trim();
    if (u.toLowerCase() !== String(benutzer).trim().toLowerCase()) continue;
    const a = Buffer.from(p), b = Buffer.from(String(passwort));
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) { gefunden = true; name = u; }
    break;
  }

  // Immer gleich lange antworten, damit sich gültige Namen nicht erraten lassen
  await new Promise(r => setTimeout(r, 350));

  if (!gefunden) {
    return res.status(401).json({ error: 'Benutzername oder Passwort ist falsch.' });
  }

  const token = tokenErstellen(name);
  res.setHeader('Set-Cookie',
    `cs_session=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${12 * 3600}`);
  return res.status(200).json({ ok: true, benutzer: name, token });
}
