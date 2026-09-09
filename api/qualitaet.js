import crypto from 'crypto';
// api/qualitaet.js
//
// Nimmt die Rueckmeldung der Kundschaft zur Qualitaetsnachfrage entgegen.
//
//   GET  /api/qualitaet?id=..&s=<stufe>&sig=..&spr=de|en
//        → Bestaetigungsseite mit Schaltflaeche
//   POST /api/qualitaet  { id, s, sig }
//        → speichert die Antwort, meldet sie an den Putzfrauenservice und
//          bittet bei den beiden oberen Stufen um eine Google-Bewertung
//
// Zwei Schritte, weil Spamfilter Links in E-Mails automatisch aufrufen.

const SAMMLUNG = 'auftraege';
const EMPFAENGER = 'putzfrauenservice@clean-service.ch';
const GOOGLE_LINK = 'https://g.page/r/CcsMov4w59NFEAE/review';

/* Die vier Stufen. «bewertung: true» loest die Bitte um eine
   Google-Bewertung aus. */
const STUFEN = {
  sehr_zufrieden: { de:'Sehr zufrieden',      en:'Very satisfied',       bewertung:true,  rang:4 },
  zufrieden:      { de:'Zufrieden',           en:'Satisfied',            bewertung:true,  rang:3 },
  teilweise:      { de:'Teilweise zufrieden', en:'Partly satisfied',     bewertung:false, rang:2 },
  nicht:          { de:'Nicht zufrieden',     en:'Not satisfied',        bewertung:false, rang:1 }
};

export function signieren(id, stufe) {
  const geheim = process.env.QUALITAET_SECRET || process.env.ANTWORT_SECRET
              || process.env.CRON_SECRET || 'cs-pfs';
  return crypto.createHmac('sha256', geheim)
               .update(String(id) + '.q.' + String(stufe))
               .digest('hex').slice(0, 20);
}
function pruefen(id, stufe, sig) {
  if (!STUFEN[stufe]) return false;
  const soll = signieren(id, stufe);
  if (!sig || sig.length !== soll.length) return false;
  return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(soll));
}

