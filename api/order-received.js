import crypto from 'crypto';
// api/order-received.js
// Wird vom Auftragsformular aufgerufen, sobald ein Kunde absendet.
//
//   1. Setzt das Angebot in Firestore auf Status "auftrag"
//      → damit stoppen die automatischen Erinnerungen sofort
//   2. Benachrichtigt euch per E-Mail über den Eingang

const SAMMLUNG = 'angebote';
const EMPFAENGER = 'putzfrauenservice@clean-service.ch';
const SPEZIAL = 'spezialreinigung@clean-service.ch';

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
      stufe: 'neu',
      bearbeitet: false
    };
    try{
      await speichern('auftraege', auftragId, auftrag);
      ergebnis.auftragGespeichert = true;
    }catch(e){
      ergebnis.auftragGespeichert = false;
      ergebnis.speicherFehler = e.message;
    }

    /* ---- 1c) Auftragserteilung ins ReportingPFS ---- */
    try {
      ergebnis.reporting = await reportingEintragen('erteilungen', {
        kunde: [b.vorname, b.nachname].filter(Boolean).join(' '),
        datum: new Date().toISOString().slice(0, 10),
        dienstleistung: repDienstleistung(b.frequenz),
        wer: (angebot && angebot.erfasstVon) || ''
      });
    } catch (e) { ergebnis.reporting = { geschrieben: false, grund: e.message }; }

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

      const inhaltT = `
        <p style="margin:0 0 16px;">Über das Angebotssystem ist eine neue Auftragserteilung eingegangen.</p>
        ${csTabelle(zeilen)}
        ${b.vereinbarungen ? `
        <div style="background:#FDF8EE;border-left:3px solid #E0B454;padding:12px 16px;margin:0 0 18px;">
          <div style="font-size:11px;color:#8A6A2A;letter-spacing:.06em;margin-bottom:5px;">BESONDERE WÜNSCHE</div>
          <div style="font-size:13px;color:#333333;">${b.vereinbarungen}</div>
        </div>` : ''}
        ${csKnopf('Im CRM bearbeiten', 'https://' + (req.headers.host || 'angebot-pfs.vercel.app') + '/admin.html')}`;

      const html = csRahmen('Neue Auftragserteilung', inhaltT,
        'Automatische Meldung aus dem Angebotssystem. Antworten gehen direkt an die Kundschaft.');

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

      /* ---- Bestätigung an die Kundschaft ---- */
      const kundenMail = b.mail || b.email || '';
      if (kundenMail && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(kundenMail)) {
        const mitSpringer = String(b.springerSofort || '').toLowerCase() === 'ja';

        const gruss = b.anrede === 'Herr' ? `Sehr geehrter Herr ${b.nachname || ''}`
                    : b.anrede === 'Frau' ? `Sehr geehrte Frau ${b.nachname || ''}`
                    : `Guten Tag ${[b.vorname, b.nachname].filter(Boolean).join(' ')}`;

        const absatzStart = mitSpringer
          ? 'Wie von Ihnen gewünscht, starten wir bereits jetzt mit unserem Springerteam, damit Sie nicht warten müssen. Mein Administrationsteam meldet sich in den nächsten Tagen bei Ihnen, um den ersten Einsatz mit Ihnen zu vereinbaren. Parallel dazu organisieren wir sorgfältig Ihre feste Raumpflegerin.'
          : 'Für die Einführung inklusive erster Reinigung benötigen wir in der Regel eine Vorlaufzeit von 10 bis 14 Werktagen. In dieser Zeit organisieren wir sorgfältig die passende Reinigungskraft für Ihre Bedürfnisse und stimmen mit Ihnen die letzten Details ab. Sollte sich der Start dennoch verzögern, bieten wir Ihnen als Übergangslösung gerne unser Springerteam an, damit Sie keinen Unterbruch spüren.';

        const eckdaten = [
          ['Objekt', [b.adresse, b.plzOrt || b.ort].filter(Boolean).join(', ')],
          ['Reinigungsrhythmus', b.frequenzText || b.frequenz || ''],
          ['Gewünschter Tag', Array.isArray(b.tage) ? b.tage.join(', ') : (b.tage || '')],
          ['Zeitfenster', b.uhrzeit || ''],
          ['Aufwand', b.aufwandText || ''],
          ['Angebot Nr.', b.angebotsnr || '']
        ].filter(([, v]) => v);

        const inhaltK = `
          <p style="margin:0 0 14px;">${gruss}</p>
          <p style="margin:0 0 14px;">Herzlichen Dank für Ihr Vertrauen und die Erteilung des Auftrags. Wir freuen uns sehr, Sie als neue Kundschaft begrüssen zu dürfen, und werden alles daransetzen, dass Sie mit unserer Dienstleistung rundum zufrieden sind.</p>
          <p style="margin:0 0 14px;">${absatzStart}</p>
          <p style="margin:0 0 14px;">Im Tagesgeschäft stehen Ihnen <strong>Frau Scalone</strong> und <strong>Herr Moreno</strong> aus meinem Administrationsteam zur Seite. Sie sind Ihre direkten Ansprechpersonen für sämtliche organisatorischen Anliegen rund um Ihre Reinigung.</p>
          <p style="margin:0 0 14px;">Unser gesamtes Team steht für Zuverlässigkeit und Sorgfalt, damit Sie sich auf eine konstant hohe Qualität verlassen können. Sollten Sie dennoch einmal nicht zufrieden sein, wenden Sie sich jederzeit direkt an mich persönlich.</p>
          <p style="margin:0 0 18px;">Ich freue mich auf die Zusammenarbeit und melde mich, sobald die Einführung geplant ist.</p>
          ${eckdaten.length ? `
          <div style="font-family:Verdana,Geneva,sans-serif;font-size:11px;color:#767676;letter-spacing:.08em;margin:20px 0 2px;">IHRE ANGABEN IM ÜBERBLICK</div>
          ${csTabelle(eckdaten)}` : ''}`;

        const kundenHtml = csRahmen('Herzlichen Dank für Ihren Auftrag', inhaltK,
          'Diese Bestätigung wurde automatisch erstellt. Sie können direkt darauf antworten.');

        const kundenText =
          `${gruss}\n\n` +
          'Herzlichen Dank für Ihr Vertrauen und die Erteilung des Auftrags. Wir freuen uns sehr, Sie als neue Kundschaft begrüssen zu dürfen, und werden alles daransetzen, dass Sie mit unserer Dienstleistung rundum zufrieden sind.\n\n' +
          absatzStart + '\n\n' +
          'Im Tagesgeschäft stehen Ihnen Frau Scalone und Herr Moreno aus meinem Administrationsteam zur Seite. Sie sind Ihre direkten Ansprechpersonen für sämtliche organisatorischen Anliegen rund um Ihre Reinigung.\n\n' +
          'Unser gesamtes Team steht für Zuverlässigkeit und Sorgfalt, damit Sie sich auf eine konstant hohe Qualität verlassen können. Sollten Sie dennoch einmal nicht zufrieden sein, wenden Sie sich jederzeit direkt an mich persönlich — ich kümmere mich umgehend um eine Lösung.\n\n' +
          'Ich freue mich auf die Zusammenarbeit und melde mich, sobald die Einführung geplant ist.\n\n' +
          (eckdaten.length ? eckdaten.map(([k, v]) => `${k}: ${v}`).join('\n') + '\n\n' : '') +
          'Freundliche Grüsse\nCristian Gambale\nBereichsleiter Putzfrauenservice\n\n' +
          'Clean Service Scaramuzzo AG · Industriestrasse 5 · 8307 Effretikon\nT 0844 355 355 · clean-service.ch';

        try {
          const rk = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              from: 'Clean Service Scaramuzzo AG <putzfrauenservice@clean-service.ch>',
              to: [kundenMail],
              reply_to: 'putzfrauenservice@clean-service.ch',
              subject: 'Herzlichen Dank für Ihren Auftrag — Clean Service Scaramuzzo AG',
              html: kundenHtml,
              text: kundenText
            })
          });
          ergebnis.kundenmailGesendet = rk.ok;
        } catch (e) {
          ergebnis.kundenmailGesendet = false;
        }
      }

      /* ---- Fensterreinigung gewünscht: Spezialreinigung informieren ---- */
      if (String(b.fensterOfferte || '').toLowerCase() === 'ja') {
        const zeilenF = [
          ['Kunde', name],
          ['Adresse', [b.adresse, b.plzOrt || b.ort].filter(Boolean).join(', ')],
          ['Telefon', b.mobile || ''],
          ['E-Mail', b.mail || b.email || ''],
          ['Zimmer', b.zimmer || ''],
          ['Fläche', b.qm ? b.qm + ' m²' : ''],
          ['Angebot Nr.', b.angebotsnr || ''],
          ['Reinigungsrhythmus', b.frequenzText || b.frequenz || '']
        ].filter(([, v]) => v);

        const inhaltF = `
          <p style="margin:0 0 16px;">Bei der Auftragserteilung für die Privathaushaltreinigung wurde eine <strong>unverbindliche Offerte für die Fensterreinigung</strong> gewünscht. Wir bitten um Kontaktaufnahme mit der Kundschaft.</p>
          ${csTabelle(zeilenF)}
          ${b.vereinbarungen ? `
          <div style="background:#FDF8EE;border-left:3px solid #E0B454;padding:12px 16px;margin:0 0 6px;">
            <div style="font-size:11px;color:#8A6A2A;letter-spacing:.06em;margin-bottom:5px;">HINWEISE DER KUNDSCHAFT</div>
            <div style="font-size:13px;color:#333333;">${b.vereinbarungen}</div>
          </div>` : ''}`;

        const htmlF = csRahmen('Fensterreinigungsofferte gewünscht', inhaltF,
          'Automatische Meldung aus dem Angebotssystem Putzfrauenservice. Antworten gehen direkt an die Kundschaft.');

        try {
          const rf = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              from: 'Angebotssystem PFS <putzfrauenservice@clean-service.ch>',
              to: [SPEZIAL],
              cc: [EMPFAENGER],
              reply_to: b.mail || b.email || EMPFAENGER,
              subject: `Fensterreinigungsofferte gewünscht — ${name}`,
              html: htmlF,
              text: 'Fensterreinigungsofferte gewünscht\n\n' +
                    zeilenF.map(([k, v]) => `${k}: ${v}`).join('\n') +
                    '\n\nBitte um Kontaktaufnahme mit der Kundschaft.'
            })
          });
          ergebnis.fenstermailGesendet = rf.ok;
        } catch (e) {
          ergebnis.fenstermailGesendet = false;
        }
      }
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
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="max-width:640px;margin:0 auto;background:#FFFFFF;border:1px solid #DDE2E1;">
    <tr><td style="padding:22px 32px 18px;border-bottom:3px solid ${CS_FARBE};">
      <div style="font-family:Verdana,Geneva,sans-serif;font-size:15px;font-weight:bold;color:${CS_DUNKEL};letter-spacing:.02em;">CLEAN SERVICE SCARAMUZZO AG</div>
      <div style="font-family:Verdana,Geneva,sans-serif;font-size:11px;color:${CS_GRAU};margin-top:3px;">Putzfrauenservice · seit 1984</div>
    </td></tr>
    <tr><td style="padding:26px 32px 8px;">
      <div style="font-family:Verdana,Geneva,sans-serif;font-size:16px;font-weight:bold;color:${CS_TEXT};line-height:1.4;">${titel}</div>
    </td></tr>
    <tr><td style="padding:12px 32px 26px;font-family:Verdana,Geneva,sans-serif;font-size:13px;line-height:1.7;color:${CS_TEXT};">
      ${inhalt}
      ${csSignatur()}
    </td></tr>
    ${hinweis ? `<tr><td style="padding:14px 32px;background:#F7F9F9;border-top:1px solid #E5E9E8;font-family:Verdana,Geneva,sans-serif;font-size:11px;color:${CS_GRAU};line-height:1.6;">${hinweis}</td></tr>` : ''}
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

