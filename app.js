// ============================================================
// Приложение: словарь + повторение по уровням (SRS) + письмо + статистика.
// Никакого бэкенда — всё живёт в localStorage (см. storage.js).
// Уровень 4 (письмо) обращается к Claude API напрямую из браузера.
// ============================================================

let dictState = { searchTerm: '', activeCategory: null, activeType: null, sortMode: 'new' };
let sessionDirection = 'kr-ru'; // 'kr-ru' | 'ru-kr' | 'mixed'
let studySession = null; // { queue, index, correct, reviewed }
let writingSession = null; // { category, words }
let currentEditId = null;
let currentHanjaEntries = []; // [{ char, meaningInWord }] — рабочая копия, пока открыта модалка слова
let toastTimer = null;
let hanjaDetailChar = null;

const CLAUDE_MODEL = 'claude-haiku-4-5';
const BACKUP_REMINDER_THRESHOLD = 8;
const AUTO_SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000;

// ---------- helpers ----------

function esc(str) {
  const d = document.createElement('div');
  d.textContent = str == null ? '' : String(str);
  return d.innerHTML;
}

function pluralizeSlovo(n) {
  const mod10 = n % 10, mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 14) return 'слов';
  if (mod10 === 1) return 'слово';
  if (mod10 >= 2 && mod10 <= 4) return 'слова';
  return 'слов';
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function showToast(msg) {
  const toast = document.getElementById('toast');
  toast.textContent = msg;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.hidden = true; }, 2400);
}

// ---------- text-to-speech (произношение корейских слов) ----------

function pickKoreanVoice() {
  if (!('speechSynthesis' in window)) return null;
  const voices = window.speechSynthesis.getVoices();
  return voices.find(v => v.lang === 'ko-KR') || voices.find(v => v.lang && v.lang.toLowerCase().startsWith('ko')) || null;
}

// Голоса в некоторых браузерах (Chrome) подгружаются асинхронно, поэтому
// проверяем сразу и повторно по событию voiceschanged — до этого прячем кнопки,
// чтобы не показывать 🔊, который ничего не сделает.
function initSpeech() {
  if (!('speechSynthesis' in window)) {
    document.body.classList.add('no-kr-voice');
    return;
  }
  const refresh = () => {
    document.body.classList.toggle('no-kr-voice', !pickKoreanVoice());
  };
  document.body.classList.add('no-kr-voice');
  refresh();
  window.speechSynthesis.addEventListener('voiceschanged', refresh);
}

function speakKorean(text) {
  if (!('speechSynthesis' in window) || !text) return;
  const voice = pickKoreanVoice();
  if (!voice) return;
  window.speechSynthesis.cancel();
  const utter = new SpeechSynthesisUtterance(text);
  utter.voice = voice;
  utter.lang = voice.lang;
  window.speechSynthesis.speak(utter);
}

function speakBtnHtml(korean) {
  return `<button type="button" class="speak-btn" data-speak="${esc(korean)}" title="Прослушать произношение" aria-label="Прослушать произношение">🔊</button>`;
}

// ---------- navigation ----------

function switchView(view) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.getElementById('view-' + view).classList.add('active');
  document.querySelectorAll('.nav-btn[data-view], .mobile-tab[data-view]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.view === view);
  });
  if (view === 'dictionary') renderDictionary();
  if (view === 'study') updateStudyIntro();
  if (view === 'stats') renderStats();
  if (view === 'hanja') renderHanjaTab();
  if (view === 'data') renderDataView();
}

// ---------- theme ----------

