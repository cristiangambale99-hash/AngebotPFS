// api/send-offer.js
// Vercel Serverless Function – versendet das persönliche Reinigungskonzept per E-Mail
// über Resend (https://resend.com), abgesendet von putzfrauenservice@clean-service.ch.
//
// Einrichtung:
// 1. Diese Datei unverändert in den Ordner "api/" im selben Vercel-Projekt legen,
//    in dem auch admin.html liegt (z. B. AngebotPFS-Repo, Ordner "api/send-offer.js").
// 2. In den Vercel-Projekteinstellungen unter "Environment Variables" hinzufügen:
//      RESEND_API_KEY = <euer Resend API-Key>
// 3. In Resend unter "Domains" die Domain clean-service.ch hinzufügen und die dort
//    angezeigten DNS-Einträge (TXT/CNAME für DKIM, ggf. MX) beim Domain-Provider
//    eintragen lassen. Erst nach erfolgreicher Verifizierung kann von
//    putzfrauenservice@clean-service.ch aus gesendet werden.
// 4. Neu deployen (Vercel deployed "api/*"-Dateien automatisch als Endpunkte).
//
// Danach ruft admin.html diesen Endpunkt unter /api/send-offer per POST auf.

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'RESEND_API_KEY ist nicht gesetzt (Vercel-Umgebungsvariable fehlt).' });
  }

  const { to, anrede, vorname, nachname, angebotsnr, link, code } = req.body || {};

  if (!to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
    return res.status(400).json({ error: 'Ungültige oder fehlende Empfänger-Adresse.' });
  }
  if (!link) {
    return res.status(400).json({ error: 'Kein Link übergeben.' });
  }

  const anredeText =
    anrede === 'Herr' ? ('Sehr geehrter Herr ' + (nachname || ''))
    : anrede === 'Frau' ? ('Sehr geehrte Frau ' + (nachname || ''))
    : ('Guten Tag ' + [vorname, nachname].filter(Boolean).join(' '));

  const subject = `Ihr persönliches Reinigungsangebot${angebotsnr ? ' Nr. ' + angebotsnr : ''}`;

  const inhalt = `
    <p style="margin:0 0 16px;">${anredeText}</p>
    <p style="margin:0 0 16px;">Besten Dank für Ihr Interesse an unserem Putzfrauenservice. Gerne unterbreiten wir Ihnen nachfolgend unser Angebot für die regelmässige Reinigung Ihres Haushalts.</p>
    <p style="margin:0 0 20px;">Wir haben das Konzept auf Ihre Situation abgestimmt. Sie finden darin die enthaltenen Leistungen, Ihre Konditionen, das für Sie zuständige Team sowie den Ablauf bis zum ersten Einsatz.</p>

    <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width:100%;margin:0 0 22px;border-collapse:collapse;">
      <tr>
        <td style="border:1px solid #D5E2E1;border-left:4px solid ${CS_FARBE};padding:20px 24px;background:#FBFDFD;">
          <div style="font-family:Verdana,Geneva,sans-serif;font-size:11px;color:${CS_GRAU};letter-spacing:.1em;margin-bottom:12px;">IHR PERSÖNLICHES ANGEBOT</div>
          ${angebotsnr ? `
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:14px;">
            <tr>
              <td style="font-family:Verdana,Geneva,sans-serif;font-size:12px;color:${CS_GRAU};padding-right:16px;">Angebot Nr.</td>
              <td style="font-family:Verdana,Geneva,sans-serif;font-size:13px;color:${CS_TEXT};font-weight:bold;">${angebotsnr}</td>
            </tr>
            ${code ? `<tr>
              <td style="font-family:Verdana,Geneva,sans-serif;font-size:12px;color:${CS_GRAU};padding-right:16px;padding-top:6px;">Zugangscode</td>
              <td style="font-family:Verdana,Geneva,sans-serif;font-size:15px;color:${CS_DUNKEL};font-weight:bold;letter-spacing:.12em;padding-top:6px;">${code}</td>
            </tr>` : ''}
          </table>` : ''}
          <table role="presentation" cellpadding="0" cellspacing="0" border="0">
            <tr><td style="background:${CS_FARBE};">
              <a href="${link}" style="display:inline-block;padding:13px 32px;font-family:Verdana,Geneva,sans-serif;font-size:13px;font-weight:bold;color:#FFFFFF;text-decoration:none;">Angebot ansehen</a>
            </td></tr>
          </table>
          <div style="font-family:Verdana,Geneva,sans-serif;font-size:11px;color:${CS_GRAU};margin-top:12px;line-height:1.5;">
            Das Angebot ist ausschliesslich für Sie bestimmt und rund fünf Minuten Lesezeit.
          </div>
        </td>
      </tr>
    </table>

    <p style="margin:0;">Für Rückfragen oder besondere Anliegen stehe ich Ihnen gerne persönlich zur Verfügung.</p>`;

  const html = csRahmen('Angebot für Ihre Haushaltreinigung', inhalt,
    'Diese Nachricht wurde automatisch erstellt. Sie können direkt darauf antworten.');

  const text =
    anredeText + '\n\n' +
    'Vielen Dank für Ihr Interesse an unserem Putzfrauenservice. Wir haben Ihr Angebot persönlich auf Ihre Wohnung zugeschnitten.\n\n' +
    'Sie finden darin:\n' +
    '- Die enthaltenen Leistungen im Detail\n' +
    '- Ihren Preis pro Einsatz und pro Monat\n' +
    '- Ihr Betreuungsteam und unser Springerteam\n' +
    '- Den Umgang mit Ihrem Schlüssel und Ihren Angaben\n\n' +
    'Angebot ansehen:\n' + link + '\n\n' +
    (code ? ('Ihr Zugangscode: ' + code + '\n\n') : '') +
    (angebotsnr ? ('Angebot Nr. ' + angebotsnr + '\n\n') : '') +
    'Für Rückfragen stehe ich Ihnen gerne persönlich zur Verfügung.' +
    csSignaturText();

  try {
    const resendRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: 'Cristian Gambale · Clean Service Scaramuzzo AG <putzfrauenservice@clean-service.ch>',
        reply_to: 'putzfrauenservice@clean-service.ch',
        to: [to],
        subject,
        html,
        text
      })
    });

    const data = await resendRes.json();

    if (!resendRes.ok) {
      return res.status(resendRes.status).json({ error: data });
    }

    return res.status(200).json({ success: true, id: data.id });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Unbekannter Fehler beim Versand.' });
  }
}

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
