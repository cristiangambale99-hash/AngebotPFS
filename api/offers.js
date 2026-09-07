import crypto from 'crypto';
// api/offers.js
// Verwaltet die gesendeten Angebote in Firestore.
//
//   GET  /api/offers            → alle Angebote mit Kennzahlen
//   POST /api/offers            → neues Angebot anlegen (beim Versand)
//   POST /api/offers?aktion=status → Status ändern (z. B. Auftrag erhalten)

const SAMMLUNG = 'angebote';

export default async function handler(req, res) {
  try {
    if (req.method === 'GET') return await liste(req, res);
    if (req.method === 'POST') {
      const aktion = (req.query && req.query.aktion) || '';
      if (aktion === 'status') return await statusAendern(req, res);
      return await anlegen(req, res);
    }
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Unbekannter Fehler' });
  }
}

/* ---- Neues Angebot beim Versand anlegen ---- */
async function anlegen(req, res) {
  const b = req.body || {};
  if (!b.code) return res.status(400).json({ error: 'Zugangscode fehlt.' });

  const jetzt = new Date().toISOString();
  const eintrag = {
    code: b.code,
    angebotsnr: b.angebotsnr || '',
    anrede: b.anrede || '',
    vorname: b.vorname || '',
    nachname: b.nachname || '',
    adresse: b.adresse || '',
    ort: b.ort || '',
    email: b.email || '',
    zimmer: b.zimmer || '',
    frequenz: b.frequenz || '',
    link: b.link || '',
    status: 'gesendet',        // gesendet · auftrag · abgesagt
    gesendetAm: jetzt,
    erinnerung1: '',           // Zeitpunkt der ersten Erinnerung (5 Tage)
    erinnerung2: '',           // Zeitpunkt der zweiten Erinnerung (10 Tage)
    erinnerungAus: false,      // manuell abschaltbar
    auftragAm: '',
    notiz: ''
  };

  const gespeichert = await speichern(SAMMLUNG, b.code, eintrag);
  return res.status(200).json({ ok: true, angebot: gespeichert });
}

/* ---- Status ändern ---- */
async function statusAendern(req, res) {
  const { code, status, erinnerungAus, notiz } = req.body || {};
  if (!code) return res.status(400).json({ error: 'Zugangscode fehlt.' });

  const vorhanden = await lesen(SAMMLUNG, code);
  if (!vorhanden) return res.status(404).json({ error: 'Angebot nicht gefunden.' });

  const neu = { ...vorhanden };
  delete neu._id;
  if (status) {
    neu.status = status;
    if (status === 'auftrag' && !neu.auftragAm) neu.auftragAm = new Date().toISOString();
  }
  if (typeof erinnerungAus === 'boolean') neu.erinnerungAus = erinnerungAus;
  if (typeof notiz === 'string') neu.notiz = notiz;

  const gespeichert = await speichern(SAMMLUNG, code, neu);
  return res.status(200).json({ ok: true, angebot: gespeichert });
}

/* ---- Liste mit Kennzahlen ---- */
async function liste(req, res) {
  const alle = await alleLesen(SAMMLUNG, 500);
  alle.sort((a, b) => (b.gesendetAm || '').localeCompare(a.gesendetAm || ''));

  const gesendet = alle.length;
  const auftraege = alle.filter(a => a.status === 'auftrag').length;
  const abgesagt = alle.filter(a => a.status === 'abgesagt').length;
  const offen = alle.filter(a => a.status === 'gesendet').length;
  const quote = gesendet ? Math.round((auftraege / gesendet) * 100) : 0;

  const jetzt = Date.now();
  const dieserMonat = alle.filter(a => {
    if (!a.gesendetAm) return false;
    const d = new Date(a.gesendetAm);
    const n = new Date();
    return d.getMonth() === n.getMonth() && d.getFullYear() === n.getFullYear();
  }).length;

  // Tage seit Versand ergänzen, damit der Admin es direkt anzeigen kann
  alle.forEach(a => {
    a.tage = a.gesendetAm
      ? Math.floor((jetzt - new Date(a.gesendetAm).getTime()) / 86400000)
      : null;
  });

  return res.status(200).json({
    kennzahlen: { gesendet, auftraege, offen, abgesagt, quote, dieserMonat },
    angebote: alle
  });
}


/* ==========================================================================
   Firestore-Anbindung (in jede Funktion eingebettet)
   Vercel liefert Dateien mit Unterstrich im Namen nicht mit aus, deshalb
   steht dieser Baustein bewusst in jeder Datei statt in einer gemeinsamen.
   ========================================================================== */
const SCOPE = 'https://www.googleapis.com/auth/datastore';
let tokenCache = { token: null, ablauf: 0 };

