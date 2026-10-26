import crypto from 'crypto';
// lib/vakanzen.js  —  erreichbar unter /api/vakanzen (Verteiler api/kunde.js)
//
// Vakanzen des Putzfrauenservice: die eigenen Objekte aus diesem Verkaufstool,
// die im Stellenportal ausgeschrieben sind, samt der Bewerbungen der
// Mitarbeiterinnen.
//
//   GET  /api/vakanzen                           → Objekte und Bewerbungen
//   POST /api/vakanzen {aktion:'bestaetigen'}    → Mitarbeiterin erhaelt das Objekt
//   POST /api/vakanzen {aktion:'absagen'}        → Absage an eine Bewerberin
//
// Gelesen wird aus zwei Quellen: die Auftraege aus Firestore (damit nur die
// eigenen Objekte erscheinen) und die Ausschreibungen samt Bewerbungen aus
// der Datenbank des Stellenportals. Die Nachrichten an die Mitarbeiterinnen
// laufen ueber Beekeeper, der Terminvorschlag an die Kundschaft ueber den
// bestehenden Ablauf in lib/einfuehrung.js.

import einfuehrung from './einfuehrung.js';
import {
  bkBereit, bkMitgliedHinzufuegen, bkNachricht, bkDirektnachricht, bkNutzerFinden, bkDiagnose,
  bkChatEroeffnen
} from './beekeeper.js';

/* Beekeeper-Profile der Bewerberinnen (Kennung, Name, Foto), je Instanz
   einige Stunden gemerkt, damit die Übersicht nicht bei jedem Aufruf
   dutzende Suchanfragen stellt. */
const NUTZER_CACHE = new Map();
const NUTZER_CACHE_DAUER = 6 * 3600 * 1000;
async function nutzerProfil(name) {
  const k = String(name || '').trim().toLowerCase();
  if (!k) return null;
  const c = NUTZER_CACHE.get(k);
  if (c && c.bis > Date.now()) return c.wert;
  let wert = null;
  try { wert = await bkNutzerFinden(name); } catch (e) { wert = null; }
  NUTZER_CACHE.set(k, { wert, bis: Date.now() + (wert ? NUTZER_CACHE_DAUER : 10 * 60 * 1000) });
  return wert;
}
async function profileLaden(namen) {
  const ergebnis = new Map();
  if (!bkBereit()) return ergebnis;
  const liste = Array.from(new Set(namen.map(n => String(n || '').trim()).filter(Boolean)));
  let i = 0;
  const arbeiter = async () => {
    while (i < liste.length) {
      const n = liste[i++];
      ergebnis.set(n.toLowerCase(), await nutzerProfil(n));
    }
  };
  await Promise.all(Array.from({ length: Math.min(5, liste.length) }, arbeiter));
  return ergebnis;
}

const SAMMLUNG = 'auftraege';
const SB_OBJEKTE = 'kunden';
const SB_BEWERBUNGEN = 'bewerbungen';
const ABTEILUNG = 'PFS';

/* ==========================================================================
   Datenbank des Stellenportals (Supabase REST)
   ========================================================================== */
