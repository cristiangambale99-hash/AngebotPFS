import crypto from 'crypto';
// api/followup.js
// Läuft einmal täglich automatisch (siehe vercel.json) und sendet
// Erinnerungen an Kundinnen und Kunden, von denen noch keine
// Auftragserteilung zurückgekommen ist.
//
//   Nach  5 Tagen → erste, freundliche Erinnerung
//   Nach 10 Tagen → zweite und letzte Erinnerung
//
// Nicht angeschrieben werden:
//   · Angebote mit Status "auftrag" oder "abgesagt"
//   · Angebote, bei denen die Erinnerung manuell abgeschaltet wurde
//   · Angebote ohne hinterlegte E-Mail-Adresse
//
// Der Aufruf ist durch CRON_SECRET geschützt, damit ihn niemand von aussen
// auslösen kann.

const SAMMLUNG = 'angebote';

export default async function handler(req, res) {
  // Zugriffsschutz: Vercel sendet den Cron-Schlüssel im Authorization-Header
  const geheim = process.env.CRON_SECRET;
  if (geheim) {
    const kopf = req.headers.authorization || '';
    if (kopf !== `Bearer ${geheim}`) {
      return res.status(401).json({ error: 'Nicht berechtigt' });
    }
  }

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'RESEND_API_KEY fehlt.' });

  try {
    const alle = await alleLesen(SAMMLUNG, 500);
    const jetzt = Date.now();
    const bericht = { geprueft: alle.length, erste: 0, zweite: 0, abgelaufen: 0, uebersprungen: 0, fehler: [] };

    for (const a of alle) {
      if (a.status !== 'gesendet' || a.erinnerungAus || !a.email || !a.gesendetAm) {
        bericht.uebersprungen++;
        continue;
      }
      const tage = Math.floor((jetzt - new Date(a.gesendetAm).getTime()) / 86400000);

      // Nach 50 Tagen ohne Rückmeldung gilt das Angebot als abgelaufen
      if (tage >= 50) {
        const neuA = { ...a };
        delete neuA._id; delete neuA.tage;
        neuA.status = 'abgesagt';
        neuA.abgesagtAm = new Date().toISOString();
        neuA.abgesagtGrund = 'Keine Rückmeldung innert 50 Tagen';
        await speichern(SAMMLUNG, a.code, neuA);
        bericht.abgelaufen++;
        continue;
      }

      let stufe = 0;
      if (tage >= 30 && !a.erinnerung2) stufe = 2;
      else if (tage >= 5 && !a.erinnerung1) stufe = 1;
      if (!stufe) { bericht.uebersprungen++; continue; }

      try {
        await sendeErinnerung(apiKey, a, stufe);
        const neu = { ...a };
        delete neu._id; delete neu.tage;
        if (stufe === 1) neu.erinnerung1 = new Date().toISOString();
        else neu.erinnerung2 = new Date().toISOString();
        await speichern(SAMMLUNG, a.code, neu);
        stufe === 1 ? bericht.erste++ : bericht.zweite++;
      } catch (e) {
        bericht.fehler.push({ code: a.code, meldung: e.message });
      }
    }

    return res.status(200).json({ ok: true, ...bericht });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

async function sendeErinnerung(apiKey, a, stufe) {
  const anrede = a.anrede === 'Herr' ? `Sehr geehrter Herr ${a.nachname}`
               : a.anrede === 'Frau' ? `Sehr geehrte Frau ${a.nachname}`
               : `Guten Tag ${a.vorname} ${a.nachname}`;

  const betreff = stufe === 1
    ? 'Ihr Reinigungsangebot — dürfen wir kurz nachfragen?'
    : 'Ihr Reinigungsangebot — noch Interesse?';

  const text = stufe === 1
    ? 'vor einigen Tagen haben wir Ihnen Ihr persönliches Reinigungsangebot zugestellt. Wir wollten kurz nachfragen, ob Sie noch Fragen haben oder etwas unklar geblieben ist.'
    : 'vor einiger Zeit haben wir Ihnen ein persönliches Reinigungsangebot zugestellt. Da wir bisher nichts von Ihnen gehört haben, möchten wir uns ein letztes Mal melden. Falls sich Ihre Pläne geändert haben, ist das selbstverständlich in Ordnung.';

  const schluss = stufe === 1
    ? 'Gerne bespreche ich Ihre Wünsche auch persönlich am Telefon.'
    : 'Ihr Angebot bleibt noch bis auf Weiteres abrufbar. Melden Sie sich jederzeit gerne, auch zu einem späteren Zeitpunkt.';

  const inhalt = `
    <p style="margin:0 0 14px;">${anrede},</p>
    <p style="margin:0 0 14px;">${text}</p>
    ${a.link ? csKnopf('Angebot erneut ansehen', a.link) : ''}
    ${a.code ? `
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width:100%;margin:4px 0 16px;">
      <tr><td style="background:#F4F8F8;border:1px solid #D5E2E1;padding:14px 18px;">
        <div style="font-family:Verdana,Geneva,sans-serif;font-size:11px;color:#767676;letter-spacing:.08em;margin-bottom:5px;">IHR ZUGANGSCODE</div>
        <div style="font-family:Verdana,Geneva,sans-serif;font-size:19px;font-weight:bold;color:#12797A;letter-spacing:.18em;">${a.code}</div>
      </td></tr>
    </table>` : ''}
    <p style="margin:0;">${schluss}</p>`;

  const html = csRahmen(stufe === 1 ? 'Dürfen wir kurz nachfragen?' : 'Besteht weiterhin Interesse?', inhalt,
    'Diese Nachricht wurde automatisch erstellt. Sie können direkt darauf antworten.');

  const klartext = `${anrede},\n\n${text}\n\n` +
    (a.link ? `${a.link}\n\n` : '') +
    (a.code ? `Ihr Zugangscode: ${a.code}\n\n` : '') +
    schluss + csSignaturText();

  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: 'Clean Service Scaramuzzo AG <putzfrauenservice@clean-service.ch>',
      to: [a.email],
      reply_to: 'putzfrauenservice@clean-service.ch',
      subject: betreff,
      html,
      text: klartext
    })
  });
  const daten = await r.json();
  if (!r.ok) throw new Error(JSON.stringify(daten));
  return daten;
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

