// api/offers.js
// Verwaltet die gesendeten Angebote in Firestore.
//
//   GET  /api/offers            → alle Angebote mit Kennzahlen
//   POST /api/offers            → neues Angebot anlegen (beim Versand)
//   POST /api/offers?aktion=status → Status ändern (z. B. Auftrag erhalten)

import { speichern, lesen, alleLesen } from './_firestore.js';

const SAMMLUNG = 'angebote';

export default async function handler(req, res) {
  try {
    if (req.method === 'GET') return await liste(req, res);
    if (req.method === 'POST') {
      const aktion = (req.query && req.query.aktion) || '';
      if (aktion === 'status') return await statusAendern(req, res);
      return await anlegen(req, res);
    }
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Unbekannter Fehler' });
  }
}

/* ---- Neues Angebot beim Versand anlegen ---- */
async function anlegen(req, res) {
  const b = req.body || {};
  if (!b.code) return res.status(400).json({ error: 'Zugangscode fehlt.' });

  const jetzt = new Date().toISOString();
  const eintrag = {
    code: b.code,
    angebotsnr: b.angebotsnr || '',
    anrede: b.anrede || '',
    vorname: b.vorname || '',
    nachname: b.nachname || '',
    adresse: b.adresse || '',
    ort: b.ort || '',
    email: b.email || '',
    zimmer: b.zimmer || '',
    frequenz: b.frequenz || '',
    link: b.link || '',
    status: 'gesendet',        // gesendet · auftrag · abgesagt
    gesendetAm: jetzt,
    erinnerung1: '',           // Zeitpunkt der ersten Erinnerung (5 Tage)
    erinnerung2: '',           // Zeitpunkt der zweiten Erinnerung (10 Tage)
    erinnerungAus: false,      // manuell abschaltbar
    auftragAm: '',
    notiz: ''
  };

  const gespeichert = await speichern(SAMMLUNG, b.code, eintrag);
  return res.status(200).json({ ok: true, angebot: gespeichert });
}

/* ---- Status ändern ---- */
async function statusAendern(req, res) {
  const { code, status, erinnerungAus, notiz } = req.body || {};
  if (!code) return res.status(400).json({ error: 'Zugangscode fehlt.' });

  const vorhanden = await lesen(SAMMLUNG, code);
  if (!vorhanden) return res.status(404).json({ error: 'Angebot nicht gefunden.' });

  const neu = { ...vorhanden };
  delete neu._id;
  if (status) {
    neu.status = status;
    if (status === 'auftrag' && !neu.auftragAm) neu.auftragAm = new Date().toISOString();
  }
  if (typeof erinnerungAus === 'boolean') neu.erinnerungAus = erinnerungAus;
  if (typeof notiz === 'string') neu.notiz = notiz;

  const gespeichert = await speichern(SAMMLUNG, code, neu);
  return res.status(200).json({ ok: true, angebot: gespeichert });
}

/* ---- Liste mit Kennzahlen ---- */
async function liste(req, res) {
  const alle = await alleLesen(SAMMLUNG, 500);
  alle.sort((a, b) => (b.gesendetAm || '').localeCompare(a.gesendetAm || ''));

  const gesendet = alle.length;
  const auftraege = alle.filter(a => a.status === 'auftrag').length;
  const abgesagt = alle.filter(a => a.status === 'abgesagt').length;
  const offen = alle.filter(a => a.status === 'gesendet').length;
  const quote = gesendet ? Math.round((auftraege / gesendet) * 100) : 0;

  const jetzt = Date.now();
  const dieserMonat = alle.filter(a => {
    if (!a.gesendetAm) return false;
    const d = new Date(a.gesendetAm);
    const n = new Date();
    return d.getMonth() === n.getMonth() && d.getFullYear() === n.getFullYear();
  }).length;

  // Tage seit Versand ergänzen, damit der Admin es direkt anzeigen kann
  alle.forEach(a => {
    a.tage = a.gesendetAm
      ? Math.floor((jetzt - new Date(a.gesendetAm).getTime()) / 86400000)
      : null;
  });

  return res.status(200).json({
    kennzahlen: { gesendet, auftraege, offen, abgesagt, quote, dieserMonat },
    angebote: alle
  });
}
