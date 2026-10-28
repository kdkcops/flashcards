import { db, uid, FACES, deleteCard, deleteDeck, saveCard, exportAll, importAll } from './db.js';
import { ocrImage, loadPdf, renderPage, extractPdfText } from './ocr.js';

const H = 3600 * 1000;
export const INTERVALS = [
  { key: '6h', label: '6시간', btn: '6시간 후', ms: 6 * H },
  { key: '1d', label: '다음날', btn: '다음날', ms: 24 * H },
  { key: '3d', label: '3일', btn: '3일 후', ms: 3 * 24 * H },
  { key: '7d', label: '일주일', btn: '일주일 후', ms: 7 * 24 * H },
  { key: '30d', label: '한달', btn: '한달 후', ms: 30 * 24 * H },
];
const INTERVAL = Object.fromEntries(INTERVALS.map((i) => [i.key, i]));
const FACE_LABEL = { front: '앞면', back1: '뒷면 1', back2: '뒷면 2' };

const app = document.getElementById('app');
let blobURLs = [];

// ---------- 유틸 ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const $ = (sel, root = app) => root.querySelector(sel);
const $$ = (sel, root = app) => [...root.querySelectorAll(sel)];

// 화면 전환 시, 새 화면에서 쓰지 않는 blob URL은 해제
function setView(html) {
  blobURLs.filter((u) => !html.includes(u)).forEach((u) => URL.revokeObjectURL(u));
  blobURLs = blobURLs.filter((u) => html.includes(u));
  app.innerHTML = html;
  window.scrollTo(0, 0);
}

function objURL(blob) {
  const url = URL.createObjectURL(blob);
  blobURLs.push(url);
  return url;
}

const isDue = (c, now = Date.now()) => c.nextDue == null || c.nextDue <= now;
// 오늘 학습에서 마지막으로 틀린 카드 (다시 맞힐 때까지 오답 확인 대상)
const isWrong = (c) => c.lastResult === false;
const isEmptyFace =(f) => !f || (!(f.text || '').trim() && !(f.attachments || []).length);

function fmtDate(ts) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fmtUntil(ts) {
  const diff = ts - Date.now();
  if (diff <= 0) return '지금';
  const min = Math.round(diff / 60000);
  if (min < 60) return `${min}분 후`;
  const h = Math.round(diff / H);
  if (h < 24) return `${h}시간 후`;
  return `${Math.round(diff / (24 * H))}일 후`;
}

function toast(msg) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.classList.add('hide'), 1800);
  setTimeout(() => el.remove(), 2200);
}

function modal(inner, setup) {
  return new Promise((resolve) => {
    const bg = document.createElement('div');
    bg.className = 'modal-bg';
    bg.innerHTML = `<div class="modal" role="dialog" aria-modal="true">${inner}</div>`;
    document.body.appendChild(bg);
    const close = (v) => { bg.remove(); resolve(v); };
    bg.addEventListener('click', (e) => { if (e.target === bg) close(null); });
    setup(bg, close);
  });
}

function confirmDlg(message, okLabel = '확인', danger = false) {
  return modal(
    `<p class="modal-msg">${esc(message)}</p>
     <div class="modal-actions"><button class="btn" data-x>취소</button><button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-ok>${esc(okLabel)}</button></div>`,
    (el, close) => {
      el.querySelector('[data-x]').onclick = () => close(false);
      el.querySelector('[data-ok]').onclick = () => close(true);
    },
  ).then(Boolean);
}

function promptDlg(title, value = '', okLabel = '저장') {
  return modal(
    `<h2 class="modal-title">${esc(title)}</h2>
     <form><input class="input" value="${esc(value)}" maxlength="60" required>
     <div class="modal-actions"><button type="button" class="btn" data-x>취소</button><button class="btn btn-primary">${esc(okLabel)}</button></div></form>`,
    (el, close) => {
      const input = el.querySelector('input');
      input.focus();
      input.select();
      el.querySelector('[data-x]').onclick = () => close(null);
      el.querySelector('form').onsubmit = (e) => { e.preventDefault(); const v = input.value.trim(); if (v) close(v); };
    },
  );
}

