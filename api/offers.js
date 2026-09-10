import crypto from 'crypto';
// api/offers.js
// Verwaltet die gesendeten Angebote in Firestore.
//
//   GET  /api/offers            → alle Angebote mit Kennzahlen
//   POST /api/offers            → neues Angebot anlegen (beim Versand)
//   POST /api/offers?aktion=status → Status ändern (z. B. Auftrag erhalten)

const SAMMLUNG = 'angebote';

export default async function handler(req, res) {
  const nutzer = sitzungPruefen(req);
  if (nutzer === null) {
    return res.status(401).json({ error: 'Nicht angemeldet.' });
  }

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
    anfrageart: b.anfrageart || '',
    quelle: b.quelle || '',
    erfasstVon: b.erfasstVon || '',
    sprache: (b.sprache === 'en') ? 'en' : 'de',
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

  // Anfrage ins ReportingPFS übertragen (Fehler blockieren den Versand nie)
  let reporting = { geschrieben: false, grund: 'nicht versucht' };
  try {
    reporting = await reportingEintragen('anfragen', {
      kunde: [b.vorname, b.nachname].filter(Boolean).join(' '),
      datum: jetzt.slice(0, 10),
      dienstleistung: repDienstleistung(b.frequenz),
      anfrageart: b.anfrageart || '',
      quelle: b.quelle || '',
      wer: b.erfasstVon || ''
    });
  } catch (e) { reporting = { geschrieben: false, grund: e.message }; }

  return res.status(200).json({ ok: true, angebot: gespeichert, reporting });
}

/* ---- Status ändern ---- */
async function statusAendern(req, res) {
  const { code, status, erinnerungAus, notiz, notizNeu, bearbeiter } = req.body || {};
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

  /* Notizen werden als Liste geführt, damit der Verlauf erhalten bleibt —
     gleich wie beim Auftrag. Ältere Einzelnotizen werden übernommen. */
  if (typeof notizNeu === 'string' && notizNeu.trim()) {
    const bisher = Array.isArray(neu.notizen) ? neu.notizen.slice()
      : (neu.notiz ? [{ text: neu.notiz, von: neu.zuletztVon || '', am: neu.zuletztAm || '' }] : []);
    bisher.push({
      text: notizNeu.trim().slice(0, 2000),
      von: String(bearbeiter || '').slice(0, 60),
      am: new Date().toISOString()
    });
    neu.notizen = bisher;
  }
  if (bearbeiter) {
    neu.zuletztVon = String(bearbeiter).slice(0, 60);
    neu.zuletztAm = new Date().toISOString();
  }

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

/* ==========================================================================
   Anbindung an ReportingPFS
   Schreibt Anfragen und Auftragserteilungen in das bestehende Reporting.
   Aufbau dort: ein Dokument je Abteilung und Monat, z. B.
   "pfs-reporting:pfs:2026-09" mit den Feldern key und value.
   value enthält als Text: { "anfragen": [...], "erteilungen": [...] }

   Sicherheit: gelesen wird zuerst, ergänzt wird nur, wenn das Format
   erkannt wurde. Bei jeder Unklarheit wird NICHT geschrieben — lieber
   ein fehlender Eintrag als ein zerstörter Monat.

   Umgebungsvariablen:
     REPORTING_PROJECT_ID · REPORTING_CLIENT_EMAIL · REPORTING_PRIVATE_KEY
   ========================================================================== */
const REP_SAMMLUNG = 'pfs_storage';
const REP_ABTEILUNG = 'pfs';
let repTokenCache = { token: null, ablauf: 0 };

async function repToken(){
  const jetzt = Math.floor(Date.now() / 1000);
  if (repTokenCache.token && repTokenCache.ablauf > jetzt + 60) return repTokenCache.token;
  const email = process.env.REPORTING_CLIENT_EMAIL;
  let key = (process.env.REPORTING_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  if (!email || !key) throw new Error('Reporting-Zugangsdaten fehlen');

  const b64 = s => Buffer.from(s).toString('base64')
    .replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
  const header = b64(JSON.stringify({ alg:'RS256', typ:'JWT' }));
  const claim = b64(JSON.stringify({
    iss: email, scope: 'https://www.googleapis.com/auth/datastore',
    aud: 'https://oauth2.googleapis.com/token', exp: jetzt + 3600, iat: jetzt
  }));
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(`${header}.${claim}`);
  const sig = signer.sign(key, 'base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'},
    body: new URLSearchParams({
      grant_type:'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${header}.${claim}.${sig}`
    })
  });
  const d = await res.json();
  if (!res.ok) throw new Error('Reporting-Anmeldung fehlgeschlagen');
  repTokenCache = { token: d.access_token, ablauf: jetzt + (d.expires_in || 3600) };
  return repTokenCache.token;
}

