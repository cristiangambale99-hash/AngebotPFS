/* HTML → PDF mit Chromium auf dem Server (gleiche Darstellung wie die Muster-PDFs).
   Der Browser bleibt pro Funktionsinstanz offen, damit Folgeaufrufe schnell sind. */
const fs = require('fs');
const path = require('path');
const AS = path.join(__dirname, '_assets');
const rd = (f, enc) => fs.readFileSync(path.join(AS, f), enc);
const b64 = (f, mime) => 'data:' + mime + ';base64,' + rd(f).toString('base64');

let FONTCSS = null;
function fontCss() {
  if (FONTCSS) return FONTCSS;
  const ff = [];
  [300, 400, 500, 600, 700].forEach(w => {
    ff.push(`@font-face{font-family:Figtree;font-style:normal;font-weight:${w};font-display:block;src:url(${b64('fonts/figtree-latin-' + w + '-normal.woff2', 'font/woff2')}) format('woff2');unicode-range:U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD}`);
    ff.push(`@font-face{font-family:Figtree;font-style:normal;font-weight:${w};font-display:block;src:url(${b64('fonts/figtree-latin-ext-' + w + '-normal.woff2', 'font/woff2')}) format('woff2');unicode-range:U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF}`);
  });
  /* Fliesstext: Verdana ist auf dem Server nicht vorhanden, DejaVu Sans ist der passende Ersatz (gleiche Laufweite) */
  ff.push(`@font-face{font-family:"DejaVu Sans";font-weight:400;font-display:block;src:url(${b64('fonts/DejaVuSans.ttf', 'font/ttf')}) format('truetype')}`);
  ff.push(`@font-face{font-family:"DejaVu Sans";font-weight:700;font-display:block;src:url(${b64('fonts/DejaVuSans-Bold.ttf', 'font/ttf')}) format('truetype')}`);
  FONTCSS = ff.join('\n'); return FONTCSS;
}
const EXTRA = `.doc .isonew{position:absolute;left:20mm;bottom:9mm;display:flex;gap:3mm;z-index:3}.doc .isonew div{width:17mm;height:17mm}.doc .isonew svg{width:100%;height:100%;display:block}
.doc .sigpg .sig{display:grid;grid-template-columns:1fr 1fr;gap:8mm 12mm;margin-top:8mm}.doc .sigpg .sig .l{border-bottom:.8pt solid #3C3C3B;height:18mm;display:flex;align-items:flex-end;padding-bottom:1mm}.doc .sigpg .sig .l img{max-height:17mm;max-width:70mm;display:block}.doc .sigpg .sig small{display:block;font-size:7pt;color:#767676;margin-top:1.2mm}.doc .sigpg .esig{font-size:6.4pt;color:#767676;margin-top:.8mm}
.doc a{color:#1B8384}`;
const UHCSS = `.doc .rbt{width:100%;border-collapse:collapse;font-size:7.6pt;table-layout:fixed}.doc .rbt th{font-family:Figtree,sans-serif;font-weight:600;font-size:6.8pt;color:#1B8384;text-align:left;padding:1.6mm 1.6mm;border-bottom:1.2pt solid #1B8384}.doc .rbt td{padding:1.25mm 1.6mm;border-bottom:.4pt solid #E3EEF0}.doc .rbt .num{text-align:right;font-variant-numeric:tabular-nums}
.doc .rbt .rgb td{font-family:Figtree,sans-serif;font-weight:600;font-size:8.6pt;color:#fff;background:#1B8384;padding:2.2mm 1.6mm;border-top:3mm solid #fff}.doc .rbt .rgb td.num{color:#fff}.doc .rbt .rg0 td{font-family:Figtree,sans-serif;font-weight:600;font-size:9pt;color:#1B8384;background:#EEF7F8;padding:2mm 1.6mm}.doc .rbt .rg1 td{font-family:Figtree,sans-serif;font-weight:600;font-size:7.8pt;letter-spacing:.06em;color:#3C3C3B;padding-top:3mm;border-bottom:.8pt solid #BFD9DC}.doc .rbt .rgt td{font-weight:bold;border-top:1.2pt solid #1B8384;border-bottom:0;padding-top:2mm}
.doc .alv{display:grid;grid-template-columns:75mm 75mm;gap:0 7mm}.doc .alv1{font-size:6.9pt}.doc .alv1 .bh{background:#EEF7F8;border-top:1.2pt solid #1B8384;padding:1.5mm 2mm;font-family:Figtree,sans-serif;font-weight:600;font-size:8.4pt;color:#1B8384}.doc .alv1 .bh i{font-style:normal;font-weight:400;font-size:6.6pt;color:#767676}
.doc .alv1 .ch,.doc .alv1 .r{display:grid;grid-template-columns:1fr 8mm 5.5mm 5.5mm 7mm;gap:0 .6mm}.doc .alv1 .ch{font-family:Figtree,sans-serif;font-weight:600;font-size:5.8pt;letter-spacing:.06em;text-transform:uppercase;color:#767676;padding:1mm 2mm;border-bottom:.5pt solid #BFD9DC}.doc .alv1 .ch span:not(:first-child),.doc .alv1 .r span:not(:first-child){text-align:center;font-variant-numeric:tabular-nums}
.doc .alv1 .k{font-family:Figtree,sans-serif;font-weight:600;font-size:7pt;color:#3C3C3B;padding:1.8mm 2mm .5mm}.doc .alv1 .r{padding:.5mm 2mm;border-bottom:.3pt solid #EEF3F4;line-height:1.3}.doc .alv1 .r i{color:#2BB6B7;font-style:normal;margin-right:1.2mm}.doc .alv1 .who{font-size:6.3pt;color:#767676;padding:1.2mm 2mm}.doc .alv1 .r>span:first-child{min-width:0;overflow-wrap:anywhere;hyphens:auto}.doc .alv1 .r .nur{display:block;font-size:5.9pt;color:#767676;margin:.2mm 0 0 3mm;line-height:1.25}.doc .alv1 .bsp{height:4mm}
.doc .lgs+.lgs{margin-top:6mm}.doc .lgs h2{margin:0 0 2mm}`;