const go = (hash) => { location.hash = hash; };

// ---------- 메인 ----------
async function viewHome() {
  const [decks, cards] = await Promise.all([db.all('decks'), db.all('cards')]);
  const now = Date.now();
  const due = cards.filter((c) => isDue(c, now));
  const dueNew = due.filter((c) => c.nextDue == null).length;
  const wrongCount = cards.filter(isWrong).length;
  const waiting = Object.fromEntries(INTERVALS.map((i) => [i.key, 0]));
  cards.forEach((c) => { if (!isDue(c, now) && waiting[c.lastInterval] != null) waiting[c.lastInterval]++; });
  const nextUp = cards.filter((c) => !isDue(c, now)).reduce((m, c) => Math.min(m, c.nextDue), Infinity);
  decks.sort((a, b) => a.createdAt - b.createdAt);

  let todayMsg;
  if (!cards.length) todayMsg = `<p class="today-sub">카드를 추가하면 학습을 시작할 수 있어요.</p>`;
  else if (!due.length) todayMsg = `<p class="today-done">오늘 학습 완료 🎉</p><p class="today-sub">다음 학습: ${fmtUntil(nextUp)} (${fmtDate(nextUp)})</p>`;
  else todayMsg = `<p class="today-sub">새 카드 ${dueNew} · 복습 ${due.length - dueNew}</p>`;

  setView(`
    <header class="topbar">
      <h1 class="title">암기카드</h1>
      <button class="icon-btn" data-act="settings" aria-label="설정">⚙️</button>
    </header>
    <main class="content">
      <section class="today">
        <div class="today-label">오늘 학습할 카드</div>
        <div class="today-count" data-testid="today-count">${due.length}<small>장</small></div>
        ${todayMsg}
      </section>
      <section class="waiting">
        <h2 class="section-title">주기별 대기 카드</h2>
        <div class="waiting-grid">
          ${INTERVALS.map((i) => `<div class="waiting-cell"><b data-wait="${i.key}">${waiting[i.key]}</b><span>${i.label}</span></div>`).join('')}
        </div>
      </section>
      <section>
        <div class="section-head">
          <h2 class="section-title">과목 <span class="muted">${decks.length}</span></h2>
          <button class="btn btn-sm" data-act="new-deck">+ 과목</button>
        </div>
        ${decks.length ? `<ul class="list">${decks.map((d) => {
          const dc = cards.filter((c) => c.deckId === d.id);
          const dd = dc.filter((c) => isDue(c, now)).length;
          return `<li><button class="list-item" data-deck="${d.id}">
            <span class="li-main"><span class="li-title">${esc(d.name)}</span><span class="li-sub">카드 ${dc.length}장</span></span>
            <span class="badge ${dd ? 'badge-due' : ''}">오늘 ${dd}</span>
          </button></li>`;
        }).join('')}</ul>` : `<div class="empty">아직 과목이 없습니다.<br>위의 <b>+ 과목</b> 버튼으로 시작하세요.</div>`}
      </section>
    </main>
    <footer class="bottombar">
      <button class="btn btn-lg btn-review grow" data-act="review">오답 확인${wrongCount ? ` (${wrongCount})` : ''}</button>
      <button class="btn btn-lg btn-primary grow" data-act="study">오늘 학습${due.length ? ` (${due.length})` : ''}</button>
    </footer>`);

  $('[data-act=settings]').onclick = () => go('#/settings');
  $('[data-act=study]').onclick = () => go('#/study');
  $('[data-act=review]').onclick = () => go('#/review');
  $('[data-act=new-deck]').onclick = async () => {
    const name = await promptDlg('새 과목 이름', '', '만들기');
    if (!name) return;
    await db.put('decks', { id: uid(), name, createdAt: Date.now() });
    toast('과목을 만들었습니다');
    viewHome();
  };
  $$('[data-deck]').forEach((b) => { b.onclick = () => go(`#/deck/${b.dataset.deck}`); });
}

