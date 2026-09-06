// api/order-received.js
// Wird vom Auftragsformular aufgerufen, sobald ein Kunde absendet.
//
//   1. Setzt das Angebot in Firestore auf Status "auftrag"
//      → damit stoppen die automatischen Erinnerungen sofort
//   2. Benachrichtigt euch per E-Mail über den Eingang

import { lesen, speichern, alleLesen } from './_firestore.js';

const SAMMLUNG = 'angebote';
const EMPFAENGER = 'putzfrauenservice@clean-service.ch';

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

      const tabelle = zeilen.map(([k, v]) => `
        <tr>
          <td style="padding:7px 0;color:#7C8C8B;font-size:13px;width:130px;vertical-align:top;">${k}</td>
          <td style="padding:7px 0;color:#0E1E1D;font-size:13px;"><strong>${v}</strong></td>
        </tr>`).join('');

      const html = `
      <div style="font-family:Verdana,Arial,sans-serif;color:#0E1E1D;max-width:560px;margin:0 auto;line-height:1.6;">
        <p style="font-size:15px;"><strong>Neue Auftragserteilung eingegangen</strong></p>
        <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-top:1px solid #E1EAE9;border-bottom:1px solid #E1EAE9;margin:14px 0;">
          ${tabelle}
        </table>
        ${b.vereinbarungen ? `<p style="font-size:13px;"><span style="color:#7C8C8B;">Spezielle Vereinbarungen:</span><br>${b.vereinbarungen}</p>` : ''}
        <p style="margin-top:22px;">
          <a href="https://${req.headers.host || 'clean-service.ch'}/admin.html"
             style="background:#2BB6B7;color:#ffffff;padding:12px 24px;border-radius:100px;text-decoration:none;font-weight:600;display:inline-block;font-size:14px;">Im Admin-Bereich ansehen</a>
        </p>
        <hr style="border:none;border-top:1px solid #E1EAE9;margin:24px 0 12px;">
        <p style="font-size:11.5px;color:#7C8C8B;">
          Automatische Meldung aus dem Angebotssystem · Clean Service Scaramuzzo AG
        </p>
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
    }

    return res.status(200).json({ ok: true, ...ergebnis });
  } catch (err) {
    // Der Kunde soll nie eine Fehlerseite sehen, nur weil die Meldung scheitert
    return res.status(200).json({ ok: false, fehler: err.message, ...ergebnis });
  }
}
