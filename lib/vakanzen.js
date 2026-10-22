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
  bkBereit, bkMitgliedHinzufuegen, bkNachricht, bkDirektnachricht, bkNutzerFinden
} from './beekeeper.js';

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
  const mitBewerbung = new Set(bewerbungen.map(b => String(b.kunde_id)));

  /* Welche Objekte gehoeren hierher: alle aus diesem Verkaufstool (ueber die
     Portal-Kennung oder Name und Adresse) sowie jedes PFS-Objekt, auf das
     sich eine Mitarbeiterin beworben hat — sonst ginge eine Bewerbung an
     einem direkt im Stellenportal erfassten Objekt verloren. */
  const eigene = [];
  for (const o of objekte) {
    const auf = nachId.get(String(o.id)) || auftragZuObjekt(nachText, o);
    if (auf || mitBewerbung.has(String(o.id))) eigene.push({ o, auf: auf || null });
  }
  if (!eigene.length) return { objekte: [], stand: new Date().toISOString() };

  const nachObjekt = new Map();
  for (const bw of bewerbungen) {
    const k = String(bw.kunde_id);
    if (!nachObjekt.has(k)) nachObjekt.set(k, []);
    nachObjekt.get(k).push({
      id: bw.id,
      name: bw.name || '',
      personalnummer: bw.personalnummer || '',
      datum: bw.datum || '',
      uhrzeit: bw.uhrzeit || '',
      status: bw.status || 'offen',
      neu: bw.neu === true,
      erstellt: bw.created_at || ''
    });
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
    bewerbungen: nachObjekt.get(String(o.id)) || []
  }); });

  // Offene Objekte zuerst, innerhalb davon die mit Bewerbungen nach oben
  liste.sort((a, b) =>
    (a.status === b.status ? b.bewerbungen.length - a.bewerbungen.length
                           : (a.status === 'offen' ? -1 : 1)));

  return { objekte: liste, stand: new Date().toISOString() };
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
    catch (e) { bericht.chatFehler = String((e && e.message) || e).slice(0, 200); }

    if (nutzer && auf && auf.chatId) {
      try {
        await bkMitgliedHinzufuegen(auf.chatId, nutzer.id);
        await bkNachricht(auf.chatId, textGruppe(gewaehlt.name, datum, zeit));
        bericht.chat = true;
      } catch (e) { bericht.chatFehler = String((e && e.message) || e).slice(0, 200); }
    } else if (auf && !auf.chatId) {
      bericht.chatFehler = 'Für diesen Auftrag ist kein Gruppenchat hinterlegt.';
    }

    if (nutzer) {
      try { await bkDirektnachricht(nutzer, textZusage(objektText, datum, zeit, !!auf)); bericht.nachrichten++; }
      catch (e) { bericht.chatFehler = String((e && e.message) || e).slice(0, 200); }
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
      if (n) { await bkDirektnachricht(n, textAbsage(objektText)); bericht.nachricht = true; }
      else bericht.chatFehler = 'Mitarbeiterin in Beekeeper nicht gefunden: ' + bw.name;
    } catch (e) { bericht.chatFehler = String((e && e.message) || e).slice(0, 200); }
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