function sbKopf() {
  const key = process.env.STELLEN_SUPABASE_KEY || process.env.STELLEN_SERVICE_KEY || '';
  if (!key) throw new Error('STELLEN_SUPABASE_KEY fehlt in den Umgebungsvariablen.');
  /* Neue Supabase-Schluessel (sb_secret_...) gehen nur ueber apikey; die
     alten service_role-Schluessel (JWT) zusaetzlich als Bearer. */
  const kopf = { apikey: key, 'Content-Type': 'application/json' };
  if (!/^sb_/.test(key)) kopf.Authorization = 'Bearer ' + key;
  return kopf;
}
function sbUrl(pfad) {
  const basis = process.env.STELLEN_SUPABASE_URL || '';
  if (!basis) throw new Error('STELLEN_SUPABASE_URL fehlt in den Umgebungsvariablen.');
  return basis.replace(/\/+$/, '') + '/rest/v1/' + pfad;
}
async function sbLesen(pfad) {
  const r = await fetch(sbUrl(pfad), { headers: sbKopf() });
  const d = await r.json().catch(() => ([]));
  if (!r.ok) throw new Error('Stellenportal: ' + JSON.stringify(d).slice(0, 200));
  return Array.isArray(d) ? d : [];
}
async function sbAendern(pfad, daten) {
  const r = await fetch(sbUrl(pfad), {
    method: 'PATCH',
    headers: Object.assign(sbKopf(), { Prefer: 'return=representation' }),
    body: JSON.stringify(daten)
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('Stellenportal: ' + JSON.stringify(d).slice(0, 200));
  return d;
}

/* ==========================================================================
   Zuordnung: welche Ausschreibung gehoert zu welchem eigenen Auftrag
   ========================================================================== */
function schluesselAusText(name, adresse) {
  const sauber = (x) => String(x || '')
    .toLowerCase()
    .replace(/[äàâ]/g, 'a').replace(/[öô]/g, 'o').replace(/[üû]/g, 'u')
    .replace(/[éèê]/g, 'e').replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]/g, '');
  return sauber(name) + '|' + sauber(adresse);
}
function auftragSchluessel(auf) {
  const name = [auf.vorname, auf.nachname].filter(Boolean).join(' ');
  return schluesselAusText(name, auf.adresse);
}
/* Rueckfall ohne Portal-Kennung: gleiche Adresse und der Portal-Name steckt
   im Namen des Auftrags (im Portal steht oft nur der Nachname). */
function auftragZuObjekt(nachText, o) {
  const voll = nachText.get(schluesselAusText(o.kundenname, o.address));
  if (voll) return voll;
  const [pn, pa] = schluesselAusText(o.kundenname, o.address).split('|');
  if (!pa || !pn) return null;
  for (const [k, auf] of nachText) {
    const [an, aa] = k.split('|');
    if (aa === pa && (an.includes(pn) || pn.includes(an))) return auf;
  }
  return null;
}

const WOCHENTAG = ['Sonntag','Montag','Dienstag','Mittwoch','Donnerstag','Freitag','Samstag'];
function langDatum(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return String(iso || '');
  return WOCHENTAG[d.getDay()] + ', ' +
    d.toLocaleDateString('de-CH', { day: '2-digit', month: 'long', year: 'numeric' });
}

/* ==========================================================================
   Nachrichten an die Mitarbeiterinnen
   ========================================================================== */
function textZusage(objekt, datum, zeit, mitAuftrag) {
  const termin = langDatum(datum) + (zeit ? ', ' + zeit + ' Uhr' : '');
  if (mitAuftrag === false) {
    return 'Danke für deine Bewerbung auf das Objekt ' + objekt + '. '
         + 'Wir haben uns für dich entschieden.\n\n'
         + 'Als Einführungstermin haben wir den ' + termin + ' vorgesehen. '
         + 'Wir klären ihn mit der Kundschaft und geben dir zeitnah Bescheid, ob er bestätigt ist.\n\n'
         + 'Liebe Grüsse\nPutzfrauenservice';
  }
  return 'Danke für deine Bewerbung auf das Objekt ' + objekt + '. '
       + 'Wir haben uns für dich entschieden.\n\n'
       + 'Wir haben den Einführungstermin vom ' + termin + ' der Kundschaft vorgeschlagen. '
       + 'Wir geben dir zeitnah Bescheid, ob der Termin bestätigt ist.\n\n'
       + 'Du findest alle Angaben zum Objekt im Gruppenchat, den wir dafür eröffnet haben.\n\n'
       + 'Liebe Grüsse\nPutzfrauenservice';
}
function textAbsage(objekt) {
  return 'Danke für deine Bewerbung auf das Objekt ' + objekt + '.\n\n'
       + 'Wir haben uns in diesem Fall für eine andere Mitarbeiterin entschieden. '
       + 'Bitte bewirb dich gerne wieder auf ein neues Objekt — es kommen laufend neue dazu.\n\n'
       + 'Liebe Grüsse\nPutzfrauenservice';
}
function textGruppe(name, datum, zeit) {
  return name + ' übernimmt dieses Objekt.\n'
       + 'Einführung und erste Reinigung: ' + langDatum(datum)
       + (zeit ? ', ' + zeit + ' Uhr' : '') + '.\n'
       + 'Sobald die Kundschaft den Termin bestätigt hat, melden wir es hier.';
}

