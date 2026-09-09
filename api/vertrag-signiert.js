import crypto from 'crypto';
// api/vertrag-signiert.js
//
// Nimmt den online unterschriebenen Reinigungsvertrag entgegen.
//
//   POST { id, sig, ort, unterschrift (Data-URL), spr }
//
// Speichert die Unterschrift beim Auftrag, meldet den Eingang an den
// Putzfrauenservice und bestaetigt der Kundschaft den Empfang.

const SAMMLUNG = 'auftraege';
const EMPFAENGER = 'putzfrauenservice@clean-service.ch';

function signatur(id) {
  const geheim = process.env.VERTRAG_SECRET || process.env.ANTWORT_SECRET
              || process.env.CRON_SECRET || 'cs-pfs';
  return crypto.createHmac('sha256', geheim).update(String(id) + '.v')
               .digest('hex').slice(0, 20);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const b = req.body || {};
  const id = String(b.id || '');
  const sig = String(b.sig || '');
  if (!id || sig !== signatur(id)) {
    return res.status(401).json({ error: 'Nicht berechtigt' });
  }

  const bild = String(b.unterschrift || '');
  if (!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(bild) || bild.length > 400000) {
    return res.status(400).json({ error: 'Unterschrift fehlt oder ist ungültig.' });
  }
  const roh = bild.split(',')[1];

  /* Der Vertrag als PDF, im Browser auf dem Briefpapier erzeugt.
     Fehlt er, geht die Meldung trotzdem — dann nur mit der Unterschrift. */
  const pdfRoh = /^[A-Za-z0-9+/=]+$/.test(String(b.pdf || '')) && String(b.pdf).length < 3000000
               ? String(b.pdf) : '';

  const bericht = { ok:false, gespeichert:false, gemeldet:false, bestaetigt:false };
  try {
    const fund = await auftragFinden(id);
    if (!fund) return res.status(404).json({ ...bericht, error: 'Auftrag nicht gefunden' });
    const auf = fund.daten;

    const neu = { ...auf };
    delete neu._id;
    neu.vertragSigniertAm = new Date().toISOString();
    neu.vertragOrt = String(b.ort || '').slice(0, 120);
    neu.vertragUnterschrift = roh;
    await speichern(SAMMLUNG, fund.schluessel, neu);
    bericht.gespeichert = true;

    const key = process.env.RESEND_API_KEY;
    if (key) {
      const name = [auf.anrede, auf.vorname, auf.nachname].filter(Boolean).join(' ') || 'Unbekannt';
      const nr = auf.angebotsnr || auf.code || '';
      const dateiname = 'Reinigungsvertrag_' + (nr || id) + '_unterschrieben.pdf';
      const anhang = [];
      if (pdfRoh) anhang.push({ filename: dateiname, content: pdfRoh });
      anhang.push({ filename: 'Unterschrift_' + (nr || id) + '.png', content: roh });

      // Meldung an den Putzfrauenservice
      try {
        await senden(key, {
          to: [EMPFAENGER],
          reply_to: auf.mail || auf.email || EMPFAENGER,
          subject: 'Vertrag unterschrieben — ' + name + (nr ? ' (Nr. ' + nr + ')' : ''),
          html:
            '<div style="font-family:Verdana,Geneva,sans-serif;font-size:13px;color:#333;line-height:1.7;">' +
            '<div style="height:3px;background:#2BB6B7;font-size:0;">&nbsp;</div><div style="padding:22px 4px;">' +
            '<div style="font-size:16px;font-weight:bold;color:#12797A;margin-bottom:12px;">Vertrag unterschrieben</div>' +
            '<p style="margin:0 0 14px;">Die Kundschaft hat den Reinigungsvertrag online unterschrieben und zurückgesendet. ' +
            (pdfRoh
              ? 'Der vollständige Vertrag liegt diesem Mail als PDF auf unserem Briefpapier bei.'
              : 'Es liegt nur die Unterschrift bei — das PDF konnte im Browser der Kundschaft nicht erzeugt werden.') +
            '</p>' +
            '<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width:100%;">' +
            zeile('Kunde', name) +
            zeile('Objekt', [auf.adresse, auf.plzOrt || auf.ort].filter(Boolean).join(', ')) +
            zeile('Vertrag Nr.', nr) +
            zeile('Ort', neu.vertragOrt) +
            zeile('Unterschrieben am', new Date(neu.vertragSigniertAm).toLocaleString('de-CH')) +
            '</table>' +
            '<div style="margin-top:16px;"><img src="cid:sigbild" alt="Unterschrift" style="max-height:90px;"></div>' +
            '</div></div>',
          text: 'Vertrag unterschrieben — ' + name + '\nOrt: ' + neu.vertragOrt,
          attachments: anhang.concat([{ filename: 'sig.png', content: roh,
                                        content_id: 'sigbild', disposition: 'inline' }])
        });
        bericht.gemeldet = true;
      } catch (e) {
        bericht.meldefehler = String(e.message || e).slice(0, 300);
        console.error('vertrag-signiert: Meldung fehlgeschlagen', e);
      }

      // Bestaetigung an die Kundschaft
      const mail = auf.mail || auf.email || '';
      if (mail) {
        const EN = String(b.spr || auf.sprache || 'de').toLowerCase() === 'en';
        const nn = auf.nachname || '';
        const anrede = EN
          ? (auf.anrede === 'Herr' ? 'Dear Mr ' + nn : auf.anrede === 'Frau' ? 'Dear Mrs ' + nn
            : 'Dear ' + [auf.vorname, nn].filter(Boolean).join(' '))
          : (auf.anrede === 'Herr' ? 'Sehr geehrter Herr ' + nn : auf.anrede === 'Frau' ? 'Sehr geehrte Frau ' + nn
            : 'Guten Tag ' + [auf.vorname, nn].filter(Boolean).join(' '));
        const L = EN ? {
          betreff:'Your signed cleaning contract',
          a1:'Thank you — we have received your signed cleaning contract. You will find it attached to this message as a PDF.',
          a2:'If you have any questions, you can reach me directly at any time.',
          gruss:'Kind regards', rolle:'Head of Putzfrauenservice'
        } : {
          betreff:'Ihr unterschriebener Reinigungsvertrag',
          a1:'Vielen Dank — Ihr unterschriebener Reinigungsvertrag ist bei uns eingegangen. Sie finden ihn als PDF im Anhang dieser Nachricht.',
          a2:'Für Rückfragen erreichen Sie mich jederzeit direkt.',
          gruss:'Freundliche Grüsse', rolle:'Bereichsleiter Putzfrauenservice'
        };
        try {
          await senden(key, {
            to: [mail], bcc: [EMPFAENGER], reply_to: EMPFAENGER,
            subject: L.betreff,
            html:
              '<div style="font-family:Verdana,Geneva,sans-serif;font-size:13px;color:#333;line-height:1.7;max-width:640px;">' +
              '<div style="height:3px;background:#2BB6B7;font-size:0;">&nbsp;</div><div style="padding:24px 4px;">' +
              '<p style="margin:0 0 16px;">' + anrede + '</p>' +
              '<p style="margin:0 0 16px;">' + L.a1 + '</p>' +
              '<p style="margin:0 0 20px;">' + L.a2 + '</p>' +
              '<div style="border-top:2px solid #2BB6B7;padding-top:16px;">' +
              '<strong>Cristian Gambale</strong><br>' + L.rolle + '<br>Direkt 052 557 02 08<br><br>' +
              '<span style="color:#767676;">Clean Service Scaramuzzo AG · Industriestrasse 5 · 8307 Effretikon<br>' +
              'T 0844 355 355 · clean-service.ch</span></div></div></div>',
            text: anrede + '\n\n' + L.a1 + '\n\n' + L.a2 + '\n\n' + L.gruss + '\nCristian Gambale',
            attachments: anhang
          });
          bericht.bestaetigt = true;
        } catch (e) {
          bericht.bestaetigungsfehler = String(e.message || e).slice(0, 300);
          console.error('vertrag-signiert: Bestätigung fehlgeschlagen', e);
        }
      }
    }

    bericht.ok = true;
    return res.status(200).json(bericht);
  } catch (err) {
    console.error('vertrag-signiert: Fehler', err);
    return res.status(500).json({ ...bericht, error: err.message });
  }
}

