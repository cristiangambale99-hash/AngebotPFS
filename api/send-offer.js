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

  /* Sprachvariante: 'de' oder 'en'. Ohne Angabe bleibt es Deutsch. */
  const spr = (req.body && req.body.sprache === 'en') ? 'en' : 'de';
  const EN = spr === 'en';

  const anredeText = EN
    ? (anrede === 'Herr' ? ('Dear Mr ' + (nachname || ''))
      : anrede === 'Frau' ? ('Dear Mrs ' + (nachname || ''))
      : ('Dear ' + [vorname, nachname].filter(Boolean).join(' ')))
    : (anrede === 'Herr' ? ('Sehr geehrter Herr ' + (nachname || ''))
      : anrede === 'Frau' ? ('Sehr geehrte Frau ' + (nachname || ''))
      : ('Guten Tag ' + [vorname, nachname].filter(Boolean).join(' ')));

  const T = EN ? {
    betreff:    `Your personal cleaning proposal${angebotsnr ? ' no. ' + angebotsnr : ''}`,
    kopf:       'Proposal for your household cleaning',
    absatz1:    'Thank you for your interest in our domestic cleaning service. We are pleased to present our proposal for the regular cleaning of your home.',
    absatz2:    'We have tailored the proposal to your situation. It sets out the services included, your rates, the team looking after you and the steps leading up to the first visit.',
    kasten:     'YOUR PERSONAL PROPOSAL',
    nummer:     'Proposal no.',
    zugang:     'Access code',
    knopf:      'View proposal',
    hinweis:    'The proposal is intended for you alone and takes about five minutes to read.',
    schluss:    'Should you have any questions or particular requests, I am personally at your disposal.'
  } : {
    betreff:    `Ihr persönliches Reinigungsangebot${angebotsnr ? ' Nr. ' + angebotsnr : ''}`,
    kopf:       'Angebot für Ihre Haushaltreinigung',
    absatz1:    '${T.absatz1}',
    absatz2:    '${T.absatz2}',
    kasten:     'IHR PERSÖNLICHES ANGEBOT',
    nummer:     'Angebot Nr.',
    zugang:     'Zugangscode',
    knopf:      'Angebot ansehen',
    hinweis:    '${T.hinweis}',
    schluss:    '${T.schluss}'
  };

  const subject = T.betreff;

  const inhalt = `
    <p style="margin:0 0 16px;">${anredeText}</p>
    <p style="margin:0 0 16px;">Besten Dank für Ihr Interesse an unserem Putzfrauenservice. Gerne unterbreiten wir Ihnen nachfolgend unser Angebot für die regelmässige Reinigung Ihres Haushalts.</p>
    <p style="margin:0 0 20px;">Wir haben das Konzept auf Ihre Situation abgestimmt. Sie finden darin die enthaltenen Leistungen, Ihre Konditionen, das für Sie zuständige Team sowie den Ablauf bis zum ersten Einsatz.</p>

    <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width:100%;margin:0 0 22px;border-collapse:collapse;">
      <tr>
        <td style="border:1px solid #D5E2E1;border-left:4px solid ${CS_FARBE};padding:20px 24px;background:#FBFDFD;">
          <div style="font-family:Verdana,Geneva,sans-serif;font-size:11px;color:${CS_GRAU};letter-spacing:.1em;margin-bottom:12px;">${T.kasten}</div>
          ${angebotsnr ? `
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:14px;">
            <tr>
              <td style="font-family:Verdana,Geneva,sans-serif;font-size:12px;color:${CS_GRAU};padding-right:16px;">${T.nummer}</td>
              <td style="font-family:Verdana,Geneva,sans-serif;font-size:13px;color:${CS_TEXT};font-weight:bold;">${angebotsnr}</td>
            </tr>
            ${code ? `<tr>
              <td style="font-family:Verdana,Geneva,sans-serif;font-size:12px;color:${CS_GRAU};padding-right:16px;padding-top:6px;">${T.zugang}</td>
              <td style="font-family:Verdana,Geneva,sans-serif;font-size:15px;color:${CS_DUNKEL};font-weight:bold;letter-spacing:.12em;padding-top:6px;">${code}</td>
            </tr>` : ''}
          </table>` : ''}
          <table role="presentation" cellpadding="0" cellspacing="0" border="0">
            <tr><td style="background:${CS_FARBE};">
              <a href="${link}" style="display:inline-block;padding:13px 32px;font-family:Verdana,Geneva,sans-serif;font-size:13px;font-weight:bold;color:#FFFFFF;text-decoration:none;">${T.knopf}</a>
            </td></tr>
          </table>
          <div style="font-family:Verdana,Geneva,sans-serif;font-size:11px;color:${CS_GRAU};margin-top:12px;line-height:1.5;">
            Das Angebot ist ausschliesslich für Sie bestimmt und rund fünf Minuten Lesezeit.
          </div>
        </td>
      </tr>
    </table>

    <p style="margin:0;">Für Rückfragen oder besondere Anliegen stehe ich Ihnen gerne persönlich zur Verfügung.</p>`;

  const html = csRahmen(T.kopf, inhalt);

  const text = EN
    ? (anredeText + '\n\n' +
       'Thank you for your interest in our domestic cleaning service. We have tailored this proposal to your home.\n\n' +
       'It contains:\n' +
       '- The services included, in detail\n' +
       '- Your price per visit and per month\n' +
       '- Your dedicated team and our relief team\n' +
       '- How we handle your keys and your data\n\n' +
       'View the proposal:\n' + link + '\n\n' +
       (code ? ('Your access code: ' + code + '\n\n') : '') +
       (angebotsnr ? ('Proposal no. ' + angebotsnr + '\n\n') : '') +
       'Should you have any questions, I am personally at your disposal.' +
       csSignaturText())
    : (anredeText + '\n\n' +
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
       csSignaturText());

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
        text,
        attachments: [{ filename:'logo.png', content: CS_LOGO, content_id:'cslogo', disposition:'inline' }]
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
const CS_LOGO = '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';
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
          <td style="background:#FFFFFF;padding:26px 36px 20px;vertical-align:middle;">
            <img src="cid:cslogo" width="185" alt="Clean Service Scaramuzzo AG" style="display:block;border:0;width:185px;height:auto;">
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
