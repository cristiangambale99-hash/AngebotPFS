/* Online-Auftragserteilung mit Live-Terminbuchung im Kalender des Objektleiters (Microsoft 365 / Graph).
   Ablauf: Die App legt beim Versand der Offerte eine Kurzfassung ab (ann-<nr>) und setzt den Knopf in die Mail.
   Der Kunde öffnet /a/<nr>-<schlüssel>, sieht freie Zeiten aus dem Kalender, unterschreibt und bucht.
   Danach: Termin im Kalender (Einladung an den Kunden), unterschriebene Auftragserteilung als PDF an Kunde und
   unterhalt@, Status der Offerte sofort «Gewonnen». Ohne Microsoft-Zugang bleibt alles ausgeschaltet. */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { rpc, assetBytes, sendMail, MS_ON, msToken, MS_G, E, HOTEL_RT, HOTEL_FROM } = require('./_lib');
const O = require('./_ordner');

const TZ = 'Europe/Zurich';
const esc = O.esc;
const tok = nr => crypto.createHmac('sha256', E.SESSION_SECRET).update('annahme:' + nr).digest('hex').slice(0, 16);
const idOf = nr => nr + '-' + tok(nr);
const urlOf = nr => O.base() + '/a/' + idOf(nr);
function parseId(id) {
  id = String(id || ''); const i = id.lastIndexOf('-'); if (i < 1) return null;
  const nr = id.slice(0, i), t = id.slice(i + 1);
  if (!/^[\w\-]+$/.test(nr) || t.length !== 16) return null;
  const a = Buffer.from(tok(nr)), b = Buffer.from(t); if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return nr;
}
async function getJson(name) { try { const a = await assetBytes(name); return a ? JSON.parse(a.buf.toString('utf8')) : null; } catch (e) { return null; } }
const putJson = (name, obj) => O.putAsset(name, 'application/json', Buffer.from(JSON.stringify(obj)));

/* ---------- Standardwerte (in der App unter Einstellungen › Online-Annahme änderbar) ---------- */
const DEF = { cc: 'unterhalt@clean-service.ch', cal: 's.silva@clean-service.ch', calName: 'Sergio Da Silva', calRolle: 'Objektleiter', dauer: 60, von: '08:00', bis: '17:00', vorlauf: 2, puffer: 30, wochen: 8 };
const cfgOf = s => { const c = Object.assign({}, DEF, (s && s.cfg) || {});
  ['dauer', 'vorlauf', 'puffer', 'wochen'].forEach(k => { c[k] = Math.max(0, +c[k] || 0); }); if (!(c.dauer > 0)) c.dauer = 60; if (!(c.wochen > 0)) c.wochen = 8;
  if (!/^\d\d:\d\d$/.test(c.von)) c.von = DEF.von; if (!/^\d\d:\d\d$/.test(c.bis)) c.bis = DEF.bis; return c; };

/* ---------- Datum und Zeit in Zürcher Ortszeit ---------- */
const FMT = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
function zParts(ms) { const p = {}; FMT.formatToParts(new Date(ms)).forEach(x => { p[x.type] = x.value; }); return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour, mi: +p.minute }; }
const ds = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
function zUtc(date, hhmm) { const [y, m, d] = date.split('-').map(Number), [hh, mm] = hhmm.split(':').map(Number), want = Date.UTC(y, m - 1, d, hh, mm);
  let g = want; for (let i = 0; i < 3; i++) { const p = zParts(g); g -= Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi) - want; } return g; }