// ---------- 과목 (카드 목록) ----------
function cardSearchText(c) {
  return FACES.map((f) => `${c[f]?.text || ''} ${(c[f]?.attachments || []).map((a) => a.name).join(' ')}`).join(' ').toLowerCase();
}

function preview(face) {
  if (!face) return '';
  const t = (face.text || '').trim().replace(/\s+/g, ' ');
  if (t) return t;
  const n = (face.attachments || []).length;
  return n ? `📎 첨부 ${n}개` : '';
}

async function viewDeck(deckId) {
  const deck = await db.get('decks', deckId);
  if (!deck) return go('#/');
  const cards = (await db.cardsByDeck(deckId)).sort((a, b) => b.createdAt - a.createdAt);
  const now = Date.now();
  const dueCount = cards.filter((c) => isDue(c, now)).length;

  setView(`
    <header class="topbar">
      <button class="icon-btn" data-act="back" aria-label="뒤로">←</button>
      <h1 class="title ellipsis">${esc(deck.name)}</h1>
      <button class="icon-btn" data-act="rename" aria-label="이름 수정">✏️</button>
      <button class="icon-btn" data-act="delete" aria-label="과목 삭제">🗑️</button>
    </header>
    <main class="content">
      <input class="input search" type="search" placeholder="카드 검색" data-act="search">
      <p class="muted small">카드 ${cards.length}장 · 오늘 학습 ${dueCount}장</p>
      <ul class="list" data-list></ul>
    </main>
    <footer class="bottombar">
      <button class="btn btn-lg" data-act="add">+ 카드 추가</button>
      <button class="btn btn-lg btn-primary grow" data-act="study">이 과목만 학습${dueCount ? ` (${dueCount})` : ''}</button>
    </footer>`);

  const list = $('[data-list]');
  const renderList = (q) => {
    const shown = q ? cards.filter((c) => cardSearchText(c).includes(q)) : cards;
    if (!cards.length) { list.innerHTML = `<div class="empty">카드가 없습니다.<br>아래 <b>+ 카드 추가</b>로 만들어 보세요.</div>`; return; }
    if (!shown.length) { list.innerHTML = `<div class="empty">검색 결과가 없습니다.</div>`; return; }
    list.innerHTML = shown.map((c) => {
      const status = c.nextDue == null ? '<span class="badge badge-new">새 카드</span>'
        : isDue(c, now) ? '<span class="badge badge-due">학습 대상</span>'
        : `<span class="badge">${fmtDate(c.nextDue)}</span>`;
      return `<li class="card-row">
        <button class="list-item" data-edit="${c.id}">
          <span class="li-main"><span class="li-title ellipsis">${esc(preview(c.front)) || '(내용 없음)'}</span>
          <span class="li-sub ellipsis">${esc(preview(c.back1))}</span></span>
          ${status}
        </button>
        <button class="icon-btn row-del" data-del="${c.id}" aria-label="카드 삭제">✕</button>
      </li>`;
    }).join('');
    $$('[data-edit]', list).forEach((b) => { b.onclick = () => go(`#/card/edit/${b.dataset.edit}`); });
    $$('[data-del]', list).forEach((b) => {
      b.onclick = async () => {
        const card = cards.find((c) => c.id === b.dataset.del);
        if (!(await confirmDlg('이 카드를 삭제할까요? 첨부 파일과 학습 기록도 함께 삭제됩니다.', '삭제', true))) return;
        await deleteCard(card);
        toast('카드를 삭제했습니다');
        viewDeck(deckId);
      };
    });
  };
  renderList('');

  $('[data-act=search]').oninput = (e) => renderList(e.target.value.trim().toLowerCase());
  $('[data-act=back]').onclick = () => go('#/');
  $('[data-act=add]').onclick = () => go(`#/card/new/${deckId}`);
  $('[data-act=study]').onclick = () => go(`#/study/${deckId}`);
  $('[data-act=rename]').onclick = async () => {
    const name = await promptDlg('과목 이름 수정', deck.name);
    if (!name || name === deck.name) return;
    await db.put('decks', { ...deck, name });
    viewDeck(deckId);
  };
  $('[data-act=delete]').onclick = async () => {
    if (!(await confirmDlg(`'${deck.name}' 과목을 삭제할까요?\n카드 ${cards.length}장과 첨부 파일, 학습 기록이 모두 삭제됩니다.`, '삭제', true))) return;
    await deleteDeck(deckId);
    toast('과목을 삭제했습니다');
    go('#/');
  };
}

