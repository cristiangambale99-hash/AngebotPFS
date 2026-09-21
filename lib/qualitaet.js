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
    /* Die Kundschaft soll auf der Seite noch wechseln können, deshalb
       bekommt jede der vier Stufen ihre eigene Signatur mit. */
    const sigs = {};
    Object.keys(STUFEN).forEach(k => { sigs[k] = signieren(id, k); });
    return res.status(200).send(seite(spr, 'frage', st, id, sig, sigs));
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
    const rueckmeldung = String((b.text || '')).trim().slice(0, 2000);
    if (rueckmeldung) neu.qualitaetText = rueckmeldung;
    // Ist die Kundschaft zufrieden, ist der Fall abgeschlossen und wandert ins Archiv.
    // Bei den unteren Stufen bleibt er offen, damit jemand nachfasst.
    if (STUFEN[st].rang >= 3) neu.stufe = 'archiv';
    await speichern(SAMMLUNG, fund.schluessel, neu);
    bericht.gespeichert = true;

    try { await melden(auf, st, rueckmeldung); bericht.gemeldet = true; }
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
async function melden(auf, st, rueckmeldung) {
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
    '</table>' +
    (rueckmeldung
      ? '<div style="margin-top:18px;border-left:3px solid ' + (gut ? '#2BB6B7' : '#B4232C') + ';' +
        'background:#F5F9F9;padding:12px 16px;font-size:13px;line-height:1.7;color:#333;">' +
        '<div style="font-size:11.5px;color:#767676;margin-bottom:6px;">Das schreibt die Kundschaft</div>' +
        String(rueckmeldung).replace(/[<>&]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[c])).replace(/\n/g, '<br>') +
        '</div>'
      : '') +
    '</div></div>';
  const r = await fetch('https://api.resend.com/emails', {
    method:'POST',
    headers:{ Authorization:'Bearer ' + key, 'Content-Type':'application/json' },
    body: JSON.stringify({
      from:'Angebotssystem PFS <putzfrauenservice@clean-service.ch>',
      to:[EMPFAENGER], reply_to: auf.mail || auf.email || EMPFAENGER,
      subject: titel, html,
      text: titel + '\n\n' + satz + (rueckmeldung ? '\n\n' + rueckmeldung : '')
    })
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('Resend: ' + JSON.stringify(d));
}

/* Bitte um eine Google-Bewertung an die Kundschaft.
   Zweiter Parameter nur fuer den Probeversand aus dem Admin-Bereich:
   die Nachricht geht dann an diese Adresse statt an die Kundschaft. */
export async function bewertungBitten(auf, zielAdresse) {
  const key = process.env.RESEND_API_KEY;
  if (!key) throw new Error('RESEND_API_KEY fehlt.');
  const mail = String(zielAdresse || auf.mail || auf.email || '');
  if (!mail) throw new Error('Keine Kundenadresse hinterlegt.');
  const EN = String(auf.sprache || 'de').toLowerCase() === 'en';
  const nn = auf.nachname || '';
  const anrede = EN
    ? (auf.anrede === 'Herr' ? 'Dear Mr ' + nn : auf.anrede === 'Frau' ? 'Dear Mrs ' + nn
      : 'Dear ' + [auf.vorname, nn].filter(Boolean).join(' '))
    : (auf.anrede === 'Herr' ? 'Sehr geehrter Herr ' + nn : auf.anrede === 'Frau' ? 'Sehr geehrte Frau ' + nn
      : 'Guten Tag ' + [auf.vorname, nn].filter(Boolean).join(' '));

  const pflegerin = auf.raumpflegerin || '';

  const L = EN ? {
    betreff: 'Five stars for ' + (pflegerin || 'your cleaner') + '?',
    vorspann: 'Two minutes, five stars',
    titel: 'Thank you for your feedback',
    a1: 'It is good to hear that you are happy with our work. May we ask for two minutes in return?',
    a2: pflegerin
      ? 'A review on Google is the finest recognition ' + pflegerin + ' can receive — and it helps other households find a service they can trust.'
      : 'A review on Google is the finest recognition our team can receive — and it helps other households find a service they can trust.',
    sterne: 'Tap a star to open Google',
    knopf: 'Write my review',
    dauer: 'Takes about two minutes · no account details needed beyond your Google login',
    a3: 'And if something is ever not right, tell us straight away — that is what we are here for.',
    gruss: 'Kind regards', rolle: 'Head of Putzfrauenservice'
  } : {
    betreff: 'Fünf Sterne für ' + (pflegerin || 'Ihre Raumpflegerin') + '?',
    vorspann: 'Zwei Minuten, fünf Sterne',
    titel: 'Danke für Ihre Rückmeldung',
    a1: 'Es freut uns zu hören, dass Sie mit unserer Arbeit zufrieden sind. Dürfen wir Sie im Gegenzug um zwei Minuten bitten?',
    a2: pflegerin
      ? 'Eine Bewertung auf Google ist die schönste Anerkennung, die ' + pflegerin + ' bekommen kann — und sie hilft anderen Haushalten, einen Dienst zu finden, dem sie vertrauen können.'
      : 'Eine Bewertung auf Google ist die schönste Anerkennung, die unser Team bekommen kann — und sie hilft anderen Haushalten, einen Dienst zu finden, dem sie vertrauen können.',
    sterne: 'Auf einen Stern tippen und Google öffnen',
    knopf: 'Jetzt bewerten',
    dauer: 'Dauert rund zwei Minuten · es genügt Ihr Google-Konto',
    a3: 'Und sollte einmal etwas nicht passen, sagen Sie es uns direkt. Genau dafür sind wir da.',
    gruss: 'Freundliche Grüsse', rolle: 'Bereichsleiter Putzfrauenservice'
  };

  /* Fünf Sterne, jeder einzeln verlinkt. Als Textzeichen, damit sie in jedem
     Mailprogramm ankommen — Bilder werden häufig blockiert. */
  const stern = '<a href="' + GOOGLE_LINK + '" style="text-decoration:none;color:#F5B301;font-size:34px;line-height:1;">&#9733;</a>';
  const sterne = new Array(5).fill(stern).join('<span style="display:inline-block;width:6px;">&nbsp;</span>');

  const html =
  '<div style="background:#F2F8F8;padding:26px 12px;font-family:Verdana,Geneva,sans-serif;">' +
  '<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="max-width:600px;width:100%;background:#FFFFFF;border-radius:12px;overflow:hidden;">' +

    '<tr><td style="height:4px;background:#2BB6B7;font-size:0;line-height:0;">&nbsp;</td></tr>' +

    /* Kopf mit Sternen */
    '<tr><td align="center" style="padding:30px 28px 22px;background:#EAF6F6;">' +
      '<div style="font-size:11px;letter-spacing:.08em;color:#12797A;margin-bottom:12px;">' + L.vorspann + '</div>' +
      '<div style="margin-bottom:10px;">' + sterne + '</div>' +
      '<div style="font-size:12px;color:#5E7273;">' + L.sterne + '</div>' +
    '</td></tr>' +

    '<tr><td style="padding:26px 28px 8px;">' +
      '<div style="font-size:19px;font-weight:bold;color:#0E1E1D;margin-bottom:14px;">' + L.titel + '</div>' +
      '<p style="margin:0 0 14px;font-size:13.5px;line-height:1.7;color:#3C4A48;">' + anrede + '</p>' +
      '<p style="margin:0 0 14px;font-size:13.5px;line-height:1.7;color:#3C4A48;">' + L.a1 + '</p>' +
      '<p style="margin:0 0 22px;font-size:13.5px;line-height:1.7;color:#3C4A48;">' + L.a2 + '</p>' +
    '</td></tr>' +

    /* Schaltfläche */
    '<tr><td align="center" style="padding:0 28px 10px;">' +
      '<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>' +
      '<td style="background:#2BB6B7;border-radius:8px;">' +
        '<a href="' + GOOGLE_LINK + '" style="display:inline-block;padding:15px 34px;font-family:Verdana,sans-serif;' +
        'font-size:14px;font-weight:bold;color:#ffffff;text-decoration:none;">' + L.knopf + '</a>' +
      '</td></tr></table>' +
      '<div style="font-size:11.5px;color:#7C8C8B;margin-top:10px;">' + L.dauer + '</div>' +
    '</td></tr>' +

    '<tr><td style="padding:22px 28px 0;">' +
      '<p style="margin:0 0 20px;font-size:13.5px;line-height:1.7;color:#3C4A48;">' + L.a3 + '</p>' +
    '</td></tr>' +

    /* Signatur */
    '<tr><td style="padding:0 28px 28px;">' +
      '<div style="border-top:2px solid #2BB6B7;padding-top:16px;font-size:13px;color:#3C4A48;line-height:1.6;">' +
        '<strong style="color:#0E1E1D;">Putzfrauenservice · Admin-Team</strong><br>Clean Service Scaramuzzo AG<br>0844 355 355' +
        '<div style="margin-top:12px;font-size:11.5px;color:#7C8C8B;">' +
          'Clean Service Scaramuzzo AG · Industriestrasse 5 · 8307 Effretikon<br>' +
          'T 0844 355 355 · clean-service.ch</div>' +
      '</div>' +
    '</td></tr>' +

  '</table></div>';

  const r = await fetch('https://api.resend.com/emails', {
    method:'POST',
    headers:{ Authorization:'Bearer ' + key, 'Content-Type':'application/json' },
    body: JSON.stringify({
      from:'Clean Service Scaramuzzo AG <putzfrauenservice@clean-service.ch>',
      to:[mail], bcc: zielAdresse ? [] : [EMPFAENGER], reply_to: EMPFAENGER,
      subject: L.betreff, html,
      text: anrede + '\n\n' + L.a1 + '\n\n' + L.a2 + '\n\n' + L.knopf + ': ' + GOOGLE_LINK + '\n\n' + L.a3 +
            '\n\n' + L.gruss + '\n\nPutzfrauenservice · Admin-Team\nClean Service Scaramuzzo AG'
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

/* Rueckmeldeseite: Stufe waehlen und frei dazuschreiben */
function seite(spr, art, st, id, sig, sigs) {
  const EN = spr === 'en';
  const T = EN ? {
    titel:'How satisfied are you?',
    frage:'Your answer goes straight to the team looking after you. You can change your choice here.',
    textLabel:'Anything you would like to add? (optional)',
    textHint:'What went well, what should we do differently?',
    platzhalter:'Your message to us …',
    knopf:'Send feedback', dankeT:'Thank you',
    danke:'We have received your feedback. Thank you for taking the time.',
    fehlerT:'This link is no longer valid',
    fehler:'Please contact us directly, we will be glad to help: T 0844 355 355.',
    warten:'Sending …', pech:'Something went wrong. Please contact us at T 0844 355 355.',
    stufen:[['sehr_zufrieden','Very satisfied'],['zufrieden','Satisfied'],
            ['teilweise','Partly satisfied'],['nicht','Not satisfied']]
  } : {
    titel:'Wie zufrieden sind Sie?',
    frage:'Ihre Antwort geht direkt an das Team, das Sie betreut. Sie können Ihre Wahl hier noch ändern.',
    textLabel:'Möchten Sie uns etwas mitgeben? (freiwillig)',
    textHint:'Was läuft gut, was sollten wir anders machen?',
    platzhalter:'Ihre Nachricht an uns …',
    knopf:'Rückmeldung senden', dankeT:'Vielen Dank',
    danke:'Ihre Rückmeldung ist bei uns eingegangen. Danke, dass Sie sich die Zeit genommen haben.',
    fehlerT:'Dieser Link ist nicht mehr gültig',
    fehler:'Bitte melden Sie sich direkt bei uns, wir helfen gerne weiter: T 0844 355 355.',
    warten:'Wird gesendet …', pech:'Da ist etwas schiefgelaufen. Bitte melden Sie sich unter T 0844 355 355.',
    stufen:[['sehr_zufrieden','Sehr zufrieden'],['zufrieden','Zufrieden'],
            ['teilweise','Teilweise zufrieden'],['nicht','Nicht zufrieden']]
  };

  const kopf = `<!DOCTYPE html><html lang="${EN?'en':'de'}"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${T.titel} – Clean Service Scaramuzzo AG</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Poppins:wght@400;600;700&family=Mulish:wght@400;600&display=swap" rel="stylesheet">
<style>
:root{--teal:#2BB6B7;--teal-deep:#1C7878;--tint:#EAF6F6;--bg:#FCFDFD;--ink:#0E1E1D;
 --body-c:#485655;--mute:#7C8C8B;--linie:#E1EAE9;--head:'Poppins',sans-serif;--body:'Mulish',sans-serif;}
*{box-sizing:border-box;}
body{margin:0;background:var(--bg);color:var(--body-c);font-family:var(--body);
 font-size:15px;line-height:1.7;-webkit-font-smoothing:antialiased;}
.shell{max-width:560px;margin:0 auto;padding:54px 22px 80px;}
h1{font-family:var(--head);font-weight:700;color:var(--ink);font-size:25px;line-height:1.3;margin:0 0 12px;text-align:center;}
p.lede{margin:0 0 26px;text-align:center;}
.wahl{display:block;width:100%;text-align:left;background:#fff;border:1.5px solid var(--linie);
 border-radius:14px;padding:15px 18px;margin-bottom:10px;cursor:pointer;font-family:var(--body);
 font-size:15px;color:var(--ink);display:flex;align-items:center;gap:13px;transition:border-color .15s,background .15s;}
.wahl:hover{border-color:#BCDDDC;background:#F7FBFB;}
.wahl.on{border-color:var(--teal);background:var(--tint);}
.punkt{width:20px;height:20px;border-radius:50%;border:2px solid var(--linie);flex:none;position:relative;}
.wahl.on .punkt{border-color:var(--teal);}
.wahl.on .punkt::after{content:'';position:absolute;inset:3px;border-radius:50%;background:var(--teal);}
.feld{margin:26px 0 8px;}
.feld label{display:block;font-family:var(--head);font-weight:600;font-size:14px;color:var(--ink);margin-bottom:4px;}
.feld .hint{font-size:13px;color:var(--mute);margin-bottom:9px;}
textarea{width:100%;min-height:120px;font-family:var(--body);font-size:15px;color:var(--ink);
 background:#fff;border:1.5px solid var(--linie);border-radius:14px;padding:13px 15px;resize:vertical;line-height:1.6;}
textarea:focus{outline:none;border-color:var(--teal);}
.mitte{text-align:center;margin-top:22px;}
button{font-family:var(--head);font-weight:600;font-size:15px;color:#fff;background:var(--teal);
 border:none;border-radius:100px;padding:14px 34px;cursor:pointer;}
button:hover{background:var(--teal-deep);} button[disabled]{background:var(--mute);cursor:default;}
.haken{width:58px;height:58px;margin:0 auto 20px;border-radius:50%;background:var(--tint);
 display:flex;align-items:center;justify-content:center;color:var(--teal-deep);font-size:26px;}
.fuss{margin-top:34px;font-size:12px;color:var(--mute);text-align:center;}
</style></head><body><div class="shell">`;
  const fuss = `<div class="fuss">Clean Service Scaramuzzo AG · Industriestrasse 5 · 8307 Effretikon<br>T 0844 355 355</div></div></body></html>`;

  if (art === 'fehler') return kopf + `<h1>${T.fehlerT}</h1><p class="lede">${T.fehler}</p>` + fuss;

  const knoepfe = T.stufen.map(([k, label]) =>
    `<button type="button" class="wahl${k === st ? ' on' : ''}" data-s="${k}" onclick="waehlen('${k}')">` +
    `<span class="punkt"></span><span>${label}</span></button>`).join('');

  return kopf + `
<h1>${T.titel}</h1>
<p class="lede">${T.frage}</p>
<div id="wahlen">${knoepfe}</div>
<div class="feld">
  <label for="txt">${T.textLabel}</label>
  <div class="hint">${T.textHint}</div>
  <textarea id="txt" maxlength="2000" placeholder="${T.platzhalter}"></textarea>
</div>
<div class="mitte"><button id="btn" onclick="senden()">${T.knopf}</button></div>
<script>
var SIGS = ${JSON.stringify(sigs || {})};
var AUSWAHL = ${JSON.stringify(st)};
function waehlen(k){
  AUSWAHL = k;
  var alle = document.querySelectorAll('.wahl');
  for(var i=0;i<alle.length;i++){ alle[i].classList.toggle('on', alle[i].dataset.s === k); }
}
async function senden(){
  var b=document.getElementById('btn');
  b.disabled=true; b.textContent=${JSON.stringify(T.warten)};
  try{
    var r=await fetch('/api/qualitaet',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({id:${JSON.stringify(id)}, s:AUSWAHL,
        sig: SIGS[AUSWAHL] || ${JSON.stringify(sig)},
        text: document.getElementById('txt').value})});
    var d=await r.json().catch(function(){return {};});
    if(!r.ok) throw new Error('Server '+r.status+' '+(d.error||''));
    document.querySelector('h1').textContent=${JSON.stringify(T.dankeT)};
    document.querySelector('p.lede').textContent=${JSON.stringify(T.danke)};
    document.getElementById('wahlen').remove();
    document.querySelector('.feld').remove();
    b.remove();
    var h=document.createElement('div'); h.className='haken'; h.textContent='\\u2713';
    document.querySelector('h1').before(h);
  }catch(e){
    document.querySelector('p.lede').textContent=${JSON.stringify(T.pech)};
    var hin=document.createElement('div');
    hin.style.cssText='margin-top:14px;font-size:11.5px;color:#B4232C;word-break:break-all;text-align:center;';
    hin.textContent=String(e&&e.message?e.message:e);
    document.querySelector('p.lede').after(hin);
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