async function senden(key, daten) {
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: 'Cristian Gambale · Clean Service Scaramuzzo AG <putzfrauenservice@clean-service.ch>',
      ...daten
    })
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('Resend: ' + JSON.stringify(d));
  return d;
}

async function auftragFinden(id) {
  try { const d = await lesen(SAMMLUNG, id); if (d) return { daten:d, schluessel:id }; }
  catch (e) { /* weiter */ }
  const alle = await alleLesen(SAMMLUNG, 500);
  const t = alle.find(x => String(x.id || '') === String(id) || String(x._id || '') === String(id));
  return t ? { daten:t, schluessel:String(t._id || t.id || id) } : null;
}

function zeile(k, v) {
  if (!v) return '';
  return '<tr><td style="padding:7px 0;font-size:12px;color:#767676;width:160px;border-bottom:1px solid #EDEFEF;">' + k +
         '</td><td style="padding:7px 0;font-size:13px;color:#333;font-weight:bold;border-bottom:1px solid #EDEFEF;">' + v + '</td></tr>';
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

/* ---------------------------------------------------------------------------
   Zugriffsschutz: nur mit gültigem Sitzungsmerkmal aus der Anmeldung.
   Der Block steht in jeder Datei, weil Vercel gemeinsame Hilfsdateien
   mit Unterstrich nicht mitliefert.
   --------------------------------------------------------------------------- */
function sitzungPruefen(req){
  try{
    const geheim = process.env.SESSION_SECRET;
    if(!geheim) return 'nicht-eingerichtet';       // Schutz noch nicht aktiv
    let token = '';
    const kopf = req.headers.authorization || '';
    if(kopf.startsWith('Bearer ')) token = kopf.slice(7);
    if(!token){
      const c = req.headers.cookie || '';
      const m = c.match(/cs_session=([^;]+)/);
      if(m) token = decodeURIComponent(m[1]);
    }
    if(!token) return null;

    const [nutz, sig] = token.split('.');
    if(!nutz || !sig) return null;
    const erwartet = Buffer.from(crypto.createHmac('sha256', geheim).update(nutz).digest())
      .toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
    const a = Buffer.from(sig), b = Buffer.from(erwartet);
    if(a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    const d = JSON.parse(Buffer.from(nutz.replace(/-/g,'+').replace(/_/g,'/'), 'base64').toString());
    if(!d.exp || d.exp < Date.now()) return null;
    return d.u || null;
  }catch(e){ return null; }
}
