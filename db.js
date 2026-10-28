// IndexedDB 저장소: decks / cards / files(원본 Blob) / history
const DB_NAME = 'flashcards';
const DB_VERSION = 1;
const STORES = ['decks', 'cards', 'files', 'history'];

let dbPromise;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const d = req.result;
      d.createObjectStore('decks', { keyPath: 'id' });
      d.createObjectStore('cards', { keyPath: 'id' }).createIndex('deckId', 'deckId');
      d.createObjectStore('files', { keyPath: 'id' });
      d.createObjectStore('history', { keyPath: 'id' }).createIndex('cardId', 'cardId');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

const p = (req) => new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });

async function tx(stores, mode, fn) {
  const d = await openDB();
  return new Promise((resolve, reject) => {
    const t = d.transaction(stores, mode);
    let out;
    Promise.resolve(fn(t)).then((v) => { out = v; }, (e) => { try { t.abort(); } catch {} reject(e); });
    t.oncomplete = () => resolve(out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

export const db = {
  all: (s) => tx([s], 'readonly', (t) => p(t.objectStore(s).getAll())),
  get: (s, id) => tx([s], 'readonly', (t) => p(t.objectStore(s).get(id))),
  put: (s, v) => tx([s], 'readwrite', (t) => { t.objectStore(s).put(v); }),
  del: (s, id) => tx([s], 'readwrite', (t) => { t.objectStore(s).delete(id); }),
  cardsByDeck: (deckId) => tx(['cards'], 'readonly', (t) => p(t.objectStore('cards').index('deckId').getAll(deckId))),
  historyByCard: (cardId) => tx(['history'], 'readonly', (t) => p(t.objectStore('history').index('cardId').getAll(cardId))),
};

export const FACES = ['front', 'back1', 'back2'];

function cardFileIds(card) {
  return FACES.flatMap((f) => (card[f]?.attachments || []).map((a) => a.id));
}

// 카드 + 첨부 원본 + 학습 이력 함께 삭제
export async function deleteCard(card) {
  return tx(['cards', 'files', 'history'], 'readwrite', async (t) => {
    t.objectStore('cards').delete(card.id);
    cardFileIds(card).forEach((id) => t.objectStore('files').delete(id));
    const keys = await p(t.objectStore('history').index('cardId').getAllKeys(card.id));
    keys.forEach((k) => t.objectStore('history').delete(k));
  });
}

export async function deleteDeck(deckId) {
  const cards = await db.cardsByDeck(deckId);
  for (const c of cards) await deleteCard(c);
  await db.del('decks', deckId);
}

// 카드 저장: 새 첨부 원본 저장, 제거된 첨부 원본 삭제
export async function saveCard(card, newFiles, removedFileIds) {
  return tx(['cards', 'files'], 'readwrite', (t) => {
    newFiles.forEach((f) => t.objectStore('files').put(f));
    removedFileIds.forEach((id) => t.objectStore('files').delete(id));
    t.objectStore('cards').put(card);
  });
}

const blobToDataURL = (blob) => new Promise((res, rej) => {
  const r = new FileReader();
  r.onload = () => res(r.result);
  r.onerror = () => rej(r.error);
  r.readAsDataURL(blob);
});

export async function exportAll() {
  const [decks, cards, files, history] = await Promise.all(STORES.map((s) => db.all(s)));
  const outFiles = [];
  for (const f of files) outFiles.push({ id: f.id, name: f.name, type: f.type, data: await blobToDataURL(f.blob) });
  return { app: 'flashcards', version: 1, exportedAt: new Date().toISOString(), decks, cards, files: outFiles, history };
}

export async function importAll(data) {
  if (!data || data.app !== 'flashcards' || !Array.isArray(data.decks) || !Array.isArray(data.cards)) {
    throw new Error('올바른 백업 파일이 아닙니다.');
  }
  const files = [];
  for (const f of data.files || []) {
    const blob = await (await fetch(f.data)).blob();
    files.push({ id: f.id, name: f.name, type: f.type, blob });
  }
  return tx(STORES, 'readwrite', (t) => {
    STORES.forEach((s) => t.objectStore(s).clear());
    data.decks.forEach((v) => t.objectStore('decks').put(v));
    data.cards.forEach((v) => t.objectStore('cards').put(v));
    files.forEach((v) => t.objectStore('files').put(v));
    (data.history || []).forEach((v) => t.objectStore('history').put(v));
  });
}