function b64url(input) {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function holeToken() {
  const jetzt = Math.floor(Date.now() / 1000);
  if (tokenCache.token && tokenCache.ablauf > jetzt + 60) return tokenCache.token;

  const email = process.env.FIREBASE_CLIENT_EMAIL;
  let key = process.env.FIREBASE_PRIVATE_KEY || '';
  key = key.replace(/\\n/g, '\n');   // Vercel speichert Zeilenumbrüche als \n

  if (!email || !key) {
    throw new Error('FIREBASE_CLIENT_EMAIL oder FIREBASE_PRIVATE_KEY fehlt in den Umgebungsvariablen.');
  }

  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64url(JSON.stringify({
    iss: email, scope: SCOPE,
    aud: 'https://oauth2.googleapis.com/token',
    exp: jetzt + 3600, iat: jetzt
  }));

  const signer = crypto.createSign('RSA-SHA256');
  signer.update(`${header}.${claim}`);
  const signatur = signer.sign(key, 'base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${header}.${claim}.${signatur}`
    })
  });
  const daten = await res.json();
  if (!res.ok) throw new Error('Firebase-Anmeldung fehlgeschlagen: ' + JSON.stringify(daten));

  tokenCache = { token: daten.access_token, ablauf: jetzt + (daten.expires_in || 3600) };
  return tokenCache.token;
}

function basisUrl() {
  const pid = process.env.FIREBASE_PROJECT_ID;
  if (!pid) throw new Error('FIREBASE_PROJECT_ID fehlt in den Umgebungsvariablen.');
  return `https://firestore.googleapis.com/v1/projects/${pid}/databases/(default)/documents`;
}

/* ---- Umwandlung zwischen JavaScript und Firestore-Format ---- */
function zuFirestore(wert) {
  if (wert === null || wert === undefined) return { nullValue: null };
  if (typeof wert === 'string') return { stringValue: wert };
  if (typeof wert === 'boolean') return { booleanValue: wert };
  if (typeof wert === 'number') {
    return Number.isInteger(wert) ? { integerValue: String(wert) } : { doubleValue: wert };
  }
  if (Array.isArray(wert)) {
    return { arrayValue: { values: wert.map(zuFirestore) } };
  }
  if (typeof wert === 'object') {
    const fields = {};
    for (const [k, v] of Object.entries(wert)) fields[k] = zuFirestore(v);
    return { mapValue: { fields } };
  }
  return { stringValue: String(wert) };
}

function ausFirestore(feld) {
  if (!feld) return null;
  if ('stringValue' in feld) return feld.stringValue;
  if ('booleanValue' in feld) return feld.booleanValue;
  if ('integerValue' in feld) return parseInt(feld.integerValue, 10);
  if ('doubleValue' in feld) return feld.doubleValue;
  if ('nullValue' in feld) return null;
  if ('arrayValue' in feld) return (feld.arrayValue.values || []).map(ausFirestore);
  if ('mapValue' in feld) {
    const o = {};
    for (const [k, v] of Object.entries(feld.mapValue.fields || {})) o[k] = ausFirestore(v);
    return o;
  }
  return null;
}

function dokumentZuObjekt(doc) {
  const o = {};
  for (const [k, v] of Object.entries(doc.fields || {})) o[k] = ausFirestore(v);
  o._id = (doc.name || '').split('/').pop();
  return o;
}

/* ---- Öffentliche Funktionen ---- */

async function speichern(sammlung, id, daten) {
  const token = await holeToken();
  const fields = {};
  for (const [k, v] of Object.entries(daten)) fields[k] = zuFirestore(v);

  const res = await fetch(`${basisUrl()}/${sammlung}/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields })
  });
  const daten2 = await res.json();
  if (!res.ok) throw new Error('Speichern fehlgeschlagen: ' + JSON.stringify(daten2));
  return dokumentZuObjekt(daten2);
}

async function lesen(sammlung, id) {
  const token = await holeToken();
  const res = await fetch(`${basisUrl()}/${sammlung}/${encodeURIComponent(id)}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (res.status === 404) return null;
  const daten = await res.json();
  if (!res.ok) throw new Error('Lesen fehlgeschlagen: ' + JSON.stringify(daten));
  return dokumentZuObjekt(daten);
}

async function alleLesen(sammlung, limit = 500) {
  const token = await holeToken();
  const alle = [];
  let seite = null;
  do {
    const url = new URL(`${basisUrl()}/${sammlung}`);
    url.searchParams.set('pageSize', String(Math.min(limit, 300)));
    if (seite) url.searchParams.set('pageToken', seite);
    const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${token}` } });
    const daten = await res.json();
    if (!res.ok) throw new Error('Liste fehlgeschlagen: ' + JSON.stringify(daten));
    (daten.documents || []).forEach(d => alle.push(dokumentZuObjekt(d)));
    seite = daten.nextPageToken;
  } while (seite && alle.length < limit);
  return alle;
}

async function loeschen(sammlung, id) {
  const token = await holeToken();
  const res = await fetch(`${basisUrl()}/${sammlung}/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` }
  });
  return res.ok;
}
/* ===== Ende Firestore-Anbindung ===== */