// ---------- 카드 생성/수정 ----------
async function viewEditor(cardId, deckId) {
  const existing = cardId ? await db.get('cards', cardId) : null;
  if (cardId && !existing) return go('#/');
  deckId = existing ? existing.deckId : deckId;
  const deck = await db.get('decks', deckId);
  if (!deck) return go('#/');

  // 편집 상태: 각 면의 첨부 목록(blob 포함)
  const state = {};
  for (const f of FACES) {
    const atts = [];
    for (const a of existing?.[f]?.attachments || []) {
      const file = await db.get('files', a.id);
      atts.push({ ...a, blob: file?.blob || null, isNew: false });
    }
    state[f] = atts;
  }
  const removed = [];
  const history = existing ? (await db.historyByCard(existing.id)).sort((a, b) => b.at - a.at) : [];

  setView(`
    <header class="topbar">
      <button class="icon-btn" data-act="back" aria-label="뒤로">←</button>
      <h1 class="title ellipsis">${existing ? '카드 수정' : '카드 추가'} <span class="muted small">${esc(deck.name)}</span></h1>
    </header>
    <main class="content">
      ${FACES.map((f) => `
        <section class="face" data-face="${f}">
          <div class="face-head"><h2>${FACE_LABEL[f]}</h2><span class="muted small">${f === 'back2' ? '선택 · 비우면 표시 안 함' : '필수'}</span></div>
          <textarea class="input" rows="${f === 'back2' ? 2 : 3}" placeholder="텍스트 입력 (이미지/PDF 첨부 시 자동 인식)">${esc(existing?.[f]?.text || '')}</textarea>
          <div class="atts"></div>
          <div class="ocr" hidden><div class="ocr-msg"></div><div class="bar"><i></i></div></div>
          <label class="btn attach-btn">📎 이미지 / PDF 첨부<input type="file" accept="image/*,application/pdf" multiple hidden></label>
        </section>`).join('')}
      ${history.length ? `<section class="history"><h2 class="section-title">학습 기록</h2><ul>
        ${history.slice(0, 20).map((h) => `<li><span>${fmtDate(h.at)}</span><span class="${h.correct ? 'ok' : 'ng'}">${h.correct ? '정답' : '오답'}</span><span>${INTERVAL[h.interval]?.btn || h.interval}</span></li>`).join('')}
      </ul></section>` : ''}
    </main>
    <footer class="bottombar">
      ${existing ? '<button class="btn btn-lg btn-danger" data-act="delete">삭제</button>' : '<button class="btn btn-lg" data-act="save-next">저장 후 계속</button>'}
      <button class="btn btn-lg btn-primary grow" data-act="save">저장</button>
    </footer>`);

  const faceEl = (f) => $(`[data-face=${f}]`);

  const renderAtts = (f) => {
    const box = $('.atts', faceEl(f));
    box.innerHTML = state[f].map((a, i) => {
      const thumb = a.type.startsWith('image/') && a.blob
        ? `<img src="${objURL(a.blob)}" alt="">`
        : `<span class="pdf-icon">PDF</span>`;
      return `<div class="att">${thumb}<span class="att-name ellipsis">${esc(a.name)}</span>
        <button type="button" class="att-btn" data-ocr="${i}">글자 인식</button>
        <button type="button" class="att-btn att-x" data-rm="${i}" aria-label="첨부 삭제">✕</button></div>`;
    }).join('');
    $$('[data-rm]', box).forEach((b) => {
      b.onclick = () => {
        const [a] = state[f].splice(+b.dataset.rm, 1);
        if (!a.isNew) removed.push(a.id);
        renderAtts(f);
      };
    });
    $$('[data-ocr]', box).forEach((b) => { b.onclick = () => runOcr(f, state[f][+b.dataset.ocr]); });
  };

  const setOcr = (f, msg, progress, kind = '') => {
    const el = $('.ocr', faceEl(f));
    el.hidden = msg == null;
    el.className = `ocr ${kind}`;
    $('.ocr-msg', el).textContent = msg || '';
    $('.bar i', el).style.width = `${Math.round((progress || 0) * 100)}%`;
  };

  const runOcr = async (f, att) => {
    if (!att?.blob) return;
    const ta = $('textarea', faceEl(f));
    try {
      let text;
      if (att.type === 'application/pdf') {
        setOcr(f, 'PDF 여는 중…', 0);
        const pdf = await loadPdf(att.blob);
        let pages = [1];
        if (pdf.numPages > 1) {
          setOcr(f, '인식할 페이지를 선택하세요', 0);
          pages = await choosePages(pdf);
          if (!pages) { setOcr(f, '글자 인식을 건너뛰었습니다. 직접 입력할 수 있어요.', 0, 'warn'); return; }
        }
        text = await extractPdfText(pdf, pages, (m, p) => setOcr(f, m, p));
      } else {
        text = await ocrImage(att.blob, (m, p) => setOcr(f, `${m}…`, p));
      }
      if (!text) { setOcr(f, '인식된 글자가 없습니다. 직접 입력해 주세요.', 1, 'warn'); return; }
      ta.value = ta.value.trim() ? `${ta.value.trimEnd()}\n${text}` : text;
      ta.dispatchEvent(new Event('input'));
      setOcr(f, `인식 완료 (${text.length}자) · 내용을 확인하고 수정하세요`, 1, 'ok');
    } catch (err) {
      console.error(err);
      setOcr(f, `인식 실패: ${String(err.message || err).replace(/\.+$/, '')}. 첨부는 유지되며 직접 입력할 수 있어요.`, 0, 'err');
    }
  };

  for (const f of FACES) {
    renderAtts(f);
    $('input[type=file]', faceEl(f)).onchange = (e) => {
      const files = [...e.target.files];
      e.target.value = '';
      for (const file of files) {
        const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
        if (!isPdf && !file.type.startsWith('image/')) { toast('이미지 또는 PDF만 첨부할 수 있어요'); continue; }
        const att = { id: uid(), name: file.name, type: isPdf ? 'application/pdf' : file.type, blob: file, isNew: true };
        state[f].push(att);
        renderAtts(f);
        runOcr(f, att);
      }
    };
  }

  const collect = () => {
    const card = existing ? { ...existing } : { id: uid(), deckId, createdAt: Date.now(), nextDue: null, lastInterval: null };
    for (const f of FACES) {
      card[f] = { text: $('textarea', faceEl(f)).value.trim(), attachments: state[f].map(({ id, name, type }) => ({ id, name, type })) };
    }
    card.updatedAt = Date.now();
    return card;
  };

  const save = async () => {
    const card = collect();
    if (isEmptyFace(card.front)) { toast('앞면을 입력하세요'); return null; }
    if (isEmptyFace(card.back1)) { toast('뒷면 1을 입력하세요'); return null; }
    const newFiles = FACES.flatMap((f) => state[f].filter((a) => a.isNew).map(({ id, name, type, blob }) => ({ id, name, type, blob })));
    await saveCard(card, newFiles, removed);
    return card;
  };

  $('[data-act=back]').onclick = () => go(`#/deck/${deckId}`);
  $('[data-act=save]').onclick = async () => { if (await save()) { toast('저장했습니다'); go(`#/deck/${deckId}`); } };
  const saveNext = $('[data-act=save-next]');
  if (saveNext) saveNext.onclick = async () => { if (await save()) { toast('저장했습니다'); viewEditor(null, deckId); } };
  const del = $('[data-act=delete]');
  if (del) del.onclick = async () => {
    if (!(await confirmDlg('이 카드를 삭제할까요? 첨부 파일과 학습 기록도 함께 삭제됩니다.', '삭제', true))) return;
    await deleteCard(existing);
    toast('카드를 삭제했습니다');
    go(`#/deck/${deckId}`);
  };
}

