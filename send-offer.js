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

  const { to, anrede, vorname, nachname, angebotsnr, link } = req.body || {};

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

  const subject = 'Ihr persönliches Reinigungskonzept – Clean Service Scaramuzzo AG';

  const html = `
  <div style="font-family:Verdana,Arial,sans-serif;color:#1F2A2B;max-width:560px;margin:0 auto;line-height:1.5;">
    <p>${anredeText}</p>
    <p>Vielen Dank für Ihr Interesse an unserem Putzfrauenservice. Ihr persönliches Reinigungskonzept mit allen Details zu Leistungen, Preisen und Ablauf steht ab sofort für Sie bereit.</p>
    <p style="text-align:center;margin:28px 0;">
      <a href="${link}" style="background:#2BB6B7;color:#ffffff;padding:14px 28px;border-radius:100px;text-decoration:none;font-weight:600;display:inline-block;">Zu Ihrem Reinigungskonzept</a>
    </p>
    ${angebotsnr ? `<p style="color:#4A5654;font-size:13px;">Angebot Nr. ${angebotsnr}</p>` : ''}
    <p>Bei Fragen sind wir jederzeit gerne persönlich für Sie da.</p>
    <p>Freundliche Grüsse<br>Ihr Team der Clean Service Scaramuzzo AG</p>
    <hr style="border:none;border-top:1px solid #eee;margin:28px 0 16px;">
    <p style="font-size:12px;color:#878787;">Clean Service Scaramuzzo AG · Industriestrasse 5 · 8307 Effretikon · T 0844 355 355 · clean-service.ch</p>
  </div>`;

  const text =
    anredeText + '\n\n' +
    'Vielen Dank für Ihr Interesse an unserem Putzfrauenservice. Ihr persönliches Reinigungskonzept steht ab sofort für Sie bereit:\n\n' +
    link + '\n\n' +
    (angebotsnr ? ('Angebot Nr. ' + angebotsnr + '\n\n') : '') +
    'Freundliche Grüsse\nIhr Team der Clean Service Scaramuzzo AG\n\n' +
    'Clean Service Scaramuzzo AG · Industriestrasse 5 · 8307 Effretikon · T 0844 355 355 · clean-service.ch';

  try {
    const resendRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: 'Clean Service Scaramuzzo AG <putzfrauenservice@clean-service.ch>',
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