/* ==========================================================================
   Einheitliche E-Mail-Vorlage — Verdana 10pt, Geschäftsbriefcharakter
   ========================================================================== */
const CS_FARBE = '#2BB6B7', CS_DUNKEL = '#12797A', CS_TEXT = '#333333', CS_GRAU = '#767676';

function csSignatur(){
  return `
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width:100%;margin-top:26px;">
    <tr><td style="padding-top:18px;border-top:2px solid ${CS_FARBE};">
      <div style="font-family:Verdana,Geneva,sans-serif;font-size:13px;line-height:1.55;color:${CS_TEXT};">
        <strong>Cristian Gambale</strong><br>
        Bereichsleiter Putzfrauenservice<br>
        Direkt 052 557 02 08 / 076 822 00 16
      </div>
      <div style="border-top:1px solid #D8D8D8;margin:12px 0;width:220px;"></div>
      <div style="font-family:Verdana,Geneva,sans-serif;font-size:12px;line-height:1.55;color:${CS_GRAU};">
        <strong style="color:${CS_TEXT};">Clean Service Scaramuzzo AG</strong><br>
        Industriestrasse 5<br>
        8307 Effretikon<br>
        0844 355 355<br>
        <a href="https://clean-service.ch" style="color:${CS_DUNKEL};text-decoration:none;">clean-service.ch</a>
      </div>
    </td></tr>
  </table>`;
}

