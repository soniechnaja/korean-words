// Слой хранения: всё живёт в localStorage этого браузера.
const STORAGE_KEY = 'kw_words_v1';
const STATE_KEY = 'kw_state_v1';

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
  return {
    ...w,
    examples,
    wordType: w.wordType || '',
    related: Array.isArray(w.related) ? w.related : [],
    updatedAt: w.updatedAt || w.createdAt || Date.now(),
    srs: {
      level: 0,
      dueDate: Date.now(),
      lastReviewed: null,
      totalReviews: 0,
      totalCorrect: 0,
      stage: 1,
      stageStreak: 0,
      ...w.srs,
    },
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
      srs: { level: 0, dueDate: now, lastReviewed: null, totalReviews: 0, totalCorrect: 0, stage: 1, stageStreak: 0 }
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
        apiKey: '',
        backup: { lastBackupAt: null, changesSinceBackup: 0 },
        dataUpdatedAt: 0,
        github: { token: '', owner: '', repo: 'korean-words-data', path: 'data.json', sha: null, lastSyncAt: null },
        ...state,
      };
    } catch (e) {
      return {
        theme: null, studyLog: {}, apiKey: '',
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

  // То, что реально синхронизируется между устройствами через GitHub —
  // без секретов (токен, API-ключ Claude, тема — всё это только для этого браузера).
  getSyncPayload() {
    const state = this.getState();
    return {
      words: this.getWords(),
      studyLog: state.studyLog || {},
      savedAt: state.dataUpdatedAt || 0,
    };
  },

  // Возвращает remoteWasStale — было ли в облаке что-то устаревшее по сравнению
  // с этим устройством (тогда вызывающий код должен отправить слияние обратно).
  applySyncPayload(payload) {
    const remoteWords = (payload.words || []).map(migrateWord);
    const { merged, remoteWasStale } = mergeWordLists(this.getWords(), remoteWords);
    this.saveWords(merged);

    const state = this.getState();
    state.studyLog = mergeStudyLogs(state.studyLog || {}, payload.studyLog || {});
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
    if (data.state && data.state.studyLog) {
      const state = this.getState();
      state.studyLog = { ...state.studyLog, ...data.state.studyLog };
      this.saveState(state);
    }
    this.noteChange(added);
    return { added, mode };
  }
};