/* ==========================================================================
   Aufruf des bestehenden Terminvorschlags (lib/einfuehrung.js) im Haus
   ========================================================================== */
async function internAufrufen(ziel, req, koerper) {
  const antwort = { status: 200, daten: null };
  const nachbau = {
    method: 'POST',
    url: '/api/einfuehrung',
    headers: req.headers || {},
    query: {},
    body: koerper
  };
  const res = {
    statusCode: 200,
    setHeader() { return res; },
    status(c) { antwort.status = c; return res; },
    json(d) { antwort.daten = d; return res; },
    send(d) { antwort.daten = d; return res; },
    end() { return res; }
  };
  await ziel(nachbau, res);
  return antwort;
}

/* ==========================================================================
   Einstieg
   ========================================================================== */
export default async function handler(req, res) {
  if (sitzungPruefen(req) === null) {
    return res.status(401).json({ error: 'Nicht berechtigt' });
  }

  if (req.method === 'GET') {
    try {
      if (String((req.query || {}).diagnose || '') === '1') {
        return res.status(200).json(await bkDiagnose(String((req.query || {}).name || 'Erika')));
      }
      return res.status(200).json(await uebersicht());
    } catch (e) {
      console.error('vakanzen: Übersicht fehlgeschlagen', e);
      return res.status(500).json({ error: String((e && e.message) || e) });
    }
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const b = req.body || {};
  const aktion = String(b.aktion || '');
  try {
    if (aktion === 'bestaetigen') return res.status(200).json(await bestaetigen(req, b));
    if (aktion === 'absagen')     return res.status(200).json(await absagen(b));
    if (aktion === 'nachholen')   return res.status(200).json(await nachholen(b));
    return res.status(400).json({ error: 'Unbekannte Aktion' });
  } catch (e) {
    console.error('vakanzen: ' + aktion + ' fehlgeschlagen', e);
    return res.status(500).json({ error: String((e && e.message) || e) });
  }
}

/* ---- Übersicht ---------------------------------------------------------- */
async function uebersicht() {
  const auftraege = await alleLesen(SAMMLUNG, 500);

  // Nachschlagewerke: Portal-Kennung und, als Rückfall für ältere Aufträge,
  // Name mit Adresse.
  const nachId = new Map(), nachText = new Map();
  for (const a of auftraege) {
    if (a.portalId) nachId.set(String(a.portalId), a);
    nachText.set(auftragSchluessel(a), a);
  }

  const objekte = await sbLesen(
    SB_OBJEKTE + '?dept=eq.' + ABTEILUNG + '&order=created_at.desc&limit=400'
  );
  let bewerbungen = [];
  try {
    bewerbungen = await sbLesen(
      SB_BEWERBUNGEN + '?dept=eq.' + ABTEILUNG + '&order=created_at.desc&limit=800'
    );
  } catch (e) { console.error('vakanzen: Bewerbungen nicht gelesen', e); }
  /* In die Vakanzen kommt ein Objekt nur, solange mindestens eine Bewerbung
     unbeantwortet ist. Sind alle abgesagt, verschwindet es wieder und kommt
     erst mit der naechsten Bewerbung zurueck. Vergebene Objekte bleiben
     unter «Besetzt» sichtbar, wenn eine Bewerbung bestaetigt wurde.
     Gehoert das Objekt zu einem Auftrag aus diesem Verkaufstool, laufen
     Terminvorschlag und Gruppenchat mit; sonst nur Beekeeper und Portal. */
  const mitOffener = new Set(), mitBestaetigter = new Set();
  for (const b of bewerbungen) {
    const st = String(b.status || 'offen');
    if (st === 'bestaetigt') mitBestaetigter.add(String(b.kunde_id));
    else if (st !== 'abgesagt') mitOffener.add(String(b.kunde_id));
  }
  const eigene = [];
  for (const o of objekte) {
    const k = String(o.id);
    const vergeben = String(o.status || 'open') === 'vergeben';
    if (!(mitOffener.has(k) || (vergeben && mitBestaetigter.has(k)))) continue;
    const auf = nachId.get(String(o.id)) || auftragZuObjekt(nachText, o);
    eigene.push({ o, auf: auf || null });
  }
  if (!eigene.length) return { objekte: [], stand: new Date().toISOString() };

  // Beekeeper-Profile (Foto, Name) der Bewerberinnen der angezeigten Objekte
  const eigeneIds = new Set(eigene.map(x => String(x.o.id)));
  const profile = await profileLaden(
    bewerbungen.filter(b => eigeneIds.has(String(b.kunde_id))).map(b => b.name)
  );

  const nachObjekt = new Map();
  for (const bw of bewerbungen) {
    const k = String(bw.kunde_id);
    if (!eigeneIds.has(k)) continue;
    if (!nachObjekt.has(k)) nachObjekt.set(k, []);
    const pr = profile.get(String(bw.name || '').trim().toLowerCase()) || null;
    nachObjekt.get(k).push({
      id: bw.id,
      name: bw.name || '',
      personalnummer: bw.personalnummer || '',
      datum: bw.datum || '',
      uhrzeit: bw.uhrzeit || '',
      status: bw.status || 'offen',
      neu: bw.neu === true,
      erstellt: bw.created_at || '',
      foto: pr && pr.avatar ? pr.avatar : '',
      beekeeperName: pr ? pr.name : '',
      beekeeperId: pr ? pr.id : ''
    });
  }
  // Neuste Bewerbung zuoberst
  for (const liste of nachObjekt.values()) {
    liste.sort((a, b) => String(b.erstellt).localeCompare(String(a.erstellt)));
  }

  const liste = eigene.map(({ o, auf: a }) => { const auf = a || {}; return ({
    portalId: o.id,
    imTool: !!a,
    auftragId: auf._id || auf.code || '',
    angebotsnr: auf.angebotsnr || '',
    kunde: o.kundenname || [auf.vorname, auf.nachname].filter(Boolean).join(' '),
    adresse: o.address || auf.adresse || '',
    plz: o.plz || auf.plzOrt || auf.ort || '',
    region: o.region || '',
    turnus: o.turnus || auf.frequenz || '',
    aufwand: auf.aufwandText || '',
    tage: auf.tage || '',
    uhrzeit: auf.uhrzeit || '',
    info: o.info || '',
    urgent: o.urgent === true,
    status: String(o.status || 'open') === 'vergeben' ? 'besetzt' : 'offen',
    vergebenAm: o.vergeben_at || '',
    ausgeschriebenAm: o.created_at || '',
    chatId: auf.chatId || '',
    chatTitel: auf.chatTitel || '',
    raumpflegerin: auf.raumpflegerin || '',
    einfuehrungAm: auf.einfuehrungAm || '',
    einfuehrungZeit: auf.einfuehrungZeit || '',
    einfuehrungBestaetigt: auf.einfuehrungBestaetigt || '',
    springerGestartet: auf.springerGestartet === true,
    bewerbungen: nachObjekt.get(String(o.id)) || [],
    neusteBewerbung: ((nachObjekt.get(String(o.id)) || [])[0] || {}).erstellt || '',
    offeneBewerbungen: (nachObjekt.get(String(o.id)) || []).filter(b => b.status !== 'abgesagt' && b.status !== 'bestaetigt').length
  }); });

  /* Reihenfolge: offene Objekte zuerst; darin die mit unbeantworteten
     Bewerbungen vor den erledigten, und jeweils die neuste Bewerbung
     zuoberst. */
  liste.sort((a, b) => {
    if (a.status !== b.status) return a.status === 'offen' ? -1 : 1;
    const ao = a.offeneBewerbungen > 0 ? 0 : 1, bo = b.offeneBewerbungen > 0 ? 0 : 1;
    if (ao !== bo) return ao - bo;
    return String(b.neusteBewerbung).localeCompare(String(a.neusteBewerbung));
  });

  return { objekte: liste, nachholen: nachzuholen(auftraege, objekte), stand: new Date().toISOString() };
}

/* ==========================================================================
   Nachholen: Ausschreibung im Stellenportal oder Gruppenchat, die bei der
   Auftragserteilung fehlgeschlagen sind (z. B. wegen eines falschen
   Schluessels). Betroffen sind Auftraege ohne Portal-Kennung bzw. ohne
   Chat-Kennung, die nicht monatlich, nicht abgesagt und nicht archiviert
   sind und die seit Oktober 2026 eingegangen sind.
   ========================================================================== */
const NACHHOLEN_AB = '2026-10-01';
function nachzuholen(auftraege, portalObjekte) {
  // Adresse und Name der Ausschreibungen, fuer den Abgleich ohne Kennung
  const portalListe = (portalObjekte || []).map(o => schluesselAusText(o.kundenname, o.address).split('|'));
  const imPortalOhneKennung = (a) => {
    const [an, aa] = auftragSchluessel(a).split('|');
    if (!aa) return false;
    return portalListe.some(([pn, pa]) => pa === aa && (!pn || !an || an.includes(pn) || pn.includes(an)));
  };
  const liste = [];
  for (const a of auftraege) {
    if (String(a.frequenz || '') === 'monatlich') continue;
    if (['abgesagt', 'archiv'].includes(String(a.stufe || ''))) continue;
    if (String(a.eingegangenAm || '') < NACHHOLEN_AB) continue;
    const imPortal = !!a.portalId || imPortalOhneKennung(a);
    const portalFehlt = !imPortal;
    const chatFehlt = !a.chatId;
    if (!portalFehlt && !chatFehlt) continue;
    liste.push({
      auftragId: a._id || a.code || '',
      angebotsnr: a.angebotsnr || '',
      kunde: [a.vorname, a.nachname].filter(Boolean).join(' '),
      adresse: [a.adresse, a.plzOrt].filter(Boolean).join(', '),
      eingegangenAm: a.eingegangenAm || '',
      stufe: a.stufe || '',
      portalFehlt, chatFehlt
    });
  }
  liste.sort((x, y) => String(y.eingegangenAm).localeCompare(String(x.eingegangenAm)));
  return liste;
}

const CHAT_FREQUENZ = {
  woechentlich: 'wöchentlich', '14-taeglich': 'alle 14 Tage', monatlich: 'monatlich',
  'Wöchentlich': 'wöchentlich', 'Alle zwei Wochen': 'alle 14 Tage', 'Monatlich': 'monatlich'
};
function chatTitel(a) {
  const name = [a.vorname, a.nachname].filter(Boolean).join(' ').trim() || 'Kundschaft';
  const nr = String(a.angebotsnr || a._id || a.code || '').trim();
  return [name, 'PFS', nr].filter(Boolean).join(' ');
}
function chatBeschreibung(b) {
  const adresse = [b.adresse, b.plzOrt || b.ort].filter(Boolean).join(', ');
  const freq = CHAT_FREQUENZ[b.frequenz] || CHAT_FREQUENZ[b.frequenzText] || b.frequenzText || b.frequenz || '';
  const m = String(b.aufwandText || '').match(/([\d.,]+)\s*(?:Std|Stunden|h)/i);
  const aufwand = m ? m[1].replace(',', '.') + ' Stunden' : '';
  const tage = Array.isArray(b.tage) ? b.tage.join(', ') : String(b.tage || '');
  const zeit = String(b.uhrzeit || '').replace(/\s*\([^)]*\)\s*$/, '').trim();
  const zeilen = [
    freq ? 'Reinigungsfrequenz: ' + freq : '',
    aufwand ? 'Reinigungsaufwand: ' + aufwand : '',
    (tage || zeit) ? 'Reinigungstag: ' + [tage, zeit].filter(Boolean).join(' / ') : ''
  ].filter(Boolean);
  return [adresse, '', ...zeilen].join('\n').trim();
}

