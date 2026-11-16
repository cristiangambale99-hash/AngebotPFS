// Push-Nachrichten (Web Push). Geräte liegen als Dokumente 'push/<id>' in der Datenbank.
const { rpc } = require('./_lib');
const E = process.env;
const ON = () => !!(E.VAPID_PUBLIC && E.VAPID_PRIVATE);
function wp() { const w = require('web-push'); w.setVapidDetails(E.VAPID_SUBJECT || 'mailto:unterhalt@clean-service.ch', E.VAPID_PUBLIC, E.VAPID_PRIVATE); return w; }
async function devices() {
  const rows = await rpc('api_docs_since', { p_since: '1970-01-01T00:00:00Z' });
  return rows.filter(r => /^push\//.test(r.path) && !r.deleted && r.data && r.data.sub && r.data.sub.endpoint);
}
// topic: 'uh' | 'ho' | 'abs' | 'nf' | 'test'; to: nur dieses Gerät (Doc-Pfad), sonst alle mit passender Einstellung
async function notify(topic, msg, to) {
  if (!ON()) return { sent: 0, off: true };
  const w = wp(), out = { sent: 0, gone: 0, err: 0 };
  for (const r of await devices()) {
    if (to && r.path !== to) continue;
    const p = r.data.prefs || {}; if (!to && !p[topic]) continue;
    try { await w.sendNotification(r.data.sub, JSON.stringify(msg), { TTL: 3600, urgency: 'high' }); out.sent++; }
    catch (e) { if (e.statusCode === 404 || e.statusCode === 410) { out.gone++; try { await rpc('api_doc_del', { p_path: r.path }); } catch (x) {} } else out.err++; }
  }
  return out;
}
module.exports = { ON, notify, devices };