/* ==========================================================================
   Anbindung an ReportingPFS
   Schreibt Anfragen und Auftragserteilungen in das bestehende Reporting.
   Aufbau dort: ein Dokument je Abteilung und Monat, z. B.
   "pfs-reporting:pfs:2026-09" mit den Feldern key und value.
   value enthält als Text: { "anfragen": [...], "erteilungen": [...] }

   Sicherheit: gelesen wird zuerst, ergänzt wird nur, wenn das Format
   erkannt wurde. Bei jeder Unklarheit wird NICHT geschrieben — lieber
   ein fehlender Eintrag als ein zerstörter Monat.

   Umgebungsvariablen:
     REPORTING_PROJECT_ID · REPORTING_CLIENT_EMAIL · REPORTING_PRIVATE_KEY
   ========================================================================== */
const REP_SAMMLUNG = 'pfs_storage';
const REP_ABTEILUNG = 'pfs';
let repTokenCache = { token: null, ablauf: 0 };

async function repToken(){
  const jetzt = Math.floor(Date.now() / 1000);
  if (repTokenCache.token && repTokenCache.ablauf > jetzt + 60) return repTokenCache.token;
  const email = process.env.REPORTING_CLIENT_EMAIL;
  let key = (process.env.REPORTING_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  if (!email || !key) throw new Error('Reporting-Zugangsdaten fehlen');

  const b64 = s => Buffer.from(s).toString('base64')
    .replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
  const header = b64(JSON.stringify({ alg:'RS256', typ:'JWT' }));
  const claim = b64(JSON.stringify({
    iss: email, scope: 'https://www.googleapis.com/auth/datastore',
    aud: 'https://oauth2.googleapis.com/token', exp: jetzt + 3600, iat: jetzt
  }));
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(`${header}.${claim}`);
  const sig = signer.sign(key, 'base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'},
    body: new URLSearchParams({
      grant_type:'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${header}.${claim}.${sig}`
    })
  });
  const d = await res.json();
  if (!res.ok) throw new Error('Reporting-Anmeldung fehlgeschlagen');
  repTokenCache = { token: d.access_token, ablauf: jetzt + (d.expires_in || 3600) };
  return repTokenCache.token;
}