const todayZ = () => { const p = zParts(Date.now()); return ds(p.y, p.m, p.d); };
const addD = (date, n) => { const d = new Date(date + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const wday = date => new Date(date + 'T12:00:00Z').getUTCDay();   // 0 = Sonntag
const mondayOf = date => addD(date, -((wday(date) + 6) % 7));
function easter(y) { const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451), mo = Math.floor((h + l - 7 * m + 114) / 31), da = ((h + l - 7 * m + 114) % 31) + 1; return ds(y, mo, da); }
function holidays(y) { const e = easter(y); return new Set([ds(y, 1, 1), ds(y, 1, 2), addD(e, -2), addD(e, 1), ds(y, 5, 1), addD(e, 39), addD(e, 50), ds(y, 8, 1), ds(y, 12, 25), ds(y, 12, 26)]); }   // Feiertage Kanton Zürich
const isHoliday = date => holidays(+date.slice(0, 4)).has(date);
const isWork = date => { const w = wday(date); return w >= 1 && w <= 5 && !isHoliday(date); };
function earliestDay(c) { let d = todayZ(), n = c.vorlauf; while (n > 0) { d = addD(d, 1); if (isWork(d)) n--; } if (c.vorlauf === 0) d = addD(d, 1); while (!isWork(d)) d = addD(d, 1); return d; }
const toMin = t => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
const hhmm = m => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const L = {
  de: { tage: ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'], kurz: ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'], mon: ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'], uhr: ' Uhr' },
  en: { tage: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'], kurz: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'], mon: ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'], uhr: '' }
};
const lg = s => (s && s.lang === 'en') ? 'en' : 'de';
function slotTxt(s, date, t, dauer) { const l = L[lg(s)], [y, m, d] = date.split('-').map(Number), end = hhmm(toMin(t) + dauer);
  return lg(s) === 'en' ? `${l.tage[wday(date)]}, ${d} ${l.mon[m - 1]} ${y}, ${t}–${end}` : `${l.tage[wday(date)]}, ${d}. ${l.mon[m - 1]} ${y}, ${t}–${end} Uhr`; }

/* ---------- Microsoft Graph ---------- */
async function graph(method, p, bodyObj, extra) {
  const t = await msToken();
  const r = await fetch(MS_G() + p, { method, headers: Object.assign({ Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' }, extra || {}), body: bodyObj ? JSON.stringify(bodyObj) : undefined });
  const txt = await r.text(); let j = {}; try { j = txt ? JSON.parse(txt) : {}; } catch (e) {}
  if (!r.ok) { const e = new Error('Kalender ' + r.status + ': ' + ((j.error && j.error.message) || txt.slice(0, 160))); e.status = r.status; throw e; }
  return j;
}
const isoNoZ = ms => new Date(ms).toISOString().slice(0, 19);
async function busyList(cal, fromMs, toMs) {
  const j = await graph('POST', '/users/' + encodeURIComponent(cal) + '/calendar/getSchedule',
    { schedules: [cal], startTime: { dateTime: isoNoZ(fromMs), timeZone: 'UTC' }, endTime: { dateTime: isoNoZ(toMs), timeZone: 'UTC' }, availabilityViewInterval: 15 },
    { Prefer: 'outlook.timezone="UTC"' });
  const v = (j.value || [])[0] || {};
  if (v.error) throw new Error('Kalender: ' + (v.error.message || v.error.responseCode || 'kein Zugriff'));
  return (v.scheduleItems || []).filter(x => ['busy', 'oof', 'tentative'].includes(String(x.status || '').toLowerCase()))
    .map(x => [Date.parse(x.start.dateTime.replace(/Z?$/, 'Z')), Date.parse(x.end.dateTime.replace(/Z?$/, 'Z'))]);
}
const overlaps = (busy, a, b) => busy.some(([s, e]) => s < b && e > a);

/* Freie Zeiten einer Woche (Mo–Fr) */
async function week(s, monday) {
  const c = cfgOf(s), first = earliestDay(c), last = addD(todayZ(), c.wochen * 7), von = toMin(c.von), bis = toMin(c.bis);
  const days = [0, 1, 2, 3, 4].map(i => addD(monday, i));
  const from = zUtc(days[0], '00:00') - c.puffer * 60000, to = zUtc(addD(days[4], 1), '00:00') + c.puffer * 60000;
  const anyOpen = days.some(d => d >= first && d <= last && isWork(d));
  const busy = anyOpen ? await busyList(c.cal, from, to) : [];
  const l = L[lg(s)], now = Date.now();
  const out = days.map(d => {
    const open = d >= first && d <= last && isWork(d), slots = [];
    for (let m = von; m + c.dauer <= bis; m += 60) {
      const t = hhmm(m), a = zUtc(d, t), b = a + c.dauer * 60000;
      slots.push({ t, free: open && a > now && !overlaps(busy, a - c.puffer * 60000, b + c.puffer * 60000) });
    }
    const [, mo, da] = d.split('-').map(Number);
    return { d, lab: l.kurz[wday(d)], dm: `${da}.${mo}.`, open, fei: isHoliday(d), slots };
  });
  const [y1, m1, d1] = days[0].split('-').map(Number), [y5, m5, d5] = days[4].split('-').map(Number);
  const range = lg(s) === 'en' ? `${d1}${m1 !== m5 ? ' ' + l.mon[m1 - 1] : ''} – ${d5} ${l.mon[m5 - 1]} ${y5}` : `${d1}.${m1 !== m5 ? ' ' + l.mon[m1 - 1] : ''} – ${d5}. ${l.mon[m5 - 1]} ${y5}`;
  return { monday, range, days: out, prev: mondayOf(first) < monday, next: addD(monday, 7) <= last, first };
}

/* ---------- PDF «Auftragserteilung» ---------- */
async function auftragPdf(s, r, c) {
  const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
  const en = lg(s) === 'en', doc = await PDFDocument.create(), pg = doc.addPage([595.28, 841.89]);
  const F = await doc.embedFont(StandardFonts.Helvetica), B = await doc.embedFont(StandardFonts.HelveticaBold);
  const safe = (f, t) => Array.from(String(t == null ? '' : t)).map(ch => { try { f.encodeText(ch); return ch; } catch (e) { return ch === '\u2011' ? '-' : '?'; } }).join('');
  const ink = rgb(0.09, 0.2, 0.23), mute = rgb(0.36, 0.45, 0.47), teal = rgb(0.055, 0.486, 0.502), line = rgb(0.84, 0.9, 0.91);
  let y = 790; const X = 56, W = 483;
  const txt = (t, o = {}) => { const f = o.b ? B : F, sz = o.sz || 10.5; pg.drawText(safe(f, t), { x: o.x || X, y: o.y != null ? o.y : y, size: sz, font: f, color: o.c || ink }); };
  const wrap = (t, f, sz, w) => { const out = []; String(t).split('\n').forEach(par => { let cur = ''; par.split(/\s+/).forEach(wd => { const n = cur ? cur + ' ' + wd : wd; if (f.widthOfTextAtSize(safe(f, n), sz) > w && cur) { out.push(cur); cur = wd; } else cur = n; }); out.push(cur); }); return out; };
  try { const lp = path.join(O.staticDir(), 'logo.png'); const img = await doc.embedPng(fs.readFileSync(lp)); pg.drawImage(img, { x: X, y: 770, width: 150, height: 150 * img.height / img.width }); } catch (e) {}
  y = 712; txt(en ? 'Order confirmation' : 'Auftragserteilung', { b: true, sz: 20 });
  y -= 20; txt((en ? 'Maintenance cleaning according to offer ' : LS(s) + ' gemäss Offerte ') + s.nr + (s.rev ? ' (Rev. ' + s.rev + ')' : ''), { c: mute, sz: 11 });
  y -= 30;
  const row = (k, v) => { txt(k, { c: mute, sz: 9.5 }); const ls = wrap(v || '–', B, 10.5, W - 150); ls.forEach((l, i) => txt(l, { b: true, x: X + 150, y: y - i * 14 })); y -= Math.max(1, ls.length) * 14 + 8; };
  row(en ? 'Client' : 'Auftraggeber', s.firma);
  row(en ? 'Property' : 'Objekt', [s.objekt, s.adresse].filter(Boolean).join(', '));
  row(en ? 'Cleaning' : 'Reinigung', s.reinigung);
  if (isHotel(s)) row('Preise', s.preis || 'gemäss Offerte, pro Einsatz, exkl. MwSt.');
  else row(en ? 'Monthly flat rate' : 'Monatlicher Pauschalbetrag', `CHF ${chfTxt(r.betrag)} ${en ? 'excl. VAT' : 'exkl. MwSt.'}${r.variante ? ' · ' + r.variante : ''}`);
  row(en ? 'Contract start' : 'Vertragsbeginn', r.vbTxt || s.start || (en ? 'By arrangement' : 'Nach Vereinbarung'));
  row(en ? 'Kick-off meeting' : 'Startbesprechung', r.d ? `${r.slotTxt} · ${c.calName}, ${en ? 'on site' : 'vor Ort'}` : r.slotTxt);
  y -= 6; pg.drawLine({ start: { x: X, y }, end: { x: X + W, y }, thickness: 0.8, color: line }); y -= 22;
  const decl = en ? `With this signature, the client awards Clean Service Scaramuzzo AG the contract for maintenance cleaning in accordance with offer ${s.nr} and confirms having read and accepted the offer including the conditions stated therein.`
    : `Mit dieser Unterschrift erteilt der Auftraggeber der Clean Service Scaramuzzo AG den Auftrag für ${isHotel(s) ? 'den ' + LS(s) : 'die Unterhaltsreinigung'} gemäss Offerte ${s.nr} und bestätigt, die Offerte mit den darin aufgeführten Konditionen gelesen zu haben und zu akzeptieren.`;
  wrap(decl, F, 10.5, W).forEach(l => { txt(l); y -= 15; });
  y -= 18; txt(en ? 'Signature' : 'Unterschrift', { c: mute, sz: 9.5 }); y -= 8;
  try { const sig = await doc.embedPng(Buffer.from(r.sig.split(',')[1], 'base64')), q = sig.height / sig.width; let w = 240, h = w * q; if (h > 90) { h = 90; w = h / q; } pg.drawImage(sig, { x: X, y: y - h, width: w, height: h }); y -= h + 4; } catch (e) { y -= 60; }
  pg.drawLine({ start: { x: X, y }, end: { x: X + 260, y }, thickness: 0.8, color: ink }); y -= 16;
  txt(r.name + (r.funktion ? ', ' + r.funktion : ''), { b: true }); y -= 14;
  txt(s.firma || '', { c: mute, sz: 9.5 }); y -= 14;
  txt((en ? 'Signed electronically on ' : 'Elektronisch unterzeichnet am ') + r.atTxt, { c: mute, sz: 9.5 });
  const foot = `${en ? 'Electronically awarded via' : 'Elektronisch erteilt über'} ${O.base().replace(/^https?:\/\//, '')} · ${r.email} · IP ${r.ip || '–'} · ${en ? 'Ref.' : 'Ref.'} ${r.ref}`;
  pg.drawLine({ start: { x: X, y: 70 }, end: { x: X + W, y: 70 }, thickness: 0.6, color: line });
  txt(foot, { y: 56, sz: 7.5, c: mute }); txt('Clean Service Scaramuzzo AG · Industriestrasse 5 · 8307 Effretikon · 0844 355 355 · clean-service.ch', { y: 44, sz: 7.5, c: teal });
  doc.setTitle((en ? 'Order confirmation ' : 'Auftragserteilung ') + s.nr); doc.setAuthor('Clean Service Scaramuzzo AG');
  return Buffer.from(await doc.save());
}
/* Hotelofferten: gleiche Seite, eigene Wortwahl. Ohne Kalenderzugang (noch keine Microsoft-Freigabe oder kein Kalender
   hinterlegt) erteilt der Kunde den Auftrag trotzdem online, die Startbesprechung vereinbart der Objektleiter danach telefonisch. */
const isHotel = s => s && s.kind === 'hotel';
const LS = s => (s && s.leistung) || 'Unterhaltsreinigung';
const noCal = s => isHotel(s) ? (!MS_ON() || !(s.cfg && s.cfg.cal)) : !(s.cfg && s.cfg.kick === true);
/* Unterhaltsreinigung ohne Online-Terminwahl (Standard): der Kunde erteilt den Auftrag, die Administration meldet sich für einen Besprechungstermin vor Ort */
const isAdm = s => !isHotel(s) && noCal(s);
const ADM_TXT = 'Unsere Administration meldet sich für einen Besprechungstermin vor Ort bei Ihnen';
const chfTxt = n => (Math.round((+n || 0) * 20) / 20).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, "'");

/* ---------- Öffentliche Aktionen (Kundenseite) ---------- */
async function pub(b, req, res) {
  const nr = parseId(b.id); if (!nr) return res.status(404).json({ error: 'Link ungültig' });
  const s = await getJson('ann-' + nr); if (!s) return res.status(404).json({ error: 'Offerte nicht gefunden' });
  const done = await getJson('ann-res-' + nr);
  if (done) return res.status(409).json({ error: lg(s) === 'en' ? 'This order has already been placed.' : 'Der Auftrag wurde bereits erteilt.', done: { slotTxt: done.slotTxt, atTxt: done.atTxt } });
  const NC = noCal(s);
  if (!MS_ON() && !NC) return res.status(503).json({ error: lg(s) === 'en' ? 'Online booking is currently unavailable. Please call us on 0844 355 355.' : 'Die Online-Terminwahl ist gerade nicht verfügbar. Bitte rufen Sie uns an: 0844 355 355.' });
  const c = cfgOf(s);
  try {
    if (b.an === 'slots') {
      if (NC) return res.status(200).json({ nocal: true });
      let mon = /^\d{4}-\d\d-\d\d$/.test(b.w || '') ? mondayOf(b.w) : mondayOf(earliestDay(c));
      return res.status(200).json(await week(s, mon));
    }
    if (b.an === 'book') {
      const en = lg(s) === 'en', err = m => res.status(400).json({ error: m });
      const name = String(b.name || '').trim().slice(0, 80), funktion = String(b.funktion || '').trim().slice(0, 80), email = String(b.email || '').trim().slice(0, 120);
      if (name.length < 3) return err(en ? 'Please enter your first and last name.' : 'Bitte Vor- und Nachname eingeben.');
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return err(en ? 'Please enter a valid e-mail address.' : 'Bitte eine gültige E-Mail-Adresse eingeben.');
      const vb = String(b.vb || ''); if (!vbOk(vb)) return err(en ? 'Please choose a start date at least 10 days from today.' : 'Bitte ein Startdatum frühestens 10 Tage ab heute wählen.');
      if (!b.agb) return err(en ? 'Please accept the offer and its conditions.' : 'Bitte die Offerte und die Konditionen bestätigen.');
      const sig = String(b.sig || ''); if (!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(sig) || sig.length < 1200 || sig.length > 600000) return err(en ? 'Please sign in the box.' : 'Bitte im Feld unterschreiben.');
      const vars = Array.isArray(s.vars) ? s.vars : []; let betrag = +s.monthly || 0, variante = '';
      if (vars.length > 1) { const v = vars[+b.v]; if (!v) return err(en ? 'Please choose a price option.' : 'Bitte eine Preisvariante wählen.'); betrag = +v.m || 0; variante = v.n || ''; }
      /* Termin nochmals live prüfen: nur Raster-Zeiten, im erlaubten Zeitraum, noch frei */
      const date = NC ? '' : String(b.d || ''), t = NC ? '' : String(b.t || '');
      let a = Date.now(), m = 0;
      if (!NC) {
      if (!/^\d{4}-\d\d-\d\d$/.test(date) || !/^\d\d:\d\d$/.test(t)) return err(en ? 'Please choose a time.' : 'Bitte einen Termin wählen.');
      m = toMin(t); const first = earliestDay(c), last = addD(todayZ(), c.wochen * 7);
      if (date < first || date > last || !isWork(date) || m < toMin(c.von) || m + c.dauer > toMin(c.bis) || (m - toMin(c.von)) % 60) return err(en ? 'This time cannot be booked.' : 'Dieser Termin ist nicht buchbar.');
      a = zUtc(date, t); const e2 = a + c.dauer * 60000;
      const busy = await busyList(c.cal, a - c.puffer * 60000 - 3600000, e2 + c.puffer * 60000 + 3600000);
      if (overlaps(busy, a - c.puffer * 60000, e2 + c.puffer * 60000)) return res.status(409).json({ error: en ? 'This time has just been taken. Please choose another one.' : 'Dieser Termin wurde soeben vergeben. Bitte wählen Sie einen anderen.', taken: true });
      }
      const ADM = isAdm(s);
      const sTxt = NC ? (ADM ? (en ? 'Our administration will contact you to arrange an on-site meeting' : ADM_TXT) : c.calName + ' vereinbart den Termin telefonisch') : slotTxt(s, date, t, c.dauer), nowP = zParts(Date.now());
      const atTxt = `${String(nowP.d).padStart(2, '0')}.${String(nowP.m).padStart(2, '0')}.${nowP.y}, ${hhmm(nowP.h * 60 + nowP.mi)}${en ? '' : ' Uhr'}`;
      const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
      const ref = crypto.createHash('sha256').update([nr, s.rev || 0, name, email, date, t, sig.length, Date.now()].join('|')).digest('hex').slice(0, 12).toUpperCase();
      const vbT = vbTxt(vb, en);
      const sigArt = ['typ', 'draw'].includes(b.sigArt) ? b.sigArt : 'draw';
      const r = { nr, rev: s.rev || 0, objId: s.objId, vb, vbTxt: vbT, sigArt, name, funktion, email, d: date, t, iso: new Date(a).toISOString(), slotTxt: sTxt, at: new Date().toISOString(), atTxt, ip, ref, betrag, variante, sig };
      /* 1. Termin im Kalender des Objektleiters, Kunde als Teilnehmer (Outlook verschickt die Einladung) */
      if (!NC) {
      const subj = (en ? 'Kick-off meeting maintenance cleaning: ' : 'Startbesprechung ' + LS(s) + ': ') + (s.firma || '') + ' (' + (en ? 'Offer ' : 'Offerte ') + nr + ')';
      const evBody = `<div style="font-family:Verdana,Arial,sans-serif;font-size:13px;line-height:1.5"><p>${en ? 'Kick-off meeting for the maintenance cleaning (order placed online).' : 'Startbesprechung für die Unterhaltsreinigung (Auftrag online erteilt).'}</p><p><b>${esc(s.firma || '')}</b><br>${esc([s.objekt, s.adresse].filter(Boolean).join(', '))}<br>${esc(name)}${funktion ? ', ' + esc(funktion) : ''}<br>${esc(email)}${s.tel ? '<br>' + esc(s.tel) : ''}</p><p>${en ? 'Contract start' : 'Vertragsbeginn'}: ${esc(vbT)}<br>${en ? 'Offer' : 'Offerte'} ${esc(nr)}${s.rev ? ' Rev. ' + s.rev : ''} · CHF ${chfTxt(betrag)} ${en ? 'per month excl. VAT' : 'pro Monat exkl. MwSt.'}${variante ? ' · ' + esc(variante) : ''}</p></div>`;
      const ev = await graph('POST', '/users/' + encodeURIComponent(c.cal) + '/events', {
        subject: subj, body: { contentType: 'HTML', content: evBody },
        start: { dateTime: date + 'T' + t + ':00', timeZone: 'W. Europe Standard Time' }, end: { dateTime: date + 'T' + hhmm(m + c.dauer) + ':00', timeZone: 'W. Europe Standard Time' },
        location: { displayName: [s.objekt, s.adresse].filter(Boolean).join(', ') || (s.firma || '') },
        attendees: [{ emailAddress: { address: email, name }, type: 'required' }].concat(String(c.cc || '').split(/[,;\s]+/).filter(x => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(x) && x.toLowerCase() !== email.toLowerCase() && x.toLowerCase() !== c.cal.toLowerCase()).map(x => ({ emailAddress: { address: x }, type: 'required' }))), showAs: 'busy', isReminderOn: true, reminderMinutesBeforeStart: 60,
        allowNewTimeProposals: true, transactionId: 'annahme-' + nr + '-' + (s.rev || 0) + '-' + date + t.replace(':', '')
      });
      r.eventId = ev.id || '';
      }
      /* 2. Unterschriebene Auftragserteilung ablegen */
      const offerPdf = ADM || !isHotel(s) ? await assetBytes('ann-pdf-' + nr).then(a => a ? a.buf : null).catch(() => null) : null;
      const pdf = isHotel(s) ? await auftragPdf(s, r, c) : await require('./_vertrag').vertragPdf(s, r, offerPdf, { host: O.base().replace(/^https?:\/\//, ''), nextTxt: ADM ? undefined : `Die Startbesprechung mit unserem ${c.calRolle} ${c.calName} findet am ${sTxt} statt. Fragen beantworten wir gerne unter 0844 355 355 oder unterhalt@clean-service.ch.` });
      await O.putAsset('ann-auf-' + nr, 'application/pdf', pdf);
      await putJson('ann-res-' + nr, r);
      const pub = Object.assign({}, r); delete pub.sig; pub.pdf = urlOf(nr) + '/auftrag'; pub.cal = c.cal; pub.calName = c.calName;
      try { await rpc('api_doc_put', { p_path: 'annahmen/' + (s.objId || nr), p_data: pub }); } catch (e) {}
      /* 3. Offerte sofort auf «Gewonnen» setzen (Nachfassung endet), die App richtet danach den Reinigungsstart ein */
      if (isHotel(s)) { try { const h = s.objId ? await rpc('api_doc_get', { p_path: 'hotel/' + s.objId }) : null; if (h && h.id) { h.status = 'gewonnen'; h.gewonnenAm = todayZ(); h.annahme = pub; h.upd = Date.now(); await rpc('api_doc_put', { p_path: 'hotel/' + h.id, p_data: h }); } } catch (e) {} }
      else try {
        const o = s.objId ? await rpc('api_doc_get', { p_path: 'objects/' + s.objId }) : null;
        if (o && o.id) {
          const d0 = todayZ(); o.log = o.log || [];
          if (o.status !== 'gewonnen') { o.status = 'gewonnen'; o.log.push([d0, 'Auftragserteilung erhalten, Nachfassung beendet']); }
          o.annahme = pub; o.revOpen = false; o.aktiv = false; o.aktivAb = vbDay(vb); o.auftragAm = d0;
          o.log.push([d0, `Reinigungsvertrag online unterzeichnet von ${name}${funktion ? ' (' + funktion + ')' : ''}, Vertragsbeginn ${vbT}${ADM ? '' : ', Startbesprechung ' + sTxt + ' mit ' + c.calName}`]);
          await rpc('api_doc_put', { p_path: 'objects/' + o.id, p_data: o });
        }
      } catch (e) {}
      /* 4. Bestätigung an den Kunden, Meldung an unterhalt@ und den Objektleiter */
      const att = [{ filename: (isHotel(s) ? (en ? 'Order_confirmation_' : 'Auftragserteilung_') : (en ? 'Cleaning_contract_' : 'Reinigungsvertrag_')) + nr + '.pdf', content: pdf.toString('base64') }];
      const to = [email]; if (s.email && s.email.toLowerCase() !== email.toLowerCase() && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.email)) to.push(s.email);
      const ort = [s.objekt, s.adresse].filter(Boolean).join(', ');
      const kText = en
        ? `${s.gruss || 'Dear Sir or Madam'}\n\nThank you very much for your order. We are looking forward to working with you. The maintenance cleaning starts on ${vbT}.\n\nYour kick-off meeting with our ${c.calRolle === 'Objektleiter' ? 'property manager' : c.calRolle} ${c.calName} will take place on ${sTxt}${ort ? ' at ' + ort : ''}. You will receive the invitation for your calendar in a separate e-mail.\n\nPlease find attached your signed order confirmation (reference ${ref}).\n\nKind regards`
        : `${s.gruss || 'Sehr geehrte Damen und Herren'}\n\nHerzlichen Dank für Ihren Auftrag. Wir freuen uns auf die Zusammenarbeit. ${isHotel(s) ? 'Der ' + LS(s) + ' startet' : 'Die Unterhaltsreinigung beginnt'} am ${vbT}.\n\n${ADM ? 'Unsere Administration meldet sich in den nächsten Tagen bei Ihnen für einen Besprechungstermin vor Ort.' : NC ? `Unser ${c.calRolle} ${c.calName} meldet sich in den nächsten Tagen telefonisch bei Ihnen, um den Termin für die Startbesprechung zu vereinbaren.` : `Die Startbesprechung mit unserem ${c.calRolle} ${c.calName} findet am ${sTxt}${ort ? ' statt, vor Ort an der ' + ort : ' statt'}. Die Einladung für Ihren Kalender erhalten Sie in einer separaten E-Mail.`}\n\n${isHotel(s) ? `Im Anhang finden Sie Ihre unterschriebene Auftragserteilung (Referenz ${ref}).` : `Im Anhang finden Sie Ihren Reinigungsvertrag: die Offerte mit allen Beilagen und die von beiden Seiten unterzeichnete Vertragsseite (Referenz ${ref}).`}\n\nFreundliche Grüsse`;
      let kOk = true; try { await sendMail({ to, subject: (isHotel(s) ? (en ? 'Order confirmation and kick-off meeting · ' : NC ? 'Auftragsbestätigung · ' : 'Auftragsbestätigung und Startbesprechung · ') : (en ? 'Your order / cleaning contract · ' : 'Ihr Auftrag / Reinigungsvertrag · ')) + nr, text: kText, kind: 'annahme', objectId: s.objId, attachments: att, lang: en ? 'en' : 'de', from: isHotel(s) ? HOTEL_FROM : undefined, replyTo: isHotel(s) ? HOTEL_RT : undefined }); } catch (e) { kOk = false; }
      const intern = (isHotel(s) ? ['hotelservice@clean-service.ch', c.cal] : [E.MAIL_REPLY_TO ? String(E.MAIL_REPLY_TO).replace(/^.*<([^>]+)>.*$/, '$1') : 'unterhalt@clean-service.ch', c.cal]).filter(x => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(x || '')).filter((x, i, a) => x && a.indexOf(x) === i);
      const iText = `Guten Tag\n\nDie Offerte ${nr}${s.rev ? ' (Rev. ' + s.rev + ')' : ''} für ${s.firma || ''}${ort ? ', ' + ort : ''} wurde soeben online angenommen.${isHotel(s) ? '' : ' Der Reinigungsvertrag (Offerte mit Vertragsseite, beide Unterschriften) ist angehängt und beim Kunden. Status im Verkaufstool: Auftragserteilung erhalten, Aktiv ab Vertragsbeginn.'}\n\nUnterschrieben von: ${name}${funktion ? ', ' + funktion : ''} (${email})\nGewünschter Vertragsbeginn: ${vbT}\n${isHotel(s) ? 'Preise: ' + (s.preis || 'gemäss Offerte') : `Monatlicher Pauschalbetrag: CHF ${chfTxt(betrag)} exkl. MwSt.${variante ? ' (' + variante + ')' : ''}`}\n${NC ? `Startbesprechung: Bitte den Termin telefonisch mit dem Kunden vereinbaren (${c.calName}).` : `Startbesprechung: ${sTxt} mit ${c.calName}. Der Termin steht im Kalender, der Kunde hat die Einladung erhalten.`}\n\n${isHotel(s) ? 'Die Hotelofferte steht im Verkaufstool automatisch auf «Gewonnen». Die unterschriebene Auftragserteilung ist angehängt.' : 'Die Offerte steht in der Offertplattform auf «Gewonnen». Bitte dort Reinigungsstart und Einführung festlegen, damit Stellenportal und Gruppenchat starten.'}${kOk ? '' : '\n\nAchtung: Die Bestätigung an den Kunden konnte nicht gesendet werden. Bitte die angehängte Auftragserteilung manuell zustellen.'}\n\nFreundliche Grüsse`;
      try { await sendMail({ to: intern, subject: isHotel(s) ? `Auftrag gewonnen: Offerte ${nr} · ${s.firma || ''}` : `Auftragserteilung erhalten: Offerte ${nr} · ${s.firma || ''}`, text: iText, kind: 'annahme-intern', objectId: s.objId, attachments: att, lang: 'de', nocopy: true, from: isHotel(s) ? HOTEL_FROM : undefined }); } catch (e) {}
      try { const P = require('./_push'); await P.notify(isHotel(s) ? 'ho' : 'uh', { title: 'Auftragserteilung erhalten', body: `${s.firma || 'Kunde'} · Offerte ${nr}${isHotel(s) ? ' · Hotelservice' : ' · Unterhaltsreinigung'}`, url: '/', tag: 'auftrag-' + nr }); } catch (e) {}
      return res.status(200).json({ ok: true, slotTxt: sTxt, ref, vbTxt: vbT, name: name + (funktion ? ', ' + funktion : '') });
    }
    res.status(400).json({ error: 'Aktion unbekannt' });
  } catch (e) { res.status(502).json({ error: (lg(s) === 'en' ? 'The calendar could not be reached. Please try again in a moment. ' : 'Der Kalender ist gerade nicht erreichbar. Bitte in einem Moment nochmals versuchen. ') + '(' + String(e.message || e).slice(0, 120) + ')' }); }
}

/* ---------- Aktionen der App (angemeldet) ---------- */
async function priv(b, res) {
  if (b.an === 'status') {
    const out = { ms: MS_ON(), cal: false };
    if (out.ms) { const cal = String(b.cal || DEF.cal); try { const now = Date.now(); await busyList(cal, now, now + 864e5); out.cal = true; } catch (e) { out.err = String(e.message || e).slice(0, 200); } }
    return res.status(200).json(out);
  }
  if (b.an === 'put') {
    const nr = O.safeNr(b.nr), s = b.snap; if (!nr || !s || typeof s !== 'object') return res.status(400).json({ error: 'nr/snap' });
    s.nr = nr; s.updated = new Date().toISOString();
    await putJson('ann-' + nr, s);
    return res.status(200).json({ ok: true, url: urlOf(nr), done: !!(await getJson('ann-res-' + nr)) });
  }
  if (b.an === 'res') { const nr = O.safeNr(b.nr); const r = nr && await getJson('ann-res-' + nr); if (r) delete r.sig; return res.status(200).json({ res: r || null, url: nr ? urlOf(nr) : null }); }
  res.status(400).json({ error: 'Aktion unbekannt' });
}

/* ---------- Kundenseite (B2B, Corporate Design Clean Service) ---------- */
/* Vertragsbeginn: jeweils per 1. eines Monats, frühestens 14 Tage ab heute, Auswahl über 9 Monate */
/* Vertragsbeginn: ein konkretes Datum, das der Kunde selbst eingibt, frühestens 10 Tage ab heute, bis 12 Monate voraus */
function startRange() { const t = todayZ(); return { min: addD(t, 10), max: addD(t, 366) }; }   /* frühestens 10 Tage ab heute */
const vbOk = vb => /^\d{4}-\d\d-\d\d$/.test(vb) && !isNaN(Date.parse(vb + 'T12:00:00Z')) && vb >= startRange().min && vb <= startRange().max;
const vbTxt = (vb, en) => { const [y, m, d] = vb.split('-').map(Number); if (!d) return en ? `1 ${L.en.mon[m - 1]} ${y}` : `1. ${L.de.mon[m - 1]} ${y}`; const l = L[en ? 'en' : 'de']; return en ? `${l.tage[wday(vb)]}, ${d} ${l.mon[m - 1]} ${y}` : `${l.tage[wday(vb)]}, ${d}. ${l.mon[m - 1]} ${y}`; };
const vbDay = vb => vb.length === 7 ? vb + '-01' : vb;
function shell(title, inner, lang) {
  return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title><link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Figtree:wght@300;400;500;600;700&family=Mrs+Saint+Delafield&family=Allura&family=Herr+Von+Muellerhoff&display=swap"><style>${CSS}</style></head><body>${inner}</body></html>`;
}
const CSS = `:root{--ink:#3C3C3B;--mute:#767676;--brand:#2BB6B7;--bd:#1B8384;--bdd:#166d6e;--line:#E2EBED;--line2:#D3E2E5;--ice:#BEE2E9;--soft:#F4F8F9;--sel:#EEF7F7;--err:#B42318;color-scheme:light}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}body{margin:0;background:#fff;color:var(--ink);font:15px/1.55 "Brandon Text","Figtree",system-ui,-apple-system,"Segoe UI",Arial,sans-serif;-webkit-font-smoothing:antialiased}
.top{border-bottom:1px solid var(--line);background:#fff}.top .in{max-width:1120px;margin:0 auto;padding:18px 24px;display:flex;align-items:center;justify-content:space-between;gap:16px}
.logo{height:50px;width:auto;display:block}.meta{text-align:right;font-size:13px;color:var(--mute);line-height:1.4}.meta b{display:block;color:var(--ink);font-weight:600;font-size:14px}
.hero{position:relative;overflow:hidden;background:var(--soft);border-bottom:1px solid var(--line)}.hero .in{position:relative;z-index:1;max-width:1120px;margin:0 auto;padding:40px 24px 44px}
.hero svg{position:absolute;right:-40px;bottom:-1px;width:min(560px,70%);height:100%;z-index:0}
.eb{font-size:12px;font-weight:600;letter-spacing:.14em;text-transform:uppercase;color:var(--bd);margin:0 0 10px}
h1{margin:0;font:300 34px/1.15 "Brandon Grotesque","Figtree",system-ui,sans-serif;letter-spacing:.06em;text-transform:uppercase;color:var(--bd)}
.firm{margin:10px 0 0;font-size:20px;font-weight:600;color:var(--ink)}.addr{margin:4px 0 0;color:var(--mute);font-size:15px}
.wrap{max-width:1120px;margin:0 auto;padding:32px 24px 56px}.layout{display:grid;grid-template-columns:minmax(0,1fr) 340px;gap:32px;align-items:start}
.steps{display:flex;flex-direction:column;gap:20px;min-width:0}
.step{border:1px solid var(--line);border-radius:12px;padding:26px 28px;background:#fff;min-width:0}
.sn{font-size:11px;font-weight:600;letter-spacing:.14em;text-transform:uppercase;color:var(--bd);margin:0 0 6px}
h2{margin:0;font-size:19px;font-weight:600;color:var(--ink);letter-spacing:0}.lead{margin:6px 0 18px;color:var(--mute);font-size:14px;max-width:62ch}
.months{display:grid;grid-template-columns:repeat(auto-fill,minmax(128px,1fr));gap:10px}
.mo{position:relative;display:flex;flex-direction:column;gap:2px;border:1px solid var(--line2);border-radius:8px;padding:12px 14px;cursor:pointer;background:#fff;transition:border-color .15s,background .15s}
.mo input{position:absolute;opacity:0;pointer-events:none}.mo small{font-size:12px;color:var(--mute)}.mo b{font-size:15px;font-weight:600}
.mo:hover{border-color:var(--bd)}.mo:has(input:checked){border-color:var(--bd);background:var(--sel);box-shadow:inset 0 0 0 1px var(--bd)}.mo:has(input:focus-visible){outline:2px solid var(--bd);outline-offset:2px}
.calh{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:0 0 14px}.calh b{font-weight:600;font-size:15px}
.navb{display:flex;gap:6px}.ib{width:38px;height:38px;border:1px solid var(--line2);border-radius:8px;background:#fff;color:var(--ink);display:grid;place-items:center;cursor:pointer}.ib:hover:not(:disabled){border-color:var(--bd);color:var(--bd)}.ib:disabled{opacity:.35;cursor:default}.ib svg{width:16px;height:16px}
.src{display:flex;align-items:center;gap:8px;font-size:13px;color:var(--mute);margin:-6px 0 16px}.src i{width:7px;height:7px;border-radius:50%;background:#60BEB3;box-shadow:0 0 0 3px rgba(96,190,179,.2)}
.grid{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:10px}.col{display:flex;flex-direction:column;gap:7px;min-width:0}
.dh{padding:0 0 8px;border-bottom:1px solid var(--line);margin-bottom:4px}.dh small{display:block;font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:var(--mute)}.dh b{font-size:14px;font-weight:600}
.sl{height:40px;border:1px solid var(--line2);border-radius:8px;background:#fff;color:var(--ink);font:inherit;font-size:14px;font-weight:500;cursor:pointer;font-variant-numeric:tabular-nums;transition:border-color .15s,background .15s,color .15s}
@media (hover:hover){.sl:hover{border-color:var(--bd);color:var(--bd)}}.sl.on{background:var(--bd);border-color:var(--bd);color:#fff}.sl:focus-visible,.ib:focus-visible,.go:focus-visible,.lnk:focus-visible{outline:2px solid var(--bd);outline-offset:2px}
.na{font-size:12px;color:#9a9a9a;padding:10px 0}.ld{color:var(--mute);font-size:14px;padding:18px 0}
.chosen{display:flex;gap:12px;align-items:flex-start;margin-top:18px;padding:14px 16px;border-radius:8px;background:var(--sel);border:1px solid #CFE6E8;font-size:14px}.chosen[hidden]{display:none}.chosen svg{flex:none;width:20px;height:20px;color:var(--bd);margin-top:1px}.chosen span{color:var(--mute)}
.fr{display:grid;grid-template-columns:1fr 1fr;gap:16px}.f{margin-top:16px;min-width:0}.f label,.lab{display:block;font-weight:600;font-size:13px;margin-bottom:6px;color:var(--ink)}
.f select{width:100%;font:inherit;font-size:16px;padding:11px 36px 11px 12px;border:1px solid var(--line2);border-radius:8px;color:var(--ink);background:#fff url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='8' viewBox='0 0 12 8'%3E%3Cpath d='M1 1.5l5 5 5-5' fill='none' stroke='%23767676' stroke-width='1.6' stroke-linecap='round'/%3E%3C/svg%3E") no-repeat right 14px center;-webkit-appearance:none;appearance:none}.f select:focus{outline:2px solid var(--bd);outline-offset:0;border-color:var(--bd)}.f select:invalid,.f select.ph{color:var(--mute)}
.f input{width:100%;font:inherit;font-size:16px;padding:11px 12px;border:1px solid var(--line2);border-radius:8px;color:var(--ink);background:#fff}.f input:focus{outline:2px solid var(--bd);outline-offset:0;border-color:var(--bd)}
.padh{display:flex;justify-content:space-between;align-items:baseline}
.seg{display:inline-flex;border:1px solid var(--line2);border-radius:8px;padding:3px;gap:2px;margin:0 0 12px;background:#fff;flex-wrap:wrap}.seg button{border:0;background:none;font:inherit;font-size:13px;font-weight:500;color:var(--mute);padding:7px 12px;border-radius:6px;cursor:pointer}.seg button[aria-pressed=true]{background:var(--sel);color:var(--bd);box-shadow:inset 0 0 0 1px #CFE6E8}
.styles{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;margin-top:10px}.sty{border:1px solid var(--line2);border-radius:8px;background:#fff;padding:8px 10px;cursor:pointer;height:58px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;font-size:26px;color:#1F2A44;line-height:40px;text-align:left}.sty[aria-pressed=true]{border-color:var(--bd);box-shadow:inset 0 0 0 1px var(--bd);background:var(--sel)}
.upl{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-top:10px;font-size:13px;color:var(--mute)}.upl label{border:1px solid var(--line2);border-radius:8px;padding:8px 14px;color:var(--bd);font-weight:600;cursor:pointer;background:#fff}.upl input{position:absolute;opacity:0;width:1px;height:1px}
.sgt{width:100%;font:inherit;font-size:16px;padding:11px 12px;border:1px solid var(--line2);border-radius:8px;color:var(--ink);background:#fff;margin:0 0 10px}.sgt:focus{outline:2px solid var(--bd);outline-offset:0;border-color:var(--bd)}
.sigok{font-size:12px;color:var(--mute);margin-top:8px}.pad{position:relative;border:1px solid var(--line2);border-radius:8px;background:#FCFEFE;height:160px;touch-action:none}
.pad canvas{position:relative;z-index:1;width:100%;height:100%;display:block;cursor:crosshair}.pad .bl{position:absolute;left:24px;right:24px;bottom:40px;border-top:1px solid #C9D9DC}
.pad .bx{position:absolute;left:24px;bottom:46px;color:#9fb5b9;font-size:14px}.pad .ph{position:absolute;left:0;right:0;bottom:14px;text-align:center;color:#9a9a9a;font-size:12px}.pad .ph[hidden]{display:none}
.lnk{background:none;border:0;color:var(--bd);font:inherit;font-size:13px;cursor:pointer;padding:0;text-decoration:underline;text-underline-offset:2px}
.chk{display:flex;gap:10px;align-items:flex-start;margin-top:20px;font-size:14px}.chk input{margin-top:2px;width:18px;height:18px;accent-color:var(--bd);flex:none}.chk a{color:var(--bd)}
.go{display:flex;align-items:center;justify-content:center;gap:8px;width:100%;margin-top:20px;border:0;border-radius:8px;background:var(--bd);color:#fff;font:inherit;font-weight:600;font-size:16px;padding:15px;cursor:pointer;transition:background .15s,transform .1s}
.go:hover{background:var(--bdd)}.go:active{transform:scale(.99)}.go:disabled{opacity:.6;cursor:default}
.err{color:var(--err);font-size:14px;min-height:20px;margin-top:10px}.legal{color:var(--mute);font-size:12px;margin:10px 0 0;line-height:1.5}
.side{position:sticky;top:24px;border:1px solid var(--line);border-radius:12px;background:#fff;overflow:hidden}
.side .hd{padding:20px 22px 16px;border-bottom:1px solid var(--line);background:var(--soft)}.side .hd .sn{margin:0 0 4px}.side .hd b{font-size:16px;font-weight:600}
.side dl{margin:0;padding:6px 22px}.side .r{display:flex;justify-content:space-between;gap:12px;padding:10px 0;border-bottom:1px solid var(--line);font-size:14px}.side .r:last-child{border-bottom:0}.side dt{color:var(--mute)}.side dd{margin:0;text-align:right;font-weight:500;max-width:60%}
.price{padding:16px 22px;border-top:1px solid var(--line);border-bottom:1px solid var(--line);background:#fff}.price small{display:block;color:var(--mute);font-size:13px}.price b{display:block;font-size:26px;font-weight:600;letter-spacing:-.01em;margin:2px 0;font-variant-numeric:tabular-nums}.price span{color:var(--mute);font-size:13px}
.vars{display:flex;flex-direction:column;gap:8px;margin-top:12px}.vars label{display:flex;gap:10px;align-items:center;border:1px solid var(--line2);border-radius:8px;padding:9px 12px;cursor:pointer;font-size:13px}.vars label:has(input:checked){border-color:var(--bd);background:var(--sel)}.vars input{accent-color:var(--bd)}.vars em{font-style:normal;margin-left:auto;font-weight:600;white-space:nowrap}
.side .ft{padding:16px 22px 20px;font-size:13px}.side .ft a{color:var(--bd);font-weight:500}.cp{margin-top:14px;padding-top:14px;border-top:1px solid var(--line);line-height:1.5}.cp small{display:block;font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:var(--mute);margin-bottom:4px}.cp b{font-weight:600}
.done{border:1px solid var(--line);border-radius:12px;padding:36px 32px;background:#fff}.done .ic{width:52px;height:52px;border-radius:50%;border:1.5px solid var(--bd);color:var(--bd);display:grid;place-items:center;margin-bottom:18px}.done .ic svg{width:24px;height:24px}
.done h2{font-size:24px}.done p{color:var(--mute);margin:8px 0 0;max-width:60ch}.done dl{margin:22px 0 0;border-top:1px solid var(--line)}.done .r{display:grid;grid-template-columns:200px 1fr;gap:12px;padding:12px 0;border-bottom:1px solid var(--line);font-size:14px}.done dt{color:var(--mute)}.done dd{margin:0;font-weight:500}
.btn2{display:inline-flex;align-items:center;gap:8px;margin-top:22px;border:1px solid var(--line2);border-radius:8px;padding:11px 16px;color:var(--bd);font-weight:600;font-size:14px;text-decoration:none;background:#fff}.btn2:hover{border-color:var(--bd)}.btn2 svg{width:16px;height:16px}
footer{border-top:1px solid var(--line);color:var(--mute);font-size:12px}footer .in{max-width:1120px;margin:0 auto;padding:18px 24px;display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap}
@media (max-width:900px){.layout{grid-template-columns:1fr}.side{position:static;order:-1}}
@media (max-width:640px){.top .in{padding:14px 16px}.logo{height:42px}.meta{font-size:12px}.hero .in{padding:28px 16px 30px}h1{font-size:24px}.firm{font-size:18px}.wrap{padding:20px 12px 40px}.step{padding:20px 16px}.done{padding:26px 18px}
.grid{gap:5px}.col{gap:5px}.dh b{font-size:12px}.dh small{font-size:10px;letter-spacing:.06em}.sl{font-size:13px;height:42px;padding:0}.fr{grid-template-columns:1fr}.months{grid-template-columns:repeat(2,minmax(0,1fr))}.done .r{grid-template-columns:1fr;gap:2px}.side dl,.side .hd,.price,.side .ft{padding-left:16px;padding-right:16px}}`;
const WAVE = '<svg viewBox="0 0 560 220" preserveAspectRatio="xMaxYMax slice" aria-hidden="true"><path d="M560 220H70C150 200 210 150 300 120S470 90 560 40z" fill="#BEE2E9" fill-opacity=".55"/><path d="M560 220H230C300 205 360 170 430 150S520 130 560 100z" fill="#9AD3D3" fill-opacity=".45"/><path d="M560 220H380C430 210 480 196 520 186S550 180 560 176z" fill="#2BB6B7" fill-opacity=".25"/></svg>';
const ICO = { chk: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.2 4.2L19 7"/></svg>',
  cal: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><rect x="3.5" y="5" width="17" height="15" rx="2"/><path d="M3.5 10h17M8 3v4M16 3v4"/></svg>',
  dl: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v11M7 10.5l5 5 5-5M5 20h14"/></svg>',
  l: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5l-7 7 7 7"/></svg>',
  r: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 5l7 7-7 7"/></svg>' };
function top(s, en) {
  return `<div class="top"><div class="in"><img class="logo" src="/ordner/logo.png" alt="Clean Service Scaramuzzo AG"><div class="meta"><b>${en ? 'Offer' : 'Offerte'} ${esc(s.nr || '')}${s.rev ? ' · Rev. ' + s.rev : ''}</b>${en ? 'Maintenance cleaning' : esc(LS(s))}</div></div></div>`;
}
function hero(s, en) {
  return `<div class="hero">${WAVE}<div class="in"><p class="eb">${en ? 'Online order placement' : 'Online-Auftragserteilung'}</p><h1>${en ? 'Maintenance cleaning' : esc(LS(s))}</h1><p class="firm">${esc(s.firma || '')}</p><p class="addr">${esc([s.objekt, s.adresse].filter(Boolean).join(' · '))}</p></div></div>`;
}
const FOOT = '<footer><div class="in"><span>Clean Service Scaramuzzo AG · Industriestrasse 5 · 8307 Effretikon</span><span>0844 355 355 · clean-service.ch</span></div></footer>';
function msgPage(res, code, title, text) { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.setHeader('Cache-Control', 'no-store');
  res.status(code).send(shell(title, `<div class="top"><div class="in"><img class="logo" src="/ordner/logo.png" alt="Clean Service Scaramuzzo AG"></div></div><div class="wrap"><div class="done"><h2>${esc(title)}</h2><p>${text}</p></div></div>${FOOT}`, 'de')); }
function doneHtml(T, r, base, s) {
  return `<div class="done"><div class="ic">${ICO.chk}</div><h2>${T.okH}</h2><p>${T.okM}</p><dl>
    <div class="r"><dt>${T.start}</dt><dd>${esc(r.vbTxt || '–')}</dd></div><div class="r"><dt>${T.kick}</dt><dd>${esc(r.slotTxt)}</dd></div>
    <div class="r"><dt>${T.signed}</dt><dd>${esc(r.name)}${r.funktion ? ', ' + esc(r.funktion) : ''} · ${esc(r.atTxt)}</dd></div><div class="r"><dt>${T.ref}</dt><dd>${esc(r.ref)}</dd></div></dl>
    <a class="btn2" href="${base}/auftrag" target="_blank" rel="noopener">${ICO.dl}${T.okPdf}</a></div>`;
}

async function page(req, res) {
  const id = String(req.query.a || ''), nr = parseId(id);
  if (!nr) return msgPage(res, 404, 'Link ungültig', 'Dieser Link ist ungültig. Bitte verwenden Sie den Link in unserer E-Mail oder kontaktieren Sie uns unter 0844 355 355.');
  const f = String(req.query.f || '');
  if (f === 'auftrag' || f === 'offerte') {
    const a = await assetBytes(f === 'auftrag' ? 'ann-auf-' + nr : 'ann-pdf-' + nr); if (!a) return msgPage(res, 404, 'Dokument nicht gefunden', 'Das Dokument ist nicht vorhanden.');
    res.setHeader('Content-Type', 'application/pdf'); res.setHeader('Content-Disposition', `inline; filename="${f === 'auftrag' ? 'Auftragserteilung' : 'Offerte'}_${nr}.pdf"`); res.setHeader('Cache-Control', 'no-store'); return res.status(200).send(a.buf);
  }
  const s = await getJson('ann-' + nr); if (!s) return msgPage(res, 404, 'Offerte nicht gefunden', 'Diese Offerte ist nicht mehr verfügbar. Bitte kontaktieren Sie uns unter 0844 355 355.');
  const en = lg(s) === 'en', c = cfgOf(s), done = await getJson('ann-res-' + nr), base = '/a/' + id;
  const hasPdf = !!(await rpc('api_asset_get', { p_name: 'ann-pdf-' + nr }).then(r => r && r.length && r[0].ctype).catch(() => null));
  const rolleEn = c.calRolle === 'Objektleiter' ? 'property manager' : c.calRolle;
  const T = en ? {
    s: 'Step', of: 'of', start: 'Start date', startH: 'Desired start date', startL: 'Enter the day the maintenance cleaning should begin.', per: 'from', minL: 'Earliest possible start:',
    kick: 'Kick-off meeting', kickH: 'Choose a date for the kick-off meeting', kickL: `${c.dauer} minutes on site with our ${rolleEn} ${c.calName}. We go through the cleaning plan, access and contacts together.`,
    src: `Availability in real time from the calendar of ${c.calName}`, loading: 'Loading available times …', none: 'No times', prevW: 'Previous week', nextW: 'Next week', onsite: `On site with ${c.calName}, ${rolleEn}`,
    ordH: 'Place the order', ordL: `With your signature you award Clean Service Scaramuzzo AG the contract in accordance with offer ${nr}.`,
    name: 'First and last name', fn: 'Position', fnPick: 'Please select', fnOther: 'Other position', fnOtherPh: 'Please enter your position', eFn: 'Please select your position.', fnList: ['Managing Director', 'Owner', 'Member of the Executive Board', 'Board of Directors', 'Head of Facility Management', 'Head of Administration', 'Office Management', 'Practice Management', 'Property Management', 'Procurement'], mail: 'E-mail for confirmation and calendar invitation', sig: 'Signature', sigPh: 'Sign with your mouse or finger', clr: 'Clear', mTyp: 'Type signature', mDraw: 'Draw by hand', typPh: 'Type your first and last name', phTyp: 'Your signature appears here', sigNote: 'Your signature is stored with date, time and reference in the order confirmation.',
    agb: `I have read offer ${nr} including the conditions stated therein and accept them.`, go: 'Place binding order', wait: 'Transmitting …',
    legal: 'You will immediately receive a confirmation with the signed order confirmation (PDF) and the calendar invitation by e-mail. Your details are used exclusively for processing the order.',
    yo: 'Your offer', client: 'Client', obj: 'Property', clean: 'Cleaning', scope: 'Scope', scopeV: 'as per specification', mon: 'Monthly flat rate', excl: 'excl. VAT, invoiced monthly', var: 'Price option',
    pdf: 'View offer (PDF)', cp: 'Your contact', okH: 'Thank you for your order', okM: 'Your order has been placed successfully. The confirmation and the calendar invitation are on their way to your inbox.', signed: 'Signed by', ref: 'Reference', okPdf: 'Download order confirmation (PDF)',
    gone: 'The selected time has just been taken. Please choose another one.', pick: 'Please choose a date for the kick-off meeting.', pickM: 'Please enter a valid start date (at least 10 days from today).', eName: 'Please enter your first and last name.', eMail: 'Please enter a valid e-mail address.', eSig: 'Please sign in the signature field.', eAgb: 'Please confirm that you accept the offer.', eb: 'Accept offer'
  } : {
    s: 'Schritt', of: 'von', start: 'Vertragsbeginn', startH: 'Gewünschter Starttermin', startL: 'Geben Sie den Tag ein, an dem die Unterhaltsreinigung beginnen soll.', per: 'ab', minL: 'Frühestmöglicher Start:',
    kick: 'Startbesprechung', kickH: 'Termin für die Startbesprechung', kickL: `${c.dauer === 60 ? '1 Stunde' : c.dauer + ' Minuten'} vor Ort mit unserem ${c.calRolle} ${c.calName}. Wir besprechen gemeinsam Reinigungsplan, Zutritt und Ansprechpersonen.`,
    src: `Verfügbarkeit in Echtzeit aus dem Kalender von ${c.calName}`, loading: 'Freie Termine werden geladen …', none: 'Keine Termine', prevW: 'Vorherige Woche', nextW: 'Nächste Woche', onsite: `Vor Ort mit ${c.calName}, ${c.calRolle}`,
    ordH: 'Auftrag erteilen', ordL: `Mit Ihrer Unterschrift erteilen Sie der Clean Service Scaramuzzo AG den Auftrag gemäss Offerte ${nr}.`,
    name: 'Vorname und Name', fn: 'Funktion', fnPick: 'Bitte wählen', fnOther: 'Andere Funktion', fnOtherPh: 'Bitte Funktion angeben', eFn: 'Bitte wählen Sie Ihre Funktion.', fnList: ['Geschäftsführung', 'Inhaber/in', 'Mitglied der Geschäftsleitung', 'Verwaltungsrat', 'Leitung Facility Management', 'Leitung Administration', 'Office Management', 'Praxisleitung', 'Liegenschaftsverwaltung', 'Einkauf / Beschaffung'], mail: 'E-Mail für Bestätigung und Kalendereinladung', sig: 'Unterschrift', sigPh: 'Mit Maus oder Finger unterschreiben', clr: 'Zurücksetzen', mTyp: 'Unterschrift eintippen', mDraw: 'Von Hand zeichnen', typPh: 'Vor- und Nachname eintippen', phTyp: 'Hier erscheint Ihre Unterschrift', sigNote: 'Ihre Unterschrift wird mit Datum, Uhrzeit und Referenz in der Auftragserteilung festgehalten.',
    agb: `Ich habe die Offerte ${nr} mit den darin aufgeführten Konditionen gelesen und akzeptiere sie.`, go: 'Auftrag verbindlich erteilen', wait: 'Wird übermittelt …',
    legal: 'Sie erhalten umgehend eine Bestätigung mit der unterzeichneten Auftragserteilung (PDF) sowie die Kalendereinladung per E-Mail. Ihre Angaben werden ausschliesslich zur Auftragsabwicklung verwendet.',
    yo: 'Ihre Offerte', client: 'Auftraggeber', obj: 'Objekt', clean: 'Reinigung', scope: 'Leistungsumfang', scopeV: 'gemäss Leistungsverzeichnis', mon: 'Monatlicher Pauschalbetrag', excl: 'exkl. MwSt., monatliche Verrechnung', var: 'Preisvariante',
    pdf: 'Offerte ansehen (PDF)', cp: 'Ihr Ansprechpartner', okH: 'Vielen Dank für Ihren Auftrag', okM: 'Ihr Auftrag wurde erfolgreich erteilt. Die Bestätigung und die Kalendereinladung sind unterwegs in Ihr Postfach.', signed: 'Unterzeichnet von', ref: 'Referenz', okPdf: 'Auftragserteilung herunterladen (PDF)',
    gone: 'Der gewählte Termin wurde soeben vergeben. Bitte wählen Sie einen anderen.', pick: 'Bitte wählen Sie einen Termin für die Startbesprechung.', pickM: 'Bitte geben Sie ein gültiges Startdatum ein (frühestens 10 Tage ab heute).', eName: 'Bitte geben Sie Vor- und Nachname an.', eMail: 'Bitte geben Sie eine gültige E-Mail-Adresse an.', eSig: 'Bitte unterschreiben Sie im Unterschriftsfeld.', eAgb: 'Bitte bestätigen Sie, dass Sie die Offerte akzeptieren.', eb: 'Offerte annehmen'
  };
  const NC = noCal(s), ADM = isAdm(s);
  if (ADM) Object.assign(T, en ? { kick: 'On-site meeting', mail: 'E-mail for the confirmation', okM: 'Your order has been placed successfully. Your cleaning contract is on its way to your inbox. Our administration will contact you to arrange an on-site meeting.', okPdf: 'Download cleaning contract (PDF)', legal: 'You will receive your cleaning contract (PDF) by e-mail immediately. Your details are used solely to process the order.', sigNote: 'Your signature is recorded in the cleaning contract with date, time and reference.' }
    : { kick: 'Besprechungstermin', mail: 'E-Mail für die Bestätigung', okM: 'Ihr Auftrag wurde erfolgreich erteilt. Ihr Reinigungsvertrag ist unterwegs in Ihr Postfach. Unsere Administration meldet sich für einen Besprechungstermin vor Ort bei Ihnen.', okPdf: 'Reinigungsvertrag herunterladen (PDF)', legal: 'Sie erhalten umgehend Ihren Reinigungsvertrag (PDF) per E-Mail: die Offerte mit allen Beilagen und die unterzeichnete Vertragsseite. Ihre Angaben werden ausschliesslich zur Auftragsabwicklung verwendet.', sigNote: 'Ihre Unterschrift wird mit Datum, Uhrzeit und Referenz im Reinigungsvertrag festgehalten.' });
  if (isHotel(s) && !en) Object.assign(T, { startL: 'Geben Sie den Tag ein, an dem der ' + LS(s) + ' beginnen soll.', kickL: NC ? `Unser ${c.calRolle} ${c.calName} meldet sich nach Ihrer Auftragserteilung telefonisch, um die Startbesprechung vor Ort zu vereinbaren. Wir besprechen Abläufe, Zutritt, Wäsche und Ansprechpersonen.` : `${c.dauer === 60 ? '1 Stunde' : c.dauer + ' Minuten'} vor Ort mit unserem ${c.calRolle} ${c.calName}. Wir besprechen Abläufe, Zutritt, Wäsche und Ansprechpersonen.`, mon: 'Preise', excl: 'pro Einsatz, exkl. MwSt., monatliche Verrechnung nach Einsätzen', scopeV: 'gemäss Offerte und Leistungsverzeichnis' }, NC ? { mail: 'E-Mail für die Bestätigung', legal: 'Sie erhalten umgehend eine Bestätigung mit der unterzeichneten Auftragserteilung (PDF) per E-Mail. Ihre Angaben werden ausschliesslich zur Auftragsabwicklung verwendet.', okM: 'Ihr Auftrag wurde erfolgreich erteilt. Die Bestätigung ist unterwegs in Ihr Postfach, unser Objektleiter meldet sich für die Startbesprechung.' } : {});
  res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.setHeader('Cache-Control', 'no-store');
  const vars = Array.isArray(s.vars) && s.vars.length > 1 ? s.vars : [];
  const vRec = vars.length ? Math.max(0, vars.findIndex(v => v.rec)) : -1;
  const kp = s.kp || {};
  const side = `<aside class="side"><div class="hd"><p class="sn">${T.yo}</p><b>${en ? 'Offer' : 'Offerte'} ${esc(nr)}${s.rev ? ' · Rev. ' + s.rev : ''}</b></div>
    <dl><div class="r"><dt>${T.client}</dt><dd>${esc(s.firma || '–')}</dd></div><div class="r"><dt>${T.obj}</dt><dd>${esc(s.objekt || s.adresse || '–')}</dd></div><div class="r"><dt>${T.clean}</dt><dd>${esc([s.reinigung2, s.reinigung1].filter(Boolean).join(', ') || '–')}</dd></div><div class="r"><dt>${T.scope}</dt><dd>${T.scopeV}</dd></div></dl>
    <div class="price"><small>${T.mon}</small><b id="betrag">${isHotel(s) ? esc(s.preisKurz || 'gemäss Offerte') : 'CHF ' + chfTxt(vars.length ? vars[vRec].m : s.monthly)}</b><span>${T.excl}</span>
    ${vars.length ? `<div class="vars" role="radiogroup" aria-label="${T.var}">${vars.map((v, i) => `<label><input type="radio" name="v" value="${i}" ${i === vRec ? 'checked' : ''}><span>${esc(v.n)}</span><em>CHF ${chfTxt(v.m)}</em></label>`).join('')}</div>` : ''}</div>
    <div class="ft">${hasPdf ? `<a href="${base}/offerte" target="_blank" rel="noopener">${T.pdf}</a>` : ''}${kp.name ? `<div class="cp"><small>${T.cp}</small><b>${esc(kp.name)}</b>${kp.rolle ? '<br>' + esc(kp.rolle) : ''}${kp.kontakt ? '<br>' + esc(kp.kontakt) : ''}</div>` : `<div class="cp"><small>${T.cp}</small><b>Clean Service Scaramuzzo AG</b><br>0844 355 355</div>`}</div></aside>`;
  if (done) return res.status(200).send(shell(T.eb, top(s, en) + hero(s, en) + `<div class="wrap"><div class="layout"><div class="steps">${doneHtml(T, done, base, s)}</div>${side}</div></div>` + FOOT, en ? 'en' : 'de'));
  const off = !MS_ON() && !NC, rng = startRange();
  const NS = ADM ? 2 : 3;
  const st1 = `<section class="step" aria-labelledby="h1s"><p class="sn">${T.s} 1 ${T.of} ${NS}</p><h2 id="h1s">${T.startH}</h2><p class="lead">${T.startL}</p>
    <div class="f" style="margin-top:0;max-width:260px"><label for="vbd">${T.start}</label><input type="date" id="vbd" name="vbd" required min="${rng.min}" max="${rng.max}" lang="${en ? 'en-GB' : 'de-CH'}"><span style="display:block;font-size:12.5px;color:var(--mute);margin-top:6px">${T.minL} ${(() => { const [y, m, d] = rng.min.split('-'); return d + '.' + m + '.' + y; })()}</span></div><div class="err" id="e0"></div></section>`;
  const st2 = ADM ? '' : `<section class="step" aria-labelledby="h2s"><p class="sn">${T.s} 2 ${T.of} 3</p><h2 id="h2s">${T.kickH}</h2><p class="lead">${esc(T.kickL)}</p>
    ${NC ? `<div class="chosen">${ICO.cal}<div><b>${esc(c.calName)}, ${esc(c.calRolle)}</b><br><span>meldet sich nach der Auftragserteilung telefonisch bei Ihnen</span></div></div><div class="err" id="e1"></div></section>` : `<div class="src"><i></i>${esc(T.src)}</div>
    <div class="calh"><b id="rg">${T.loading}</b><div class="navb"><button class="ib" id="pw" type="button" disabled aria-label="${T.prevW}">${ICO.l}</button><button class="ib" id="nw" type="button" disabled aria-label="${T.nextW}">${ICO.r}</button></div></div>
    <div class="grid" id="grid" aria-live="polite"></div><div class="chosen" id="ch" hidden></div><div class="err" id="e1"></div></section>`}`;
  const st3 = `<section class="step" aria-labelledby="h3s"><p class="sn">${T.s} ${NS} ${T.of} ${NS}</p><h2 id="h3s">${T.ordH}</h2><p class="lead">${esc(T.ordL)}</p>
    <div class="fr"><div class="f" style="margin-top:0"><label for="nm">${T.name}</label><input id="nm" autocomplete="name" value="${esc(s.kontakt || '')}"></div><div class="f" style="margin-top:0"><label for="fns">${T.fn}</label><select id="fns"><option value="">${T.fnPick}</option>${T.fnList.map(x => `<option>${esc(x)}</option>`).join('')}<option value="__x">${T.fnOther}</option></select><input id="fn" autocomplete="organization-title" placeholder="${T.fnOtherPh}" hidden style="margin-top:8px"></div></div>
    <div class="f"><label for="em">${T.mail}</label><input id="em" type="email" autocomplete="email" value="${esc(s.email || '')}"></div>
    <div class="f"><div class="padh"><span class="lab">${T.sig}</span><button class="lnk" type="button" id="sgc">${T.clr}</button></div>
    <div class="seg" role="group" aria-label="${T.sig}"><button type="button" data-m="typ" aria-pressed="true">${T.mTyp}</button><button type="button" data-m="draw" aria-pressed="false">${T.mDraw}</button></div>
    <div id="mTyp"><input id="sgt" class="sgt" autocomplete="off" spellcheck="false" placeholder="${T.typPh}" aria-label="${T.typPh}"></div>
    <div class="pad"><div class="bl"></div><span class="bx">×</span><canvas id="sg" aria-label="${T.sig}"></canvas><span class="ph" id="sgh">${T.phTyp}</span></div>
    <div id="mSty"><div class="styles" id="sty"></div></div>
    <p class="sigok">${T.sigNote}</p></div>
    <label class="chk"><input type="checkbox" id="agb"><span>${esc(T.agb)}</span></label>
    <button class="go" id="go" type="button">${T.go}</button><div class="err" id="e2" role="alert"></div><p class="legal">${T.legal}</p></section>`;
  const offTxt = en ? 'Online order placement is currently unavailable. Please contact us on 0844 355 355 or reply to our e-mail.' : 'Die Online-Auftragserteilung ist momentan nicht verfügbar. Bitte kontaktieren Sie uns unter 0844 355 355 oder antworten Sie auf unsere E-Mail.';
  const body = top(s, en) + hero(s, en) + `<div class="wrap"><div class="layout"><div class="steps" id="main">${off ? `<div class="done"><p style="margin:0;color:var(--ink)">${offTxt}</p></div>` : st1 + st2 + st3}</div>${side}</div></div>` + FOOT
    + (off ? '' : `<script>const NOCAL=${NC ? 'true' : 'false'},ID=${JSON.stringify(id)},T=${JSON.stringify(T)},VARS=${JSON.stringify(vars.map(v => v.m))},BASE=${JSON.stringify(base)},DAUER=${c.dauer},LANG=${JSON.stringify(en ? 'en' : 'de')},ICO=${JSON.stringify(ICO)};${CLIENT}</script>`);
  res.status(200).send(shell(T.eb + ' ' + nr, body, en ? 'en' : 'de'));
}
/* Skript der Kundenseite */
const CLIENT = `
const $=s=>document.querySelector(s);let W=null,SEL=null,busy=false;const E=s=>String(s==null?'':s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const chf=n=>(Math.round((+n||0)*20)/20).toFixed(2).replace(/\\B(?=(\\d{3})+(?!\\d))/g,"'");
const MO=LANG==='en'?['January','February','March','April','May','June','July','August','September','October','November','December']:['Januar','Februar','März','April','Mai','Juni','Juli','August','September','Oktober','November','Dezember'];
const TG=LANG==='en'?['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday']:['Sonntag','Montag','Dienstag','Mittwoch','Donnerstag','Freitag','Samstag'];
async function api(b){const r=await fetch('/api/ordner',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(Object.assign({id:ID},b))});const j=await r.json().catch(()=>({}));return {ok:r.ok,status:r.status,j};}
const TXT=(d,t)=>{const x=new Date(d+'T12:00:00Z'),[h,m]=t.split(':').map(Number),e=h*60+m+DAUER,en=String(Math.floor(e/60)).padStart(2,'0')+':'+String(e%60).padStart(2,'0');return LANG==='en'?TG[x.getUTCDay()]+', '+x.getUTCDate()+' '+MO[x.getUTCMonth()]+' '+x.getUTCFullYear()+', '+t+'–'+en:TG[x.getUTCDay()]+', '+x.getUTCDate()+'. '+MO[x.getUTCMonth()]+' '+x.getUTCFullYear()+', '+t+'–'+en+' Uhr';};
function draw(){if(!W)return;$('#rg').textContent=W.range;$('#pw').disabled=!W.prev;$('#nw').disabled=!W.next;
 if(SEL){const d=W.days.find(x=>x.d===SEL.d);if(d){const s=d.slots.find(x=>x.t===SEL.t);if(!s||!s.free){SEL=null;$('#e1').textContent=T.gone;}}}
 $('#grid').innerHTML=W.days.map(d=>{const fr=d.open?d.slots.filter(s=>s.free):[];return '<div class="col"><div class="dh"><small>'+d.lab+'</small><b>'+d.dm+'</b></div>'+(fr.length?fr.map(s=>{const on=SEL&&SEL.d===d.d&&SEL.t===s.t;return '<button type="button" class="sl'+(on?' on':'')+'" data-d="'+d.d+'" data-t="'+s.t+'" aria-pressed="'+on+'">'+s.t+'</button>';}).join(''):'<div class="na">'+T.none+'</div>')+'</div>';}).join('');
 const ch=$('#ch');if(SEL){ch.hidden=false;ch.innerHTML=ICO.cal+'<div><b>'+SEL.txt+'</b><br><span>'+T.onsite+'</span></div>';}else ch.hidden=true;}
async function load(w){const r=await api({an:'slots',w:w||(W&&W.monday)});if(!r.ok){$('#e1').textContent=r.j.error||'Fehler';if(r.status===409)location.reload();return;}W=r.j;if(!SEL)$('#e1').textContent='';draw();}
const shift=n=>{const d=new Date(W.monday+'T12:00:00Z');d.setUTCDate(d.getUTCDate()+n);load(d.toISOString().slice(0,10));};
if(!NOCAL){$('#pw').onclick=()=>shift(-7);$('#nw').onclick=()=>shift(7);}
if(!NOCAL)$('#grid').addEventListener('click',e=>{const b=e.target.closest('button.sl');if(!b)return;SEL={d:b.dataset.d,t:b.dataset.t,txt:TXT(b.dataset.d,b.dataset.t)};$('#e1').textContent='';draw();});
document.querySelectorAll('input[name=v]').forEach(r=>r.addEventListener('change',()=>{$('#betrag').textContent='CHF '+chf(VARS[+r.value]);}));
const VBD=$('#vbd');if(VBD)VBD.addEventListener('change',()=>{$('#e0').textContent='';});
const cv=$('#sg'),cx=cv.getContext('2d');let pts=0,down=false,ST=[],MODE='typ',FONT=0;
const FONTS=['Mrs Saint Delafield','Allura','Herr Von Muellerhoff'];
const nmv=()=>{const x=$('#sgt');return x?x.value.trim():'';};
function W_(){return cv.getBoundingClientRect();}
function paint(){const r=W_();cx.clearRect(0,0,r.width,r.height);
 if(MODE==='typ'){const n=nmv();$('#sgh').hidden=!!n;if(!n)return;let fs=Math.min(64,r.height*.5);cx.font=fs+'px "'+FONTS[FONT]+'"';while(cx.measureText(n).width>r.width-70&&fs>20){fs-=2;cx.font=fs+'px "'+FONTS[FONT]+'"';}cx.textBaseline='alphabetic';cx.fillText(n,40,r.height-46);return;}

 $('#sgh').hidden=ST.length>0;ST.forEach(l=>{if(l.length<2){if(l.length){cx.beginPath();cx.arc(l[0][0],l[0][1],1.1,0,7);cx.fill();}return;}cx.beginPath();cx.moveTo(l[0][0],l[0][1]);for(let i=1;i<l.length-1;i++){const mx=(l[i][0]+l[i+1][0])/2,my=(l[i][1]+l[i+1][1])/2;cx.quadraticCurveTo(l[i][0],l[i][1],mx,my);}const z=l[l.length-1];cx.lineTo(z[0],z[1]);cx.stroke();});}
function fit(){if(!document.body.contains(cv))return;const r=W_(),k=window.devicePixelRatio||1;cv.width=r.width*k;cv.height=r.height*k;cx.setTransform(k,0,0,k,0,0);cx.lineWidth=1.8;cx.lineCap='round';cx.lineJoin='round';cx.strokeStyle=cx.fillStyle='#1F2A44';paint();}
fit();window.addEventListener('resize',fit);
function styles(){const n=nmv()||(LANG==='en'?'Your name':'Ihr Name');$('#sty').innerHTML=FONTS.map((f,i)=>'<button type="button" class="sty" data-f="'+i+'" aria-pressed="'+(i===FONT)+'" style="font-family:&quot;'+f+'&quot;,cursive">'+E(n)+'</button>').join('');}
styles();if(document.fonts){FONTS.forEach(f=>document.fonts.load('48px "'+f+'"'));document.fonts.ready.then(()=>{styles();paint();});}
$('#sty').addEventListener('click',e=>{const b=e.target.closest('.sty');if(!b)return;FONT=+b.dataset.f;styles();paint();});
const fsel=$('#fns');const fsy=()=>{fsel.classList.toggle('ph',!fsel.value);$('#fn').hidden=fsel.value!=='__x';if(fsel.value==='__x')$('#fn').focus();};fsel.addEventListener('change',fsy);fsy();
$('#sgt').addEventListener('input',()=>{styles();if(MODE==='typ')paint();});
const PH={typ:T.phTyp,draw:T.sigPh};
function setMode(m){MODE=m;document.querySelectorAll('.seg button').forEach(b=>b.setAttribute('aria-pressed',b.dataset.m===m));$('#mTyp').hidden=m!=='typ';$('#mSty').hidden=m!=='typ';$('#sgh').textContent=PH[m];cv.style.cursor=m==='draw'?'crosshair':'default';paint();}
document.querySelectorAll('.seg button').forEach(b=>b.onclick=()=>setMode(b.dataset.m));
const P=e=>{const r=W_();return [e.clientX-r.left,e.clientY-r.top];};
cv.addEventListener('pointerdown',e=>{if(MODE!=='draw')return;down=true;ST.push([P(e)]);cv.setPointerCapture(e.pointerId);$('#sgh').hidden=true;e.preventDefault();});
cv.addEventListener('pointermove',e=>{if(!down)return;ST[ST.length-1].push(P(e));pts++;paint();});
['pointerup','pointercancel'].forEach(t=>cv.addEventListener(t,()=>{down=false;}));
$('#sgc').onclick=()=>{ST=[];pts=0;$('#sgt').value='';styles();paint();};
const sigReady=()=>MODE==='typ'?nmv().length>=3:pts>=8;
function sigData(){paint();const k=cv.width/W_().width,d=cx.getImageData(0,0,cv.width,cv.height).data;let x0=cv.width,y0=cv.height,x1=-1,y1=-1;for(let y=0;y<cv.height;y+=2)for(let x=0;x<cv.width;x+=2){if(d[(y*cv.width+x)*4+3]>20){if(x<x0)x0=x;if(x>x1)x1=x;if(y<y0)y0=y;if(y>y1)y1=y;}}
 if(x1<0){x0=0;y0=0;x1=cv.width-1;y1=cv.height-1;}const pad=12*k;x0=Math.max(0,x0-pad);y0=Math.max(0,y0-pad);x1=Math.min(cv.width,x1+pad);y1=Math.min(cv.height,y1+pad);const sw=x1-x0,sh=y1-y0,sc=Math.min(1,600/sw);
 const o=document.createElement('canvas');o.width=Math.round(sw*sc);o.height=Math.round(sh*sc);const c=o.getContext('2d');c.fillStyle='#fff';c.fillRect(0,0,o.width,o.height);c.drawImage(cv,x0,y0,sw,sh,0,0,o.width,o.height);return o.toDataURL('image/png');}
const bad=(id,msg,el)=>{$(id).textContent=msg;(el||$(id)).scrollIntoView({behavior:'smooth',block:'center'});};
$('#go').onclick=async()=>{if(busy)return;['#e0','#e1','#e2'].forEach(x=>{const el=$(x);if(el)el.textContent='';});
 const vb={value:($('#vbd')&&$('#vbd').value)||''};if(!/^\\d{4}-\\d\\d-\\d\\d$/.test(vb.value)||vb.value<$('#vbd').min||vb.value>$('#vbd').max)return bad('#e0',T.pickM,$('#vbd'));
 if(!NOCAL&&!SEL)return bad('#e1',T.pick,$('#grid'));
 const fs_=$('#fns').value,name=$('#nm').value.trim(),fn=fs_==='__x'?$('#fn').value.trim():fs_,em=$('#em').value.trim();
 if(name.length<3){$('#nm').focus();return void($('#e2').textContent=T.eName);}
 if(!fn){(fs_==='__x'?$('#fn'):$('#fns')).focus();return void($('#e2').textContent=T.eFn);}
 if(!/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(em)){$('#em').focus();return void($('#e2').textContent=T.eMail);}
 if(!sigReady())return void($('#e2').textContent=T.eSig);
 if(!$('#agb').checked)return void($('#e2').textContent=T.eAgb);
 const v=document.querySelector('input[name=v]:checked');busy=true;const g=$('#go');g.disabled=true;g.textContent=T.wait;
 const r=await api({an:'book',vb:vb.value,d:SEL?SEL.d:'',t:SEL?SEL.t:'',name,funktion:fn,email:em,sig:sigData(),sigArt:MODE,agb:true,v:v?+v.value:undefined});
 busy=false;g.disabled=false;g.textContent=T.go;
 if(!r.ok){$('#e2').textContent=r.j.error||'Fehler';if(r.j.taken){SEL=null;load();bad('#e1',T.gone,$('#grid'));}if(r.status===409&&!r.j.taken)setTimeout(()=>location.reload(),1500);return;}
 const x=r.j;$('#main').innerHTML='<div class="done"><div class="ic">'+ICO.chk+'</div><h2>'+T.okH+'</h2><p>'+T.okM+'</p><dl><div class="r"><dt>'+T.start+'</dt><dd>'+E(x.vbTxt)+'</dd></div><div class="r"><dt>'+T.kick+'</dt><dd>'+E(x.slotTxt)+'</dd></div><div class="r"><dt>'+T.signed+'</dt><dd>'+E(x.name)+'</dd></div><div class="r"><dt>'+T.ref+'</dt><dd>'+E(x.ref)+'</dd></div></dl><a class="btn2" href="'+BASE+'/auftrag" target="_blank" rel="noopener">'+ICO.dl+T.okPdf+'</a></div>';
 document.querySelectorAll('.vars input').forEach(i=>i.disabled=true);window.scrollTo({top:0,behavior:'smooth'});};
if(!NOCAL){load();setInterval(()=>{if(!document.hidden&&!busy&&W)load(W.monday);},45000);}
`;
module.exports = { pub, priv, page, urlOf, idOf, parseId };