async function nachholen(b) {
  const auftragId = String(b.auftragId || '');
  const was = Array.isArray(b.was) ? b.was : [String(b.was || '')];
  if (!auftragId) return { ok: false, error: 'Auftrag fehlt.' };
  const auf = await lesen(SAMMLUNG, auftragId);
  if (!auf) return { ok: false, error: 'Auftrag ' + auftragId + ' nicht gefunden.' };
  const bericht = { ok: true, auftragId };
  const neu = Object.assign({}, auf); delete neu._id;
  let geaendert = false;

  if (was.includes('portal')) {
    const portal = process.env.STELLENPORTAL_URL;
    if (!portal) bericht.portalFehler = 'STELLENPORTAL_URL nicht gesetzt';
    else {
      try {
        const std = (String(auf.aufwandText || '').match(/([\d.]+)\s*(Std|hrs)/) || [])[1] || '';
        const pr = await fetch(portal.replace(/\/+$/, '') + '/api/kunde-anlegen', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-portal-schluessel': process.env.PORTAL_SECRET || '' },
          body: JSON.stringify({
            vorname: auf.vorname, nachname: auf.nachname,
            adresse: auf.adresse, plzOrt: auf.plzOrt,
            frequenz: auf.frequenz, tage: auf.tage, uhrzeit: auf.uhrzeit,
            aufwandStunden: std, springerSofort: auf.springerSofort,
            zimmer: auf.zimmer, qm: auf.qm, badezimmer: auf.badezimmer,
            bodenbelaege: auf.bodenbelaege, stockwerk: auf.stockwerk, lift: auf.lift,
            pp: auf.pp, haustiere: auf.haustiere, alarmanlage: auf.alarmanlage,
            vereinbarungen: auf.vereinbarungen, angebotsnr: auf.angebotsnr,
            herkunft: 'Angebotssystem PFS', auftragId: auftragId,
            mail: auf.mail, mobile: auf.mobile
          })
        });
        const pd = await pr.json().catch(() => ({}));
        if (pr.ok && pd.id) { neu.portalId = String(pd.id); geaendert = true; bericht.portal = { id: pd.id, region: pd.region }; }
        else bericht.portalFehler = pd.error || ('HTTP ' + pr.status);
      } catch (e) { bericht.portalFehler = String((e && e.message) || e).slice(0, 300); }
    }
  }

  if (was.includes('chat')) {
    if (!bkBereit()) bericht.chatFehler = 'Beekeeper ist nicht eingerichtet (BEEKEEPER_URL und BEEKEEPER_TOKEN).';
    else {
      try {
        const r = await bkChatEroeffnen({ titel: chatTitel(auf), beschreibung: chatBeschreibung(auf), mitglieder: [] });
        neu.chatId = String(r.chatId || ''); neu.chatTitel = r.titel || ''; neu.chatAm = new Date().toISOString();
        geaendert = true;
        bericht.chat = { chatId: neu.chatId, titel: neu.chatTitel, hinweise: r.fehler || [] };
      } catch (e) { bericht.chatFehler = String((e && e.message) || e).slice(0, 400); console.error('vakanzen: Chat nachholen', e); }
    }
  }

  if (geaendert) {
    try { await speichern(SAMMLUNG, auftragId, neu); }
    catch (e) { bericht.speicherFehler = String((e && e.message) || e).slice(0, 200); }
  }
  bericht.ok = !bericht.portalFehler && !bericht.chatFehler;
  return bericht;
}

