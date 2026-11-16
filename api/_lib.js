const crypto = require('crypto');
const E = process.env;
const SB = () => E.SUPABASE_URL + '/rest/v1/rpc/';
async function rpc(fn, args) {
  const r = await fetch(SB() + fn, { method: 'POST', headers: { apikey: E.SUPABASE_ANON_KEY, Authorization: 'Bearer ' + E.SUPABASE_ANON_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ p_secret: E.DB_SECRET, ...args }) });
  const t = await r.text();
  if (!r.ok) throw new Error('db ' + fn + ' ' + r.status + ' ' + t.slice(0, 200));
  return t ? JSON.parse(t) : null;
}
const b64u = b => Buffer.from(b).toString('base64url');
const sign = s => crypto.createHmac('sha256', E.SESSION_SECRET).update(s).digest('base64url');
function makeToken(days = 30) { const p = b64u(JSON.stringify({ exp: Date.now() + days * 864e5 })); return { token: p + '.' + sign(p), exp: Date.now() + days * 864e5 }; }
function okToken(tok) {
  if (!tok || !tok.includes('.')) return false; const [p, s] = tok.split('.');
  const a = Buffer.from(sign(p)), b = Buffer.from(s || ''); if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  try { return JSON.parse(Buffer.from(p, 'base64url').toString()).exp > Date.now(); } catch (e) { return false; }
}
const bearer = req => (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
function guard(req, res) { if (okToken(bearer(req))) return true; res.status(401).json({ error: 'Nicht angemeldet' }); return false; }
async function body(req) { if (req.body && typeof req.body === 'object') return req.body; try { return JSON.parse(req.body || '{}'); } catch (e) { return {}; } }
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
async function settings() { const d = await rpc('api_docs_since', { p_since: '1970-01-01T00:00:00Z' }); const x = d.find(r => r.path === 'config/settings' && !r.deleted); return x ? x.data : {}; }
/* Signatur fest im Code (nicht aus den Einstellungen), damit ein altes offenes Browserfenster sie nicht mehr überschreiben kann.
   Unterhaltsreinigung: Mail unterhalt@, Hotelservice (Absender hotelservice@): Mail hotelservice@ */
const SIG = { name: 'Sebastian Hidegh', rolle: 'Sachbearbeiter Innendienst', rolleEn: 'Office Administration', direkt: '052 557 02 03' };
const sigMail = from => /hotelservice@/i.test(String(from || '')) ? 'hotelservice@clean-service.ch' : 'unterhalt@clean-service.ch';
function sigHtml(S, iso, lang, from) {
  const en = lang === 'en';
  return `<div style="font-family:Verdana,Arial,sans-serif;font-size:14px;line-height:1.5;color:#555;margin-top:22px"><div style="color:#4fb3a5">${esc(SIG.name)}</div>${esc(en ? SIG.rolleEn : SIG.rolle)}<br>${en ? 'Direct' : 'Direkt'} ${esc(SIG.direkt)}<br>${esc(sigMail(from))}<br>---------------------------------<br><div style="color:#4fb3a5">Clean Service Scaramuzzo AG</div>Industriestrasse 5<br>8307 Effretikon<br>0844 355 355<div style="margin-top:14px"><img src="${iso}" alt="ISO 9001, 14001, 45001" width="172" height="52" style="display:block;border:0"></div></div>`;
}
function sigText(S, lang, from) { const en = lang === 'en'; return `\n\n${SIG.name}\n${en ? SIG.rolleEn : SIG.rolle}\n${en ? 'Direct' : 'Direkt'} ${SIG.direkt}\n${sigMail(from)}\n\nClean Service Scaramuzzo AG\nIndustriestrasse 5\n8307 Effretikon\n0844 355 355`; }

/* ---------- Versand über Microsoft 365 (Graph): Mails gehen über das echte Postfach (gleiche Server wie Outlook) ---------- */
const MS_ON = () => !!(E.MS_TENANT_ID && E.MS_CLIENT_ID && E.MS_CLIENT_SECRET);
let msTok = null;
const MS_G = () => (E.MS_GRAPH_URL || 'https://graph.microsoft.com') + '/v1.0';
async function msToken() {
  if (msTok && msTok.exp > Date.now() + 60000) return msTok.t;
  const r = await fetch((E.MS_LOGIN_URL || 'https://login.microsoftonline.com') + '/' + encodeURIComponent(E.MS_TENANT_ID) + '/oauth2/v2.0/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: E.MS_CLIENT_ID, client_secret: E.MS_CLIENT_SECRET, scope: 'https://graph.microsoft.com/.default', grant_type: 'client_credentials' }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error('Microsoft-Anmeldung fehlgeschlagen: ' + (j.error_description || j.error || r.status));
  msTok = { t: j.access_token, exp: Date.now() + (j.expires_in || 3000) * 1000 }; return msTok.t;
}
const addrOf = s => { const m = /<([^>]+)>/.exec(String(s || '')); return (m ? m[1] : String(s || '')).trim(); };
async function msSend({ from, to, bcc, replyTo, subject, html, attachments }) {
  const tok = await msToken(), G = MS_G() + '/users/' + encodeURIComponent(addrOf(from));
  const H = { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' };
  const rec = a => ({ emailAddress: { address: a } });
  const small = [], big = [];
  (attachments || []).forEach(a => { const size = Math.floor(String(a.content).length * 3 / 4); (size > 2500000 ? big : small).push(Object.assign({}, a, { size })); });
  const fa = a => ({ '@odata.type': '#microsoft.graph.fileAttachment', name: a.filename, contentType: a.content_type || (/\.pdf$/i.test(a.filename) ? 'application/pdf' : 'application/octet-stream'), contentBytes: a.content, isInline: !!a.content_id, contentId: a.content_id || undefined });
  const msg = { subject, body: { contentType: 'HTML', content: html }, toRecipients: to.map(rec), bccRecipients: (bcc || []).map(rec), replyTo: replyTo ? [rec(addrOf(replyTo))] : [], attachments: small.map(fa) };
  if (!big.length) {
    const r = await fetch(G + '/sendMail', { method: 'POST', headers: H, body: JSON.stringify({ message: msg, saveToSentItems: true }) });
    if (!r.ok) throw new Error('Microsoft-Versand: ' + r.status + ' ' + (await r.text()).slice(0, 200));
    return 'ms-' + Date.now();
  }
  /* grosse Anhänge: Entwurf anlegen, Datei in Teilen hochladen, dann senden */
  const d = await fetch(G + '/messages', { method: 'POST', headers: H, body: JSON.stringify(msg) }); const dj = await d.json().catch(() => ({}));
  if (!d.ok || !dj.id) throw new Error('Microsoft-Entwurf: ' + d.status + ' ' + JSON.stringify(dj).slice(0, 200));
  for (const a of big) {
    const u = await fetch(G + '/messages/' + dj.id + '/attachments/createUploadSession', { method: 'POST', headers: H, body: JSON.stringify({ AttachmentItem: { attachmentType: 'file', name: a.filename, size: a.size, contentType: 'application/pdf' } }) });
    const uj = await u.json().catch(() => ({})); if (!u.ok || !uj.uploadUrl) throw new Error('Microsoft-Upload: ' + u.status);
    const buf = Buffer.from(a.content, 'base64'), CH = 3 * 1024 * 1024;
    for (let i = 0; i < buf.length; i += CH) { const part = buf.subarray(i, Math.min(i + CH, buf.length));
      const pr = await fetch(uj.uploadUrl, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(part.length), 'Content-Range': `bytes ${i}-${i + part.length - 1}/${buf.length}` }, body: part });
      if (!pr.ok) throw new Error('Microsoft-Upload Teil: ' + pr.status); }
  }
  const sr = await fetch(G + '/messages/' + dj.id + '/send', { method: 'POST', headers: H });
  if (!sr.ok) throw new Error('Microsoft-Senden: ' + sr.status + ' ' + (await sr.text()).slice(0, 200));
  return 'ms-' + dj.id.slice(-12);
}
async function sendMail({ to, subject, text, attachments, kind, objectId, S, lang, nocopy, replyTo, copyTo, from }) {
  const FROM = from || E.MAIL_FROM;   /* Hotelservice: Absender hotelservice@ statt unterhalt@ */
  const RT = replyTo || E.MAIL_REPLY_TO;
  S = S || await settings();
  const base = E.PUBLIC_URL || 'https://offertplattform-uh.vercel.app';
  const MDL = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g;
  const lnk = p => esc(p).replace(MDL, (m, t, u) => `<a href="${u}" style="color:#1f6f8b;text-decoration:underline">${t}</a>`).replace(/\n/g, '<br>');
  /* Knopf im Mailtext: Absatz «[[BTN:Beschriftung|https://…|Hinweis]]» wird als grosser Knopf dargestellt */
  const BTN = /^\[\[BTN:([^|\]]+)\|(https?:\/\/[^|\]\s]+)(?:\|([^\]]*))?\]\]$/;
  const para = p => { const b = BTN.exec(p.trim()); if (!b) return `<p style="margin:0 0 14px">${lnk(p)}</p>`;
    const en = lang === 'en', lab = en ? 'ONLINE ORDER PLACEMENT' : 'ONLINE-AUFTRAGSERTEILUNG', sub = en ? 'Choose the contract start, book the kick-off meeting and sign the order electronically.' : 'Vertragsbeginn festlegen, Startbesprechung terminieren und Auftrag elektronisch unterzeichnen.';
    return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:6px 0 20px;max-width:560px;border-collapse:collapse"><tr><td style="border-left:3px solid #1B8384;background:#F4F8F9;padding:18px 22px 20px">`
      + `<div style="font-family:Verdana,Arial,sans-serif;font-size:10px;letter-spacing:2px;color:#1B8384;font-weight:bold;margin:0 0 6px">${lab}</div>`
      + `<div style="font-family:Verdana,Arial,sans-serif;font-size:13px;line-height:1.5;color:#3C3C3B;margin:0 0 14px">${sub}</div>`
      + `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td bgcolor="#1B8384" style="background:#1B8384;border-radius:3px"><a href="${b[2]}" target="_blank" style="display:inline-block;padding:11px 22px;font-family:Verdana,Arial,sans-serif;font-size:13px;font-weight:bold;letter-spacing:.3px;color:#ffffff;text-decoration:none;border-radius:3px">${esc(b[1])}</a></td></tr></table>`
      + `${b[3] ? `<div style="font-family:Verdana,Arial,sans-serif;font-size:11px;color:#767676;margin:10px 0 0">${esc(b[3])}</div>` : ''}</td></tr></table>`; };
  let iso = base + '/asset/iso.png', inl = null;
  try { const a = await assetBytes('iso.png'); if (a) { inl = { filename: 'iso.png', content: a.b64, content_type: 'image/png', content_id: 'iso-zertifikate' }; iso = 'cid:iso-zertifikate'; } } catch (e) {}
  const html = `<!doctype html><html lang="${lang === 'en' ? 'en' : 'de'}"><head><meta charset="utf-8"><title>${esc(subject)}</title></head><body><div style="font-family:Verdana,Arial,sans-serif;font-size:14px;line-height:1.6;color:#222">${String(text).split(/\n{2,}/).map(para).join('')}${sigHtml(S, iso, lang, FROM)}</div></body></html>`;
  const plain = String(text).replace(/\[\[BTN:([^|\]]+)\|(https?:\/\/[^|\]\s]+)(?:\|[^\]]*)?\]\]/g, '$1: $2').replace(MDL, '$1: $2');
  const k = String(kind || ''), copy = nocopy ? false : /^cal/.test(k) ? S.bccBes !== 'nein' : /^(nf\d|re6)/.test(k) ? S.bccNach !== 'nein' : true;
  const payload = { from: FROM, to: Array.isArray(to) ? to : [to], reply_to: RT, subject, html, text: plain + sigText(S, lang, FROM) };
  if (copy) payload.bcc = copyTo ? [].concat(copyTo) : [RT];   /* Kopie: Hotelofferten an unterhalt@, sonst an die Antwortadresse */
  const att = (attachments && attachments.length ? attachments.slice() : []); if (inl) att.push(inl);
  if (att.length) payload.attachments = att;
  let id = null, status = 'ok', err = null;
  /* Bevorzugt Microsoft 365 (landet zuverlässig im Posteingang). Klappt das nicht, geht die Mail wie bisher über Resend raus. */
  if (MS_ON()) {
    try { try { id = await msSend({ from: FROM, to: payload.to, bcc: payload.bcc, replyTo: RT, subject, html, attachments: att }); }
      catch (e1) { if (FROM === E.MAIL_FROM) throw e1; console.error('Absender ' + FROM + ' nicht möglich, Versand über Standardpostfach', e1.message); id = await msSend({ from: E.MAIL_FROM, to: payload.to, bcc: payload.bcc, replyTo: RT, subject, html, attachments: att }); }
      try { await rpc('api_mail_log', { p_kind: kind || '', p_object: objectId || '', p_to: [].concat(to).join(', '), p_subject: subject, p_resend: id, p_status: 'ok', p_error: 'via Microsoft 365' }); } catch (e) {}
      return id;
    } catch (e) { err = String(e.message || e); try { await rpc('api_mail_log', { p_kind: kind || '', p_object: objectId || '', p_to: [].concat(to).join(', '), p_subject: subject, p_resend: null, p_status: 'ms-fehler', p_error: err.slice(0, 300) }); } catch (e2) {} err = null; }
  }
  try {
    const r = await fetch((E.RESEND_URL || 'https://api.resend.com') + '/emails', { method: 'POST', headers: { Authorization: 'Bearer ' + E.RESEND_API_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    const j = await r.json().catch(() => ({})); if (!r.ok) { status = 'fehler'; err = j.message || ('HTTP ' + r.status); } else id = j.id;
  } catch (e) { status = 'fehler'; err = String(e.message || e); }
  try { await rpc('api_mail_log', { p_kind: kind || '', p_object: objectId || '', p_to: [].concat(to).join(', '), p_subject: subject, p_resend: id, p_status: status, p_error: err }); } catch (e) {}
  if (status !== 'ok') throw new Error(err);
  return id;
}
async function assetBytes(name) {
  const r = await rpc('api_asset_get', { p_name: name }); if (!r || !r.length || !r[0].b64) return null;
  return { ctype: r[0].ctype, buf: Buffer.from(r[0].b64, 'base64'), b64: r[0].b64 };
}
const HOTEL_RT = 'Clean Service Hotelservice <hotelservice@clean-service.ch>';
const HOTEL_FROM = 'Clean Service Hotelservice <hotelservice@clean-service.ch>';
const HOTEL_CC = 'unterhalt@clean-service.ch';   /* Kopie jeder versendeten Hotelofferte */
module.exports = { MS_ON, msToken, MS_G, esc, rpc, makeToken, okToken, bearer, guard, body, sendMail, settings, assetBytes, E, HOTEL_RT, HOTEL_CC, HOTEL_FROM };
