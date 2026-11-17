/* Offerte Unterhaltsreinigung im neuen Layout als PDF (Server-Chromium).
   POST { d: Daten der Offerte, stash?: 'tmp-<id>' }
   ohne stash → PDF als Datei zurück (Vorschau), mit stash → PDF als Zwischenablage für den Mailversand, Antwort JSON. */
const { guard, body, rpc } = require('./_lib');
const R = require('./_render');
module.exports = async (req, res) => {
  /* Kurztest ohne Kundendaten: /api/pdf?diag=1 rendert eine leere Seite und meldet Erfolg oder Fehler */
  if (req.method === 'GET' && req.query && req.query.diag) {
    const t = Date.now();
    try { const { pdf } = await R.render(R.shell('<div class="doc"><p>Test</p></div>')); return res.status(200).json({ ok: true, bytes: pdf.length, ms: Date.now() - t, node: process.version }); }
    catch (e) { console.error('pdf diag', e); return res.status(200).json({ ok: false, error: String(e && e.message || e).slice(0, 800), node: process.version, ms: Date.now() - t }); }
  }
  if (req.method !== 'POST' || !guard(req, res)) return;
  const b = await body(req), d = b.d;
  /* Hotelofferte: fertiges Druck-HTML aus dem Hotel-Editor (vorher per /api/stash hochgeladen) → PDF, abgelegt unter b.stash */
  if (b.htmlStash) {
    if (!/^tmp-[\w\-]+$/.test(b.htmlStash) || !/^tmp-[\w\-]+$/.test(b.stash || '')) return res.status(400).json({ error: 'name' });
    try {
      const a = await require('./_lib').assetBytes(b.htmlStash); if (!a) return res.status(404).json({ error: 'Druckdaten nicht gefunden' });
      const { pdf } = await R.render(a.buf.toString('utf8'));
      const CH = 600000, s64 = pdf.toString('base64'), tot = Math.max(1, Math.ceil(s64.length / CH));
      for (let i = 0; i < tot; i++) await rpc('api_asset_put', { p_name: b.stash, p_ctype: 'application/pdf', p_idx: i, p_total: tot, p_b64: s64.slice(i * CH, (i + 1) * CH) });
      return res.status(200).json({ ok: true, name: b.stash, bytes: pdf.length });
    } catch (e) { console.error('pdf hotel', e); return res.status(500).json({ error: 'PDF konnte nicht erstellt werden: ' + String(e.message || e).slice(0, 300) }); }
  }
  /* Anpassungsvertrag: Daten in b.av → PDF (mit stash abgelegt für den Mailversand, sonst als Datei) */
  if (b.av && typeof b.av === 'object') {
    try {
      const { pdf } = await R.render(require('./_av').html(b.av));
      if (b.stash) {
        if (!/^tmp-[\w\-]+$/.test(b.stash)) return res.status(400).json({ error: 'name' });
        const CH = 600000, s64 = pdf.toString('base64'), tot = Math.max(1, Math.ceil(s64.length / CH));
        for (let i = 0; i < tot; i++) await rpc('api_asset_put', { p_name: b.stash, p_ctype: 'application/pdf', p_idx: i, p_total: tot, p_b64: s64.slice(i * CH, (i + 1) * CH) });
        return res.status(200).json({ ok: true, name: b.stash, bytes: pdf.length });
      }
      res.setHeader('Content-Type', 'application/pdf'); res.setHeader('Cache-Control', 'no-store'); return res.status(200).send(pdf);
    } catch (e) { console.error('pdf av', e); return res.status(500).json({ error: 'Vertrag konnte nicht erstellt werden: ' + String(e.message || e).slice(0, 300) }); }
  }
  if (!d || typeof d !== 'object' || !Array.isArray(d.rb) || !Array.isArray(d.lv)) return res.status(400).json({ error: 'Daten fehlen' });
  try {
    const { pdf, info } = await R.render(R.uhOfferHtml(d), { wait: true });
    res.setHeader('X-Pages', String((info && info.pages) || 0));
    if (info && info.over && info.over.length) res.setHeader('X-Overflow', JSON.stringify(info.over).slice(0, 200));
    if (b.stash) {
      if (!/^tmp-[\w\-]+$/.test(b.stash)) return res.status(400).json({ error: 'name' });
      const CH = 600000, s = pdf.toString('base64'), tot = Math.max(1, Math.ceil(s.length / CH));
      for (let i = 0; i < tot; i++) await rpc('api_asset_put', { p_name: b.stash, p_ctype: 'application/pdf', p_idx: i, p_total: tot, p_b64: s.slice(i * CH, (i + 1) * CH) });
      return res.status(200).json({ ok: true, name: b.stash, bytes: pdf.length, pages: info && info.pages, over: info && info.over });
    }
    res.setHeader('Content-Type', 'application/pdf'); res.setHeader('Cache-Control', 'no-store');
    res.status(200).send(pdf);
  } catch (e) { console.error('pdf', e); res.status(500).json({ error: 'PDF konnte nicht erstellt werden: ' + String(e.message || e).slice(0, 300) }); }
};
