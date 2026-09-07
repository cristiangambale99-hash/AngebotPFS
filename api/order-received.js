import crypto from 'crypto';
// api/order-received.js
// Wird vom Auftragsformular aufgerufen, sobald ein Kunde absendet.
//
//   1. Setzt das Angebot in Firestore auf Status "auftrag"
//      → damit stoppen die automatischen Erinnerungen sofort
//   2. Benachrichtigt euch per E-Mail über den Eingang

const SAMMLUNG = 'angebote';
const EMPFAENGER = 'putzfrauenservice@clean-service.ch';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const b = req.body || {};
  const ergebnis = { statusGesetzt: false, mailGesendet: false };

  try {
    /* ---- 1) Angebot finden und auf "auftrag" setzen ---- */
    let angebot = null;
    if (b.code) {
      angebot = await lesen(SAMMLUNG, b.code);
    }
    // Kein Code übergeben: über Angebotsnummer oder Nachname suchen
    if (!angebot && (b.angebotsnr || b.nachname)) {
      const alle = await alleLesen(SAMMLUNG, 500);
      angebot = alle.find(a =>
        (b.angebotsnr && a.angebotsnr === b.angebotsnr) ||
        (b.nachname && a.nachname && a.nachname.toLowerCase() === String(b.nachname).toLowerCase())
      ) || null;
    }

    if (angebot) {
      const neu = { ...angebot };
      delete neu._id; delete neu.tage;
      neu.status = 'auftrag';
      neu.auftragAm = new Date().toISOString();
      await speichern(SAMMLUNG, angebot.code, neu);
      ergebnis.statusGesetzt = true;
    }

    /* ---- 1b) Die vollständige Auftragserteilung dauerhaft ablegen ---- */
    // Ohne diesen Schritt sähe das Team die Angaben nur im Browser des Kunden.
    const auftragId = (b.code || '') || ('A' + Date.now());
    const auftrag = {
      code: b.code || '',
      angebotsnr: b.angebotsnr || '',
      eingegangenAm: new Date().toISOString(),
      anrede: b.anrede || '', vorname: b.vorname || '', nachname: b.nachname || '',
      adresse: b.adresse || '', plzOrt: b.plzOrt || b.ort || '',
      mobile: b.mobile || '', mail: b.mail || b.email || '',
      zimmer: String(b.zimmer || ''), qm: String(b.qm || ''), badezimmer: String(b.badezimmer || ''),
      frequenz: b.frequenz || '', frequenzText: b.frequenzText || '',
      tage: Array.isArray(b.tage) ? b.tage.join(', ') : String(b.tage || ''),
      uhrzeit: b.uhrzeit || '', aufwandText: b.aufwandText || '',
      pp: b.pp || '', haustiere: b.haustiere || '',
      alarmanlage: b.alarmanlage || '', alarmCode: b.alarmCode || '',
      fensterOfferte: b.fensterOfferte || '', springerSofort: b.springerSofort || '',
      zusatzBettbezuege: !!b.zusatzBettbezuege, zusatzWaesche: !!b.zusatzWaesche,
      buegelservice: b.buegelservice || '', zusatzGeschirrspueler: !!b.zusatzGeschirrspueler,
      zusatzBackofen: !!b.zusatzBackofen,
      vereinbarungen: b.vereinbarungen || '',
      bearbeitet: false
    };
    try{
      await speichern('auftraege', auftragId, auftrag);
      ergebnis.auftragGespeichert = true;
    }catch(e){
      ergebnis.auftragGespeichert = false;
      ergebnis.speicherFehler = e.message;
    }

    /* ---- 2) Benachrichtigung an das Team ---- */
    const apiKey = process.env.RESEND_API_KEY;
    if (apiKey) {
      const name = [b.anrede, b.vorname, b.nachname].filter(Boolean).join(' ') || 'Unbekannt';
      const zeilen = [
        ['Kunde', name],
        ['Adresse', [b.adresse, b.plzOrt || b.ort].filter(Boolean).join(', ')],
        ['Telefon', b.mobile || ''],
        ['E-Mail', b.mail || b.email || ''],
        ['Angebot Nr.', b.angebotsnr || ''],
        ['Zimmer', b.zimmer || ''],
        ['Frequenz', b.frequenzText || b.frequenz || ''],
        ['Reinigungstag', Array.isArray(b.tage) ? b.tage.join(', ') : (b.tage || '')],
        ['Uhrzeit', b.uhrzeit || ''],
        ['Aufwand', b.aufwandText || '']
      ].filter(([, v]) => v);

      const tabelle = zeilen.map(([k, v]) => `
        <tr>
          <td style="padding:7px 0;color:#7C8C8B;font-size:13px;width:130px;vertical-align:top;">${k}</td>
          <td style="padding:7px 0;color:#0E1E1D;font-size:13px;"><strong>${v}</strong></td>
        </tr>`).join('');

      const html = `
      <div style="font-family:Verdana,Arial,sans-serif;color:#0E1E1D;max-width:560px;margin:0 auto;line-height:1.6;">
        <p style="font-size:15px;"><strong>Neue Auftragserteilung eingegangen</strong></p>
        <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-top:1px solid #E1EAE9;border-bottom:1px solid #E1EAE9;margin:14px 0;">
          ${tabelle}
        </table>
        ${b.vereinbarungen ? `<p style="font-size:13px;"><span style="color:#7C8C8B;">Spezielle Vereinbarungen:</span><br>${b.vereinbarungen}</p>` : ''}
        <p style="margin-top:22px;">
          <a href="https://${req.headers.host || 'clean-service.ch'}/admin.html"
             style="background:#2BB6B7;color:#ffffff;padding:12px 24px;border-radius:100px;text-decoration:none;font-weight:600;display:inline-block;font-size:14px;">Im Admin-Bereich ansehen</a>
        </p>
        <hr style="border:none;border-top:1px solid #E1EAE9;margin:24px 0 12px;">
        <p style="font-size:11.5px;color:#7C8C8B;">
          Automatische Meldung aus dem Angebotssystem · Clean Service Scaramuzzo AG
        </p>
      </div>`;

      const r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: 'Angebotssystem <putzfrauenservice@clean-service.ch>',
          to: [EMPFAENGER],
          reply_to: b.mail || b.email || EMPFAENGER,
          subject: `Neue Auftragserteilung — ${name}${b.angebotsnr ? ' (Nr. ' + b.angebotsnr + ')' : ''}`,
          html,
          text: `Neue Auftragserteilung eingegangen\n\n` +
                zeilen.map(([k, v]) => `${k}: ${v}`).join('\n') +
                (b.vereinbarungen ? `\n\nSpezielle Vereinbarungen:\n${b.vereinbarungen}` : '')
        })
      });
      ergebnis.mailGesendet = r.ok;
    }

    return res.status(200).json({ ok: true, ...ergebnis });
  } catch (err) {
    // Der Kunde soll nie eine Fehlerseite sehen, nur weil die Meldung scheitert
    return res.status(200).json({ ok: false, fehler: err.message, ...ergebnis });
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
