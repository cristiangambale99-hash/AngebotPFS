// api/followup.js
// Läuft einmal täglich automatisch (siehe vercel.json) und sendet
// Erinnerungen an Kundinnen und Kunden, von denen noch keine
// Auftragserteilung zurückgekommen ist.
//
//   Nach  5 Tagen → erste, freundliche Erinnerung
//   Nach 10 Tagen → zweite und letzte Erinnerung
//
// Nicht angeschrieben werden:
//   · Angebote mit Status "auftrag" oder "abgesagt"
//   · Angebote, bei denen die Erinnerung manuell abgeschaltet wurde
//   · Angebote ohne hinterlegte E-Mail-Adresse
//
// Der Aufruf ist durch CRON_SECRET geschützt, damit ihn niemand von aussen
// auslösen kann.

import { alleLesen, speichern } from './_firestore.js';

const SAMMLUNG = 'angebote';

export default async function handler(req, res) {
  // Zugriffsschutz: Vercel sendet den Cron-Schlüssel im Authorization-Header
  const geheim = process.env.CRON_SECRET;
  if (geheim) {
    const kopf = req.headers.authorization || '';
    if (kopf !== `Bearer ${geheim}`) {
      return res.status(401).json({ error: 'Nicht berechtigt' });
    }
  }

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'RESEND_API_KEY fehlt.' });

  try {
    const alle = await alleLesen(SAMMLUNG, 500);
    const jetzt = Date.now();
    const bericht = { geprueft: alle.length, erste: 0, zweite: 0, uebersprungen: 0, fehler: [] };

    for (const a of alle) {
      if (a.status !== 'gesendet' || a.erinnerungAus || !a.email || !a.gesendetAm) {
        bericht.uebersprungen++;
        continue;
      }
      const tage = Math.floor((jetzt - new Date(a.gesendetAm).getTime()) / 86400000);

      let stufe = 0;
      if (tage >= 10 && !a.erinnerung2) stufe = 2;
      else if (tage >= 5 && !a.erinnerung1) stufe = 1;
      if (!stufe) { bericht.uebersprungen++; continue; }

      try {
        await sendeErinnerung(apiKey, a, stufe);
        const neu = { ...a };
        delete neu._id; delete neu.tage;
        if (stufe === 1) neu.erinnerung1 = new Date().toISOString();
        else neu.erinnerung2 = new Date().toISOString();
        await speichern(SAMMLUNG, a.code, neu);
        stufe === 1 ? bericht.erste++ : bericht.zweite++;
      } catch (e) {
        bericht.fehler.push({ code: a.code, meldung: e.message });
      }
    }

    return res.status(200).json({ ok: true, ...bericht });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

async function sendeErinnerung(apiKey, a, stufe) {
  const anrede = a.anrede === 'Herr' ? `Sehr geehrter Herr ${a.nachname}`
               : a.anrede === 'Frau' ? `Sehr geehrte Frau ${a.nachname}`
               : `Guten Tag ${a.vorname} ${a.nachname}`;

  const betreff = stufe === 1
    ? 'Ihr Reinigungsangebot — dürfen wir kurz nachfragen?'
    : 'Ihr Reinigungsangebot — letzte Erinnerung';

  const text = stufe === 1
    ? 'vor einigen Tagen haben wir Ihnen Ihr persönliches Reinigungsangebot zugestellt. Wir wollten kurz nachfragen, ob Sie noch Fragen haben oder etwas unklar geblieben ist.'
    : 'Ihr persönliches Reinigungsangebot ist noch für kurze Zeit gültig. Falls sich Ihre Pläne geändert haben, ist das selbstverständlich in Ordnung — eine kurze Rückmeldung genügt.';

  const schluss = stufe === 1
    ? 'Gerne bespreche ich Ihre Wünsche auch persönlich am Telefon.'
    : 'Wenn Sie zu einem späteren Zeitpunkt Interesse haben, melden Sie sich jederzeit gerne.';

  const html = `
  <div style="font-family:Verdana,Arial,sans-serif;color:#0E1E1D;max-width:560px;margin:0 auto;line-height:1.6;">
    <p>${anrede},</p>
    <p>${text}</p>
    ${a.link ? `
    <p style="text-align:center;margin:26px 0 20px;">
      <a href="${a.link}" style="background:#2BB6B7;color:#ffffff;padding:14px 28px;border-radius:100px;text-decoration:none;font-weight:600;display:inline-block;">Angebot erneut ansehen</a>
    </p>` : ''}
    ${a.code ? `
    <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;margin:0 0 22px;">
      <tr><td style="background:#EAF6F6;border:1px solid #CFE6EA;border-radius:12px;padding:16px 18px;text-align:center;">
        <div style="font-size:11.5px;color:#7C8C8B;text-transform:uppercase;letter-spacing:.12em;margin-bottom:7px;">Ihr Zugangscode</div>
        <div style="font-family:'Courier New',monospace;font-size:24px;font-weight:bold;color:#12797A;letter-spacing:.2em;">${a.code}</div>
      </td></tr>
    </table>` : ''}
    <p>${schluss}</p>
    <p>Freundliche Grüsse<br>
       <strong>Cristian Gambale</strong><br>
       <span style="color:#7C8C8B;font-size:13px;">Bereichsleiter Putzfrauenservice</span></p>
    <hr style="border:none;border-top:1px solid #E1EAE9;margin:26px 0 14px;">
    <p style="font-size:11.5px;color:#7C8C8B;">
      Clean Service Scaramuzzo AG · Industriestrasse 5 · 8307 Effretikon<br>
      T 0844 355 355 · putzfrauenservice@clean-service.ch · clean-service.ch
    </p>
  </div>`;

  const klartext = `${anrede},\n\n${text}\n\n` +
    (a.link ? `${a.link}\n\n` : '') +
    (a.code ? `Ihr Zugangscode: ${a.code}\n\n` : '') +
    `${schluss}\n\nFreundliche Grüsse\nCristian Gambale\nBereichsleiter Putzfrauenservice\n\n` +
    'Clean Service Scaramuzzo AG · T 0844 355 355 · clean-service.ch';

  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: 'Clean Service Scaramuzzo AG <putzfrauenservice@clean-service.ch>',
      to: [a.email],
      reply_to: 'putzfrauenservice@clean-service.ch',
      subject: betreff,
      html,
      text: klartext
    })
  });
  const daten = await r.json();
  if (!r.ok) throw new Error(JSON.stringify(daten));
  return daten;
}