// PDF 여러 페이지 중 인식할 페이지 선택
function choosePages(pdf) {
  const n = pdf.numPages;
  return modal(
    `<h2 class="modal-title">인식할 페이지 선택 <span class="muted small">총 ${n}쪽</span></h2>
     <div class="page-tools"><button type="button" class="btn btn-sm" data-all>전체 선택</button><button type="button" class="btn btn-sm" data-none>전체 해제</button></div>
     <div class="page-grid">${Array.from({ length: n }, (_, i) => `
       <label class="page-cell"><input type="checkbox" value="${i + 1}" ${i === 0 ? 'checked' : ''}>
       <span class="page-thumb" data-thumb="${i + 1}"></span><span>${i + 1}쪽</span></label>`).join('')}</div>
     <div class="modal-actions"><button class="btn" data-x>인식 안 함</button><button class="btn btn-primary" data-ok>인식</button></div>`,
    (el, close) => {
      const boxes = [...el.querySelectorAll('input[type=checkbox]')];
      el.querySelector('[data-all]').onclick = () => boxes.forEach((b) => { b.checked = true; });
      el.querySelector('[data-none]').onclick = () => boxes.forEach((b) => { b.checked = false; });
      el.querySelector('[data-x]').onclick = () => close(null);
      el.querySelector('[data-ok]').onclick = () => {
        const pages = boxes.filter((b) => b.checked).map((b) => +b.value);
        if (!pages.length) { toast('페이지를 선택하세요'); return; }
        close(pages);
      };
      (async () => {
        for (let i = 1; i <= Math.min(n, 60); i++) {
          if (!el.isConnected) return;
          try {
            const page = await pdf.getPage(i);
            const scale = 140 / page.getViewport({ scale: 1 }).width;
            const canvas = await renderPage(pdf, i, scale);
            el.querySelector(`[data-thumb="${i}"]`)?.appendChild(canvas);
          } catch { /* 썸네일 실패는 무시 */ }
        }
      })();
    },
  );
}

