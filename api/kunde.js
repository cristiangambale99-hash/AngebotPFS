// api/kunde.js
// Eine Serverfunktion für alle signierten Kundenlinks.
//
// Hintergrund: Der Hobby-Plan von Vercel erlaubt höchstens 12 Funktionen
// pro Deployment. Deshalb liegen die fünf Kundenfunktionen als Module in
// lib/ und werden hier verteilt. Die bisherigen Adressen bleiben gültig:
// vercel.json leitet /api/antwort, /api/qualitaet, /api/einfuehrung,
// /api/vertrag-signiert und /api/termine hierher um (Parameter fn).
// Links in bereits verschickten Mails funktionieren daher unverändert.

import antwort from '../lib/antwort.js';
import qualitaet from '../lib/qualitaet.js';
import einfuehrung from '../lib/einfuehrung.js';
import vertragSigniert from '../lib/vertrag-signiert.js';
import termine from '../lib/termine.js';

const FUNKTIONEN = {
  'antwort': antwort,
  'qualitaet': qualitaet,
  'einfuehrung': einfuehrung,
  'vertrag-signiert': vertragSigniert,
  'termine': termine
};

export default async function handler(req, res) {
  const q = req.query || {};
  let fn = String(q.fn || '');
  // Rückfall, falls der Parameter fehlt: Pfad der ursprünglichen Anfrage
  if (!fn) {
    const m = String(req.url || '').match(/\/api\/([a-z-]+)/);
    if (m && FUNKTIONEN[m[1]]) fn = m[1];
  }
  const ziel = FUNKTIONEN[fn];
  if (!ziel) return res.status(404).json({ error: 'Unbekannte Funktion' });
  delete q.fn;   // die Zielfunktion soll nur ihre eigenen Parameter sehen
  return ziel(req, res);
}
