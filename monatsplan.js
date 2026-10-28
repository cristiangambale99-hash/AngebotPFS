/* monatsplan.js — liest den Aduna-Monatsplan einer Mitarbeiterin aus den
   Textpositionen eines PDF (pdf.js: str, x, y) und erkennt pro Kunde Name,
   Adresse, Einsatztage, Stunden, Wochentag und Rhythmus.
   Läuft im Browser (admin.html) und in Node (Tests). Keine Abhängigkeiten. */
(function (wurzel) {
  const MONATE = { januar:0, februar:1, 'märz':2, maerz:2, april:3, mai:4, juni:5, juli:6, august:7, september:8, oktober:9, november:10, dezember:11 };
  const WT = ['So','Mo','Di','Mi','Do','Fr','Sa'];

  function zeilen(items) {
    // Textstücke zu Zeilen bündeln (gleiche Höhe ±2)
    const s = items.filter(i => String(i.s || '').trim()).map(i => ({ s: String(i.s).trim(), x: +i.x, y: +i.y }))
      .sort((a, b) => a.y - b.y || a.x - b.x);
    const z = [];
    for (const i of s) {
      const l = z.length ? z[z.length - 1] : null;
      if (l && Math.abs(l.y - i.y) <= 2) l.t.push(i); else z.push({ y: i.y, t: [i] });
    }
    return z;
  }

  function rhythmus(tage, jahr, mon) {
    const t = Object.keys(tage).map(Number).sort((a, b) => a - b);
    const wt = [...new Set(t.map(x => WT[new Date(jahr, mon, x).getDay()]))].join('/');
    const std = t.length ? tage[t[0]] : 0;
    if (!t.length) return { freq: '', wt: '', std: 0, sicher: 'unsicher', grund: 'keine Einsätze' };
    if (t.length === 1) return { freq: 'monatlich', wt, std, sicher: 'unsicher', grund: 'nur ein Einsatz im Monat' };
    const abst = []; for (let i = 1; i < t.length; i++) abst.push(t[i] - t[i - 1]);
    if (abst.every(x => x === 7)) return { freq: 'wöchentlich', wt, std, sicher: t.length >= 4 ? 'sicher' : 'prüfen', grund: t.length >= 4 ? '' : 'nur ' + t.length + ' Einsätze, evtl. Ferien' };
    if (abst.every(x => x === 14)) return { freq: 'alle 2 Wochen', wt, std, sicher: 'sicher', grund: '' };
    if (abst.every(x => x % 7 === 0)) {
      const w = abst.filter(x => x === 7).length >= abst.length / 2 ? 'wöchentlich' : 'alle 2 Wochen';
      return { freq: w, wt, std, sicher: 'prüfen', grund: 'unregelmässige Abstände (' + abst.join('/') + ' Tage)' };
    }
    return { freq: 'wöchentlich', wt, std, sicher: 'prüfen', grund: 'Einsätze an verschiedenen Wochentagen' };
  }

  function monatsplanLesen(seiten) {
    // seiten: Array von Item-Arrays (eine Seite = ein Array), oder ein einziges Array
    const alle = Array.isArray(seiten[0]) ? seiten : [seiten];
    const kopf = { mitarbeiterin: '', pnr: '', periode: '', jahr: new Date().getFullYear(), mon: new Date().getMonth() };
    const kunden = [];

    for (const items of alle) {
      const zl = zeilen(items);
      // Kopfzeilen
      for (const l of zl) {
        const txt = l.t.map(i => i.s).join(' ');
        const mP = txt.match(/Periode:\s*([A-Za-zäöüÄÖÜ]+)\s+(\d{4})/);
        if (mP && !kopf.periode) { kopf.periode = mP[1] + ' ' + mP[2]; kopf.jahr = +mP[2]; const m = MONATE[mP[1].toLowerCase()]; if (m !== undefined) kopf.mon = m; }
        const mM = txt.match(/Mitarbeitervertrag:\s*(\d+),\s*([^,]+,\s*[^,]+),\s*\d+/) || txt.match(/Mitarbeiter:\s*([^,]+,\s*[^,]+),\s*(\d+)/);
        if (mM && !kopf.mitarbeiterin) {
          if (/Mitarbeitervertrag/.test(txt)) { kopf.pnr = mM[1]; kopf.mitarbeiterin = mM[2].trim(); }
          else { kopf.mitarbeiterin = mM[1].trim(); kopf.pnr = mM[2]; }
        }
      }
      // Tageskopf: Zeile mit vielen zweistelligen Zahlen
      const kopfZeile = zl.find(l => l.t.filter(i => /^\d{2}$/.test(i.s)).length >= 20);
      if (!kopfZeile) continue;
      const tagX = kopfZeile.t.filter(i => /^\d{2}$/.test(i.s)).map(i => ({ d: +i.s, x: i.x }));
      const xStart = Math.min(...tagX.map(t => t.x)) - 6;
      const tagZuX = x => { let b = null; for (const t of tagX) if (!b || Math.abs(t.x - x) < Math.abs(b.x - x)) b = t; return b && Math.abs(b.x - x) <= 9 ? b.d : null; };
      const istMA = s => kopf.mitarbeiterin && s.replace(/\s+/g, ' ').trim() === kopf.mitarbeiterin.replace(/\s+/g, ' ').trim();

      // Blöcke: beginnen bei einer Zeile mit Stundenzahlen, enden bei der Zeile mit dem Namen der Mitarbeiterin
      let i = zl.indexOf(kopfZeile) + 1;
      while (i < zl.length) {
        const l = zl[i];
        const zahlen = l.t.filter(t => /^\d+\.\d{2}$/.test(t.s));
        const text = l.t.filter(t => !/^\d+\.\d{2}$/.test(t.s) && t.x < xStart);
        if (zahlen.length > 12) { i++; continue; }               // Summenzeile am Schluss
        if (zahlen.length && !text.length) {
          const tage = {};
          for (const z of zahlen) { if (z.x < xStart) continue; const d = tagZuX(z.x); const v = parseFloat(z.s); if (d && v > 0) tage[d] = v; }
          // Namens- und Adresszeilen bis zur Mitarbeiterinnen-Zeile sammeln
          const txtZeilen = [];
          let j = i + 1, gefunden = false;
          while (j < zl.length && j <= i + 6) {
            const tl = zl[j].t.filter(t => t.x < xStart);
            const s = tl.map(t => t.s).join(' ').replace(/\s+/g, ' ').trim();
            if (!tl.length) { j++; continue; }
            if (/Clean Service Scaramuzzo|^Seite \d|^\d{2}\.\d{2}\.\d{4},/.test(s)) break;   // Fusszeile
            if (istMA(s.replace(/\s*\d{3} \d{3} \d{2} \d{2}.*$/, '')) || /^\d{3} \d{3} \d{2} \d{2}$/.test(s)) { gefunden = true; break; }
            if (zl[j].t.some(t => /^\d+\.\d{2}$/.test(t.s) && t.x >= xStart)) break; // nächster Block
            txtZeilen.push(s); j++;
          }
          if (txtZeilen.length) {
            const voll = txtZeilen.join(' ').replace(/\s+/g, ' ').trim();
            let [name, ...rest] = voll.split(/\s+-\s*|\s-\s|-\s/);
            let adresse = rest.join(' ').trim();
            if (!rest.length) { name = voll; adresse = ''; }
            const mNr = adresse.match(/\(([\d-]+)\)\s*$/); const nr = mNr ? mNr[1] : '';
            adresse = adresse.replace(/\s*\([\d-]+\)\s*$/, '').replace(/,\s*$/, '').trim();
            const r = rhythmus(tage, kopf.jahr, kopf.mon);
            kunden.push({ kunde: name.replace(/\s+,/g, ',').trim(), adresse, nr, tage, einsaetze: Object.keys(tage).length,
              freq: r.freq, wt: r.wt, std: r.std, sicher: r.sicher, grund: r.grund, monatlich: r.freq === 'monatlich' });
          }
          i = gefunden ? j + 1 : j;
        } else i++;
      }
    }
    return Object.assign({ kunden }, kopf);
  }

  wurzel.monatsplanLesen = monatsplanLesen;
  wurzel.monatsplanRhythmus = rhythmus;
})(typeof module !== 'undefined' && module.exports ? module.exports : (typeof window !== 'undefined' ? window : globalThis));