/* ---- Bestätigen: Mitarbeiterin erhält das Objekt ------------------------ */
async function bestaetigen(req, b) {
  const portalId = String(b.portalId || '');
  const bewerbungId = String(b.bewerbungId || '');
  const datum = String(b.datum || '').trim();
  const zeit = String(b.zeit || '').trim();
  if (!portalId || !bewerbungId) return { ok: false, error: 'Objekt oder Bewerbung fehlt.' };
  if (!datum || !zeit) return { ok: false, error: 'Datum und Uhrzeit sind nötig.' };

  const bericht = { ok: false, terminGesendet: false, chat: false, nachrichten: 0, portal: false };

  const objekte = await sbLesen(SB_OBJEKTE + '?id=eq.' + encodeURIComponent(portalId));
  const objekt = objekte[0];
  if (!objekt) return { ok: false, error: 'Objekt im Stellenportal nicht gefunden.' };

  const bewerbungen = await sbLesen(
    SB_BEWERBUNGEN + '?kunde_id=eq.' + encodeURIComponent(portalId) + '&limit=200'
  );
  const gewaehlt = bewerbungen.find(x => String(x.id) === bewerbungId);
  if (!gewaehlt) return { ok: false, error: 'Bewerbung nicht gefunden.' };

  // Eigenen Auftrag dazu finden
  const auftraege = await alleLesen(SAMMLUNG, 500);
  const nachText = new Map(auftraege.map(a => [auftragSchluessel(a), a]));
  const auf = auftraege.find(a => String(a.portalId || '') === String(portalId))
           || auftragZuObjekt(nachText, objekt) || null;
  const objektText = [objekt.address, objekt.plz].filter(Boolean).join(', ');
  bericht.imTool = !!auf;

  /* 1. Terminvorschlag an die Kundschaft — bestehender Ablauf, damit die
        Kundschaft genau dieselbe Mail wie bisher erhaelt. Bei einem Objekt,
        das direkt im Stellenportal erfasst wurde, gibt es hier keinen
        Auftrag: dann entfaellt die Mail und der Termin wird von Hand mit
        der Kundschaft abgemacht. */
  if (auf) {
    const auftragId = auf._id || auf.code || '';
    const antwort = await internAufrufen(einfuehrung, req, {
      id: auftragId, raumpflegerin: gewaehlt.name, datum: datum, zeit: zeit
    });
    if (antwort.status >= 400) {
      return { ok: false, error: (antwort.daten && antwort.daten.error) || 'Terminvorschlag fehlgeschlagen.' };
    }
    bericht.terminGesendet = true;
  } else {
    bericht.hinweis = 'Objekt wurde direkt im Stellenportal erfasst: kein Terminvorschlag-Mail und kein Gruppenchat aus diesem Tool.';
  }

  /* 2. Mitarbeiterin in den Gruppenchat und Nachrichten verschicken */
  if (bkBereit()) {
    let nutzer = null;
    try { nutzer = await bkNutzerFinden(gewaehlt.name); }
    catch (e) { bericht.chatFehler = String((e && e.message) || e).slice(0, 300); console.error('vakanzen: Nutzersuche', e); }

    if (nutzer && auf && auf.chatId) {
      try {
        await bkMitgliedHinzufuegen(auf.chatId, nutzer.id);
        await bkNachricht(auf.chatId, textGruppe(gewaehlt.name, datum, zeit));
        bericht.chat = true;
      } catch (e) { bericht.chatFehler = String((e && e.message) || e).slice(0, 300); console.error('vakanzen: Gruppenchat', e); }
    } else if (auf && !auf.chatId) {
      bericht.chatFehler = 'Für diesen Auftrag ist kein Gruppenchat hinterlegt.';
    }

    if (nutzer) {
      try { await bkDirektnachricht(nutzer, textZusage(objektText, datum, zeit, !!auf)); bericht.nachrichten++; }
      catch (e) { bericht.chatFehler = String((e && e.message) || e).slice(0, 300); console.error('vakanzen: Zusage', e); }
    } else {
      bericht.chatFehler = bericht.chatFehler || ('Mitarbeiterin in Beekeeper nicht gefunden: ' + gewaehlt.name);
      console.error('vakanzen: Nutzer nicht gefunden', gewaehlt.name);
    }

    // Die uebrigen Bewerberinnen erhalten die Absage
    for (const bw of bewerbungen) {
      if (String(bw.id) === bewerbungId) continue;
      if (String(bw.status || '') === 'abgesagt') continue;
      try {
        const n = await bkNutzerFinden(bw.name);
        if (n) { await bkDirektnachricht(n, textAbsage(objektText)); bericht.nachrichten++; }
      } catch (e) { /* eine fehlende Absage darf den Ablauf nicht stoppen */ }
    }
  } else {
    bericht.chatFehler = 'Beekeeper ist nicht eingerichtet (BEEKEEPER_URL und BEEKEEPER_TOKEN).';
  }

  /* 3. Stellenportal nachfuehren: Objekt vergeben, Bewerbungen abschliessen */
  try {
    await sbAendern(SB_OBJEKTE + '?id=eq.' + encodeURIComponent(portalId),
      { status: 'vergeben', vergeben_at: new Date().toISOString() });
    await sbAendern(SB_BEWERBUNGEN + '?id=eq.' + encodeURIComponent(bewerbungId),
      { status: 'bestaetigt', neu: false });
    await sbAendern(SB_BEWERBUNGEN + '?kunde_id=eq.' + encodeURIComponent(portalId) +
      '&id=neq.' + encodeURIComponent(bewerbungId) + '&status=neq.abgesagt',
      { status: 'abgesagt', neu: false });
    bericht.portal = true;
  } catch (e) {
    bericht.portalFehler = String((e && e.message) || e).slice(0, 200);
  }

  bericht.ok = true;
  bericht.raumpflegerin = gewaehlt.name;
  return bericht;
}

