/* Anpassungsvertrag (Erweiterung eines bestehenden Reinigungsvertrags) im neuen Clean-Service-Layout.
   html(d) → Druck-HTML; wird von api/_pdf.js (POST { av: {...}, stash? }) zu PDF gerendert. */
const escH = t => String(t == null ? '' : t).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const chf = n => 'Fr. ' + (Math.round((+n || 0) * 100) / 100).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, '’');
const br = t => escH(t).replace(/\n/g, '<br>');
const CSS = `.doc h1{margin-bottom:5mm!important}.doc .pr{table-layout:auto!important}.doc .pt{display:grid;grid-template-columns:1fr 1fr;gap:8mm;margin:0 0 8mm}
.doc .pt>div{border-top:.8pt solid #bfd9dc;padding-top:3mm}.doc .pt .r,.doc .sg .r{font-family:Figtree,sans-serif;font-weight:600;font-size:7pt;letter-spacing:.14em;text-transform:uppercase;color:#1b8384;margin-bottom:1.5mm}
.doc .sg{display:grid;grid-template-columns:1fr 1fr;gap:12mm;margin-top:7mm}.doc .sg .ln{height:17mm;border-bottom:.8pt solid #3c3c3b;display:flex;align-items:flex-end}.doc .sg img{height:16mm;mix-blend-mode:multiply}
.doc .sg .nm{margin-top:1.5mm;font-size:8.2pt}.doc .sg .nm span{display:block;color:#767676;font-size:7.2pt}
.doc .pr td:first-child{white-space:normal;font-weight:normal}.doc .pr tr.t td:first-child{font-weight:bold}.doc .pr td.u{font-weight:normal;color:#767676;font-size:7.6pt;width:22mm}
.doc .pr tr.t td{font-weight:bold;font-size:10pt;background:#f1f7f8;border-bottom:1.2pt solid #1b8384}.doc .in.av{inset:40mm 28mm 40mm 25mm;overflow:visible}`;
function html(d) {
  const R = require('./_render'), A = R.assets();
  const sig = d.sig === false ? '' : (A.SIG ? '<img src="' + A.SIG + '" alt="">' : '');
  const ex = +d.erweiterung || 0, be = +d.bestehend || 0, tot = be + ex;
  const rows = (be ? '<tr><td>Monatspauschale für Unterhaltsreinigung (bestehend)</td><td class="num">' + chf(be) + '</td><td class="u">monatlich</td></tr>' : '')
    + '<tr><td>' + escH(d.posText || 'Erweiterung gemäss Leistungsverzeichnis') + '</td><td class="num">' + chf(ex) + '</td><td class="u">monatlich</td></tr>'
    + (be ? '<tr class="t"><td>Total neue Monatspauschale</td><td class="num">' + chf(tot) + '</td><td class="u">monatlich</td></tr>' : '');
  const ref = d.ref ? escH(d.ref) : '';
  const body = '<div class="doc"><div class="pg lh" style="background:#fff url(' + A.LH + ') 0 0/100% 100% no-repeat"><div class="in av">'
    + '<div class="eb">Vertrag ' + escH(d.nr || '') + '</div><h1>Anpassungs&shy;vertrag</h1>'
    + '<div class="pt"><div><div class="r">Auftragnehmer</div><b>Clean Service Scaramuzzo AG</b><br>Industriestrasse 5<br>8307 Effretikon</div>'
    + '<div><div class="r">Auftraggeber</div><b>' + escH(d.firma) + '</b><br>' + br(d.adresse) + '</div></div>'
    + '<h2>1 Leistungen</h2><p>Im Rahmen des vorliegenden Vertrages beauftragt der Auftraggeber den Auftragnehmer mit den folgenden Leistungen:</p>'
    + '<div class="box" style="margin-top:3mm"><b>' + escH(d.titel || 'Anpassung Unterhaltsreinigung') + '</b><br><span class="note">gemäss beiliegendem Leistungsverzeichnis</span></div>'
    + '<h2 style="margin-top:6mm">2 Finanzielle Bedingungen</h2><table class="pr" style="margin-bottom:3mm">' + rows + '</table><p class="note">Die oben genannten Preise verstehen sich exkl. MwSt.</p>'
    + '<h2 style="margin-top:6mm">3 Vertragsbeginn, Dauer und Auflösung</h2><p>Der vorliegende Vertrag tritt per ' + escH(d.vbTxt || 'Vereinbarung') + ' in Kraft.</p>'
    + (ref ? '<p>Sämtliche weiteren Konditionen werden vom Reinigungsvertrag ' + ref + ' übernommen.</p>' : '<p>Sämtliche weiteren Konditionen werden vom bestehenden Reinigungsvertrag übernommen.</p>')
    + '<p style="margin-top:5mm">Effretikon, den ' + escH(d.datumTxt || '') + '</p>'
    + '<div class="sg"><div><div class="r">Der Auftragnehmer</div><div class="ln">' + sig + '</div><div class="nm">Mirco Scaramuzzo<span>Clean Service Scaramuzzo AG</span></div></div>'
    + '<div><div class="r">Der Auftraggeber</div><div class="ln"></div><div class="nm">' + escH(d.unterzeichner || '') + '<span>' + escH(d.firma) + '</span></div></div></div>'
    + '</div></div></div>';
  return R.shell('<style>' + CSS + '</style>' + body);
}
module.exports = { html };
