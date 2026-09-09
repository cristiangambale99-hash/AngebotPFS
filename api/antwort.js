import crypto from 'crypto';
// api/antwort.js
// Nimmt die Antwort der Kundschaft auf die Vorlaufmail entgegen.
//
//   GET  /api/antwort?id=..&a=ja|nein&sig=..&spr=de|en
//        → zeigt eine Bestätigungsseite mit Schaltfläche
//   POST /api/antwort  { id, a, sig }
//        → speichert die Antwort und meldet sie an den Putzfrauenservice
//
// Warum zwei Schritte: Outlook, Microsoft Defender und Spamfilter rufen
// Links in E-Mails automatisch auf, um sie zu prüfen. Würde der blosse
// Aufruf den Status ändern, entstünden Antworten, die niemand gegeben hat.
// Erst der Klick auf der Bestätigungsseite löst die Änderung aus.

const SAMMLUNG = 'auftraege';
const EMPFAENGER = 'putzfrauenservice@clean-service.ch';

/* Signatur: verhindert, dass jemand durch Raten fremde Aufträge ändert */
export function signieren(id, antwort) {
  const geheim = process.env.ANTWORT_SECRET || process.env.CRON_SECRET || 'cs-pfs';
  return crypto.createHmac('sha256', geheim)
               .update(String(id) + '.' + String(antwort))
               .digest('hex').slice(0, 20);
}

function pruefen(id, antwort, sig) {
  const soll = signieren(id, antwort);
  if (!sig || sig.length !== soll.length) return false;
  return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(soll));
}

export default async function handler(req, res) {
  const q = req.query || {};
  const b = req.body || {};

  if (req.method === 'GET') {
    const id  = String(q.id  || '');
    const a   = String(q.a   || '');
    const sig = String(q.sig || '');
    const spr = q.spr === 'en' ? 'en' : 'de';
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (!id || (a !== 'ja' && a !== 'nein') || !pruefen(id, a, sig)) {
      return res.status(400).send(seite(spr, 'fehler', a));
    }
    return res.status(200).send(seite(spr, 'frage', a, id, sig));
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const id  = String(b.id  || '');
  const a   = String(b.a   || '');
  const sig = String(b.sig || '');
  if (!id || (a !== 'ja' && a !== 'nein') || !pruefen(id, a, sig)) {
    return res.status(400).json({ error: 'Ungültiger Aufruf' });
  }

  try {
    const auf = await lesen(SAMMLUNG, id);
    if (!auf) return res.status(404).json({ error: 'Auftrag nicht gefunden' });

    const neu = { ...auf };
    delete neu._id;
    neu.springerAntwort = a;
    neu.springerAntwortAm = new Date().toISOString();
    // Ja: Auftrag rutscht in den eigenen Status. Nein: bleibt in Bearbeitung,
    // wird aber gekennzeichnet, damit niemand dasselbe nochmals anbietet.
    if (a === 'ja') neu.stufe = 'springer_gewuenscht';
    await speichern(SAMMLUNG, id, neu);

    await melden(auf, a).catch(() => {});
    return res.status(200).json({ ok: true, antwort: a });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

/* Meldung an den Putzfrauenservice */
async function melden(auf, a) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return;
  const name = [auf.anrede, auf.vorname, auf.nachname].filter(Boolean).join(' ') || 'Unbekannt';
  const ort  = [auf.adresse, auf.plzOrt || auf.ort].filter(Boolean).join(', ');
  const ja   = a === 'ja';

  const titel = ja
    ? 'Start mit Springerteam gewünscht — ' + name
    : 'Springerteam abgelehnt — ' + name;
  const satz = ja
    ? 'Die Kundschaft hat auf die Vorlaufmail geantwortet und möchte mit dem Springerteam starten. Der Auftrag steht jetzt auf «Start mit Springerteam gewünscht». Bitte den ersten Einsatz einplanen.'
    : 'Die Kundschaft hat auf die Vorlaufmail geantwortet und möchte auf die feste Raumpflegerin warten. Der Auftrag bleibt in Bearbeitung und ist entsprechend gekennzeichnet.';

  const html =
    '<div style="font-family:Verdana,Geneva,sans-serif;font-size:13px;color:#333333;line-height:1.7;">' +
    '<div style="height:3px;background:' + (ja ? '#2BB6B7' : '#B4A06A') + ';font-size:0;">&nbsp;</div>' +
    '<div style="padding:22px 4px;">' +
    '<div style="font-size:16px;font-weight:bold;color:#12797A;margin-bottom:12px;">' + titel + '</div>' +
    '<p style="margin:0 0 14px;">' + satz + '</p>' +
    '<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width:100%;">' +
    zeile('Kunde', name) + zeile('Objekt', ort) +
    zeile('Telefon', auf.mobile || '') + zeile('E-Mail', auf.mail || auf.email || '') +
    zeile('Angebot Nr.', auf.angebotsnr || '') +
    zeile('Antwort', ja ? 'Ja, Start mit Springerteam' : 'Nein, wartet auf feste Raumpflegerin') +
    '</table></div></div>';

  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: 'Angebotssystem PFS <putzfrauenservice@clean-service.ch>',
      to: [EMPFAENGER],
      reply_to: auf.mail || auf.email || EMPFAENGER,
      subject: titel,
      html,
      text: titel + '\n\n' + satz + '\n\nKunde: ' + name + '\nObjekt: ' + ort +
            '\nTelefon: ' + (auf.mobile || '') + '\nE-Mail: ' + (auf.mail || auf.email || '')
    })
  });
}

