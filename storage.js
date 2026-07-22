// Слой хранения: всё живёт в localStorage этого браузера.
const STORAGE_KEY = 'kw_words_v1';
const STATE_KEY = 'kw_state_v1';
const HANJA_CUSTOM_KEY = 'kw_hanja_custom_v1';

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function todayStr(date) {
  const d = date ? new Date(date) : new Date();
  return d.toISOString().slice(0, 10);
}

// Приводит слово к актуальной форме (примеры массивом, поля стадии обучения).
// Нужно, потому что база могла быть создана более ранней версией сайта.
function migrateWord(w) {
  let examples = w.examples;
  if (!Array.isArray(examples)) {
    examples = w.example ? [w.example] : [];
  }

  const oldSrs = w.srs || {};
  let srs;
  if (oldSrs.learned !== undefined || oldSrs.reviewStep !== undefined) {
    // Уже в актуальном формате — только подстрахуем дефолты недостающих полей
    // (например, после добавления нового поля в будущем).
    srs = {
      stage: 1, stageStreak: 0, learned: false, learnedAt: null, reviewStep: -1, nextReviewDate: null,
      inDailyBatch: false, totalReviews: 0, totalCorrect: 0, lastReviewed: null,
      ...oldSrs,
    };
    // Слово уже было выучено до того, как появилось поле learnedAt — берём
    // дату последнего изменения слова как приближение для графика активности.
    if (srs.learned && !srs.learnedAt) srs.learnedAt = w.updatedAt || w.createdAt || Date.now();
  } else {
    // Старый формат (level 0-7 + dueDate + stage 1-4, без разделения на "новые"
    // и "повтор"). Если слово уже дошло хотя бы до стадии 3 ("предложение") —
    // считаем его выученным и переносим в очередь повторения, сохраняя точную
    // дату повтора (dueDate), чтобы разом не обвалить сотни слов как "срочно
    // повторить" в день обновления сайта. Иначе слово остаётся на текущей
    // стадии (1 или 2) и просто попадёт в дневную пачку новых слов как обычно.
    const wasLearned = (oldSrs.stage || 1) >= 3;
    srs = {
      stage: Math.min(oldSrs.stage || 1, 2),
      stageStreak: 0,
      learned: wasLearned,
      learnedAt: wasLearned ? (w.updatedAt || w.createdAt || Date.now()) : null,
      // 5 = REVIEW_INTERVALS_DAYS.length - 1 в srs.js — держим в уме при правке той лестницы.
      reviewStep: wasLearned ? Math.max(0, Math.min(oldSrs.level ?? 0, 5)) : -1,
      nextReviewDate: wasLearned ? (oldSrs.dueDate ?? Date.now()) : null,
      inDailyBatch: false,
      totalReviews: oldSrs.totalReviews || 0,
      totalCorrect: oldSrs.totalCorrect || 0,
      lastReviewed: oldSrs.lastReviewed || null,
    };
  }

  return {
    ...w,
    examples,
    wordType: w.wordType || '',
    related: Array.isArray(w.related) ? w.related : [],
    // hanja: [{ char: '韓', meaningInWord: 'Корея' }, ...] — по одному на слог/часть слова,
    // пусто у исконно корейских слов (고유어).
    hanja: Array.isArray(w.hanja) ? w.hanja : [],
    updatedAt: w.updatedAt || w.createdAt || Date.now(),
    srs,
  };
}

// Слияние слов с другого устройства с локальными: по каждому id оставляем ту
// версию, что менялась позже (updatedAt), а не заменяем весь список целиком —
// иначе слово, добавленное здесь прямо перед синхронизацией, могло бы потеряться.
// remoteWasStale = true, если в облаке не хватало чего-то, что есть только тут.
function mergeWordLists(localWords, remoteWords) {
  const map = new Map(remoteWords.map(w => [w.id, w]));
  let remoteWasStale = false;

  localWords.forEach(w => {
    const remote = map.get(w.id);
    if (!remote || (w.updatedAt || 0) > (remote.updatedAt || 0)) {
      map.set(w.id, w);
      remoteWasStale = true;
    }
  });

  return { merged: [...map.values()], remoteWasStale };
}

// Активность за день берём как максимум из двух устройств, а не перезаписываем —
// иначе счётчик за сегодняшний день на одном устройстве мог стереть счётчик с другого.
function mergeStudyLogs(a, b) {
  const merged = { ...a };
  Object.keys(b).forEach(day => {
    merged[day] = Math.max(merged[day] || 0, b[day] || 0);
  });
  return merged;
}

// Те же принципы, что и mergeWordLists, но ключ — сам иероглиф, а не id.
function mergeHanjaLists(localList, remoteList) {
  const map = new Map(remoteList.map(h => [h.char, h]));
  localList.forEach(h => {
    const remote = map.get(h.char);
    if (!remote || (h.updatedAt || 0) > (remote.updatedAt || 0)) map.set(h.char, h);
  });
  return [...map.values()];
}

