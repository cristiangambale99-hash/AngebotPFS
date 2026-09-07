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

  const subject = `Ihr persönliches Reinigungsangebot${angebotsnr ? ' — Nr. ' + angebotsnr : ''} · Clean Service Scaramuzzo AG`;

  const html = `
  <div style="background:#F4F8F8;padding:28px 16px;">
    <div style="max-width:600px;margin:0 auto;background:#FFFFFF;border-radius:14px;overflow:hidden;box-shadow:0 2px 12px rgba(14,30,29,.07);font-family:Verdana,Arial,sans-serif;">

      <div style="background:linear-gradient(135deg,#2BB6B7,#12797A);padding:28px;">
        <div style="color:rgba(255,255,255,.82);font-size:11px;letter-spacing:.14em;text-transform:uppercase;margin-bottom:8px;">Clean Service Scaramuzzo AG · seit 1984</div>
        <div style="color:#FFFFFF;font-size:21px;font-weight:bold;line-height:1.3;">Ihr persönliches Reinigungsangebot</div>
        ${angebotsnr ? `<div style="color:rgba(255,255,255,.9);font-size:13.5px;margin-top:6px;">Angebot Nr. ${angebotsnr}</div>` : ''}
      </div>

      <div style="padding:28px;color:#485655;font-size:14px;line-height:1.7;">
        <p style="margin:0 0 16px;">${anredeText}</p>
        <p style="margin:0 0 16px;">Vielen Dank für Ihr Interesse an unserem Putzfrauenservice. Wir haben Ihr Angebot persönlich auf Ihre Wohnung zugeschnitten — mit allen Leistungen, Ihren Konditionen und dem konkreten Ablauf.</p>
        <p style="margin:0 0 4px;">Sie finden darin unter anderem:</p>
        <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;margin:0 0 20px;">
          <tr><td style="padding:5px 0;font-size:13.5px;color:#485655;">&nbsp;·&nbsp; Welche Leistungen in Ihrer Reinigung enthalten sind</td></tr>
          <tr><td style="padding:5px 0;font-size:13.5px;color:#485655;">&nbsp;·&nbsp; Ihren konkreten Preis pro Einsatz und pro Monat</td></tr>
          <tr><td style="padding:5px 0;font-size:13.5px;color:#485655;">&nbsp;·&nbsp; Das Team, das Sie betreut, und unser Springerteam bei Ausfällen</td></tr>
          <tr><td style="padding:5px 0;font-size:13.5px;color:#485655;">&nbsp;·&nbsp; Wie wir mit Ihrem Schlüssel und Ihren Angaben umgehen</td></tr>
        </table>

        <p style="text-align:center;margin:24px 0 20px;">
          <a href="${link}" style="background:#2BB6B7;color:#ffffff;padding:15px 32px;border-radius:100px;text-decoration:none;font-weight:bold;display:inline-block;font-size:15px;">Angebot jetzt ansehen</a>
        </p>

        ${code ? `
        <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;margin:0 0 20px;">
          <tr><td style="background:#EAF6F6;border:1px solid #CFE6EA;border-radius:12px;padding:18px 20px;text-align:center;">
            <div style="font-size:11px;color:#7C8C8B;text-transform:uppercase;letter-spacing:.12em;margin-bottom:8px;">Ihr persönlicher Zugangscode</div>
            <div style="font-family:'Courier New',monospace;font-size:26px;font-weight:bold;color:#12797A;letter-spacing:.22em;">${code}</div>
            <div style="font-size:11.5px;color:#7C8C8B;margin-top:8px;">Bitte geben Sie diesen Code beim Öffnen ein. Das Angebot ist ausschliesslich für Sie bestimmt.</div>
          </td></tr>
        </table>` : ''}

        <p style="margin:0;">Das Durchlesen dauert rund fünf Minuten. Wenn Sie Fragen haben oder etwas anders wünschen, rufen Sie mich einfach an — ich bin gerne persönlich für Sie da.</p>
      </div>

      <div style="padding:0 28px 24px;">
        <div style="border-top:1px solid #EDF3F2;padding-top:20px;">
          <div style="font-size:14.5px;color:#0E1E1D;font-weight:bold;">Cristian Gambale</div>
          <div style="font-size:12.5px;color:#7C8C8B;margin-top:2px;">Bereichsleiter Putzfrauenservice</div>
          <div style="font-size:12.5px;color:#12797A;margin-top:9px;line-height:1.7;">
            T 0844 355 355<br>
            putzfrauenservice@clean-service.ch
          </div>
        </div>
      </div>

      <div style="padding:16px 28px 22px;background:#F7FBFB;text-align:center;">
        <div style="font-size:11px;color:#9AA8A7;line-height:1.6;">
          Clean Service Scaramuzzo AG · Industriestrasse 5 · 8307 Effretikon<br>
          T 0844 355 355 · clean-service.ch · ISO 9001 · ISO 14001 · ISO 45001
        </div>
      </div>

    </div>
  </div>`;

  const text =
    anredeText + '\n\n' +
    'Vielen Dank für Ihr Interesse an unserem Putzfrauenservice. Wir haben Ihr Angebot persönlich auf Ihre Wohnung zugeschnitten — mit allen Leistungen, Ihren Konditionen und dem konkreten Ablauf.\n\n' +
    'Sie finden darin unter anderem:\n' +
    '· Welche Leistungen in Ihrer Reinigung enthalten sind\n' +
    '· Ihren konkreten Preis pro Einsatz und pro Monat\n' +
    '· Das Team, das Sie betreut, und unser Springerteam bei Ausfällen\n' +
    '· Wie wir mit Ihrem Schlüssel und Ihren Angaben umgehen\n\n' +
    'Angebot ansehen:\n' + link + '\n\n' +
    (code ? ('Ihr persönlicher Zugangscode: ' + code + '\n' +
             'Bitte geben Sie diesen Code beim Öffnen ein. Das Angebot ist ausschliesslich für Sie bestimmt.\n\n') : '') +
    (angebotsnr ? ('Angebot Nr. ' + angebotsnr + '\n\n') : '') +
    'Das Durchlesen dauert rund fünf Minuten. Wenn Sie Fragen haben oder etwas anders wünschen, rufen Sie mich einfach an.\n\n' +
    'Freundliche Grüsse\n' +
    'Cristian Gambale\n' +
    'Bereichsleiter Putzfrauenservice\n' +
    'T 0844 355 355 · putzfrauenservice@clean-service.ch\n\n' +
    'Clean Service Scaramuzzo AG · Industriestrasse 5 · 8307 Effretikon · clean-service.ch';

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
