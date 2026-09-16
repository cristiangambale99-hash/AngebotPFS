// api/portal-zugang.js
//
// Liefert der Vertragsseite den persoenlichen Portal-Zugangslink der Kundschaft,
// damit er beim Erzeugen des Vertrags-PDF bereits vorliegt.
//
//   GET /api/portal-zugang?id=<Auftragsnummer>&sig=<Signatur>
//   -> { ok: true, link: "https://portal.clean-service.ch/k/boesiger80-m3mg" }
//
// Warum ueber den Server und nicht direkt aus dem Browser:
// Der Aufruf ans Kundenportal braucht den gemeinsamen Schluessel PORTAL_API_KEY.
// Landet dieser im Frontend, koennte jede Besucherin ihn aus den Entwicklertools
// auslesen und beliebige Portalzugaenge auf fremde Namen erzeugen. Deshalb
// bleibt der Schluessel serverseitig; der Browser weist sich stattdessen mit der
// Signatur aus, die er ohnehin schon hat (gleiches Verfahren wie vertrag-signiert.js).
//
// Scheitert irgendetwas, antwortet die Funktion mit { ok:false } und HTTP 200.
// Der Vertrag entsteht dann ohne Link - ein fehlender Zugang darf niemals
// eine Vertragsunterschrift blockieren.

import crypto from 'crypto';

const SAMMLUNG = 'auftraege';

/* Ein Vertragslink bleibt gültig, auch wenn später ein anderes Geheimnis
   gesetzt wird: Es zählt, ob die Signatur zu irgendeinem der hinterlegten
   Werte passt. Sonst brechen alle bereits versendeten Links, sobald eine
   Umgebungsvariable dazukommt oder geändert wird. */
function vertragGeheimnisse() {
  return [process.env.VERTRAG_SECRET, process.env.ANTWORT_SECRET,
          process.env.CRON_SECRET, 'cs-pfs'].filter(Boolean);
}
function vertragSignatur(id, geheim) {
  return crypto.createHmac('sha256', geheim).update(String(id) + '.v')
               .digest('hex').slice(0, 20);
}
function vertragSigGueltig(id, sig) {
  const s = String(sig || '');
  return vertragGeheimnisse().some(g => vertragSignatur(id, g) === s);
}

export default async function handler(req, res) {
  try {
    const q = req.query || {};
    const id = String(q.id || '');
    const sig = String(q.sig || '');

    if (!id || !vertragSigGueltig(id, sig)) {
      return res.status(400).json({ ok: false, error: 'Signatur stimmt nicht' });
    }

    const basis = (process.env.PORTAL_URL || '').replace(/\/$/, '');
    const schluessel = process.env.PORTAL_API_KEY || '';
    if (!basis || !schluessel) {
      return res.status(200).json({ ok: false, grund: 'nicht-eingerichtet' });
    }

    const auf = await lesen(SAMMLUNG, id);
    if (!auf) {
      return res.status(200).json({ ok: false, grund: 'auftrag-fehlt' });
    }

    const mail   = auf.mail || auf.email || '';
    const name   = [auf.vorname, auf.nachname].filter(Boolean).join(' ').trim();
    const nummer = String(auf.angebotsnr || auf.code || '').trim();  // Auftragsnr = Objektnr

    if (!mail || !name || !nummer) {
      return res.status(200).json({ ok: false, grund: 'unvollstaendig' });
    }

    const r = await fetch(basis + '/api/zugang?action=aus-angebot', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Api-Key': schluessel },
      body: JSON.stringify({
        objekt_id: nummer,
        name,
        email: mail,
        adresse: [auf.adresse, auf.plzOrt || auf.ort].filter(Boolean).join(', '),
        senden: false      // die Einladung verschickt vertrag-signiert.js selbst,
                           // damit sie im Clean-Service-Layout ankommt
      })
    });

    const d = await r.json().catch(() => ({}));
    if (!r.ok) {
      console.error('portal-zugang: Portal antwortet', r.status, d);
      return res.status(200).json({ ok: false, grund: 'portal-fehler' });
    }

    return res.status(200).json({ ok: true, link: d.link, token: d.token });

  } catch (err) {
    console.error('portal-zugang: Fehler', err);
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