function csRahmen(titel, inhalt, hinweis){
  return `
<div style="background:#F2F4F4;padding:24px 12px;font-family:Verdana,Geneva,sans-serif;">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="max-width:640px;margin:0 auto;background:#FFFFFF;border:1px solid #DDE2E1;border-top:none;">
    <tr><td style="padding:0;">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width:100%;">
        <tr>
          <td style="background:#FFFFFF;padding:26px 36px 20px;">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td style="vertical-align:middle;padding-right:14px;">
                  <div style="width:38px;height:38px;background:${CS_FARBE};border-radius:50%;text-align:center;line-height:38px;">
                    <span style="font-family:Georgia,serif;font-size:20px;color:#FFFFFF;font-weight:bold;">C</span>
                  </div>
                </td>
                <td style="vertical-align:middle;">
                  <div style="font-family:Verdana,Geneva,sans-serif;font-size:16px;font-weight:bold;color:${CS_DUNKEL};letter-spacing:.04em;line-height:1.2;">CLEAN SERVICE</div>
                  <div style="font-family:Verdana,Geneva,sans-serif;font-size:10.5px;color:${CS_GRAU};letter-spacing:.16em;margin-top:2px;">BY SCARAMUZZO</div>
                </td>
              </tr>
            </table>
          </td>
          <td style="background:#FFFFFF;padding:26px 36px 20px;text-align:right;vertical-align:middle;">
            <div style="font-family:Verdana,Geneva,sans-serif;font-size:10.5px;color:${CS_GRAU};line-height:1.6;">
              Putzfrauenservice<br>seit 1984
            </div>
          </td>
        </tr>
      </table>
      <div style="height:3px;background:${CS_FARBE};font-size:0;line-height:0;">&nbsp;</div>
    </td></tr>
    <tr><td style="padding:30px 36px 8px;">
      <div style="font-family:Verdana,Geneva,sans-serif;font-size:16px;font-weight:bold;color:${CS_TEXT};line-height:1.4;">${titel}</div>
    </td></tr>
    <tr><td style="padding:12px 36px 30px;font-family:Verdana,Geneva,sans-serif;font-size:13px;line-height:1.7;color:${CS_TEXT};">
      ${inhalt}
      ${csSignatur()}
    </td></tr>
    ${hinweis ? `<tr><td style="padding:16px 36px;background:#F7F9F9;border-top:1px solid #E5E9E8;font-family:Verdana,Geneva,sans-serif;font-size:11px;color:${CS_GRAU};line-height:1.6;">${hinweis}</td></tr>` : ''}
  </table>
</div>`;
}

function csTabelle(zeilen){
  const r = zeilen.filter(([, v]) => v).map(([k, v]) => `
    <tr>
      <td style="padding:8px 0;font-family:Verdana,Geneva,sans-serif;font-size:12px;color:${CS_GRAU};width:170px;vertical-align:top;border-bottom:1px solid #EDEFEF;">${k}</td>
      <td style="padding:8px 0;font-family:Verdana,Geneva,sans-serif;font-size:13px;color:${CS_TEXT};font-weight:bold;border-bottom:1px solid #EDEFEF;">${v}</td>
    </tr>`).join('');
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width:100%;margin:6px 0 18px;">${r}</table>`;
}

function csKnopf(text, link){
  return `
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:20px 0;">
    <tr><td style="background:${CS_FARBE};">
      <a href="${link}" style="display:inline-block;padding:13px 30px;font-family:Verdana,Geneva,sans-serif;font-size:13px;font-weight:bold;color:#FFFFFF;text-decoration:none;">${text}</a>
    </td></tr>
  </table>`;
}

function csSignaturText(){
  return '\n\nFreundliche Grüsse\n\n' +
    'Cristian Gambale\n' +
    'Bereichsleiter Putzfrauenservice\n' +
    'Direkt 052 557 02 08 / 076 822 00 16\n' +
    '---------------------------------\n' +
    'Clean Service Scaramuzzo AG\n' +
    'Industriestrasse 5\n' +
    '8307 Effretikon\n' +
    '0844 355 355\n' +
    'clean-service.ch';
}
