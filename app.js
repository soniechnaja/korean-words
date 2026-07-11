// ============================================================
// Приложение: словарь + повторение по уровням (SRS) + письмо + статистика.
// Никакого бэкенда — всё живёт в localStorage (см. storage.js).
// Уровень 4 (письмо) обращается к Claude API напрямую из браузера.
// ============================================================

let dictState = { searchTerm: '', activeCategory: null, sortMode: 'new' };
let sessionSizeLimit = 10;
let studySession = null; // { queue, index, correct, reviewed }
let writingSession = null; // { category, words }
let currentEditId = null;
let toastTimer = null;
let syncPushTimer = null;

const CLAUDE_MODEL = 'claude-haiku-4-5';
const BACKUP_REMINDER_THRESHOLD = 8;
const SYNC_PUSH_DELAY_MS = 2500;

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
  return [w.korean, w.translation, w.transcription, w.category, w.notes, ...(w.examples || [])]
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

function levelBadge(w) {
  if (w.srs.totalReviews === 0) return { label: 'новое', mastered: false };
  if (SRS.isMastered(w)) return { label: 'выучено', mastered: true };
  return { label: `учу · ур.${w.srs.stage}`, mastered: false };
}

function renderWordCard(w) {
  const badge = levelBadge(w);
  const firstExample = (w.examples || [])[0];
  return `
    <div class="word-card" data-id="${w.id}">
      <div class="word-card-top">
        <div>
          <div class="word-kr">${esc(w.korean)}</div>
          ${w.transcription ? `<div class="word-tr">${esc(w.transcription)}</div>` : ''}
        </div>
        <span class="word-level ${badge.mastered ? 'mastered' : ''}">${badge.label}</span>
      </div>
      <div class="word-translation">${esc(w.translation)}</div>
      ${w.category ? `<span class="word-category">${esc(w.category)}</span>` : ''}
      ${firstExample ? `<div class="word-example">${esc(firstExample)}</div>` : ''}
    </div>
  `;
}