function getEffectiveTheme() {
  const state = Storage.getState();
  if (state.theme) return state.theme;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function updateThemeIcon() {
  document.getElementById('theme-toggle').textContent = getEffectiveTheme() === 'dark' ? '☀️' : '🌙';
}

function initTheme() {
  const state = Storage.getState();
  if (state.theme) document.documentElement.setAttribute('data-theme', state.theme);
  updateThemeIcon();
}

function toggleTheme() {
  const next = getEffectiveTheme() === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  const state = Storage.getState();
  state.theme = next;
  Storage.saveState(state);
  updateThemeIcon();
}

// ---------- dictionary ----------

function matchesSearch(w, term) {
  if (!term) return true;
  const t = term.toLowerCase();
  return [w.korean, w.translation, w.transcription, w.category, w.wordType, w.notes, ...(w.examples || [])]
    .some(f => (f || '').toLowerCase().includes(t));
}

function renderCategoryChips(words) {
  const categories = [...new Set(words.map(w => w.category).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ko'));
  const wrap = document.getElementById('category-chips');
  if (categories.length === 0) { wrap.innerHTML = ''; return; }
  const chips = [{ label: 'Все', value: null }, ...categories.map(c => ({ label: c, value: c }))];
  wrap.innerHTML = chips.map(c =>
    `<button class="chip ${dictState.activeCategory === c.value ? 'active' : ''}" data-cat="${esc(c.value || '')}">${esc(c.label)}</button>`
  ).join('');
  wrap.querySelectorAll('.chip').forEach(btn => {
    btn.addEventListener('click', () => {
      dictState.activeCategory = btn.dataset.cat || null;
      renderDictionary();
    });
  });
}

function renderTypeChips(words) {
  const types = [...new Set(words.map(w => w.wordType).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ru'));
  const wrap = document.getElementById('type-chips');
  if (types.length === 0) { wrap.innerHTML = ''; return; }
  const chips = [{ label: 'Все типы', value: null }, ...types.map(t => ({ label: t, value: t }))];
  wrap.innerHTML = chips.map(c =>
    `<button class="chip ${dictState.activeType === c.value ? 'active' : ''}" data-type="${esc(c.value || '')}">${esc(c.label)}</button>`
  ).join('');
  wrap.querySelectorAll('.chip').forEach(btn => {
    btn.addEventListener('click', () => {
      dictState.activeType = btn.dataset.type || null;
      renderDictionary();
    });
  });
}

function levelBadge(w) {
  if (SRS.isLearned(w)) return { label: 'выучено', mastered: true };
  if (w.srs.totalReviews === 0) return { label: 'новое', mastered: false };
  return { label: `учу · ур.${w.srs.stage}`, mastered: false };
}

function renderWordCard(w) {
  const badge = levelBadge(w);
  const firstExample = (w.examples || [])[0];
  return `
    <div class="word-card" data-id="${w.id}">
      <div class="word-card-top">
        <div>
          <div class="word-kr">${esc(w.korean)}${speakBtnHtml(w.korean)}</div>
          ${w.transcription ? `<div class="word-tr">${esc(w.transcription)}</div>` : ''}
        </div>
        <span class="word-level ${badge.mastered ? 'mastered' : ''}">${badge.label}</span>
      </div>
      <div class="word-translation">${esc(w.translation)}</div>
      <div class="word-tags">
        ${w.category ? `<span class="word-category">${esc(w.category)}</span>` : ''}
        ${w.wordType ? `<span class="word-type">${esc(w.wordType)}</span>` : ''}
      </div>
      ${firstExample ? `<div class="word-example">${esc(firstExample)}</div>` : ''}
    </div>
  `;
}

function renderDictionary() {
  const all = Storage.getWords();
  document.getElementById('dict-count').textContent = `${all.length} ${pluralizeSlovo(all.length)}`;

  document.getElementById('empty-state').hidden = all.length !== 0;

  renderCategoryChips(all);
  renderTypeChips(all);

  let filtered = all.filter(w => matchesSearch(w, dictState.searchTerm)
    && (!dictState.activeCategory || w.category === dictState.activeCategory)
    && (!dictState.activeType || w.wordType === dictState.activeType));

  switch (dictState.sortMode) {
    case 'old': filtered.sort((a, b) => a.createdAt - b.createdAt); break;
    case 'az': filtered.sort((a, b) => a.korean.localeCompare(b.korean, 'ko')); break;
    case 'hard': filtered.sort((a, b) => {
      if (a.srs.learned !== b.srs.learned) return a.srs.learned ? 1 : -1; // невыученные считаем "сложнее"
      if (!a.srs.learned) return a.srs.stage - b.srs.stage;
      return (a.srs.reviewStep - b.srs.reviewStep) || ((a.srs.nextReviewDate || 0) - (b.srs.nextReviewDate || 0));
    }); break;
    default: filtered.sort((a, b) => b.createdAt - a.createdAt);
  }

  const list = document.getElementById('word-list');
  if (all.length === 0) {
    list.innerHTML = '';
  } else if (filtered.length === 0) {
    list.innerHTML = `<p class="hint-text">Ничего не найдено по этому запросу.</p>`;
  } else {
    list.innerHTML = filtered.map(renderWordCard).join('');
    list.querySelectorAll('.word-card').forEach(card => {
      card.addEventListener('click', (e) => {
        if (e.target.closest('.speak-btn')) return;
        const word = Storage.getWords().find(w => w.id === card.dataset.id);
        if (word) openWordModal(word);
      });
    });
  }

  refreshNavBadges();
}

// ---------- word modal ----------

function fillCategoryDatalist() {
  const categories = [...new Set(Storage.getWords().map(w => w.category).filter(Boolean))].sort();
  document.getElementById('category-list').innerHTML = categories.map(c => `<option value="${esc(c)}">`).join('');
}

const RELATION_LABELS = { synonym: 'Синоним', antonym: 'Антоним', similar: 'Похоже по форме' };

function renderRelatedList(word) {
  const wrap = document.getElementById('related-list');
  const related = word.related || [];
  if (related.length === 0) {
    wrap.innerHTML = '<p class="hint-text" style="margin:0 0 10px;">Пока нет связанных слов.</p>';
    return;
  }
  const allWords = Storage.getWords();
  wrap.innerHTML = related.map(r => {
    const target = allWords.find(w => w.id === r.id);
    if (!target) return '';
    return `
      <div class="related-row">
        <span class="related-tag">${esc(RELATION_LABELS[r.relation] || r.relation)}</span>
        <button type="button" class="related-link" data-jump="${target.id}">${esc(target.korean)} — ${esc(target.translation)}</button>
        <button type="button" class="related-remove" data-unlink="${target.id}" title="Убрать связь">✕</button>
      </div>
    `;
  }).join('');
}

function fillRelatedWordSelect(word) {
  const sel = document.getElementById('f-related-word');
  const linkedIds = new Set((word.related || []).map(r => r.id));
  const options = Storage.getWords()
    .filter(w => w.id !== word.id && !linkedIds.has(w.id))
    .sort((a, b) => a.korean.localeCompare(b.korean, 'ko'))
    .map(w => `<option value="${w.id}">${esc(w.korean)} — ${esc(w.translation)}</option>`);
  sel.innerHTML = options.length ? options.join('') : '<option value="">Нет доступных слов</option>';
}

function renderHanjaList() {
  const wrap = document.getElementById('hanja-list');
  if (currentHanjaEntries.length === 0) {
    wrap.innerHTML = '<p class="hint-text" style="margin:0 0 10px;">Ханча не добавлена.</p>';
    return;
  }
  wrap.innerHTML = currentHanjaEntries.map((h, i) => `
    <div class="related-row">
      <span class="hanja-char-tag">${esc(h.char)}</span>
      <span class="hanja-meaning-text">${esc(h.meaningInWord)}</span>
      <button type="button" class="related-remove" data-remove-hanja-index="${i}" title="Убрать">✕</button>
    </div>
  `).join('');
}

// Подсказки по слогам корейского слова — ищем в базе иероглиф с таким чтением.
// Ничего не добавляется само: клик по подсказке только заполняет поля формы.
function renderHanjaSuggestions() {
  const wrap = document.getElementById('hanja-suggestions');
  const korean = document.getElementById('f-korean').value;
  const usedChars = new Set(currentHanjaEntries.map(h => h.char));
  const syllables = [...new Set(korean.split('').filter(ch => /[가-힣]/.test(ch)))];
  const db = Storage.getHanjaDatabase();
  const suggestions = [];
  syllables.forEach(syl => {
    db.filter(h => h.reading === syl && !usedChars.has(h.char)).slice(0, 3).forEach(h => suggestions.push(h));
  });
  if (suggestions.length === 0) { wrap.innerHTML = ''; return; }
  wrap.innerHTML = suggestions.map(h =>
    `<button type="button" class="hanja-suggestion-chip" data-suggest-char="${esc(h.char)}" data-suggest-reading="${esc(h.reading)}" data-suggest-meaning="${esc(h.meaning)}">${esc(h.reading)} → ${esc(h.char)} (${esc(h.meaning)})</button>`
  ).join('');
}

function updateHanjaCharInput() {
  const char = document.getElementById('f-hanja-char').value.trim();
  const readingInput = document.getElementById('f-hanja-reading');
  const meaningInput = document.getElementById('f-hanja-meaning');
  if (!char) { readingInput.hidden = true; return; }
  const found = Storage.findHanja(char);
  if (found) {
    readingInput.hidden = true;
    if (!meaningInput.value) meaningInput.value = found.meaning;
  } else {
    readingInput.hidden = false;
  }
}

function handleAddHanja() {
  const char = document.getElementById('f-hanja-char').value.trim();
  const reading = document.getElementById('f-hanja-reading').value.trim();
  const meaning = document.getElementById('f-hanja-meaning').value.trim();
  if (!char || !meaning) return;

  if (!Storage.findHanja(char)) {
    if (!reading) { showToast('Укажи чтение — этого иероглифа ещё нет в базе'); return; }
    Storage.upsertCustomHanja(char, reading, meaning);
  }

  currentHanjaEntries.push({ char, meaningInWord: meaning });
  renderHanjaList();
  document.getElementById('f-hanja-char').value = '';
  document.getElementById('f-hanja-reading').value = '';
  document.getElementById('f-hanja-reading').hidden = true;
  document.getElementById('f-hanja-meaning').value = '';
  renderHanjaSuggestions();
}

function openWordModal(word) {
  currentEditId = word ? word.id : null;
  document.getElementById('word-modal-title').textContent = word ? 'Редактировать слово' : 'Новое слово';
  document.getElementById('f-id').value = word ? word.id : '';
  document.getElementById('f-korean').value = word ? word.korean : '';
  document.getElementById('f-translation').value = word ? word.translation : '';
  document.getElementById('f-transcription').value = word ? word.transcription : '';
  document.getElementById('f-category').value = word ? word.category : '';
  document.getElementById('f-word-type').value = word ? (word.wordType || '') : '';
  document.getElementById('f-examples').value = word ? (word.examples || []).join('\n') : '';
  document.getElementById('f-notes').value = word ? word.notes : '';
  document.getElementById('btn-delete-word').hidden = !word;

  document.getElementById('related-field').hidden = !word;
  if (word) {
    renderRelatedList(word);
    fillRelatedWordSelect(word);
  }

  currentHanjaEntries = word ? [...(word.hanja || [])] : [];
  document.getElementById('f-hanja-char').value = '';
  document.getElementById('f-hanja-reading').value = '';
  document.getElementById('f-hanja-reading').hidden = true;
  document.getElementById('f-hanja-meaning').value = '';
  renderHanjaList();
  renderHanjaSuggestions();

  fillCategoryDatalist();
  document.getElementById('word-modal-overlay').hidden = false;
  document.getElementById('f-korean').focus();
}

function closeWordModal() {
  document.getElementById('word-modal-overlay').hidden = true;
  document.getElementById('word-form').reset();
  currentEditId = null;
  currentHanjaEntries = [];
}

function handleWordFormSubmit(e) {
  e.preventDefault();
  const payload = {
    korean: document.getElementById('f-korean').value,
    translation: document.getElementById('f-translation').value,
    transcription: document.getElementById('f-transcription').value,
    category: document.getElementById('f-category').value,
    wordType: document.getElementById('f-word-type').value,
    hanja: currentHanjaEntries,
    examples: document.getElementById('f-examples').value.split('\n').map(s => s.trim()).filter(Boolean),
    notes: document.getElementById('f-notes').value,
  };
  if (!payload.korean.trim() || !payload.translation.trim()) return;

  if (currentEditId) {
    Storage.updateWord(currentEditId, payload);
    showToast('Слово обновлено');
  } else {
    Storage.addWord(payload);
    showToast('Слово добавлено');
  }
  closeWordModal();
  renderDictionary();
}

function handleDeleteWord() {
  if (!currentEditId) return;
  if (!confirm('Удалить это слово из словаря?')) return;
  Storage.deleteWord(currentEditId);
  closeWordModal();
  renderDictionary();
  showToast('Слово удалено');
}

// ---------- bulk add ----------

// "韓=Корея,食:식=еда" -> [{char:'韓', meaningInWord:'Корея', explicitReading:''}, {char:'食', meaningInWord:'еда', explicitReading:'식'}]
// "иероглиф:чтение=значение" — чтение нужно только если иероглифа ещё нет в базе.
function parseHanjaField(raw) {
  if (!raw) return [];
  return raw.split(',').map(s => s.trim()).filter(Boolean).map(entry => {
    const eqIdx = entry.indexOf('=');
    if (eqIdx === -1) return null;
    const left = entry.slice(0, eqIdx).trim();
    const meaningInWord = entry.slice(eqIdx + 1).trim();
    if (!left || !meaningInWord) return null;
    const colonIdx = left.indexOf(':');
    const char = (colonIdx === -1 ? left : left.slice(0, colonIdx)).trim();
    const explicitReading = colonIdx === -1 ? '' : left.slice(colonIdx + 1).trim();
    if (!char) return null;
    return { char, meaningInWord, explicitReading };
  }).filter(Boolean);
}

function parseBulkLine(line) {
  const parts = line.split(';').map(p => p.trim());
  const [korean, translation, transcription, category, wordType, hanjaRaw, examplesRaw] = parts;
  if (!korean || !translation) return { ok: false, line };
  const examples = examplesRaw ? examplesRaw.split('|').map(s => s.trim()).filter(Boolean) : [];
  const hanja = parseHanjaField(hanjaRaw);
  return { ok: true, korean, translation, transcription, category, wordType, hanja, examples };
}

function renderBulkPreview() {
  const raw = document.getElementById('bulk-input').value;
  const lines = raw.split('\n').map(l => l.trim()).filter(Boolean);
  const parsed = lines.map(parseBulkLine);
  const okCount = parsed.filter(p => p.ok).length;
  const errCount = parsed.length - okCount;
  const preview = document.getElementById('bulk-preview');
  if (lines.length === 0) { preview.innerHTML = ''; return; }
  preview.innerHTML =
    `<div><strong>Будет добавлено: ${okCount}</strong>${errCount ? `, ошибок: ${errCount}` : ''}</div>` +
    parsed.filter(p => !p.ok).map(p => `<div class="bulk-preview-row err">⚠ пропущена строка: "${esc(p.line)}"</div>`).join('');
}

function openBulkModal() {
  document.getElementById('bulk-input').value = '';
  document.getElementById('bulk-preview').innerHTML = '';
  document.getElementById('bulk-modal-overlay').hidden = false;
}

function closeBulkModal() {
  document.getElementById('bulk-modal-overlay').hidden = true;
}

function handleBulkSubmit() {
  const raw = document.getElementById('bulk-input').value;
  const lines = raw.split('\n').map(l => l.trim()).filter(Boolean);
  const parsed = lines.map(parseBulkLine).filter(p => p.ok);
  parsed.forEach(p => {
    // Иероглиф без чтения, которого ещё нет в базе, регистрируем сразу с этим
    // чтением; если чтения не дали — слово всё равно получит свою ханчу, просто
    // во вкладке «Иероглифика» она пока покажется без чтения из общей базы.
    p.hanja.forEach(h => {
      if (h.explicitReading && !Storage.findHanja(h.char)) {
        Storage.upsertCustomHanja(h.char, h.explicitReading, h.meaningInWord);
      }
    });
    Storage.addWord({
      ...p,
      hanja: p.hanja.map(h => ({ char: h.char, meaningInWord: h.meaningInWord })),
    });
  });
  closeBulkModal();
  renderDictionary();
  showToast(`Добавлено слов: ${parsed.length}`);
}

// ---------- study: mode switch (Слова / Письмо) ----------

function switchStudyMode(mode) {
  document.querySelectorAll('#study-mode-switch button').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
  document.getElementById('study-words-mode').hidden = mode !== 'words';
  document.getElementById('study-writing-mode').hidden = mode !== 'writing';
  if (mode === 'writing') renderWritingIntro();
}

// ---------- study: new words (daily batch) + spaced-repetition review ----------

function refreshNavBadges() {
  const words = Storage.getWords();
  const dueCount = words.filter(w => SRS.isReviewDue(w)).length;
  const dueBadge = document.getElementById('due-badge');
  const dueBadgeMobile = document.getElementById('due-badge-mobile');
  [dueBadge, dueBadgeMobile].forEach(el => {
    el.textContent = dueCount;
    el.hidden = dueCount === 0;
  });

  const state = Storage.getState();
  const backup = state.backup || { lastBackupAt: null, changesSinceBackup: 0 };
  const needsBackup = words.length > 0 && (backup.changesSinceBackup >= BACKUP_REMINDER_THRESHOLD || (!backup.lastBackupAt && words.length >= 5));
  document.getElementById('backup-dot').hidden = !needsBackup;
}

// Дневная пачка новых слов — следующие N (по порядку добавления) невыученных
// слов, которые не входят ни в какую предыдущую пачку. Пачка "закрепляется":
// пока в ней остаётся хоть одно невыученное слово, повторные вызовы отдают
// тот же набор — новая пачка формируется только когда предыдущая полностью
// пройдена (все её слова получили srs.learned = true).
// Возвращает { active: ещё не выученные слова пачки, all: вся пачка целиком }.
function ensureDailyBatch(words, dailyGoal) {
  const inProgress = words.filter(w => w.srs.inDailyBatch && !w.srs.learned);
  if (inProgress.length > 0) {
    return { active: inProgress, all: words.filter(w => w.srs.inDailyBatch) };
  }

  // Прошлая пачка (если была) полностью выучена. Снимаем с неё флаг в любом
  // случае — она своё отработала, — но новую назначаем только если в базе
  // вообще остались невыученные слова, иначе блок "Учить новые" просто
  // скроется (см. updateStudyIntro), а не покажет пустую "0 из 0".
  const hadBatch = words.some(w => w.srs.inDailyBatch);
  if (hadBatch) {
    words.filter(w => w.srs.inDailyBatch).forEach(w => {
      Storage.updateWord(w.id, { srs: { ...w.srs, inDailyBatch: false } });
    });
  }

  const candidates = Storage.getWords()
    .filter(w => !w.srs.learned)
    .sort((a, b) => a.createdAt - b.createdAt)
    .slice(0, dailyGoal);
  if (candidates.length === 0) return { active: [], all: [] };

  candidates.forEach(w => {
    Storage.updateWord(w.id, { srs: { ...w.srs, inDailyBatch: true } });
  });

  const batchWords = Storage.getWords().filter(w => w.srs.inDailyBatch);
  return { active: batchWords.filter(w => !w.srs.learned), all: batchWords };
}

function updateStudyIntro() {
  const words = Storage.getWords();
  const state = Storage.getState();
  const dailyGoal = state.dailyGoal || 15;

  const reviewDue = words.filter(w => SRS.isReviewDue(w));
  const { all: batchAll } = ensureDailyBatch(words, dailyGoal);

  document.getElementById('review-block').hidden = reviewDue.length === 0;
  document.getElementById('review-due-count').textContent = reviewDue.length;
  document.getElementById('review-due-word').textContent = pluralizeSlovo(reviewDue.length);

  document.getElementById('new-words-block').hidden = batchAll.length === 0;
  if (batchAll.length > 0) {
    // Счётчик — сколько слов выучено сегодня СУММАРНО за день (см. Storage.logWordLearned),
    // а не сколько выучено именно в текущей пачке — иначе он обнулялся бы при
    // переходе к новой пачке в тот же день. Цель (знаменатель) — всегда
    // актуальная дневная цель, а не размер уже сформированной пачки, чтобы
    // смена цели сразу отражалась в счётчике.
    const learnedToday = (state.dailyLearnedLog || {})[todayStr()] || 0;
    document.getElementById('daily-progress-label').textContent = `${learnedToday} из ${dailyGoal}`;
  }
  document.querySelectorAll('#daily-goal button').forEach(b => {
    b.classList.toggle('active', parseInt(b.dataset.goal, 10) === dailyGoal);
  });

  document.getElementById('empty-dict-hint').hidden = words.length !== 0;
  document.getElementById('all-learned-hint').hidden = !(words.length > 0 && batchAll.length === 0 && reviewDue.length === 0);

  const subtitle = document.getElementById('study-subtitle');
  if (words.length === 0) subtitle.textContent = 'Сначала добавь слова в словарь';
  else if (reviewDue.length === 0 && batchAll.length === 0) subtitle.textContent = 'Всё сделано — загляни попозже';
  else subtitle.textContent = 'Выбери, с чего начать';

  document.getElementById('study-intro').hidden = false;
  document.getElementById('study-session').hidden = true;
  document.getElementById('study-summary').hidden = true;
  refreshNavBadges();
}

// Новые слова: стадия 1 — карточка, стадия 2 — выбор перевода. После стадии 2
// слово выпускается в очередь повторения (см. SRS.gradeNewWord).
function pickNewWordCardMode(word, allWords) {
  const stage = word.srs.stage;
  if (stage <= 1) return 'flash';

  const otherTranslations = new Set(
    allWords.filter(w => w.id !== word.id && w.translation !== word.translation).map(w => w.translation)
  );
  const canQuiz = otherTranslations.size >= 3;

  if (stage === 2) return canQuiz ? 'quiz' : 'flash';

  // stage 3: вставить слово в предложение
  const usableExamples = (word.examples || []).filter(ex => ex.includes(word.korean));
  const otherKoreans = new Set(allWords.filter(w => w.id !== word.id && w.korean !== word.korean).map(w => w.korean));
  if (usableExamples.length > 0 && otherKoreans.size >= 3) return 'fillblank';
  return canQuiz ? 'quiz' : 'flash';
}

// Повторение: чередуем выбор перевода и вставку слова в предложение — оба дают
// чистый верно/неверно для SRS.gradeReview. Флешкарта — запасной вариант для
// совсем маленького словаря, где не набрать вариантов для quiz/fillblank.
function pickReviewCardMode(word, allWords) {
  const usableExamples = (word.examples || []).filter(ex => ex.includes(word.korean));
  const otherKoreans = new Set(allWords.filter(w => w.id !== word.id && w.korean !== word.korean).map(w => w.korean));
  const otherTranslations = new Set(allWords.filter(w => w.id !== word.id && w.translation !== word.translation).map(w => w.translation));
  const canFillblank = usableExamples.length > 0 && otherKoreans.size >= 3;
  const canQuiz = otherTranslations.size >= 3;
  if (canFillblank && canQuiz) return Math.random() < 0.5 ? 'fillblank' : 'quiz';
  if (canFillblank) return 'fillblank';
  if (canQuiz) return 'quiz';
  return 'flash';
}

function startNewWordSession() {
  const words = Storage.getWords();
  const state = Storage.getState();
  const { active } = ensureDailyBatch(words, state.dailyGoal || 15);
  if (active.length === 0) {
    showToast('Дневная пачка уже пройдена! 🎉');
    updateStudyIntro();
    return;
  }
  studySession = { type: 'new', queue: shuffle(active), index: 0, correct: 0, reviewed: 0 };
  document.getElementById('study-intro').hidden = true;
  document.getElementById('study-summary').hidden = true;
  document.getElementById('study-session').hidden = false;
  renderCurrentCard();
}

function startReviewSession() {
  const words = Storage.getWords();
  const due = shuffle(words.filter(w => SRS.isReviewDue(w)));
  if (due.length === 0) {
    showToast('Нет слов для повторения. Отличная работа! 🎉');
    return;
  }
  studySession = { type: 'review', queue: due, index: 0, correct: 0, reviewed: 0 };
  document.getElementById('study-intro').hidden = true;
  document.getElementById('study-summary').hidden = true;
  document.getElementById('study-session').hidden = false;
  renderCurrentCard();
}

function updateSessionProgress() {
  const { index, queue } = studySession;
  const pct = Math.round((index / queue.length) * 100);
  document.getElementById('session-progress-fill').style.width = pct + '%';
  document.getElementById('session-progress-label').textContent = `${Math.min(index + 1, queue.length)} / ${queue.length}`;
}

function renderCurrentCard() {
  updateSessionProgress();
  const word = studySession.queue[studySession.index];
  const allWords = Storage.getWords();
  const isReview = studySession.type === 'review';
  const mode = isReview ? pickReviewCardMode(word, allWords) : pickNewWordCardMode(word, allWords);
  const direction = sessionDirection === 'mixed' ? (Math.random() < 0.5 ? 'kr-ru' : 'ru-kr') : sessionDirection;
  const reverse = direction === 'ru-kr';
  const stageTag = isReview ? `повтор · шаг ${word.srs.reviewStep + 1}` : `новое · стадия ${word.srs.stage}`;
  const stage = document.getElementById('card-stage');

  if (mode === 'flash') {
    const frontHtml = reverse
      ? `<div class="kr-word" style="font-size:26px;">${esc(word.translation)}</div>`
      : `<div class="kr-word">${esc(word.korean)}${speakBtnHtml(word.korean)}</div>${word.transcription ? `<div class="kr-trans">${esc(word.transcription)}</div>` : ''}`;

    stage.innerHTML = `
      <div class="flashcard">
        <div class="card-category">${esc(stageTag)}${word.category ? ' · ' + esc(word.category) : ''}</div>
        ${frontHtml}
        <div id="card-answer-area">
          <button class="btn btn-ghost reveal-btn" id="btn-reveal">${reverse ? 'Показать слово' : 'Показать перевод'}</button>
        </div>
      </div>
    `;
    document.getElementById('btn-reveal').addEventListener('click', () => {
      const answerHtml = reverse
        ? `<div class="card-translation">${esc(word.korean)}${speakBtnHtml(word.korean)}</div>${word.transcription ? `<div class="kr-trans">${esc(word.transcription)}</div>` : ''}`
        : `<div class="card-translation">${esc(word.translation)}</div>`;
      document.getElementById('card-answer-area').innerHTML = `
        <div class="card-answer">
          ${answerHtml}
          ${word.examples && word.examples[0] ? `<div class="card-example">${esc(word.examples[0])}</div>` : ''}
          ${word.notes ? `<div class="card-notes">${esc(word.notes)}</div>` : ''}
        </div>
        <div class="grade-row">
          <button class="grade-btn grade-wrong" data-correct="false">❌<small>${isReview ? 'откат на шаг назад' : 'ещё раз позже'}</small></button>
          <button class="grade-btn grade-right" data-correct="true">✅<small>${isReview ? 'интервал растёт' : 'стадия выше'}</small></button>
        </div>
      `;
      document.querySelectorAll('.grade-btn').forEach(btn => {
        btn.addEventListener('click', () => gradeCurrent(btn.dataset.correct === 'true'));
      });
    });
  } else if (mode === 'quiz') {
    const distractorPool = allWords.filter(w => w.id !== word.id && w.translation !== word.translation);
    const correctOption = reverse ? word.korean : word.translation;
    const otherOptions = shuffle([...new Set(distractorPool.map(w => reverse ? w.korean : w.translation))]).slice(0, 3);
    const options = shuffle([correctOption, ...otherOptions]);
    const promptHtml = reverse
      ? `<div class="kr-trans" style="font-size:16px;">${esc(word.translation)}</div>`
      : `<div class="kr-word">${esc(word.korean)}${speakBtnHtml(word.korean)}</div>${word.transcription ? `<div class="kr-trans">${esc(word.transcription)}</div>` : ''}`;

    stage.innerHTML = `
      <div class="flashcard">
        <div class="card-category">${esc(stageTag)}${word.category ? ' · ' + esc(word.category) : ''}</div>
        ${promptHtml}
        <div class="quiz-options">
          ${options.map(opt => `<button class="quiz-option" data-opt="${esc(opt)}">${esc(opt)}</button>`).join('')}
        </div>
        <div class="quiz-feedback" id="quiz-feedback"></div>
      </div>
    `;

    const optionButtons = stage.querySelectorAll('.quiz-option');
    optionButtons.forEach(btn => {
      btn.addEventListener('click', () => {
        optionButtons.forEach(b => b.disabled = true);
        const isCorrect = btn.dataset.opt === correctOption;
        btn.classList.add(isCorrect ? 'correct' : 'wrong');
        if (!isCorrect) {
          optionButtons.forEach(b => { if (b.dataset.opt === correctOption) b.classList.add('correct'); });
        }
        const feedback = document.getElementById('quiz-feedback');
        feedback.innerHTML = isCorrect
          ? `Верно! ✓${reverse ? speakBtnHtml(correctOption) : ''}`
          : `Неверно — правильно: ${esc(correctOption)}${reverse ? speakBtnHtml(correctOption) : ''}`;
        feedback.classList.add(isCorrect ? 'correct' : 'wrong');
        setTimeout(() => gradeCurrent(isCorrect), 900);
      });
    });
  } else {
    // fillblank — вставить слово в предложение
    const usableExamples = word.examples.filter(ex => ex.includes(word.korean));
    const example = usableExamples[Math.floor(Math.random() * usableExamples.length)];
    const blanked = example.replace(word.korean, '_____');
    const otherKoreans = shuffle([...new Set(
      allWords.filter(w => w.id !== word.id && w.korean !== word.korean).map(w => w.korean)
    )]).slice(0, 3);
    const options = shuffle([word.korean, ...otherKoreans]);

    stage.innerHTML = `
      <div class="flashcard">
        <div class="card-category">${esc(stageTag)}${word.category ? ' · ' + esc(word.category) : ''}</div>
        <div class="fillblank-sentence">${esc(blanked)}</div>
        <div class="kr-trans">${esc(word.translation)}</div>
        <div class="quiz-options">
          ${options.map(opt => `<button class="quiz-option" data-opt="${esc(opt)}">${esc(opt)}</button>`).join('')}
        </div>
        <div class="quiz-feedback" id="quiz-feedback"></div>
      </div>
    `;

    const optionButtons = stage.querySelectorAll('.quiz-option');
    optionButtons.forEach(btn => {
      btn.addEventListener('click', () => {
        optionButtons.forEach(b => b.disabled = true);
        const isCorrect = btn.dataset.opt === word.korean;
        btn.classList.add(isCorrect ? 'correct' : 'wrong');
        if (!isCorrect) {
          optionButtons.forEach(b => { if (b.dataset.opt === word.korean) b.classList.add('correct'); });
        }
        const feedback = document.getElementById('quiz-feedback');
        feedback.innerHTML = isCorrect
          ? `Верно! ✓${speakBtnHtml(word.korean)}`
          : `Неверно — правильно: ${esc(word.korean)}${speakBtnHtml(word.korean)}`;
        feedback.classList.add(isCorrect ? 'correct' : 'wrong');
        setTimeout(() => gradeCurrent(isCorrect), 900);
      });
    });
  }
}

function gradeCurrent(isCorrect) {
  const word = studySession.queue[studySession.index];
  const newSrs = studySession.type === 'review' ? SRS.gradeReview(word, isCorrect) : SRS.gradeNewWord(word, isCorrect);
  Storage.updateWord(word.id, { srs: newSrs });
  if (studySession.type === 'new' && !word.srs.learned && newSrs.learned) {
    Storage.logWordLearned();
  }
  if (isCorrect) studySession.correct++;
  studySession.reviewed++;
  studySession.index++;
  if (studySession.index >= studySession.queue.length) {
    finishSession();
  } else {
    renderCurrentCard();
  }
}

function finishSession() {
  Storage.logReview(studySession.reviewed);
  document.getElementById('study-session').hidden = true;
  document.getElementById('study-summary').hidden = false;
  document.getElementById('summary-correct').textContent = studySession.correct;
  document.getElementById('summary-total').textContent = studySession.reviewed;
  refreshNavBadges();
}

// ---------- study: writing (level 4, Claude-graded) ----------

function renderWritingIntro() {
  document.getElementById('writing-session').hidden = true;
  document.getElementById('writing-intro').hidden = false;

  const words = Storage.getWords().filter(w => SRS.isWritingReady(w));
  const counts = {};
  words.forEach(w => {
    const cat = w.category || 'без темы';
    counts[cat] = (counts[cat] || 0) + 1;
  });
  const categories = Object.keys(counts).sort((a, b) => counts[b] - counts[a]);

  const wrap = document.getElementById('writing-category-chips');
  document.getElementById('writing-empty-hint').hidden = categories.length > 0;

  wrap.innerHTML = categories.map(cat =>
    `<button class="chip" data-cat="${esc(cat)}">${esc(cat)} (${counts[cat]})</button>`
  ).join('');
  wrap.querySelectorAll('.chip').forEach(btn => {
    btn.addEventListener('click', () => startWritingSession(btn.dataset.cat));
  });
}

function startWritingSession(category) {
  const words = Storage.getWords().filter(w => SRS.isWritingReady(w) && (w.category || 'без темы') === category);
  const picked = shuffle(words).slice(0, 4);
  writingSession = { category, words: picked };

  document.getElementById('writing-intro').hidden = true;
  document.getElementById('writing-session').hidden = false;
  document.getElementById('writing-category-label').textContent = category;
  document.getElementById('writing-words-list').innerHTML = picked.map(w =>
    `<span class="writing-word-chip"><b>${esc(w.korean)}</b>${esc(w.translation)}${w.transcription ? `<small>${esc(w.transcription)}</small>` : ''}</span>`
  ).join('');
  document.getElementById('writing-input').value = '';
  const result = document.getElementById('writing-result');
  result.hidden = true;
  result.innerHTML = '';
}

async function callClaudeWritingCheck(sentence, words, category) {
  const state = Storage.getState();
  if (!state.apiKey) {
    throw new Error('Сначала добавь Anthropic API-ключ в разделе «Данные».');
  }
  const wordList = words.map(w => `${w.korean} (${w.translation})`).join(', ');
  const prompt = `Ты — доброжелательный преподаватель корейского языка для русскоязычной студентки начального уровня.
Тема: "${category}". Студентка должна была написать предложение по-корейски, используя хотя бы часть этих слов: ${wordList}.

Предложение студентки: "${sentence}"

Проверь грамматику и уместность использования слов. Ответь по-русски, кратко и по-доброму.`;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': state.apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 500,
      output_config: {
        format: {
          type: 'json_schema',
          schema: {
            type: 'object',
            properties: {
              correct: { type: 'boolean', description: 'грамматически верно и слова использованы уместно' },
              feedback: { type: 'string', description: 'краткий комментарий по-русски' },
              corrected: { type: 'string', description: 'исправленный или образцовый вариант предложения по-корейски' },
            },
            required: ['correct', 'feedback', 'corrected'],
            additionalProperties: false,
          },
        },
      },
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Claude API вернул ошибку (${response.status}): ${body.slice(0, 200)}`);
  }

  const data = await response.json();
  const textBlock = (data.content || []).find(b => b.type === 'text');
  if (!textBlock) throw new Error('Claude не вернул текстовый ответ.');
  return JSON.parse(textBlock.text);
}

async function handleWritingCheck() {
  const sentence = document.getElementById('writing-input').value.trim();
  if (!sentence) return;

  const btn = document.getElementById('btn-writing-check');
  btn.disabled = true;
  btn.textContent = 'Проверяю...';

  const resultEl = document.getElementById('writing-result');
  resultEl.hidden = true;

  try {
    const verdict = await callClaudeWritingCheck(sentence, writingSession.words, writingSession.category);

    writingSession.words.forEach(w => {
      const newSrs = SRS.gradeReview(w, verdict.correct);
      Storage.updateWord(w.id, { srs: newSrs });
    });

    resultEl.hidden = false;
    resultEl.className = 'writing-result ' + (verdict.correct ? 'correct' : 'wrong');
    resultEl.innerHTML = `
      <div class="writing-result-verdict ${verdict.correct ? 'correct' : 'wrong'}">${verdict.correct ? '✓ Похоже, верно!' : '✗ Есть над чем поработать'}</div>
      <div>${esc(verdict.feedback)}</div>
      <div class="writing-result-corrected"><strong>Образец:</strong> ${esc(verdict.corrected)}</div>
    `;
  } catch (err) {
    showToast(err.message || 'Не удалось проверить предложение');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Проверить';
  }
}

// ---------- stats ----------

function computeStreak(log) {
  let count = 0;
  const cursor = new Date();
  if (!(log[todayStr(cursor)] > 0)) cursor.setDate(cursor.getDate() - 1);
  while (log[todayStr(cursor)] > 0) {
    count++;
    cursor.setDate(cursor.getDate() - 1);
  }
  return count;
}

// ---------- streak flower (SVG, без картинок) ----------

const FLOWER_STAGE_COUNT = 5; // росток → бутон → полу-раскрытый → раскрытый → полный бутон
const FLOWER_COLORS = ['#4a3aa7', '#d1477a', '#e08c2b', '#2a9d6b', '#2f7fd1'];
const FLOWER_PETAL_SHAPES = [
  'M0,0 C-6,-10 -6,-22 0,-28 C6,-22 6,-10 0,0 Z', // круглый лепесток
  'M0,0 C-3,-14 -1,-24 0,-30 C1,-24 3,-14 0,0 Z', // узкий, тюльпан
  'M0,0 C-8,-6 -9,-16 0,-20 C9,-16 8,-6 0,0 Z',   // короткий, ромашка
];
// Параметры бутона/лепестков/центра/листьев по стадии внутри одного уровня (0..4)
const FLOWER_STAGE_PARAMS = [
  { bud: 0.35, petalDist: 4, petalScale: 0, center: 0, leaf: 0.4 },
  { bud: 1, petalDist: 4, petalScale: 0, center: 0, leaf: 1 },
  { bud: 0, petalDist: 8, petalScale: 0.55, center: 0.3, leaf: 1 },
  { bud: 0, petalDist: 11, petalScale: 0.85, center: 0.7, leaf: 1 },
  { bud: 0, petalDist: 13, petalScale: 1, center: 1, leaf: 1 },
];

// Каждые FLOWER_STAGE_COUNT дней стрика — новый "уровень" (другой цвет и форма
// лепестков), а стадия внутри уровня показывает рост день за днём.
function flowerVisualFor(streak) {
  const level = Math.floor((streak - 1) / FLOWER_STAGE_COUNT);
  const stage = (streak - 1) % FLOWER_STAGE_COUNT;
  return { level, stage };
}

function describeFlowerState(streak, hasHistory) {
  if (streak <= 0) return hasHistory ? { wilted: true } : { seed: true };
  return flowerVisualFor(streak);
}

// Устанавливает inline-стили элементов цветка. CSS-transition на самих
// элементах анимирует переход, если до этого стояли другие значения —
// поэтому эта функция не занимается анимацией сама, только конечным состоянием.
function applyFlowerVisual(visual) {
  const svg = document.getElementById('streak-flower');
  const petals = [...svg.querySelectorAll('.fl-petal')];
  const bud = document.getElementById('fl-bud');
  const center = document.getElementById('fl-center');
  const leaves = [...svg.querySelectorAll('.fl-leaf')];
  const stem = document.getElementById('fl-stem');

  svg.classList.toggle('full-bloom', !visual.wilted && !visual.seed && visual.stage === FLOWER_STAGE_COUNT - 1);

  if (visual.seed) {
    petals.forEach(p => { p.style.transform = 'translate(50px,42px) scale(0)'; p.style.opacity = '0'; });
    bud.style.transform = 'translate(50px,46px) scale(0.15)';
    bud.style.opacity = '0.5';
    bud.style.fill = 'var(--baseline)';
    center.style.transform = 'translate(50px,42px) scale(0)';
    center.style.opacity = '0';
    leaves.forEach(l => { l.style.opacity = '0'; });
    stem.style.stroke = 'var(--baseline)';
    return;
  }

  const wilted = !!visual.wilted;
  const level = visual.level || 0;
  const stage = wilted ? FLOWER_STAGE_COUNT - 1 : visual.stage;
  const shape = FLOWER_PETAL_SHAPES[level % FLOWER_PETAL_SHAPES.length];
  const color = wilted ? 'var(--text-faint)' : FLOWER_COLORS[level % FLOWER_COLORS.length];
  const p = FLOWER_STAGE_PARAMS[stage];

  petals.forEach((petal, i) => {
    petal.setAttribute('d', shape);
    const angle = i * (360 / petals.length);
    const droop = wilted ? 55 : 0;
    const dist = wilted ? p.petalDist * 0.8 : p.petalDist;
    const scale = wilted ? p.petalScale * 0.85 : p.petalScale;
    petal.style.transform = `translate(50px,42px) rotate(${angle + droop}deg) translate(0,${-dist}px) scale(${scale})`;
    petal.style.opacity = String(wilted ? 0.55 : 1);
    petal.style.fill = color;
  });

  bud.style.transform = `translate(50px,46px) scale(${wilted ? 0 : p.bud})`;
  bud.style.opacity = wilted ? '0' : '1';
  bud.style.fill = color;

  center.style.transform = `translate(50px,42px) scale(${wilted ? 0.5 : p.center})`;
  center.style.opacity = String(wilted ? 0.4 : (p.center > 0 ? 1 : 0));

  leaves.forEach(l => {
    l.style.opacity = String(wilted ? 0.35 : p.leaf);
    l.style.fill = wilted ? 'var(--text-faint)' : 'var(--good)';
  });
  stem.style.stroke = wilted ? 'var(--text-faint)' : 'var(--good)';
}

// Показываем предыдущее состояние цветка и на следующем кадре — новое, чтобы
// сыграл CSS-transition, только если стрик реально поменялся с прошлого визита
// (иначе цветок просто рисуется в конечном состоянии, без анимации при каждом
// заходе на вкладку «Прогресс»).
function renderStreakFlower(log, state) {
  const streak = computeStreak(log);
  const hasHistory = Object.keys(log).length > 0;
  const prevStreak = state.lastSeenStreak || 0;

  document.getElementById('s-streak').textContent = streak;
  document.getElementById('streak-label').textContent = streak > 0
    ? `${streak} ${pluralizeSlovo(streak)} подряд`
    : (hasHistory ? 'стрик прервался — самое время вернуться' : 'начни серию дней сегодня');

  const currVisual = describeFlowerState(streak, hasHistory);

  if (prevStreak === streak) {
    applyFlowerVisual(currVisual);
  } else {
    const prevVisual = describeFlowerState(prevStreak, hasHistory);
    const svg = document.getElementById('streak-flower');
    svg.classList.add('no-anim');
    applyFlowerVisual(prevVisual);
    void svg.offsetWidth; // форсируем reflow, чтобы стартовое состояние точно применилось без анимации
    svg.classList.remove('no-anim');
    requestAnimationFrame(() => requestAnimationFrame(() => applyFlowerVisual(currVisual)));
  }

  state.lastSeenStreak = streak;
  Storage.saveState(state);
}

const LEARNED_CHART_DAYS = 30;

// Пересчитываем прямо из ТЕКУЩЕГО состояния слов (по дате последнего перехода
// в статус "выучено", srs.learnedAt) — не из исторического лога. Если слово
// провалит достаточно повторений и когда-нибудь перестанет считаться
// "выученным", оно само перестанет попадать в счётчик того дня, без отдельной
// правки истории задним числом.
function renderLearnedChart(words) {
  // Не обнуляем время суток здесь: todayStr() переводит дату в UTC-строку, а
  // локальная полночь при положительном часовом поясе (например, UTC+3)
  // после этого конвертируется в предыдущий UTC-день — тогда "сегодняшний"
  // столбец никогда бы не совпадал с датой в learnedAt, которая берётся от
  // текущего момента без обнуления. Держим оба конца в одном базисе.
  const days = [];
  for (let i = LEARNED_CHART_DAYS - 1; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    days.push(d);
  }

  const counts = new Map(days.map(d => [todayStr(d), 0]));
  words.forEach(w => {
    if (!w.srs.learned || !w.srs.learnedAt) return;
    const key = todayStr(w.srs.learnedAt);
    if (counts.has(key)) counts.set(key, counts.get(key) + 1);
  });

  const values = days.map(d => counts.get(todayStr(d)));
  const max = Math.max(...values, 1);
  const todayKey = todayStr();

  const barsHtml = days.map((d, i) => {
    const count = values[i];
    const heightPct = Math.round((count / max) * 100);
    const dayKey = todayStr(d);
    const isToday = dayKey === todayKey;
    const dateLabel = d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
    // Подписей на 30 столбцов слишком много — показываем только каждый 5-й
    // день и сегодня, остальное несёт подсказка по наведению.
    const showLabel = i % 5 === 0 || isToday;
    const dayLabel = showLabel ? d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' }) : '';
    return `
      <div class="lc-col">
        <div class="chart-tooltip">${esc(dateLabel)}: ${count} ${esc(pluralizeSlovo(count))}</div>
        <div class="lc-bar ${count === 0 ? 'zero' : ''}" style="height:${count === 0 ? '3px' : heightPct + '%'}"></div>
        <div class="lc-day-label ${isToday ? 'today' : ''}">${esc(dayLabel)}</div>
      </div>
    `;
  }).join('');

  document.getElementById('learned-chart').innerHTML = `<div class="lc-bars">${barsHtml}</div>`;
}

function renderStats() {
  const words = Storage.getWords();
  const state = Storage.getState();
  document.getElementById('s-total').textContent = words.length;
  document.getElementById('s-learned').textContent = words.filter(w => SRS.isLearned(w)).length;
  document.getElementById('s-due').textContent = words.filter(w => SRS.isReviewDue(w)).length;
  renderStreakFlower(state.studyLog || {}, state);
  renderLearnedChart(words);
}

// ---------- hanja (иероглифика) ----------

function pluralizeHieroglyph(n) {
  const mod10 = n % 10, mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 14) return 'иероглифов';
  if (mod10 === 1) return 'иероглиф';
  if (mod10 >= 2 && mod10 <= 4) return 'иероглифа';
  return 'иероглифов';
}

// char -> [{ word, meaningInWord }] по всем словам словаря.
function computeHanjaUsageMap() {
  const map = new Map();
  Storage.getWords().forEach(w => {
    (w.hanja || []).forEach(h => {
      if (!map.has(h.char)) map.set(h.char, []);
      map.get(h.char).push({ word: w, meaningInWord: h.meaningInWord });
    });
  });
  return map;
}

function renderHanjaTab() {
  const usageMap = computeHanjaUsageMap();
  const count = usageMap.size;
  document.getElementById('hanja-count').textContent = `${count} ${pluralizeHieroglyph(count)} в твоих словах`;
  document.getElementById('hanja-empty-state').hidden = count !== 0;
  document.getElementById('hanja-detail-view').hidden = true;
  document.getElementById('hanja-list-view').hidden = false;
  renderHanjaGrid(usageMap);
}

function renderHanjaGrid(usageMap) {
  const searchTerm = (document.getElementById('hanja-search-input').value || '').trim().toLowerCase();
  const db = Storage.getHanjaDatabase();
  const rows = [...usageMap.keys()].map(char => {
    const dbEntry = db.find(h => h.char === char);
    return {
      char,
      reading: dbEntry ? dbEntry.reading : '',
      meaning: dbEntry ? dbEntry.meaning : '',
      count: usageMap.get(char).length,
    };
  });
  const filtered = searchTerm
    ? rows.filter(r => r.char.includes(searchTerm) || r.reading.toLowerCase().includes(searchTerm) || r.meaning.toLowerCase().includes(searchTerm))
    : rows;
  filtered.sort((a, b) => b.count - a.count || a.char.localeCompare(b.char));

  const grid = document.getElementById('hanja-grid');
  if (filtered.length === 0) {
    grid.innerHTML = searchTerm ? '<p class="hint-text">Ничего не найдено.</p>' : '';
  } else {
    grid.innerHTML = filtered.map(r => `
      <button type="button" class="hanja-tile" data-char="${esc(r.char)}">
        <div class="hanja-tile-char">${esc(r.char)}</div>
        <div class="hanja-tile-reading">${esc(r.reading)}</div>
        <div class="hanja-tile-count">${r.count} ${esc(pluralizeSlovo(r.count))}</div>
      </button>
    `).join('');
    grid.querySelectorAll('.hanja-tile').forEach(btn => {
      btn.addEventListener('click', () => openHanjaDetail(btn.dataset.char));
    });
  }
}

// Группируем слова, использующие этот иероглиф, по значению именно В ЭТОМ
// СЛОВЕ (meaningInWord) — один и тот же символ в разных словах может нести
// разный смысловой оттенок, и это отдельные "ветки" смыслового мини-майндмэпа.
function openHanjaDetail(char) {
  hanjaDetailChar = char;
  const usages = computeHanjaUsageMap().get(char) || [];
  const dbEntry = Storage.findHanja(char);

  document.getElementById('hanja-list-view').hidden = true;
  document.getElementById('hanja-detail-view').hidden = false;
  document.getElementById('hanja-detail-char').textContent = char;
  document.getElementById('hanja-detail-reading').textContent = dbEntry
    ? `${dbEntry.reading} · ${dbEntry.meaning}`
    : 'нет в базовом словаре иероглифов';

  const clusters = new Map();
  usages.forEach(u => {
    const key = (u.meaningInWord || '').trim() || '(без указанного значения)';
    if (!clusters.has(key)) clusters.set(key, []);
    clusters.get(key).push(u.word);
  });

  const wrap = document.getElementById('hanja-branches');
  wrap.innerHTML = [...clusters.entries()].map(([meaning, words]) => `
    <div class="hanja-branch">
      <div class="hanja-branch-title">→ ${esc(meaning)}</div>
      <div class="hanja-branch-words">
        ${words.map(w => `<button type="button" class="hanja-branch-word" data-word-id="${w.id}"><b>${esc(w.korean)}</b>${esc(w.translation)}</button>`).join('')}
      </div>
    </div>
  `).join('');
  wrap.querySelectorAll('.hanja-branch-word').forEach(btn => {
    btn.addEventListener('click', () => {
      const word = Storage.getWords().find(w => w.id === btn.dataset.wordId);
      if (word) openWordModal(word);
    });
  });
}

// ---------- data (export / import / clear / api key / backup) ----------

function renderDataView() {
  const state = Storage.getState();
  const words = Storage.getWords();
  const backup = state.backup || { lastBackupAt: null, changesSinceBackup: 0 };

  document.getElementById('f-api-key').value = state.apiKey || '';

  const gh = state.github || {};
  document.getElementById('f-gh-owner').value = gh.owner || '';
  document.getElementById('f-gh-repo').value = gh.repo || 'korean-words-data';
  document.getElementById('f-gh-token').value = gh.token || '';
  document.getElementById('sync-status-text').textContent = gh.lastSyncAt
    ? `Последняя синхронизация: ${new Date(gh.lastSyncAt).toLocaleString('ru-RU')}`
    : (ghConfigured(gh) ? 'Ещё не синхронизировалось.' : 'Синхронизация не настроена.');

  document.getElementById('last-backup-text').textContent = backup.lastBackupAt
    ? `Последний экспорт: ${new Date(backup.lastBackupAt).toLocaleString('ru-RU')} · изменений с тех пор: ${backup.changesSinceBackup}`
    : 'Резервная копия ещё не делалась.';

  const needsBackup = words.length > 0 && (backup.changesSinceBackup >= BACKUP_REMINDER_THRESHOLD || (!backup.lastBackupAt && words.length >= 5));
  const panel = document.getElementById('backup-reminder-panel');
  panel.hidden = !needsBackup;
  if (needsBackup) {
    document.getElementById('backup-reminder-text').textContent = backup.lastBackupAt
      ? `Изменений с последнего экспорта: ${backup.changesSinceBackup}. Стоит сделать новый экспорт.`
      : `В базе уже ${words.length} ${pluralizeSlovo(words.length)}, а резервной копии ещё не было.`;
  }
}

// ---------- sync: GitHub private repo as the shared database ----------

function b64EncodeUtf8(str) {
  return btoa(unescape(encodeURIComponent(str)));
}

function b64DecodeUtf8(b64) {
  return decodeURIComponent(escape(atob(b64.replace(/\n/g, ''))));
}

function ghConfigured(gh) {
  return !!(gh && gh.token && gh.owner && gh.repo);
}

async function githubFetchFile(gh) {
  const url = `https://api.github.com/repos/${gh.owner}/${gh.repo}/contents/${encodeURIComponent(gh.path)}`;
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${gh.token}`, Accept: 'application/vnd.github+json' },
  });
  if (resp.status === 404) return null;
  if (!resp.ok) throw new Error(`GitHub API ${resp.status} при чтении файла`);
  const data = await resp.json();
  return { sha: data.sha, content: JSON.parse(b64DecodeUtf8(data.content)) };
}

async function githubPutFile(gh, payload, sha, opts) {
  const url = `https://api.github.com/repos/${gh.owner}/${gh.repo}/contents/${encodeURIComponent(gh.path)}`;
  const body = {
    message: `sync: ${new Date().toISOString()}`,
    content: b64EncodeUtf8(JSON.stringify(payload, null, 2)),
  };
  if (sha) body.sha = sha;
  const resp = await fetch(url, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${gh.token}`,
      Accept: 'application/vnd.github+json',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
    ...(opts && opts.keepalive ? { keepalive: true } : {}),
  });
  if (!resp.ok) {
    const errBody = await resp.text().catch(() => '');
    throw new Error(`GitHub API ${resp.status} при сохранении: ${errBody.slice(0, 200)}`);
  }
  const data = await resp.json();
  return data.content.sha;
}

async function pushToGithub(manual, knownMissing, opts) {
  const state = Storage.getState();
  const gh = state.github;
  if (!ghConfigured(gh)) {
    if (manual) showToast('Сначала настрой синхронизацию в разделе «Данные».');
    return;
  }
  try {
    let sha = gh.sha;
    if (!sha && !knownMissing) {
      const remote = await githubFetchFile(gh);
      sha = remote ? remote.sha : null;
    }
    const payload = Storage.getSyncPayload();
    const newSha = await githubPutFile(gh, payload, sha, opts);
    const s = Storage.getState();
    s.github.sha = newSha;
    s.github.lastSyncAt = Date.now();
    Storage.saveState(s);
    if (manual) showToast('Синхронизировано ✓');
    renderDataView();
  } catch (err) {
    console.warn('sync push failed', err);
    if (manual) showToast('Не получилось синхронизировать: ' + (err.message || 'ошибка'));
  }
}

// При открытии сайта — подтягиваем данные с другого устройства и СЛИВАЕМ их со
// своими по каждому слову (у кого правка новее), а не заменяем всё целиком.
// Так свежедобавленное слово не потеряется, даже если в облаке в этот момент
// лежит более новая правка какого-то другого слова.
async function pullFromGithub(manual) {
  const state = Storage.getState();
  const gh = state.github;
  if (!ghConfigured(gh)) {
    if (manual) showToast('Сначала настрой синхронизацию в разделе «Данные».');
    return;
  }
  try {
    const remote = await githubFetchFile(gh);
    if (!remote) {
      await pushToGithub(manual, true);
      return;
    }

    const { remoteWasStale } = Storage.applySyncPayload(remote.content);
    const s = Storage.getState();
    s.github.sha = remote.sha;
    s.github.lastSyncAt = Date.now();
    Storage.saveState(s);
    renderDictionary();
    updateStudyIntro();
    renderStats();

    if (remoteWasStale) {
      await pushToGithub(manual);
    } else if (manual) {
      showToast('Синхронизировано ✓');
    }
    renderDataView();
  } catch (err) {
    console.warn('sync pull failed', err);
    showToast('Не получилось синхронизировать: ' + (err.message || 'ошибка'));
  }
}

// Изменения уже отмечены через Storage.noteChange() (обновляет dataUpdatedAt) —
// здесь просто сравниваем её с моментом последней успешной синхронизации.
function hasPendingSyncChanges() {
  const state = Storage.getState();
  return (state.dataUpdatedAt || 0) > (state.github.lastSyncAt || 0);
}

// Не пушим в GitHub при каждой правке (иначе на каждое слово — отдельный
// коммит и лишний вызов API) — копим изменения и отправляем раз в сутки.
// Часовой таймер нужен на случай, если вкладка не закрывается днями.
function maybeAutoSyncPush() {
  const gh = Storage.getState().github;
  if (!ghConfigured(gh)) return;
  const dueForSync = Date.now() - (gh.lastSyncAt || 0) >= AUTO_SYNC_INTERVAL_MS;
  if (dueForSync && hasPendingSyncChanges()) pushToGithub(false);
}

// При уходе со страницы (закрытие вкладки, сворачивание, переключение) —
// подчищаем накопленные изменения, не дожидаясь суточного таймера.
// keepalive позволяет запросу пережить закрытие вкладки (с ограничением ~64КБ
// на тело запроса — для большого словаря может не сработать, но это не
// страшно: несохранённое всё равно останется в localStorage и уйдёт в облако
// при следующем открытии сайта или на следующий день по таймеру).
let hideFlushDone = false;
function flushPendingSyncOnHide() {
  if (hideFlushDone) return;
  const gh = Storage.getState().github;
  if (!ghConfigured(gh) || !hasPendingSyncChanges()) return;
  hideFlushDone = true;
  pushToGithub(false, false, { keepalive: true });
}

function handleSyncSave() {
  const state = Storage.getState();
  state.github = {
    ...state.github,
    owner: document.getElementById('f-gh-owner').value.trim(),
    repo: document.getElementById('f-gh-repo').value.trim() || 'korean-words-data',
    token: document.getElementById('f-gh-token').value.trim(),
    sha: null, // сменились настройки — узнаём sha заново при следующем запросе
  };
  Storage.saveState(state);
  pullFromGithub(true);
}

// Аварийный вариант на случай рассинхронизации меток времени (например, после
// старого бага с импортом) — просто заливает локальные данные поверх облака.
function handleForceSyncPush() {
  if (!confirm('Залить то, что есть на этом устройстве, в облако, не глядя на то, что там сейчас лежит?')) return;
  const state = Storage.getState();
  state.dataUpdatedAt = Date.now();
  Storage.saveState(state);
  pushToGithub(true);
}

function handleExport() {
  const json = Storage.exportJSON();
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `korean-words-backup-${todayStr()}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  Storage.markBackedUp();
  renderDataView();
  refreshNavBadges();
  showToast('Файл сохранён');
}

function handleImportFile(e) {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const replace = confirm('Заменить всю текущую базу этим файлом?\nOK — заменить\nОтмена — объединить (добавить как новые слова)');
      const result = Storage.importJSON(reader.result, replace ? 'replace' : 'merge');
      renderDictionary();
      updateStudyIntro();
      renderDataView();
      showToast(`Готово: ${result.added} слов ${result.mode === 'replace' ? 'загружено' : 'добавлено'}`);
    } catch (err) {
      showToast('Не получилось прочитать файл — проверь формат JSON');
    }
    e.target.value = '';
  };
  reader.readAsText(file);
}

function handleSaveApiKey() {
  const key = document.getElementById('f-api-key').value.trim();
  const state = Storage.getState();
  state.apiKey = key;
  Storage.saveState(state);
  showToast(key ? 'Ключ сохранён' : 'Ключ удалён');
}

function handleClearAll() {
  const gh = Storage.getState().github;
  const warning = ghConfigured(gh)
    ? 'Удалить всю базу слов без возможности восстановления?\nЭто также сотрёт синхронизированную копию в GitHub.'
    : 'Удалить всю базу слов без возможности восстановления?';
  if (!confirm(warning)) return;
  Storage.clearAll();
  renderDictionary();
  updateStudyIntro();
  renderDataView();
  showToast('База очищена');
}

// ---------- wiring ----------

function wireEvents() {
  document.querySelectorAll('.nav-btn[data-view], .mobile-tab[data-view]').forEach(btn => {
    btn.addEventListener('click', () => switchView(btn.dataset.view));
  });
  document.getElementById('theme-toggle').addEventListener('click', toggleTheme);

  document.getElementById('search-input').addEventListener('input', e => {
    dictState.searchTerm = e.target.value;
    renderDictionary();
  });
  document.getElementById('sort-select').addEventListener('change', e => {
    dictState.sortMode = e.target.value;
    renderDictionary();
  });

  document.getElementById('hanja-search-input').addEventListener('input', () => renderHanjaGrid(computeHanjaUsageMap()));
  document.getElementById('btn-hanja-back').addEventListener('click', renderHanjaTab);

  document.getElementById('btn-add-word').addEventListener('click', () => openWordModal(null));
  document.getElementById('btn-add-word-empty').addEventListener('click', () => openWordModal(null));
  document.getElementById('word-modal-close').addEventListener('click', closeWordModal);
  document.getElementById('word-modal-cancel').addEventListener('click', closeWordModal);
  document.getElementById('word-form').addEventListener('submit', handleWordFormSubmit);
  document.getElementById('btn-delete-word').addEventListener('click', handleDeleteWord);
  document.getElementById('word-modal-overlay').addEventListener('click', e => {
    if (e.target.id === 'word-modal-overlay') closeWordModal();
  });

  document.getElementById('related-list').addEventListener('click', e => {
    const jumpBtn = e.target.closest('.related-link');
    if (jumpBtn) {
      const target = Storage.getWords().find(w => w.id === jumpBtn.dataset.jump);
      if (target) openWordModal(target);
      return;
    }
    const removeBtn = e.target.closest('.related-remove');
    if (removeBtn && currentEditId) {
      Storage.removeRelation(currentEditId, removeBtn.dataset.unlink);
      const updated = Storage.getWords().find(w => w.id === currentEditId);
      renderRelatedList(updated);
      fillRelatedWordSelect(updated);
    }
  });
  document.getElementById('btn-add-related').addEventListener('click', () => {
    const targetId = document.getElementById('f-related-word').value;
    const relation = document.getElementById('f-related-relation').value;
    if (!targetId || !currentEditId) return;
    Storage.addRelation(currentEditId, targetId, relation);
    const updated = Storage.getWords().find(w => w.id === currentEditId);
    renderRelatedList(updated);
    fillRelatedWordSelect(updated);
  });

  document.getElementById('hanja-list').addEventListener('click', e => {
    const removeBtn = e.target.closest('[data-remove-hanja-index]');
    if (!removeBtn) return;
    currentHanjaEntries.splice(parseInt(removeBtn.dataset.removeHanjaIndex, 10), 1);
    renderHanjaList();
    renderHanjaSuggestions();
  });
  document.getElementById('f-hanja-char').addEventListener('input', updateHanjaCharInput);
  document.getElementById('btn-add-hanja').addEventListener('click', handleAddHanja);
  document.getElementById('f-korean').addEventListener('input', renderHanjaSuggestions);
  document.getElementById('hanja-suggestions').addEventListener('click', e => {
    const chip = e.target.closest('.hanja-suggestion-chip');
    if (!chip) return;
    document.getElementById('f-hanja-char').value = chip.dataset.suggestChar;
    document.getElementById('f-hanja-reading').value = chip.dataset.suggestReading;
    document.getElementById('f-hanja-reading').hidden = true;
    document.getElementById('f-hanja-meaning').value = chip.dataset.suggestMeaning;
  });

  document.getElementById('btn-bulk-add').addEventListener('click', openBulkModal);
  document.getElementById('bulk-modal-close').addEventListener('click', closeBulkModal);
  document.getElementById('bulk-modal-cancel').addEventListener('click', closeBulkModal);
  document.getElementById('bulk-input').addEventListener('input', renderBulkPreview);
  document.getElementById('btn-bulk-submit').addEventListener('click', handleBulkSubmit);
  document.getElementById('bulk-modal-overlay').addEventListener('click', e => {
    if (e.target.id === 'bulk-modal-overlay') closeBulkModal();
  });

  document.getElementById('study-mode-switch').querySelectorAll('button').forEach(btn => {
    btn.addEventListener('click', () => switchStudyMode(btn.dataset.mode));
  });

  document.getElementById('daily-goal').querySelectorAll('button').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#daily-goal button').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const state = Storage.getState();
      state.dailyGoal = parseInt(btn.dataset.goal, 10);
      Storage.saveState(state);
      updateStudyIntro();
    });
  });
  document.getElementById('session-direction').querySelectorAll('button').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#session-direction button').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      sessionDirection = btn.dataset.dir;
    });
  });

  document.addEventListener('click', e => {
    const speakBtn = e.target.closest('.speak-btn');
    if (speakBtn) speakKorean(speakBtn.dataset.speak);
  });
  document.getElementById('btn-start-new').addEventListener('click', startNewWordSession);
  document.getElementById('btn-start-review').addEventListener('click', startReviewSession);
  document.getElementById('btn-study-again').addEventListener('click', () => {
    document.getElementById('study-summary').hidden = true;
    if (studySession && studySession.type === 'review') startReviewSession();
    else startNewWordSession();
  });
  document.getElementById('btn-study-done').addEventListener('click', () => {
    document.getElementById('study-summary').hidden = true;
    updateStudyIntro();
  });

  document.getElementById('btn-writing-back').addEventListener('click', renderWritingIntro);
  document.getElementById('btn-writing-check').addEventListener('click', handleWritingCheck);

  document.getElementById('btn-export').addEventListener('click', handleExport);
  document.getElementById('import-file').addEventListener('change', handleImportFile);
  document.getElementById('btn-save-api-key').addEventListener('click', handleSaveApiKey);
  document.getElementById('btn-sync-save').addEventListener('click', handleSyncSave);
  document.getElementById('btn-sync-force-push').addEventListener('click', handleForceSyncPush);
  document.getElementById('btn-clear-all').addEventListener('click', handleClearAll);

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      closeWordModal();
      closeBulkModal();
    }
  });
}

// ---------- init ----------

initTheme();
initSpeech();
wireEvents();
switchView('dictionary');

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('service-worker.js').catch(err => console.warn('SW register failed', err));
  });
}

// Тихая синхронизация в фоне — первая отрисовка не ждёт сеть,
// а когда данные подтянутся, экран сам обновится.
pullFromGithub(false).then(() => {
  renderDictionary();
  updateStudyIntro();
  renderStats();
  maybeAutoSyncPush(); // на случай изменений из прошлой сессии, которые ещё не улетели в облако
});

// Раз в час перепроверяем, не пора ли (раз в сутки) отправить накопленные
// изменения в GitHub — на случай, если вкладка держится открытой долго.
setInterval(maybeAutoSyncPush, 60 * 60 * 1000);

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') flushPendingSyncOnHide();
  else hideFlushDone = false;
});
window.addEventListener('pagehide', flushPendingSyncOnHide);