function repUrl(dokument){
  const pid = process.env.REPORTING_PROJECT_ID;
  if (!pid) throw new Error('REPORTING_PROJECT_ID fehlt');
  return `https://firestore.googleapis.com/v1/projects/${pid}/databases/(default)/documents/` +
         `${REP_SAMMLUNG}/${encodeURIComponent(dokument)}`;
}

function repDienstleistung(frequenz){
  const m = { 'woechentlich':'wöchentlich', '14-taeglich':'14-täglich', 'monatlich':'monatlich' };
  return m[frequenz] || frequenz || '';
}

function repId(){
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

/**
 * Trägt einen Datensatz ins Reporting ein.
 * @param {'anfragen'|'erteilungen'} bereich
 * @param {object} satz  { kunde, datum, dienstleistung, anfrageart, quelle, wer }
 * @returns {Promise<object>} Ergebnisbericht
 */
async function reportingEintragen(bereich, satz){
  const bericht = { bereich, geschrieben: false };
  if (!process.env.REPORTING_PROJECT_ID) { bericht.grund = 'nicht eingerichtet'; return bericht; }
  if (!satz || !satz.kunde || !satz.datum) { bericht.grund = 'unvollständige Daten'; return bericht; }

  try {
    const monat = String(satz.datum).slice(0, 7);            // z. B. 2026-09
    const dok = `pfs-reporting:${REP_ABTEILUNG}:${monat}`;
    const token = await repToken();

    // 1) Bestehenden Stand lesen
    const res = await fetch(repUrl(dok), { headers: { Authorization: `Bearer ${token}` } });
    let inhalt = { anfragen: [], erteilungen: [] };
    let vorhanden = false;

    if (res.ok) {
      const doc = await res.json();
      const roh = doc?.fields?.value?.stringValue;
      if (typeof roh === 'string' && roh.trim()) {
        let geparst;
        try { geparst = JSON.parse(roh); }
        catch (e) {
          bericht.grund = 'Inhalt nicht lesbar — es wurde nichts geschrieben';
          return bericht;                                     // Schutz: nicht überschreiben
        }
        if (!geparst || typeof geparst !== 'object' ||
            !Array.isArray(geparst.anfragen) || !Array.isArray(geparst.erteilungen)) {
          bericht.grund = 'unerwartetes Format — es wurde nichts geschrieben';
          return bericht;                                     // Schutz
        }
        inhalt = geparst;
        vorhanden = true;
      }
    } else if (res.status !== 404) {
      bericht.grund = 'Lesen fehlgeschlagen (' + res.status + ')';
      return bericht;
    }

    // 2) Doppelte Einträge vermeiden
    const schonDa = inhalt[bereich].some(x =>
      x.kunde === satz.kunde && x.datum === satz.datum);
    if (schonDa) { bericht.grund = 'bereits erfasst'; bericht.geschrieben = true; return bericht; }

    // 3) Ergänzen
    inhalt[bereich].push(Object.assign({ id: repId() }, satz));

    // 4) Zurückschreiben — nur die beiden bekannten Felder
    const speichern = await fetch(repUrl(dok) + '?updateMask.fieldPaths=key&updateMask.fieldPaths=value', {
      method:'PATCH',
      headers:{ Authorization:`Bearer ${token}`, 'Content-Type':'application/json' },
      body: JSON.stringify({ fields: {
        key:   { stringValue: dok },
        value: { stringValue: JSON.stringify(inhalt) }
      }})
    });
    if (!speichern.ok) {
      bericht.grund = 'Schreiben fehlgeschlagen (' + speichern.status + ')';
      return bericht;
    }

    bericht.geschrieben = true;
    bericht.dokument = dok;
    bericht.anzahlNachher = inhalt[bereich].length;
    bericht.dokumentWarVorhanden = vorhanden;
    return bericht;

  } catch (err) {
    bericht.grund = err.message;
    return bericht;
  }
}