let ASSETS = null;
function assets() {
  if (ASSETS) return ASSETS;
  ASSETS = { LH: b64('lh.png', 'image/png'), LOGO: b64('logo.png', 'image/png'), ICO: JSON.parse(rd('ico.json', 'utf8')), BADGES: JSON.parse(rd('badges.json', 'utf8')), DOCCSS: rd('doc.css', 'utf8') };
  try { ASSETS.SIG = 'data:image/png;base64,' + require('./_sig').SIG_MIRCO; } catch (e) {}
  return ASSETS;
}
const ARTS = ['buero', 'praxis', 'fitness', 'restaurant', 'schule', 'verkauf', 'industrie', 'wohnbau', 'kita', 'hotel', 'indigo'];
function artImg(k) { if (!ARTS.includes(k)) return ''; const f = path.join(AS, 'art', k + '.jpg'); return fs.existsSync(f) ? 'data:image/jpeg;base64,' + fs.readFileSync(f).toString('base64') : ''; }
const safeJson = o => JSON.stringify(o).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

function shell(bodyHtml, script) {
  const A = assets();
  return `<!doctype html><html lang="de"><head><meta charset="utf-8"><style>${fontCss()}
@page{size:A4;margin:0}html,body{margin:0;padding:0;background:#fff}
${A.DOCCSS}
${UHCSS}
${EXTRA}</style></head><body>${bodyHtml}${script ? '<script>' + script + '</script>' : ''}</body></html>`;
}
/* Offerte Unterhaltsreinigung: Daten aus der App → komplettes HTML */
function uhOfferHtml(d) {
  const A = assets();
  const a = { LH: A.LH, LOGO: A.LOGO, ICO: A.ICO, BADGES: A.BADGES, SIG: A.SIG || '', COVER: artImg(d.artBild) || artImg(d.art) };
  /* Neutrale Fassung (z. B. für Weitergabe über Dritte): ohne Clean-Service-Logo und ohne ISO-Badges */
  if (d.neutral) { a.LH = b64('lh-neutral.png', 'image/png'); a.LOGO = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'; a.BADGES = []; }
  const client = rd('uhdoc-client.txt', 'utf8');
  return shell('<div class="doc" id="root"></div>', `window.D=${safeJson(d)};window.A=${safeJson(a)};document.fonts.ready.then(()=>{try{${client}}catch(e){window.__err=String(e&&e.stack||e);window.__done=true;}});`);
}

let BROWSER = null, LAUNCHING = null;
async function browser() {
  if (BROWSER && BROWSER.connected) return BROWSER;
  if (LAUNCHING) return LAUNCHING;   /* zwei Aufrufe gleichzeitig: nur ein Start */
  LAUNCHING = launch().finally(() => { LAUNCHING = null; });
  return LAUNCHING;
}
async function launch() {
  /* Beide Pakete sind ES-Module: per import() laden, require() wird auf Vercel abgelehnt */
  const pm = await import('puppeteer-core'), puppeteer = pm.default || pm;
  let exe = process.env.CHROME_PATH || '', args = ['--no-sandbox', '--font-render-hinting=none'];
  if (!exe) { const cm = await import('@sparticuz/chromium'), chromium = cm.default || cm; chromium.setGraphicsMode = false; exe = await chromium.executablePath(); args = chromium.args.concat(['--font-render-hinting=none']); }
  BROWSER = await puppeteer.launch({ executablePath: exe, args, headless: true, defaultViewport: { width: 1240, height: 1754 } });
  return BROWSER;
}
/* Rendert ein HTML-Dokument; wartet auf window.__done, falls das Dokument selbst Seiten aufbaut */
async function render(html, opts = {}) {
  try { return await renderOnce(html, opts); }
  catch (e) { /* eingefrorener oder abgestürzter Browser nach Pause: neu starten und einmal wiederholen */
    console.error('render 1. Versuch', e && e.message);
    try { if (BROWSER) await BROWSER.close().catch(() => {}); } catch (x) {} BROWSER = null;
    return await renderOnce(html, opts);
  }
}
async function renderOnce(html, opts = {}) {
  const b = await browser(), p = await b.newPage();
  try {
    await p.setContent(html, { waitUntil: 'load', timeout: 30000 });
    if (opts.wait) await p.waitForFunction('window.__done === true', { timeout: 30000 });
    const info = opts.wait ? await p.evaluate(() => ({ info: window.__info || null, err: window.__err || null })) : {};
    if (info.err) throw new Error('Layout: ' + info.err.slice(0, 300));
    await p.emulateMediaType('print');
    const pdf = await p.pdf({ preferCSSPageSize: true, printBackground: true, tagged: false });
    return { pdf: Buffer.from(pdf), info: info.info };
  } finally { await p.close().catch(() => {}); }
}
module.exports = { uhOfferHtml, shell, render, assets };