function zeile(k, v) {
  if (!v) return '';
  return '<tr><td style="padding:7px 0;font-size:12px;color:#767676;width:150px;border-bottom:1px solid #EDEFEF;">' + k +
         '</td><td style="padding:7px 0;font-size:13px;color:#333333;font-weight:bold;border-bottom:1px solid #EDEFEF;">' + v + '</td></tr>';
}

/* Bestätigungsseite im Layout des Konzepts */
function seite(spr, art, a, id, sig) {
  const EN = spr === 'en';
  const ja = a === 'ja';
  const T = EN ? {
    titel: ja ? 'Start with our relief team' : 'Wait for your regular cleaner',
    frage: ja
      ? 'Please confirm that we may start with our relief team. We will then schedule the first visit right away.'
      : 'Please confirm that you would rather wait for your regular cleaner. We will be in touch as soon as the assignment is settled.',
    knopf: 'Confirm',
    dankeT: 'Thank you',
    dankeJa: 'We have noted your answer. My team will contact you shortly to arrange the first visit.',
    dankeNein: 'We have noted your answer. I will be in touch as soon as your regular cleaner is assigned.',
    fehlerT: 'This link is no longer valid',
    fehler: 'Please contact us directly, we will be glad to help: T 0844 355 355.',
    warten: 'Saving …', pech: 'Something went wrong. Please contact us at T 0844 355 355.'
  } : {
    titel: ja ? 'Start mit dem Springerteam' : 'Auf die feste Raumpflegerin warten',
    frage: ja
      ? 'Bitte bestätigen Sie, dass wir mit unserem Springerteam starten dürfen. Wir planen den ersten Einsatz dann umgehend ein.'
      : 'Bitte bestätigen Sie, dass Sie lieber auf Ihre feste Raumpflegerin warten möchten. Wir melden uns, sobald die Zuteilung steht.',
    knopf: 'Bestätigen',
    dankeT: 'Vielen Dank',
    dankeJa: 'Ihre Antwort ist bei uns eingegangen. Mein Team meldet sich in Kürze, um den ersten Einsatz mit Ihnen zu vereinbaren.',
    dankeNein: 'Ihre Antwort ist bei uns eingegangen. Ich melde mich, sobald Ihre feste Raumpflegerin zugeteilt ist.',
    fehlerT: 'Dieser Link ist nicht mehr gültig',
    fehler: 'Bitte melden Sie sich direkt bei uns, wir helfen gerne weiter: T 0844 355 355.',
    warten: 'Wird gespeichert …', pech: 'Da ist etwas schiefgelaufen. Bitte melden Sie sich unter T 0844 355 355.'
  };

  const kopf = `<!DOCTYPE html><html lang="${EN ? 'en' : 'de'}"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${T.titel} – Clean Service Scaramuzzo AG</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Poppins:wght@400;600;700&family=Mulish:wght@400;600&display=swap" rel="stylesheet">
<style>
:root{--teal:#2BB6B7;--teal-deep:#1C7878;--tint:#EAF6F6;--bg:#FCFDFD;--surface:#FFFFFF;
 --border:#E1EAE9;--ink:#0E1E1D;--body-c:#485655;--mute:#7C8C8B;
 --head:'Poppins',sans-serif;--body:'Mulish',sans-serif;}
*{box-sizing:border-box;}
body{margin:0;background:var(--bg);color:var(--body-c);font-family:var(--body);
 font-size:15px;line-height:1.7;-webkit-font-smoothing:antialiased;}
.shell{max-width:560px;margin:0 auto;padding:60px 24px 90px;text-align:center;}
h1{font-family:var(--head);font-weight:700;color:var(--ink);font-size:26px;line-height:1.3;margin:0 0 14px;}
p{margin:0 0 22px;}
button{font-family:var(--head);font-weight:600;font-size:15px;color:#fff;background:var(--teal);
 border:none;border-radius:100px;padding:14px 34px;cursor:pointer;}
button:hover{background:var(--teal-deep);}
button[disabled]{background:var(--mute);cursor:default;}
.fuss{margin-top:34px;font-size:12px;color:var(--mute);}
.haken{width:58px;height:58px;margin:0 auto 20px;border-radius:50%;background:var(--tint);
 display:flex;align-items:center;justify-content:center;color:var(--teal-deep);font-size:26px;}
</style></head><body><div class="shell">`;
  const fuss = `<div class="fuss">Clean Service Scaramuzzo AG · Industriestrasse 5 · 8307 Effretikon<br>T 0844 355 355</div></div></body></html>`;

  if (art === 'fehler') {
    return kopf + `<h1>${T.fehlerT}</h1><p>${T.fehler}</p>` + fuss;
  }

  return kopf + `
<h1>${T.titel}</h1>
<p id="frage">${T.frage}</p>
<button id="btn" onclick="senden()">${T.knopf}</button>
<script>
async function senden(){
  var b=document.getElementById('btn');
  b.disabled=true; b.textContent=${JSON.stringify(T.warten)};
  try{
    var r=await fetch('/api/antwort',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({id:${JSON.stringify(id)},a:${JSON.stringify(a)},sig:${JSON.stringify(sig)}})});
    if(!r.ok) throw new Error('Server '+r.status);
    document.querySelector('h1').textContent=${JSON.stringify(T.dankeT)};
    document.getElementById('frage').textContent=${JSON.stringify(ja ? T.dankeJa : T.dankeNein)};
    b.remove();
    var h=document.createElement('div'); h.className='haken'; h.textContent='\\u2713';
    document.querySelector('h1').before(h);
  }catch(e){
    document.getElementById('frage').textContent=${JSON.stringify(T.pech)};
    b.remove();
  }
}
</script>` + fuss;
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