const Storage = {
  getWords() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      const words = raw ? JSON.parse(raw) : [];
      return words.map(migrateWord);
    } catch (e) {
      console.error('Не удалось прочитать словарь', e);
      return [];
    }
  },

  saveWords(words) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(words));
  },

  addWord(word) {
    const words = this.getWords();
    const now = Date.now();
    const entry = {
      id: uid(),
      korean: word.korean.trim(),
      translation: word.translation.trim(),
      transcription: (word.transcription || '').trim(),
      category: (word.category || '').trim(),
      wordType: (word.wordType || '').trim(),
      examples: Array.isArray(word.examples) ? word.examples.filter(Boolean) : (word.example ? [word.example] : []),
      notes: (word.notes || '').trim(),
      createdAt: now,
      updatedAt: now,
      related: [],
      hanja: Array.isArray(word.hanja) ? word.hanja : [],
      srs: {
        stage: 1, stageStreak: 0, learned: false, learnedAt: null, reviewStep: -1, nextReviewDate: null,
        inDailyBatch: false, totalReviews: 0, totalCorrect: 0, lastReviewed: null,
      },
    };
    words.push(entry);
    this.saveWords(words);
    this.noteChange(1);
    return entry;
  },

  updateWord(id, patch) {
    const words = this.getWords();
    const idx = words.findIndex(w => w.id === id);
    if (idx === -1) return null;
    words[idx] = { ...words[idx], ...patch, updatedAt: Date.now() };
    this.saveWords(words);
    this.noteChange(1);
    return words[idx];
  },

  deleteWord(id) {
    const words = this.getWords().filter(w => w.id !== id);
    // Убираем висячие ссылки на удалённое слово из чужих списков связанных слов.
    words.forEach(w => {
      if ((w.related || []).some(r => r.id === id)) {
        w.related = w.related.filter(r => r.id !== id);
        w.updatedAt = Date.now();
      }
    });
    this.saveWords(words);
    this.noteChange(1);
  },

  // Связи симметричны (синоним/антоним/похоже по форме — отношение верно в обе
  // стороны), поэтому храним запись у обоих слов сразу.
  addRelation(idA, idB, relation) {
    if (idA === idB) return;
    const words = this.getWords();
    const a = words.find(w => w.id === idA);
    const b = words.find(w => w.id === idB);
    if (!a || !b) return;
    const link = (word, otherId) => {
      word.related = (word.related || []).filter(r => r.id !== otherId);
      word.related.push({ id: otherId, relation });
      word.updatedAt = Date.now();
    };
    link(a, idB);
    link(b, idA);
    this.saveWords(words);
    this.noteChange(1);
  },

  removeRelation(idA, idB) {
    const words = this.getWords();
    const a = words.find(w => w.id === idA);
    const b = words.find(w => w.id === idB);
    if (a) { a.related = (a.related || []).filter(r => r.id !== idB); a.updatedAt = Date.now(); }
    if (b) { b.related = (b.related || []).filter(r => r.id !== idA); b.updatedAt = Date.now(); }
    this.saveWords(words);
    this.noteChange(1);
  },

  clearAll() {
    // Стирает только слова — API-ключи, токен GitHub и тема остаются как есть.
    localStorage.removeItem(STORAGE_KEY);
    const state = this.getState();
    state.backup = { lastBackupAt: null, changesSinceBackup: 0 };
    state.studyLog = {};
    state.dailyLearnedLog = {};
    state.dataUpdatedAt = Date.now();
    this.saveState(state);
  },

  getState() {
    try {
      const raw = localStorage.getItem(STATE_KEY);
      const state = raw ? JSON.parse(raw) : {};
      return {
        theme: null,
        studyLog: {},
        dailyLearnedLog: {},
        apiKey: '',
        backup: { lastBackupAt: null, changesSinceBackup: 0 },
        dataUpdatedAt: 0,
        lastSeenStreak: 0, // для анимации цветка-стрика — чисто локальное, не синхронизируется
        dailyGoal: 15,
        github: { token: '', owner: '', repo: 'korean-words-data', path: 'data.json', sha: null, lastSyncAt: null },
        ...state,
      };
    } catch (e) {
      return {
        theme: null, studyLog: {}, dailyLearnedLog: {}, apiKey: '',
        backup: { lastBackupAt: null, changesSinceBackup: 0 },
        dataUpdatedAt: 0,
        github: { token: '', owner: '', repo: 'korean-words-data', path: 'data.json', sha: null, lastSyncAt: null },
      };
    }
  },

  saveState(state) {
    localStorage.setItem(STATE_KEY, JSON.stringify(state));
  },

  logReview(count) {
    const state = this.getState();
    const day = todayStr();
    state.studyLog = state.studyLog || {};
    state.studyLog[day] = (state.studyLog[day] || 0) + count;
    this.saveState(state);
  },

  // Считает выученные сегодня слова суммарно за календарный день — не
  // привязано к дневной пачке, поэтому не обнуляется, когда пачка закрыта и
  // назначена новая. Сбрасывается само собой при смене дня (ключ — todayStr()).
  logWordLearned() {
    const state = this.getState();
    const day = todayStr();
    state.dailyLearnedLog = state.dailyLearnedLog || {};
    state.dailyLearnedLog[day] = (state.dailyLearnedLog[day] || 0) + 1;
    this.saveState(state);
  },

  noteChange(n) {
    const state = this.getState();
    state.backup = state.backup || { lastBackupAt: null, changesSinceBackup: 0 };
    state.backup.changesSinceBackup = (state.backup.changesSinceBackup || 0) + n;
    state.dataUpdatedAt = Date.now();
    this.saveState(state);
  },

  markBackedUp() {
    const state = this.getState();
    state.backup = { lastBackupAt: Date.now(), changesSinceBackup: 0 };
    this.saveState(state);
  },

  exportJSON() {
    // В файл экспорта не кладём секреты (ключ Claude, токен GitHub) — они
    // остаются только в этом браузере и не нужны для восстановления слов.
    const state = this.getState();
    const safeState = { ...state, apiKey: '', github: { ...state.github, token: '' } };
    return JSON.stringify({ words: this.getWords(), state: safeState, exportedAt: new Date().toISOString() }, null, 2);
  },

  // ---- Иероглифы (ханча): личные привязки живут на самом слове (hanja[]),
  // а справочная база иероглифов — отдельная сущность. HANJA_BASE_DATA (см.
  // hanja-data.js) — это готовый датасет 1800 базовых ханча, "кастомные" —
  // те, что пользователь добавил сам и которых не было в базовом датасете.
  getCustomHanja() {
    try {
      const raw = localStorage.getItem(HANJA_CUSTOM_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch (e) {
      return [];
    }
  },

  saveCustomHanja(list) {
    localStorage.setItem(HANJA_CUSTOM_KEY, JSON.stringify(list));
  },

  upsertCustomHanja(char, reading, meaning) {
    const list = this.getCustomHanja().filter(h => h.char !== char);
    list.push({ char, reading, meaning, updatedAt: Date.now() });
    this.saveCustomHanja(list);
    this.noteChange(1);
  },

  // Базовый датасет + кастомные (кастомные перекрывают базовые при совпадении символа).
  getHanjaDatabase() {
    const map = new Map(HANJA_BASE_DATA.map(h => [h.char, h]));
    this.getCustomHanja().forEach(h => map.set(h.char, h));
    return [...map.values()];
  },

  findHanja(char) {
    return this.getHanjaDatabase().find(h => h.char === char) || null;
  },

  // То, что реально синхронизируется между устройствами через GitHub —
  // без секретов (токен, API-ключ Claude, тема — всё это только для этого браузера).
  getSyncPayload() {
    const state = this.getState();
    return {
      words: this.getWords(),
      studyLog: state.studyLog || {},
      dailyLearnedLog: state.dailyLearnedLog || {},
      customHanja: this.getCustomHanja(),
      savedAt: state.dataUpdatedAt || 0,
    };
  },

  // Возвращает remoteWasStale — было ли в облаке что-то устаревшее по сравнению
  // с этим устройством (тогда вызывающий код должен отправить слияние обратно).
  applySyncPayload(payload) {
    const remoteWords = (payload.words || []).map(migrateWord);
    const { merged, remoteWasStale } = mergeWordLists(this.getWords(), remoteWords);
    this.saveWords(merged);
    this.saveCustomHanja(mergeHanjaLists(this.getCustomHanja(), payload.customHanja || []));

    const state = this.getState();
    state.studyLog = mergeStudyLogs(state.studyLog || {}, payload.studyLog || {});
    state.dailyLearnedLog = mergeStudyLogs(state.dailyLearnedLog || {}, payload.dailyLearnedLog || {});
    state.dataUpdatedAt = Date.now();
    this.saveState(state);

    return { remoteWasStale };
  },

  importJSON(json, mode) {
    const data = JSON.parse(json);
    const incoming = (Array.isArray(data.words) ? data.words : Array.isArray(data) ? data : []).map(migrateWord);
    let added;
    if (mode === 'replace') {
      this.saveWords(incoming);
      added = incoming.length;
    } else {
      const existing = this.getWords();
      const existingIds = new Set(existing.map(w => w.id));
      added = 0;
      for (const w of incoming) {
        if (!w.id || !existingIds.has(w.id)) {
          existing.push({ ...w, id: w.id || uid() });
          added++;
        }
      }
      this.saveWords(existing);
    }
    // Из импортированного файла берём только историю занятий — секреты
    // (API-ключи, токен GitHub, тема) этого браузера никогда не перезаписываем.
    if (data.state && (data.state.studyLog || data.state.dailyLearnedLog)) {
      const state = this.getState();
      state.studyLog = { ...state.studyLog, ...(data.state.studyLog || {}) };
      state.dailyLearnedLog = { ...state.dailyLearnedLog, ...(data.state.dailyLearnedLog || {}) };
      this.saveState(state);
    }
    this.noteChange(added);
    return { added, mode };
  }
};
