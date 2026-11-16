const { guard, body } = require('./_lib');
// Ping für den Verbindungstest. Zusätzlich: Push-Schlüssel (öffentlich) und Testnachricht an ein Gerät.
module.exports = async (req, res) => {
  const q = req.query || {};
  if (q.push === 'key') return res.status(200).json({ key: process.env.VAPID_PUBLIC || null });
  if (q.push === 'test' && req.method === 'POST') {
    if (!guard(req, res)) return;
    try { const b = await body(req); const P = require('./_push'); if (!P.ON()) return res.status(503).json({ error: 'Push ist auf dem Server noch nicht eingerichtet.' });
      const r = await P.notify('test', { title: 'Testnachricht', body: 'Push funktioniert auf diesem Gerät.', url: '/', tag: 'test' }, 'push/' + String(b.id || '').replace(/[^\w-]/g, ''));
      return res.status(200).json({ ok: r.sent > 0, ...r }); } catch (e) { return res.status(500).json({ error: String(e.message) }); }
  }
  res.status(200).json({ ok: true, backend: true });
};
