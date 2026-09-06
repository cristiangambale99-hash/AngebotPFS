// api/orders.js
// Liefert dem Admin-Bereich alle eingegangenen Auftragserteilungen.
//
//   GET  /api/orders                  → alle Aufträge, neueste zuerst
//   POST /api/orders?aktion=update    → einzelne Felder ändern
//   POST /api/orders?aktion=delete    → Auftrag löschen

import { alleLesen, lesen, speichern, loeschen } from './_firestore.js';

const SAMMLUNG = 'auftraege';

export default async function handler(req, res) {
  try {
    if (req.method === 'GET') {
      const alle = await alleLesen(SAMMLUNG, 500);
      alle.sort((a, b) => (b.eingegangenAm || '').localeCompare(a.eingegangenAm || ''));

      const jetzt = new Date();
      const dieserMonat = alle.filter(a => {
        if (!a.eingegangenAm) return false;
        const d = new Date(a.eingegangenAm);
        return d.getMonth() === jetzt.getMonth() && d.getFullYear() === jetzt.getFullYear();
      }).length;

      return res.status(200).json({
        kennzahlen: {
          total: alle.length,
          dieserMonat,
          offen: alle.filter(a => !a.bearbeitet).length,
          ohneNummer: alle.filter(a => !a.angebotsnr).length
        },
        auftraege: alle
      });
    }

    if (req.method === 'POST') {
      const aktion = (req.query && req.query.aktion) || '';
      const b = req.body || {};
      if (!b.id) return res.status(400).json({ error: 'Kennung fehlt.' });

      if (aktion === 'delete') {
        await loeschen(SAMMLUNG, b.id);
        return res.status(200).json({ ok: true });
      }

      const vorhanden = await lesen(SAMMLUNG, b.id);
      if (!vorhanden) return res.status(404).json({ error: 'Auftrag nicht gefunden.' });

      const neu = { ...vorhanden };
      delete neu._id;
      ['angebotsnr', 'notiz', 'vereinbarungen'].forEach(f => {
        if (typeof b[f] === 'string') neu[f] = b[f];
      });
      if (typeof b.bearbeitet === 'boolean') neu.bearbeitet = b.bearbeitet;

      const gespeichert = await speichern(SAMMLUNG, b.id, neu);
      return res.status(200).json({ ok: true, auftrag: gespeichert });
    }

    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Unbekannter Fehler' });
  }
}
