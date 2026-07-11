// Простая система интервального повторения (в духе Leitner/Anki)
// плюс прогресс по уровням упражнений (карточка → выбор → предложение → письмо).
const SRS_INTERVALS_DAYS = [0, 1, 3, 7, 14, 30, 90, 180];
const SRS_MASTERED_LEVEL = 4; // с этого уровня слово считается "выученным уверенно"

const STAGE_MAX = 4;
const STAGE_STREAK_TO_ADVANCE = 2; // столько подряд успешных ответов нужно, чтобы перейти на уровень выше
const STAGE_LABELS = {
  1: 'карточка',
  2: 'выбор перевода',
  3: 'предложение',
  4: 'письмо',
};

const SRS = {
  isDue(word, now = Date.now()) {
    return word.srs.dueDate <= now;
  },

  isMastered(word) {
    return word.srs.level >= SRS_MASTERED_LEVEL;
  },

  stageLabel(word) {
    return STAGE_LABELS[word.srs.stage] || STAGE_LABELS[1];
  },

  // grade: 'again' | 'hard' | 'good' | 'easy'
  grade(word, grade) {
    const srs = { ...word.srs };
    srs.totalReviews += 1;
    const now = Date.now();

    if (grade === 'again') {
      srs.level = 0;
    } else if (grade === 'hard') {
      srs.level = Math.max(0, srs.level - 1);
    } else if (grade === 'good') {
      srs.level = Math.min(SRS_INTERVALS_DAYS.length - 1, srs.level + 1);
    } else if (grade === 'easy') {
      srs.level = Math.min(SRS_INTERVALS_DAYS.length - 1, srs.level + 2);
    }

    if (grade === 'good' || grade === 'easy') {
      srs.totalCorrect += 1;
      srs.stageStreak = (srs.stageStreak || 0) + 1;
      if (srs.stageStreak >= STAGE_STREAK_TO_ADVANCE && srs.stage < STAGE_MAX) {
        srs.stage += 1;
        srs.stageStreak = 0;
      }
    } else {
      srs.stageStreak = 0;
    }

    const days = SRS_INTERVALS_DAYS[srs.level];
    srs.dueDate = now + days * 24 * 60 * 60 * 1000;
    srs.lastReviewed = now;
    return srs;
  }
};