// ---------- 학습 ----------
// review=true: 오답 확인 모드. 틀렸던 카드만 연습하고 주기·이력은 바꾸지 않음
async function viewStudy(deckId, review = false) {
  const now = Date.now();
  let cards = deckId ? await db.cardsByDeck(deckId) : await db.all('cards');
  const deck = deckId ? await db.get('decks', deckId) : null;
  const backTo = deckId ? `#/deck/${deckId}` : '#/';
  let queue;
  if (review) {
    // 다음 테스트가 가까운 순
    queue = cards.filter(isWrong).sort((a, b) => a.nextDue - b.nextDue);
  } else {
    // 복습 대상(오래 기다린 순) → 새 카드(만든 순)
    const reviews = cards.filter((c) => c.nextDue != null && c.nextDue <= now).sort((a, b) => a.nextDue - b.nextDue);
    const fresh = cards.filter((c) => c.nextDue == null).sort((a, b) => a.createdAt - b.createdAt);
    queue = [...reviews, ...fresh];
  }
  const stats = { correct: 0, wrong: 0 };
  let idx = 0;

  const finish = (message) => {
    const note = review ? '오답 확인 결과는 암기 주기에 반영되지 않습니다.' : '오답 카드는 6시간 후 다시 학습 대상이 됩니다.';
    const empty = review ? '틀린 카드가 없습니다.' : `${deck ? esc(deck.name) + ' · ' : ''}지금 학습할 카드가 없습니다.`;
    setView(`
      <main class="content center">
        <div class="done-emoji">${review && !(stats.correct + stats.wrong) ? '👍' : '🎉'}</div>
        <h1 class="done-title">${message}</h1>
        ${stats.correct + stats.wrong ? `<p class="done-stats"><span class="ok">정답 ${stats.correct}</span> · <span class="ng">오답 ${stats.wrong}</span></p>
          <p class="muted">${note}</p>` : `<p class="muted">${empty}</p>`}
      </main>
      <footer class="bottombar"><button class="btn btn-lg btn-primary grow" data-act="home">돌아가기</button></footer>`);
    $('[data-act=home]').onclick = () => go(backTo);
  };

  if (!queue.length) return finish(review ? '오답 확인' : '오늘 학습 완료');

  const faceHTML = async (face, label) => {
    let html = `<div class="study-face">${label ? `<div class="face-label">${label}</div>` : ''}`;
    if ((face.text || '').trim()) html += `<div class="study-text">${esc(face.text)}</div>`;
    for (const a of face.attachments || []) {
      const file = await db.get('files', a.id);
      if (!file) continue;
      const url = objURL(file.blob);
      html += a.type.startsWith('image/')
        ? `<img class="study-img" src="${url}" alt="${esc(a.name)}" data-open="${url}">`
        : `<button type="button" class="pdf-chip" data-open="${url}">📄 ${esc(a.name)}</button>`;
    }
    return html + '</div>';
  };

  const show = async () => {
    if (idx >= queue.length) return finish(review ? '오답 확인 완료' : '학습 완료');
    const card = queue[idx];
    const hasBack2 = !isEmptyFace(card.back2);
    const [front, b1, b2] = await Promise.all([
      faceHTML(card.front, ''),
      faceHTML(card.back1, hasBack2 ? '뒷면 1' : ''),
      hasBack2 ? faceHTML(card.back2, '뒷면 2') : '',
    ]);
    setView(`
      <header class="topbar study-top">
        <div class="progress-wrap">
          <div class="progress-text" data-testid="progress">${review ? '<span class="mode-tag">오답 확인</span>' : ''}${idx + 1} / ${queue.length}</div>
          <div class="bar"><i style="width:${(idx / queue.length) * 100}%"></i></div>
        </div>
        <button class="btn btn-sm" data-act="quit">종료</button>
      </header>
      <main class="content study" data-stage="front">
        <div class="study-card" data-act="reveal">
          ${card.nextDue == null ? '<span class="badge badge-new">새 카드</span>' : ''}
          ${front}
          <div class="back" hidden><hr>${b1}${b2}</div>
          <p class="tap-hint">화면을 탭하면 정답을 확인합니다</p>
        </div>
      </main>
      <footer class="bottombar study-actions" hidden></footer>`);

    const actions = $('.study-actions');
    const stageJudge = () => {
      actions.hidden = false;
      actions.innerHTML = `
        <button class="btn btn-lg btn-wrong grow" data-act="wrong">오답</button>
        <button class="btn btn-lg btn-right grow" data-act="right">정답</button>`;
      if (review) {
        $('[data-act=wrong]').onclick = () => practice(false);
        $('[data-act=right]').onclick = () => practice(true);
        return;
      }
      $('[data-act=wrong]').onclick = () => answer(card, false, '6h');
      $('[data-act=right]').onclick = stageInterval;
    };
    const stageInterval = () => {
      actions.innerHTML = `
        <div class="interval-box">
          <div class="interval-head"><span>다음 테스트는 언제?</span><button class="btn btn-sm" data-act="undo">← 뒤로</button></div>
          <div class="interval-grid">${INTERVALS.map((i) => `<button class="btn btn-lg" data-iv="${i.key}">${i.btn}</button>`).join('')}</div>
        </div>`;
      $('[data-act=undo]').onclick = stageJudge;
      $$('[data-iv]').forEach((b) => { b.onclick = () => answer(card, true, b.dataset.iv); });
    };

    const studyCard = $('[data-act=reveal]');
    studyCard.onclick = (e) => {
      const open = e.target.closest('[data-open]');
      const revealed = !$('.back').hidden;
      if (open && (revealed || open.classList.contains('pdf-chip'))) { window.open(open.dataset.open, '_blank'); return; }
      if (revealed) return;
      $('.back').hidden = false;
      $('.tap-hint').hidden = true;
      $('.study').dataset.stage = 'back';
      stageJudge();
    };
    $('[data-act=quit]').onclick = () => go(backTo);
  };

  // 오답 확인: 결과만 세고 카드·이력은 저장하지 않음
  const practice = (correct) => {
    stats[correct ? 'correct' : 'wrong']++;
    idx++;
    show();
  };

  let busy = false;
  const answer = async (card, correct, key) => {
    if (busy) return;
    busy = true;
    const at = Date.now();
    const updated = { ...card, nextDue: at + INTERVAL[key].ms, lastInterval: key, lastResult: correct, reviewCount: (card.reviewCount || 0) + 1 };
    await db.put('cards', updated);
    await db.put('history', { id: uid(), cardId: card.id, deckId: card.deckId, at, correct, interval: key });
    stats[correct ? 'correct' : 'wrong']++;
    idx++;
    busy = false;
    show();
  };

  show();
}