/* ---- Absagen: einzelne Bewerbung ---------------------------------------- */
async function absagen(b) {
  const bewerbungId = String(b.bewerbungId || '');
  if (!bewerbungId) return { ok: false, error: 'Bewerbung fehlt.' };

  const treffer = await sbLesen(SB_BEWERBUNGEN + '?id=eq.' + encodeURIComponent(bewerbungId));
  const bw = treffer[0];
  if (!bw) return { ok: false, error: 'Bewerbung nicht gefunden.' };

  const bericht = { ok: false, nachricht: false };
  const objektText = bw.adresse || '';

  if (bkBereit()) {
    try {
      const n = await bkNutzerFinden(bw.name);
      if (n) { await bkDirektnachricht(n, textAbsage(objektText)); bericht.nachricht = true; bericht.beekeeperName = n.name; }
      else { bericht.chatFehler = 'Mitarbeiterin in Beekeeper nicht gefunden: ' + bw.name + ' (kein Nutzer mit diesem Namen).'; console.error('vakanzen: Nutzer nicht gefunden', bw.name); }
    } catch (e) { bericht.chatFehler = String((e && e.message) || e).slice(0, 300); console.error('vakanzen: Absage', e); }
  } else {
    bericht.chatFehler = 'Beekeeper ist nicht eingerichtet (BEEKEEPER_URL und BEEKEEPER_TOKEN).';
  }

  try {
    await sbAendern(SB_BEWERBUNGEN + '?id=eq.' + encodeURIComponent(bewerbungId),
      { status: 'abgesagt', neu: false });
  } catch (e) { bericht.portalFehler = String((e && e.message) || e).slice(0, 200); }

  bericht.ok = true;
  bericht.name = bw.name || '';
  return bericht;
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

/* ---------------------------------------------------------------------------
   Zugriffsschutz: nur mit gültigem Sitzungsmerkmal aus der Anmeldung.
   Der Block steht in jeder Datei, weil Vercel gemeinsame Hilfsdateien
   mit Unterstrich nicht mitliefert.
   --------------------------------------------------------------------------- */
function sitzungPruefen(req){
  try{
    const geheim = process.env.SESSION_SECRET;
    if(!geheim) return 'nicht-eingerichtet';       // Schutz noch nicht aktiv
    let token = '';
    const kopf = req.headers.authorization || '';
    if(kopf.startsWith('Bearer ')) token = kopf.slice(7);
    if(!token){
      const c = req.headers.cookie || '';
      const m = c.match(/cs_session=([^;]+)/);
      if(m) token = decodeURIComponent(m[1]);
    }
    if(!token) return null;

    const [nutz, sig] = token.split('.');
    if(!nutz || !sig) return null;
    const erwartet = Buffer.from(crypto.createHmac('sha256', geheim).update(nutz).digest())
      .toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
    const a = Buffer.from(sig), b = Buffer.from(erwartet);
    if(a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    const d = JSON.parse(Buffer.from(nutz.replace(/-/g,'+').replace(/_/g,'/'), 'base64').toString());
    if(!d.exp || d.exp < Date.now()) return null;
    return d.u || null;
  }catch(e){ return null; }
}