function repUrl(dokument){
  const pid = process.env.REPORTING_PROJECT_ID;
  if (!pid) throw new Error('REPORTING_PROJECT_ID fehlt');
  return `https://firestore.googleapis.com/v1/projects/${pid}/databases/(default)/documents/` +
         `${REP_SAMMLUNG}/${encodeURIComponent(dokument)}`;
}

function repDienstleistung(frequenz){
  const m = { 'woechentlich':'wöchentlich', '14-taeglich':'14-täglich', 'monatlich':'monatlich' };
  return m[frequenz] || frequenz || '';
}

function repId(){
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

/**
 * Trägt einen Datensatz ins Reporting ein.
 * @param {'anfragen'|'erteilungen'} bereich
 * @param {object} satz  { kunde, datum, dienstleistung, anfrageart, quelle, wer }
 * @returns {Promise<object>} Ergebnisbericht
 */
async function reportingEintragen(bereich, satz){
  const bericht = { bereich, geschrieben: false };
  if (!process.env.REPORTING_PROJECT_ID) { bericht.grund = 'nicht eingerichtet'; return bericht; }
  if (!satz || !satz.kunde || !satz.datum) { bericht.grund = 'unvollständige Daten'; return bericht; }

  try {
    const monat = String(satz.datum).slice(0, 7);            // z. B. 2026-09
    const dok = `pfs-reporting:${REP_ABTEILUNG}:${monat}`;
    const token = await repToken();

    // 1) Bestehenden Stand lesen
    const res = await fetch(repUrl(dok), { headers: { Authorization: `Bearer ${token}` } });
    let inhalt = { anfragen: [], erteilungen: [] };
    let vorhanden = false;

    if (res.ok) {
      const doc = await res.json();
      const roh = doc?.fields?.value?.stringValue;
      if (typeof roh === 'string' && roh.trim()) {
        let geparst;
        try { geparst = JSON.parse(roh); }
        catch (e) {
          bericht.grund = 'Inhalt nicht lesbar — es wurde nichts geschrieben';
          return bericht;                                     // Schutz: nicht überschreiben
        }
        if (!geparst || typeof geparst !== 'object' ||
            !Array.isArray(geparst.anfragen) || !Array.isArray(geparst.erteilungen)) {
          bericht.grund = 'unerwartetes Format — es wurde nichts geschrieben';
          return bericht;                                     // Schutz
        }
        inhalt = geparst;
        vorhanden = true;
      }
    } else if (res.status !== 404) {
      bericht.grund = 'Lesen fehlgeschlagen (' + res.status + ')';
      return bericht;
    }

    // 2) Doppelte Einträge vermeiden
    const schonDa = inhalt[bereich].some(x =>
      x.kunde === satz.kunde && x.datum === satz.datum);
    if (schonDa) { bericht.grund = 'bereits erfasst'; bericht.geschrieben = true; return bericht; }

    // 3) Ergänzen
    inhalt[bereich].push(Object.assign({ id: repId() }, satz));

    // 4) Zurückschreiben — nur die beiden bekannten Felder
    const speichern = await fetch(repUrl(dok) + '?updateMask.fieldPaths=key&updateMask.fieldPaths=value', {
      method:'PATCH',
      headers:{ Authorization:`Bearer ${token}`, 'Content-Type':'application/json' },
      body: JSON.stringify({ fields: {
        key:   { stringValue: dok },
        value: { stringValue: JSON.stringify(inhalt) }
      }})
    });
    if (!speichern.ok) {
      bericht.grund = 'Schreiben fehlgeschlagen (' + speichern.status + ')';
      return bericht;
    }

    bericht.geschrieben = true;
    bericht.dokument = dok;
    bericht.anzahlNachher = inhalt[bereich].length;
    bericht.dokumentWarVorhanden = vorhanden;
    return bericht;

  } catch (err) {
    bericht.grund = err.message;
    return bericht;
  }
}

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
