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

      const tabelle = zeilen.map(([k, v], i) => `
        <tr style="background:${i % 2 ? '#FFFFFF' : '#F7FBFB'};">
          <td style="padding:11px 16px;color:#7C8C8B;font-size:12.5px;width:150px;vertical-align:top;border-bottom:1px solid #EDF3F2;">${k}</td>
          <td style="padding:11px 16px;color:#0E1E1D;font-size:13.5px;font-weight:600;border-bottom:1px solid #EDF3F2;">${v}</td>
        </tr>`).join('');

      const html = `
      <div style="background:#F4F8F8;padding:28px 16px;">
        <div style="max-width:600px;margin:0 auto;background:#FFFFFF;border-radius:14px;overflow:hidden;box-shadow:0 2px 12px rgba(14,30,29,.07);font-family:Verdana,Arial,sans-serif;">

          <div style="background:linear-gradient(135deg,#2BB6B7,#12797A);padding:26px 28px;">
            <div style="color:rgba(255,255,255,.82);font-size:11px;letter-spacing:.14em;text-transform:uppercase;margin-bottom:7px;">Clean Service Scaramuzzo AG</div>
            <div style="color:#FFFFFF;font-size:20px;font-weight:bold;line-height:1.3;">Neue Auftragserteilung</div>
            <div style="color:rgba(255,255,255,.9);font-size:14px;margin-top:5px;">${name}${b.angebotsnr ? ' &nbsp;·&nbsp; Angebot Nr. ' + b.angebotsnr : ''}</div>
          </div>

          <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;">
            ${tabelle}
          </table>

          ${b.vereinbarungen ? `
          <div style="padding:18px 28px;background:#FFF8EC;border-top:1px solid #F2E3C9;">
            <div style="font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:#96601A;margin-bottom:6px;">Spezielle Vereinbarungen</div>
            <div style="font-size:13.5px;color:#0E1E1D;line-height:1.6;">${b.vereinbarungen}</div>
          </div>` : ''}

          <div style="padding:24px 28px;text-align:center;">
            <a href="https://${req.headers.host || 'angebot-pfs.vercel.app'}/admin.html"
               style="background:#2BB6B7;color:#FFFFFF;padding:14px 30px;border-radius:100px;text-decoration:none;font-weight:bold;display:inline-block;font-size:14px;">Im CRM bearbeiten</a>
          </div>

          <div style="padding:16px 28px 22px;border-top:1px solid #EDF3F2;text-align:center;">
            <div style="font-size:11px;color:#9AA8A7;line-height:1.6;">
              Automatische Meldung aus dem Angebotssystem<br>
              Clean Service Scaramuzzo AG · Industriestrasse 5 · 8307 Effretikon
            </div>
          </div>

        </div>
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

        const eckTabelle = eckdaten.map(([k, v], i) => `
          <tr style="background:${i % 2 ? '#FFFFFF' : '#F7FBFB'};">
            <td style="padding:10px 16px;color:#7C8C8B;font-size:12.5px;width:160px;border-bottom:1px solid #EDF3F2;">${k}</td>
            <td style="padding:10px 16px;color:#0E1E1D;font-size:13.5px;font-weight:600;border-bottom:1px solid #EDF3F2;">${v}</td>
          </tr>`).join('');

        const kundenHtml = `
        <div style="background:#F4F8F8;padding:28px 16px;">
          <div style="max-width:600px;margin:0 auto;background:#FFFFFF;border-radius:14px;overflow:hidden;box-shadow:0 2px 12px rgba(14,30,29,.07);font-family:Verdana,Arial,sans-serif;">

            <div style="background:linear-gradient(135deg,#2BB6B7,#12797A);padding:28px;">
              <div style="color:rgba(255,255,255,.82);font-size:11px;letter-spacing:.14em;text-transform:uppercase;margin-bottom:8px;">Clean Service Scaramuzzo AG</div>
              <div style="color:#FFFFFF;font-size:21px;font-weight:bold;line-height:1.3;">Herzlichen Dank für Ihr Vertrauen</div>
            </div>

            <div style="padding:28px;color:#485655;font-size:14px;line-height:1.7;">
              <p style="margin:0 0 16px;">${gruss}</p>
              <p style="margin:0 0 16px;">Herzlichen Dank für Ihr Vertrauen und die Erteilung des Auftrags. Wir freuen uns sehr, Sie als neue Kundschaft begrüssen zu dürfen, und werden alles daransetzen, dass Sie mit unserer Dienstleistung rundum zufrieden sind.</p>
              <p style="margin:0 0 16px;">${absatzStart}</p>
              <p style="margin:0 0 16px;">Im Tagesgeschäft stehen Ihnen <strong>Frau Scalone</strong> und <strong>Herr Moreno</strong> aus meinem Administrationsteam zur Seite. Sie sind Ihre direkten Ansprechpersonen für sämtliche organisatorischen Anliegen rund um Ihre Reinigung.</p>
              <p style="margin:0 0 16px;">Unser gesamtes Team steht für Zuverlässigkeit und Sorgfalt, damit Sie sich auf eine konstant hohe Qualität verlassen können. Sollten Sie dennoch einmal nicht zufrieden sein, wenden Sie sich jederzeit direkt an mich persönlich — ich kümmere mich umgehend um eine Lösung.</p>
              <p style="margin:0;">Ich freue mich auf die Zusammenarbeit und melde mich, sobald die Einführung geplant ist.</p>
            </div>

            ${eckTabelle ? `
            <div style="padding:0 28px 4px;">
              <div style="font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:#7C8C8B;margin-bottom:8px;">Ihre Angaben im Überblick</div>
            </div>
            <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;border-top:1px solid #EDF3F2;">
              ${eckTabelle}
            </table>` : ''}

            <div style="padding:24px 28px;border-top:1px solid #EDF3F2;">
              <div style="font-size:14px;color:#0E1E1D;font-weight:bold;">Cristian Gambale</div>
              <div style="font-size:12.5px;color:#7C8C8B;margin-top:2px;">Bereichsleiter Putzfrauenservice</div>
              <div style="font-size:12.5px;color:#12797A;margin-top:8px;">T 0844 355 355 · putzfrauenservice@clean-service.ch</div>
            </div>

            <div style="padding:16px 28px 22px;background:#F7FBFB;text-align:center;">
              <div style="font-size:11px;color:#9AA8A7;line-height:1.6;">
                Clean Service Scaramuzzo AG · Industriestrasse 5 · 8307 Effretikon<br>
                T 0844 355 355 · clean-service.ch
              </div>
            </div>

          </div>
        </div>`;

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

        const tabF = zeilenF.map(([k, v], i) => `
          <tr style="background:${i % 2 ? '#FFFFFF' : '#F7FBFB'};">
            <td style="padding:10px 16px;color:#7C8C8B;font-size:12.5px;width:150px;border-bottom:1px solid #EDF3F2;">${k}</td>
            <td style="padding:10px 16px;color:#0E1E1D;font-size:13.5px;font-weight:600;border-bottom:1px solid #EDF3F2;">${v}</td>
          </tr>`).join('');

        const htmlF = `
        <div style="background:#F4F8F8;padding:28px 16px;">
          <div style="max-width:600px;margin:0 auto;background:#FFFFFF;border-radius:14px;overflow:hidden;box-shadow:0 2px 12px rgba(14,30,29,.07);font-family:Verdana,Arial,sans-serif;">
            <div style="background:linear-gradient(135deg,#2BB6B7,#12797A);padding:26px 28px;">
              <div style="color:rgba(255,255,255,.82);font-size:11px;letter-spacing:.14em;text-transform:uppercase;margin-bottom:7px;">Anfrage aus dem Putzfrauenservice</div>
              <div style="color:#FFFFFF;font-size:20px;font-weight:bold;line-height:1.3;">Fensterreinigungsofferte gewünscht</div>
            </div>
            <div style="padding:22px 28px 6px;color:#485655;font-size:14px;line-height:1.7;">
              <p style="margin:0;">Bei der Auftragserteilung für die Privathaushaltreinigung hat die Kundschaft eine <strong>unverbindliche Offerte für die Fensterreinigung</strong> gewünscht. Bitte um Kontaktaufnahme.</p>
            </div>
            <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;margin-top:16px;">
              ${tabF}
            </table>
            ${b.vereinbarungen ? `
            <div style="padding:16px 28px;background:#FFF8EC;border-top:1px solid #F2E3C9;">
              <div style="font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:#96601A;margin-bottom:6px;">Hinweise der Kundschaft</div>
              <div style="font-size:13.5px;color:#0E1E1D;line-height:1.6;">${b.vereinbarungen}</div>
            </div>` : ''}
            <div style="padding:16px 28px 22px;background:#F7FBFB;text-align:center;">
              <div style="font-size:11px;color:#9AA8A7;line-height:1.6;">
                Automatische Meldung aus dem Angebotssystem · Clean Service Scaramuzzo AG
              </div>
            </div>
          </div>
        </div>`;

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