function renderDictionary() {
  const all = Storage.getWords();
  document.getElementById('dict-count').textContent = `${all.length} ${pluralizeSlovo(all.length)}`;

  document.getElementById('empty-state').hidden = all.length !== 0;

  renderCategoryChips(all);

  let filtered = all.filter(w => matchesSearch(w, dictState.searchTerm) && (!dictState.activeCategory || w.category === dictState.activeCategory));

  switch (dictState.sortMode) {
    case 'old': filtered.sort((a, b) => a.createdAt - b.createdAt); break;
    case 'az': filtered.sort((a, b) => a.korean.localeCompare(b.korean, 'ko')); break;
    case 'hard': filtered.sort((a, b) => a.srs.level - b.srs.level || a.srs.dueDate - b.srs.dueDate); break;
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
      card.addEventListener('click', () => {
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

function openWordModal(word) {
  currentEditId = word ? word.id : null;
  document.getElementById('word-modal-title').textContent = word ? 'Редактировать слово' : 'Новое слово';
  document.getElementById('f-id').value = word ? word.id : '';
  document.getElementById('f-korean').value = word ? word.korean : '';
  document.getElementById('f-translation').value = word ? word.translation : '';
  document.getElementById('f-transcription').value = word ? word.transcription : '';
  document.getElementById('f-category').value = word ? word.category : '';
  document.getElementById('f-examples').value = word ? (word.examples || []).join('\n') : '';
  document.getElementById('f-notes').value = word ? word.notes : '';
  document.getElementById('btn-delete-word').hidden = !word;
  fillCategoryDatalist();
  document.getElementById('word-modal-overlay').hidden = false;
  document.getElementById('f-korean').focus();
}

function closeWordModal() {
  document.getElementById('word-modal-overlay').hidden = true;
  document.getElementById('word-form').reset();
  currentEditId = null;
}

function handleWordFormSubmit(e) {
  e.preventDefault();
  const payload = {
    korean: document.getElementById('f-korean').value,
    translation: document.getElementById('f-translation').value,
    transcription: document.getElementById('f-transcription').value,
    category: document.getElementById('f-category').value,
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
  scheduleSyncPush();
}

function handleDeleteWord() {
  if (!currentEditId) return;
  if (!confirm('Удалить это слово из словаря?')) return;
  Storage.deleteWord(currentEditId);
  closeWordModal();
  renderDictionary();
  showToast('Слово удалено');
  scheduleSyncPush();
}

// ---------- bulk add ----------

function parseBulkLine(line) {
  const parts = line.split(';').map(p => p.trim());
  const [korean, translation, transcription, category, examplesRaw] = parts;
  if (!korean || !translation) return { ok: false, line };
  const examples = examplesRaw ? examplesRaw.split('|').map(s => s.trim()).filter(Boolean) : [];
  return { ok: true, korean, translation, transcription, category, examples };
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
  parsed.forEach(p => Storage.addWord(p));
  closeBulkModal();
  renderDictionary();
  showToast(`Добавлено слов: ${parsed.length}`);
  scheduleSyncPush();
}

// ---------- study: mode switch (Слова / Письмо) ----------

function switchStudyMode(mode) {
  document.querySelectorAll('#study-mode-switch button').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
  document.getElementById('study-words-mode').hidden = mode !== 'words';
  document.getElementById('study-writing-mode').hidden = mode !== 'writing';
  if (mode === 'writing') renderWritingIntro();
}

// ---------- study: words (levels 1-3) ----------

function refreshNavBadges() {
  const words = Storage.getWords();
  const dueCount = words.filter(w => SRS.isDue(w)).length;
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

function updateStudyIntro() {
  const words = Storage.getWords();
  const due = words.filter(w => SRS.isDue(w) && w.srs.totalReviews > 0).length;
  const fresh = words.filter(w => w.srs.totalReviews === 0).length;

  document.getElementById('stat-due').textContent = due;
  document.getElementById('stat-new').textContent = fresh;
  document.getElementById('stat-total-dict').textContent = words.length;

  const subtitle = document.getElementById('study-subtitle');
  if (words.length === 0) subtitle.textContent = 'Сначала добавь слова в словарь';
  else if (due + fresh === 0) subtitle.textContent = 'Всё повторено — заходи завтра';
  else subtitle.textContent = `Готово к повторению: ${due + fresh}`;

  document.getElementById('study-intro').hidden = false;
  document.getElementById('study-session').hidden = true;
  document.getElementById('study-summary').hidden = true;
  refreshNavBadges();
}

// Уровень слова (1-3) определяет тип упражнения; слова уровня 4 используют
// тот же тип, что и 3-й, но дополнительно открываются для практики "Письмо".
function pickCardMode(word, allWords) {
  const stage = Math.min(word.srs.stage, 3);

  if (stage === 1) return 'flash';

  const otherTranslations = new Set(
    allWords.filter(w => w.id !== word.id && w.translation !== word.translation).map(w => w.translation)
  );
  const canQuiz = otherTranslations.size >= 3;

  if (stage === 2) return canQuiz ? 'quiz' : 'flash';

  // stage 3: подставить слово в предложение
  const usableExamples = (word.examples || []).filter(ex => ex.includes(word.korean));
  const otherKoreans = new Set(allWords.filter(w => w.id !== word.id && w.korean !== word.korean).map(w => w.korean));
  if (usableExamples.length > 0 && otherKoreans.size >= 3) return 'fillblank';
  return canQuiz ? 'quiz' : 'flash';
}

function startStudySession() {
  const words = Storage.getWords();
  const pool = shuffle(words.filter(w => SRS.isDue(w)));
  if (pool.length === 0) {
    showToast('Нет слов для повторения. Отличная работа! 🎉');
    return;
  }
  studySession = { queue: pool.slice(0, sessionSizeLimit), index: 0, correct: 0, reviewed: 0 };
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
  const mode = pickCardMode(word, allWords);
  const stageTag = word.srs.stage >= 4 ? 'готово к письму' : `уровень ${Math.min(word.srs.stage, 3)}`;
  const stage = document.getElementById('card-stage');

  if (mode === 'flash') {
    stage.innerHTML = `
      <div class="flashcard">
        <div class="card-category">${esc(stageTag)}${word.category ? ' · ' + esc(word.category) : ''}</div>
        <div class="kr-word">${esc(word.korean)}</div>
        ${word.transcription ? `<div class="kr-trans">${esc(word.transcription)}</div>` : ''}
        <div id="card-answer-area">
          <button class="btn btn-ghost reveal-btn" id="btn-reveal">Показать перевод</button>
        </div>
      </div>
    `;
    document.getElementById('btn-reveal').addEventListener('click', () => {
      document.getElementById('card-answer-area').innerHTML = `
        <div class="card-answer">
          <div class="card-translation">${esc(word.translation)}</div>
          ${word.examples && word.examples[0] ? `<div class="card-example">${esc(word.examples[0])}</div>` : ''}
          ${word.notes ? `<div class="card-notes">${esc(word.notes)}</div>` : ''}
        </div>
        <div class="grade-row">
          <button class="grade-btn grade-again" data-grade="again">Не помню<small>снова завтра</small></button>
          <button class="grade-btn grade-hard" data-grade="hard">Трудно<small>ещё раз скоро</small></button>
          <button class="grade-btn grade-good" data-grade="good">Хорошо<small>через несколько дней</small></button>
          <button class="grade-btn grade-easy" data-grade="easy">Легко<small>ещё не скоро</small></button>
        </div>
      `;
      document.querySelectorAll('.grade-btn').forEach(btn => {
        btn.addEventListener('click', () => gradeCurrent(btn.dataset.grade));
      });
    });
  } else if (mode === 'quiz') {
    const otherTranslations = shuffle([...new Set(
      allWords.filter(w => w.id !== word.id && w.translation !== word.translation).map(w => w.translation)
    )]).slice(0, 3);
    const options = shuffle([word.translation, ...otherTranslations]);

    stage.innerHTML = `
      <div class="flashcard">
        <div class="card-category">${esc(stageTag)}${word.category ? ' · ' + esc(word.category) : ''}</div>
        <div class="kr-word">${esc(word.korean)}</div>
        ${word.transcription ? `<div class="kr-trans">${esc(word.transcription)}</div>` : ''}
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
        const isCorrect = btn.dataset.opt === word.translation;
        btn.classList.add(isCorrect ? 'correct' : 'wrong');
        if (!isCorrect) {
          optionButtons.forEach(b => { if (b.dataset.opt === word.translation) b.classList.add('correct'); });
        }
        const feedback = document.getElementById('quiz-feedback');
        feedback.textContent = isCorrect ? 'Верно! ✓' : `Неверно — правильно: ${word.translation}`;
        feedback.classList.add(isCorrect ? 'correct' : 'wrong');
        setTimeout(() => gradeCurrent(isCorrect ? 'good' : 'again'), 900);
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
        feedback.textContent = isCorrect ? 'Верно! ✓' : `Неверно — правильно: ${word.korean}`;
        feedback.classList.add(isCorrect ? 'correct' : 'wrong');
        setTimeout(() => gradeCurrent(isCorrect ? 'good' : 'again'), 900);
      });
    });
  }
}

function gradeCurrent(grade) {
  const word = studySession.queue[studySession.index];
  const newSrs = SRS.grade(word, grade);
  Storage.updateWord(word.id, { srs: newSrs });
  if (grade === 'good' || grade === 'easy') studySession.correct++;
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
  scheduleSyncPush();
}

// ---------- study: writing (level 4, Claude-graded) ----------

function renderWritingIntro() {
  document.getElementById('writing-session').hidden = true;
  document.getElementById('writing-intro').hidden = false;

  const words = Storage.getWords().filter(w => w.srs.stage >= 4);
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
  const words = Storage.getWords().filter(w => w.srs.stage >= 4 && (w.category || 'без темы') === category);
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
      const newSrs = SRS.grade(w, verdict.correct ? 'good' : 'hard');
      Storage.updateWord(w.id, { srs: newSrs });
    });

    resultEl.hidden = false;
    resultEl.className = 'writing-result ' + (verdict.correct ? 'correct' : 'wrong');
    resultEl.innerHTML = `
      <div class="writing-result-verdict ${verdict.correct ? 'correct' : 'wrong'}">${verdict.correct ? '✓ Похоже, верно!' : '✗ Есть над чем поработать'}</div>
      <div>${esc(verdict.feedback)}</div>
      <div class="writing-result-corrected"><strong>Образец:</strong> ${esc(verdict.corrected)}</div>
    `;
    scheduleSyncPush();
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

function renderActivityChart(log) {
  const dayLetters = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    days.push(d);
  }
  const counts = days.map(d => log[todayStr(d)] || 0);
  const maxVal = Math.max(...counts, 1);
  const today = todayStr();

  const html = days.map((d, i) => {
    const count = counts[i];
    const isToday = todayStr(d) === today;
    const heightPct = Math.round((count / maxVal) * 100);
    const dateLabel = d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
    return `
      <div class="bar-col">
        <div class="chart-tooltip">${esc(dateLabel)}: ${count} ${pluralizeSlovo(count)}</div>
        ${isToday ? `<div class="bar-value-label">${count}</div>` : ''}
        <div class="bar-fill ${count === 0 ? 'zero' : ''}" style="height:${count === 0 ? '4px' : heightPct + '%'}"></div>
        <div class="bar-day-label ${isToday ? 'today' : ''}">${dayLetters[d.getDay()]}</div>
      </div>
    `;
  }).join('');

  document.getElementById('activity-chart').innerHTML = html;
}

function renderCategoryBreakdown(words) {
  const wrap = document.getElementById('category-breakdown');
  if (words.length === 0) {
    wrap.innerHTML = '<p class="hint-text">Пока нет слов.</p>';
    return;
  }
  const counts = {};
  words.forEach(w => {
    const cat = w.category || 'без темы';
    counts[cat] = (counts[cat] || 0) + 1;
  });
  const rows = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  const maxCount = rows[0][1];
  wrap.innerHTML = rows.map(([name, count]) => `
    <div class="cat-row">
      <div class="cat-row-name">${esc(name)}</div>
      <div class="cat-row-bar-bg"><div class="cat-row-bar-fill" style="width:${Math.round(count / maxCount * 100)}%"></div></div>
      <div class="cat-row-count">${count}</div>
    </div>
  `).join('');
}

function renderStats() {
  const words = Storage.getWords();
  const state = Storage.getState();
  document.getElementById('s-total').textContent = words.length;
  document.getElementById('s-learned').textContent = words.filter(w => SRS.isMastered(w)).length;
  document.getElementById('s-due').textContent = words.filter(w => SRS.isDue(w)).length;
  document.getElementById('s-streak').textContent = computeStreak(state.studyLog || {});
  renderActivityChart(state.studyLog || {});
  renderCategoryBreakdown(words);
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

async function githubPutFile(gh, payload, sha) {
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
  });
  if (!resp.ok) {
    const errBody = await resp.text().catch(() => '');
    throw new Error(`GitHub API ${resp.status} при сохранении: ${errBody.slice(0, 200)}`);
  }
  const data = await resp.json();
  return data.content.sha;
}

async function pushToGithub(manual, knownMissing) {
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
    const newSha = await githubPutFile(gh, payload, sha);
    const s = Storage.getState();
    s.github.sha = newSha;
    s.github.lastSyncAt = Date.now();
    Storage.saveState(s);
    if (manual) showToast('Синхронизировано ✓');
    renderDataView();
  } catch (err) {
    console.warn('sync push failed', err);
    showToast('Не получилось синхронизировать: ' + (err.message || 'ошибка'));
  }
}

// При открытии сайта — подтягиваем более свежую версию (по timestamp),
// либо, если локальная новее (или в облаке пока пусто), заливаем её наверх.
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
    const localUpdatedAt = Storage.getState().dataUpdatedAt || 0;
    const remoteSavedAt = remote.content.savedAt || 0;

    if (remoteSavedAt > localUpdatedAt) {
      Storage.applySyncPayload(remote.content);
      const s = Storage.getState();
      s.github.sha = remote.sha;
      s.github.lastSyncAt = Date.now();
      Storage.saveState(s);
      renderDictionary();
      updateStudyIntro();
      renderStats();
      if (manual) showToast('Загружены свежие данные с другого устройства');
    } else if (remoteSavedAt < localUpdatedAt) {
      await pushToGithub(manual);
    } else {
      const s = Storage.getState();
      s.github.sha = remote.sha;
      s.github.lastSyncAt = Date.now();
      Storage.saveState(s);
      if (manual) showToast('Уже синхронизировано');
    }
    renderDataView();
  } catch (err) {
    console.warn('sync pull failed', err);
    showToast('Не получилось синхронизировать: ' + (err.message || 'ошибка'));
  }
}

function scheduleSyncPush() {
  const gh = Storage.getState().github;
  if (!ghConfigured(gh)) return;
  clearTimeout(syncPushTimer);
  syncPushTimer = setTimeout(() => pushToGithub(false), SYNC_PUSH_DELAY_MS);
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
      scheduleSyncPush();
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
  scheduleSyncPush();
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

  document.getElementById('btn-add-word').addEventListener('click', () => openWordModal(null));
  document.getElementById('btn-add-word-empty').addEventListener('click', () => openWordModal(null));
  document.getElementById('word-modal-close').addEventListener('click', closeWordModal);
  document.getElementById('word-modal-cancel').addEventListener('click', closeWordModal);
  document.getElementById('word-form').addEventListener('submit', handleWordFormSubmit);
  document.getElementById('btn-delete-word').addEventListener('click', handleDeleteWord);
  document.getElementById('word-modal-overlay').addEventListener('click', e => {
    if (e.target.id === 'word-modal-overlay') closeWordModal();
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

  document.getElementById('session-size').querySelectorAll('button').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#session-size button').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      sessionSizeLimit = parseInt(btn.dataset.size, 10);
    });
  });
  document.getElementById('btn-start-study').addEventListener('click', startStudySession);
  document.getElementById('btn-study-again').addEventListener('click', () => {
    document.getElementById('study-summary').hidden = true;
    startStudySession();
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
wireEvents();
switchView('dictionary');

// Тихая синхронизация в фоне — первая отрисовка не ждёт сеть,
// а когда данные подтянутся, экран сам обновится.
pullFromGithub(false).then(() => {
  renderDictionary();
  updateStudyIntro();
  renderStats();
});
