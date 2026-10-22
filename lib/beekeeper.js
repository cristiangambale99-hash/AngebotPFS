// lib/beekeeper.js
//
// Zugriff auf Beekeeper für den Putzfrauenservice: Gruppenchat je Objekt
// eröffnen, Mitarbeiterinnen hinzufügen, Nachrichten und Absagen senden.
//
// Umgebungsvariablen (Projekt angebot-pfs in Vercel):
//   BEEKEEPER_URL      z. B. https://cleanservice.beekeeper.io
//   BEEKEEPER_TOKEN    Token des PFS Bots
//   BEEKEEPER_MEMBERS  Kennungen, die in jeden Chat gehören und dort
//                      Administrator sind, mit Komma getrennt:
//                      Abteilung Putzfrauenservice und Cristian Gambale
//
// Ist eine der Variablen nicht gesetzt, melden die Funktionen das sauber
// zurück, statt einen Fehler zu werfen. Der übrige Ablauf läuft weiter.

const PFAD = '/api/2';

function basis() {
  const u = String(process.env.BEEKEEPER_URL || '').replace(/\/+$/, '');
  return u ? (u.endsWith(PFAD) ? u : u + PFAD) : '';
}
export function bkBereit() {
  return !!(basis() && process.env.BEEKEEPER_TOKEN);
}
export function bkStammMitglieder() {
  return String(process.env.BEEKEEPER_MEMBERS || '')
    .split(/[,;\s]+/).map(x => x.trim()).filter(Boolean);
}

async function ruf(pfad, opt = {}) {
  if (!bkBereit()) throw new Error('Beekeeper ist nicht eingerichtet (BEEKEEPER_URL oder BEEKEEPER_TOKEN fehlt).');
  const r = await fetch(basis() + pfad, Object.assign({}, opt, {
    headers: Object.assign({
      Authorization: 'Token ' + process.env.BEEKEEPER_TOKEN,
      'Content-Type': 'application/json'
    }, opt.headers || {})
  }));
  const text = await r.text();
  let daten = {};
  try { daten = text ? JSON.parse(text) : {}; } catch (e) { daten = { roh: text.slice(0, 300) }; }
  if (!r.ok) throw new Error('Beekeeper ' + r.status + ': ' + JSON.stringify(daten).slice(0, 300));
  /* Beekeeper meldet Fehler teilweise mit Status 200 im Feld error. */
  if (daten && daten.error) throw new Error('Beekeeper: ' + String(daten.error).slice(0, 200));
  return daten;
}

/* Gruppenchat eröffnen. Die Stammmitglieder kommen hinein und werden
   anschliessend zu Administratoren gemacht. Die Beschreibung setzen wir
   zusätzlich als erste Nachricht, damit sie auch dann im Chat steht, wenn
   das Beschreibungsfeld nicht gesetzt werden kann. */
export async function bkChatEroeffnen({ titel, beschreibung, mitglieder }) {
  const ids = Array.from(new Set([...(mitglieder || []), ...bkStammMitglieder()])).filter(Boolean);
  const chat = await ruf('/conversations', {
    method: 'POST',
    body: JSON.stringify({ name: titel, conversation_type: 'group', user_ids: ids })
  });
  const chatId = chat && (chat.id || chat.conversation_id);
  if (!chatId) throw new Error('Beekeeper hat keine Chat-Kennung zurückgegeben.');

  const bericht = { chatId, titel, mitglieder: ids, adminGesetzt: [], beschreibungGesetzt: false, fehler: [] };

  for (const id of bkStammMitglieder()) {
    try { await bkRolleSetzen(chatId, id, 'admin'); bericht.adminGesetzt.push(id); }
    catch (e) { bericht.fehler.push('Administrator ' + id + ': ' + e.message); }
  }

  if (beschreibung) {
    /* Das Beschreibungsfeld ist in der Beekeeper-API nicht offiziell
       dokumentiert. Wir versuchen es und nehmen einen Fehlschlag hin. */
    try {
      await ruf('/conversations/' + encodeURIComponent(chatId), {
        method: 'PATCH', body: JSON.stringify({ description: beschreibung })
      });
      bericht.beschreibungGesetzt = true;
    } catch (e) { bericht.fehler.push('Beschreibung: ' + e.message); }

    try { await bkNachricht(chatId, beschreibung); }
    catch (e) { bericht.fehler.push('Erste Nachricht: ' + e.message); }
  }
  return bericht;
}

export async function bkRolleSetzen(chatId, userId, rolle = 'member') {
  return ruf('/conversations/' + encodeURIComponent(chatId) + '/members/' + encodeURIComponent(userId), {
    method: 'PUT', body: JSON.stringify({ role: rolle })
  });
}

export async function bkMitgliedHinzufuegen(chatId, userId) {
  return bkRolleSetzen(chatId, userId, 'member');
}

export async function bkNachricht(chatId, text) {
  return ruf('/conversations/' + encodeURIComponent(chatId) + '/messages', {
    method: 'POST', body: JSON.stringify({ text: String(text || '') })
  });
}

/* Direktnachricht: Beekeeper legt den Einzelchat an, falls es ihn nicht gibt.
   Als Ziel geht die Kennung oder das Benutzerkürzel; je nach Tenant greift
   das eine oder das andere, deshalb versuchen wir beide. */
export async function bkDirektnachricht(ziel, text) {
  const wege = (typeof ziel === 'object' && ziel)
    ? [ziel.profile, ziel.name, ziel.id].filter(Boolean)
    : [ziel].filter(Boolean);
  let letzter = null;
  for (const weg of wege) {
    try {
      const chat = await ruf('/conversations/by_user/' + encodeURIComponent(weg));
      const id = chat && (chat.id || chat.conversation_id);
      if (id) return bkNachricht(id, text);
    } catch (e) { letzter = e; }
  }
  throw new Error('Einzelchat konnte nicht geöffnet werden' + (letzter ? ': ' + letzter.message : '.'));
}

/* Mitarbeiterin über den Namen finden. Erst die Nutzerliste, sonst die
   Profile — je nach Rechten des Tokens ist nur eines der beiden erlaubt. */
export async function bkNutzerSuchen(name) {
  const q = encodeURIComponent(String(name || '').trim());
  if (!q) return [];
  for (const pfad of ['/users?q=' + q, '/profiles?q=' + q]) {
    try {
      const d = await ruf(pfad);
      const liste = Array.isArray(d) ? d : (d.users || d.results || []);
      if (liste.length) return liste.map(u => ({
        id: u.id || u.user_id || u.uuid,
        profile: u.profile || '',
        name: u.display_name || u.name || [u.firstname, u.lastname].filter(Boolean).join(' '),
        avatar: u.avatar || ''
      })).filter(u => u.id);
    } catch (e) { /* nächster Weg */ }
  }
  return [];
}

/* Beste Übereinstimmung zu einem Namen, sonst null. */
export async function bkNutzerFinden(name) {
  const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();
  const liste = await bkNutzerSuchen(name);
  return liste.find(u => norm(u.name) === norm(name)) || liste[0] || null;
}
