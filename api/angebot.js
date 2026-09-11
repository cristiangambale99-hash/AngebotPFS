// api/angebot.js
//
// Oeffnet das Angebot ueber den sechsstelligen Zugangscode, ohne persoenlichen
// Link. Gedacht fuer Kundschaft, die die Mail nicht mehr findet und die
// Adresse angebot.clean-service.ch direkt aufruft.
//
//   GET /api/angebot?code=ABC123
//   -> { ok:true, angebot:{ anrede, vorname, nachname, adresse, ort,
//                           angebotsnr, zimmer, frequenz, sprache } }
//
// Warum das vertretbar ist: Der Code ist sechs Stellen aus 32 Zeichen, also
// rund eine Milliarde Moeglichkeiten, und er gibt nur das eigene Angebot frei
// - keine Liste, keine Suche, keine fremden Daten. Die E-Mail-Adresse wird
// bewusst NICHT zurueckgegeben, damit sich aus einem geratenen Code keine
// Kontaktdaten gewinnen lassen. Zusaetzlich bremst eine kurze Wartezeit jeden
// Versuch, Codes maschinell durchzuprobieren.

import crypto from 'crypto';

const SAMMLUNG = 'angebote';

/* Kurze Bremse gegen das maschinelle Durchprobieren von Codes. */
function warten(ms) {
  return new Promise(r => setTimeout(r, ms));
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ ok: false, error: 'Methode nicht erlaubt.' });
  }

  try {
    const code = String((req.query && req.query.code) || '').trim().toUpperCase();

    /* Form pruefen, bevor ueberhaupt gelesen wird. */
    if (!/^[A-Z0-9]{6}$/.test(code)) {
      await warten(400);
      return res.status(200).json({ ok: false, grund: 'code-ungueltig' });
    }

    const angebot = await lesen(SAMMLUNG, code);
    await warten(400);

    if (!angebot) {
      return res.status(200).json({ ok: false, grund: 'nicht-gefunden' });
    }
    if (String(angebot.status || '') === 'abgesagt') {
      return res.status(200).json({ ok: false, grund: 'abgesagt' });
    }

    /* Nur das, was die Seite zum Aufbau braucht - keine Kontaktdaten. */
    return res.status(200).json({
      ok: true,
      angebot: {
        anrede:     angebot.anrede || '',
        vorname:    angebot.vorname || '',
        nachname:   angebot.nachname || '',
        adresse:    angebot.adresse || '',
        ort:        angebot.ort || angebot.plzOrt || '',
        angebotsnr: angebot.angebotsnr || '',
        zimmer:     angebot.zimmer || '',
        frequenz:   angebot.frequenz || '',
        sprache:    (angebot.sprache === 'en') ? 'en' : 'de'
      }
    });

  } catch (err) {
    console.error('angebot.js', err);
    return res.status(200).json({ ok: false, grund: 'fehler' });
  }
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
  key = key.replace(/\\n/g, '\n');

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

  const antwort = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${header}.${claim}.${signatur}`
    })
  });
  const daten = await antwort.json();
  if (!antwort.ok) throw new Error('Firebase-Anmeldung fehlgeschlagen: ' + JSON.stringify(daten));

  tokenCache = { token: daten.access_token, ablauf: jetzt + (daten.expires_in || 3600) };
  return tokenCache.token;
}

function basisUrl() {
  const pid = process.env.FIREBASE_PROJECT_ID;
  if (!pid) throw new Error('FIREBASE_PROJECT_ID fehlt in den Umgebungsvariablen.');
  return `https://firestore.googleapis.com/v1/projects/${pid}/databases/(default)/documents`;
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

async function lesen(sammlung, id) {
  const token = await holeToken();
  const antwort = await fetch(`${basisUrl()}/${sammlung}/${encodeURIComponent(id)}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (antwort.status === 404) return null;
  const daten = await antwort.json();
  if (!antwort.ok) throw new Error('Lesen fehlgeschlagen: ' + JSON.stringify(daten));
  return dokumentZuObjekt(daten);
}
/* ===== Ende Firestore-Anbindung ===== */