// ---------- 설정 ----------
async function viewSettings() {
  const [decks, cards, files, history] = await Promise.all(['decks', 'cards', 'files', 'history'].map((s) => db.all(s)));
  const bytes = files.reduce((s, f) => s + (f.blob?.size || 0), 0);
  setView(`
    <header class="topbar">
      <button class="icon-btn" data-act="back" aria-label="뒤로">←</button>
      <h1 class="title">설정</h1>
    </header>
    <main class="content">
      <section class="panel">
        <h2 class="section-title">저장된 데이터</h2>
        <p>과목 ${decks.length} · 카드 ${cards.length} · 첨부 ${files.length}개 (${bytes < 1048576 ? `${Math.ceil(bytes / 1024)}KB` : `${(bytes / 1048576).toFixed(1)}MB`}) · 학습 기록 ${history.length}건</p>
        <p class="muted small">모든 데이터는 이 기기의 브라우저에만 저장됩니다. 주기적으로 백업하세요.</p>
      </section>
      <section class="panel">
        <h2 class="section-title">백업</h2>
        <p class="muted small">과목, 카드, 첨부 원본(이미지·PDF), 학습 기록을 JSON 파일 하나로 내보냅니다.</p>
        <button class="btn btn-lg btn-primary full" data-act="export">백업 파일 내보내기</button>
      </section>
      <section class="panel">
        <h2 class="section-title">복원</h2>
        <p class="muted small">백업 파일을 불러오면 현재 데이터가 모두 백업 내용으로 교체됩니다.</p>
        <label class="btn btn-lg full">백업 파일 가져오기<input type="file" accept="application/json,.json" hidden data-act="import"></label>
      </section>
    </main>`);

  $('[data-act=back]').onclick = () => go('#/');
  $('[data-act=export]').onclick = async (e) => {
    e.target.disabled = true;
    try {
      const data = await exportAll();
      const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
      const d = new Date();
      const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `암기카드-백업-${stamp}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      toast('백업 파일을 내보냈습니다');
    } finally {
      e.target.disabled = false;
    }
  };
  $('[data-act=import]').onchange = async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (!(await confirmDlg(`백업(과목 ${data.decks?.length ?? 0}, 카드 ${data.cards?.length ?? 0})으로 현재 데이터를 모두 교체할까요?`, '복원', true))) return;
      await importAll(data);
      toast('복원했습니다');
      viewSettings();
    } catch (err) {
      toast(`복원 실패: ${err.message}`);
    }
  };
}

// ---------- 라우터 ----------
const routes = [
  [/^#?\/?$/, () => viewHome()],
  [/^#\/deck\/([\w-]+)$/, (m) => viewDeck(m[1])],
  [/^#\/card\/new\/([\w-]+)$/, (m) => viewEditor(null, m[1])],
  [/^#\/card\/edit\/([\w-]+)$/, (m) => viewEditor(m[1])],
  [/^#\/study(?:\/([\w-]+))?$/, (m) => viewStudy(m[1])],
  [/^#\/review$/, () => viewStudy(null, true)],
  [/^#\/settings$/, () => viewSettings()],
];

function route() {
  document.querySelectorAll('.modal-bg').forEach((m) => m.remove());
  const hash = location.hash || '#/';
  for (const [re, fn] of routes) {
    const m = hash.match(re);
    if (m) {
      fn(m).catch((err) => { console.error(err); toast(`오류: ${err.message}`); });
      return;
    }
  }
  go('#/');
}

window.addEventListener('hashchange', route);
route();

navigator.storage?.persist?.().catch(() => {});
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}