export default async function handler(req, res) {
  const q = req.query || {};
  const b = req.body || {};

  if (req.method === 'GET') {
    const id = String(q.id || ''), st = String(q.s || ''), sig = String(q.sig || '');
    const spr = q.spr === 'en' ? 'en' : 'de';
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (!id || !pruefen(id, st, sig)) return res.status(400).send(seite(spr, 'fehler'));
    return res.status(200).send(seite(spr, 'frage', st, id, sig));
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const id = String(b.id || ''), st = String(b.s || ''), sig = String(b.sig || '');
  if (!id || !pruefen(id, st, sig)) return res.status(400).json({ error: 'Ungültiger Aufruf' });

  const bericht = { ok:false, stufe:st, gespeichert:false, gemeldet:false, bewertungGebeten:false };
  try {
    const fund = await auftragFinden(id);
    if (!fund) return res.status(404).json({ ...bericht, error: 'Auftrag ' + id + ' nicht gefunden' });

    const auf = fund.daten;
    const neu = { ...auf };
    delete neu._id;
    neu.qualitaetAntwort = st;
    neu.qualitaetAntwortAm = new Date().toISOString();
    await speichern(SAMMLUNG, fund.schluessel, neu);
    bericht.gespeichert = true;

    try { await melden(auf, st); bericht.gemeldet = true; }
    catch (e) { bericht.meldefehler = String(e.message || e).slice(0, 300);
                console.error('qualitaet.js: Meldung fehlgeschlagen', e); }

    if (STUFEN[st].bewertung) {
      try { await bewertungBitten(auf); bericht.bewertungGebeten = true; }
      catch (e) { bericht.bewertungsfehler = String(e.message || e).slice(0, 300);
                  console.error('qualitaet.js: Bewertungsmail fehlgeschlagen', e); }
    }

    bericht.ok = true;
    return res.status(200).json(bericht);
  } catch (err) {
    console.error('qualitaet.js: Fehler', err);
    return res.status(500).json({ ...bericht, error: err.message });
  }
}

async function auftragFinden(id) {
  try { const d = await lesen(SAMMLUNG, id); if (d) return { daten:d, schluessel:id }; }
  catch (e) { /* weiter */ }
  const alle = await alleLesen(SAMMLUNG, 500);
  const t = alle.find(x => String(x.id || '') === String(id) || String(x._id || '') === String(id));
  return t ? { daten:t, schluessel:String(t._id || t.id || id) } : null;
}

/* Meldung an den Putzfrauenservice */
async function melden(auf, st) {
  const key = process.env.RESEND_API_KEY;
  if (!key) throw new Error('RESEND_API_KEY fehlt.');
  const name = [auf.anrede, auf.vorname, auf.nachname].filter(Boolean).join(' ') || 'Unbekannt';
  const s = STUFEN[st];
  const gut = s.rang >= 3;
  const titel = 'Qualitätsnachfrage: ' + s.de + ' — ' + name;
  const satz = gut
    ? 'Die Kundschaft hat auf die Qualitätsnachfrage geantwortet. Die Bitte um eine Google-Bewertung wurde automatisch verschickt.'
    : 'Die Kundschaft ist nicht rundum zufrieden. Bitte zeitnah Kontakt aufnehmen und die Ursache klären.';
  const html =
    '<div style="font-family:Verdana,Geneva,sans-serif;font-size:13px;color:#333;line-height:1.7;">' +
    '<div style="height:3px;background:' + (gut ? '#2BB6B7' : '#B4232C') + ';font-size:0;">&nbsp;</div>' +
    '<div style="padding:22px 4px;">' +
    '<div style="font-size:16px;font-weight:bold;color:' + (gut ? '#12797A' : '#B4232C') + ';margin-bottom:12px;">' + titel + '</div>' +
    '<p style="margin:0 0 14px;">' + satz + '</p>' +
    '<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width:100%;">' +
    zeile('Kunde', name) +
    zeile('Objekt', [auf.adresse, auf.plzOrt || auf.ort].filter(Boolean).join(', ')) +
    zeile('Telefon', auf.mobile || '') + zeile('E-Mail', auf.mail || auf.email || '') +
    zeile('Rhythmus', auf.frequenzText || auf.frequenz || '') +
    zeile('Erste Reinigung', auf.erstReinigung || '') +
    zeile('Rückmeldung', s.de) +
    '</table></div></div>';
  const r = await fetch('https://api.resend.com/emails', {
    method:'POST',
    headers:{ Authorization:'Bearer ' + key, 'Content-Type':'application/json' },
    body: JSON.stringify({
      from:'Angebotssystem PFS <putzfrauenservice@clean-service.ch>',
      to:[EMPFAENGER], reply_to: auf.mail || auf.email || EMPFAENGER,
      subject: titel, html,
      text: titel + '\n\n' + satz
    })
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('Resend: ' + JSON.stringify(d));
}

/* Bitte um eine Google-Bewertung an die Kundschaft */
async function bewertungBitten(auf) {
  const key = process.env.RESEND_API_KEY;
  if (!key) throw new Error('RESEND_API_KEY fehlt.');
  const mail = auf.mail || auf.email || '';
  if (!mail) throw new Error('Keine Kundenadresse hinterlegt.');
  const EN = String(auf.sprache || 'de').toLowerCase() === 'en';
  const nn = auf.nachname || '';
  const anrede = EN
    ? (auf.anrede === 'Herr' ? 'Dear Mr ' + nn : auf.anrede === 'Frau' ? 'Dear Mrs ' + nn
      : 'Dear ' + [auf.vorname, nn].filter(Boolean).join(' '))
    : (auf.anrede === 'Herr' ? 'Sehr geehrter Herr ' + nn : auf.anrede === 'Frau' ? 'Sehr geehrte Frau ' + nn
      : 'Guten Tag ' + [auf.vorname, nn].filter(Boolean).join(' '));

  const L = EN ? {
    betreff:'Thank you — and a small favour',
    a1:'Thank you very much for your feedback. It is good to hear that you are satisfied with our work.',
    a2:'If you have two minutes: a short review on Google helps other households find us — and it means a great deal to the team that looks after you.',
    knopf:'Write a review on Google',
    a3:'If anything is ever not to your satisfaction, please come to me directly at any time.',
    gruss:'Kind regards', rolle:'Head of Putzfrauenservice'
  } : {
    betreff:'Herzlichen Dank — und eine kleine Bitte',
    a1:'Vielen Dank für Ihre Rückmeldung. Es freut uns zu hören, dass Sie mit unserer Arbeit zufrieden sind.',
    a2:'Wenn Sie zwei Minuten erübrigen: Eine kurze Bewertung auf Google hilft anderen Haushalten, uns zu finden — und sie bedeutet dem Team, das Sie betreut, sehr viel.',
    knopf:'Bewertung auf Google schreiben',
    a3:'Sollte einmal etwas nicht passen, wenden Sie sich jederzeit direkt an mich.',
    gruss:'Freundliche Grüsse', rolle:'Bereichsleiter Putzfrauenservice'
  };

  const html =
    '<div style="font-family:Verdana,Geneva,sans-serif;font-size:13px;color:#333;line-height:1.7;max-width:640px;">' +
    '<div style="height:3px;background:#2BB6B7;font-size:0;">&nbsp;</div>' +
    '<div style="padding:24px 4px;">' +
    '<p style="margin:0 0 16px;">' + anrede + '</p>' +
    '<p style="margin:0 0 16px;">' + L.a1 + '</p>' +
    '<p style="margin:0 0 18px;">' + L.a2 + '</p>' +
    '<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 20px;"><tr>' +
    '<td style="background:#2BB6B7;"><a href="' + GOOGLE_LINK + '" style="display:inline-block;padding:13px 28px;' +
    'font-family:Verdana,sans-serif;font-size:13px;font-weight:bold;color:#fff;text-decoration:none;">' + L.knopf + '</a></td>' +
    '</tr></table>' +
    '<p style="margin:0 0 20px;">' + L.a3 + '</p>' +
    '<div style="border-top:2px solid #2BB6B7;padding-top:16px;font-size:13px;">' +
    '<strong>Cristian Gambale</strong><br>' + L.rolle + '<br>Direkt 052 557 02 08<br><br>' +
    '<span style="color:#767676;">Clean Service Scaramuzzo AG · Industriestrasse 5 · 8307 Effretikon<br>' +
    'T 0844 355 355 · clean-service.ch</span></div>' +
    '</div></div>';

  const r = await fetch('https://api.resend.com/emails', {
    method:'POST',
    headers:{ Authorization:'Bearer ' + key, 'Content-Type':'application/json' },
    body: JSON.stringify({
      from:'Cristian Gambale · Clean Service Scaramuzzo AG <putzfrauenservice@clean-service.ch>',
      to:[mail], bcc:[EMPFAENGER], reply_to: EMPFAENGER,
      subject: L.betreff, html,
      text: anrede + '\n\n' + L.a1 + '\n\n' + L.a2 + '\n\n' + GOOGLE_LINK + '\n\n' + L.a3 +
            '\n\n' + L.gruss + '\n\nCristian Gambale\n' + L.rolle
    })
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('Resend: ' + JSON.stringify(d));
}

function zeile(k, v) {
  if (!v) return '';
  return '<tr><td style="padding:7px 0;font-size:12px;color:#767676;width:150px;border-bottom:1px solid #EDEFEF;">' + k +
         '</td><td style="padding:7px 0;font-size:13px;color:#333;font-weight:bold;border-bottom:1px solid #EDEFEF;">' + v + '</td></tr>';
}

/* Bestaetigungsseite */
function seite(spr, art, st, id, sig) {
  const EN = spr === 'en';
  const s = STUFEN[st] || {};
  const T = EN ? {
    titel:'Your feedback: ' + (s.en || ''),
    frage:'Please confirm your feedback. It goes straight to the team looking after you.',
    knopf:'Confirm', dankeT:'Thank you',
    danke:'We have received your feedback. Thank you for taking the time.',
    fehlerT:'This link is no longer valid',
    fehler:'Please contact us directly, we will be glad to help: T 0844 355 355.',
    warten:'Saving …', pech:'Something went wrong. Please contact us at T 0844 355 355.'
  } : {
    titel:'Ihre Rückmeldung: ' + (s.de || ''),
    frage:'Bitte bestätigen Sie Ihre Rückmeldung. Sie geht direkt an das Team, das Sie betreut.',
    knopf:'Bestätigen', dankeT:'Vielen Dank',
    danke:'Ihre Rückmeldung ist bei uns eingegangen. Danke, dass Sie sich die Zeit genommen haben.',
    fehlerT:'Dieser Link ist nicht mehr gültig',
    fehler:'Bitte melden Sie sich direkt bei uns, wir helfen gerne weiter: T 0844 355 355.',
    warten:'Wird gespeichert …', pech:'Da ist etwas schiefgelaufen. Bitte melden Sie sich unter T 0844 355 355.'
  };

  const kopf = `<!DOCTYPE html><html lang="${EN?'en':'de'}"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${T.titel} – Clean Service Scaramuzzo AG</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Poppins:wght@400;600;700&family=Mulish:wght@400;600&display=swap" rel="stylesheet">
<style>
:root{--teal:#2BB6B7;--teal-deep:#1C7878;--tint:#EAF6F6;--bg:#FCFDFD;--ink:#0E1E1D;
 --body-c:#485655;--mute:#7C8C8B;--head:'Poppins',sans-serif;--body:'Mulish',sans-serif;}
*{box-sizing:border-box;}
body{margin:0;background:var(--bg);color:var(--body-c);font-family:var(--body);
 font-size:15px;line-height:1.7;-webkit-font-smoothing:antialiased;}
.shell{max-width:560px;margin:0 auto;padding:60px 24px 90px;text-align:center;}
h1{font-family:var(--head);font-weight:700;color:var(--ink);font-size:25px;line-height:1.3;margin:0 0 14px;}
p{margin:0 0 22px;}
button{font-family:var(--head);font-weight:600;font-size:15px;color:#fff;background:var(--teal);
 border:none;border-radius:100px;padding:14px 34px;cursor:pointer;}
button:hover{background:var(--teal-deep);} button[disabled]{background:var(--mute);cursor:default;}
.haken{width:58px;height:58px;margin:0 auto 20px;border-radius:50%;background:var(--tint);
 display:flex;align-items:center;justify-content:center;color:var(--teal-deep);font-size:26px;}
.fuss{margin-top:34px;font-size:12px;color:var(--mute);}
</style></head><body><div class="shell">`;
  const fuss = `<div class="fuss">Clean Service Scaramuzzo AG · Industriestrasse 5 · 8307 Effretikon<br>T 0844 355 355</div></div></body></html>`;

  if (art === 'fehler') return kopf + `<h1>${T.fehlerT}</h1><p>${T.fehler}</p>` + fuss;

  return kopf + `
<h1>${T.titel}</h1>
<p id="frage">${T.frage}</p>
<button id="btn" onclick="senden()">${T.knopf}</button>
<script>
async function senden(){
  var b=document.getElementById('btn');
  b.disabled=true; b.textContent=${JSON.stringify(T.warten)};
  try{
    var r=await fetch('/api/qualitaet',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({id:${JSON.stringify(id)},s:${JSON.stringify(st)},sig:${JSON.stringify(sig)}})});
    var d=await r.json().catch(function(){return {};});
    if(!r.ok) throw new Error('Server '+r.status+' '+(d.error||''));
    document.querySelector('h1').textContent=${JSON.stringify(T.dankeT)};
    document.getElementById('frage').textContent=${JSON.stringify(T.danke)};
    b.remove();
    var h=document.createElement('div'); h.className='haken'; h.textContent='\\u2713';
    document.querySelector('h1').before(h);
  }catch(e){
    document.getElementById('frage').textContent=${JSON.stringify(T.pech)};
    var hin=document.createElement('div');
    hin.style.cssText='margin-top:14px;font-size:11.5px;color:#B4232C;word-break:break-all;';
    hin.textContent=String(e&&e.message?e.message:e);
    document.getElementById('frage').after(hin);
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
