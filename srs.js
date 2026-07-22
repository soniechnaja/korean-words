// Два независимых потока обучения:
// 1) Новые слова — фиксированная дневная пачка, прогресс по стадиям упражнений
//    (карточка → выбор перевода → вставка в предложение); пройдя 3-ю стадию,
//    слово считается выученным и уходит в очередь повторения.
// 2) Очередь повторения — интервальное повторение (spaced repetition) с
//    растущими интервалами; ошибка откатывает на шаг назад, а не сбрасывает.
const NEW_WORD_STAGE_MAX = 3; // 1 = карточка, 2 = выбор перевода, 3 = вставить в предложение; дальше — выпуск в повторение
const STAGE_STREAK_TO_ADVANCE = 2; // столько подряд верных ответов нужно, чтобы перейти на стадию выше
const REVIEW_INTERVALS_DAYS = [1, 3, 5, 7, 14, 30];
const DAY_MS = 24 * 60 * 60 * 1000;

const SRS = {
  isLearned(word) {
    return !!word.srs.learned;
  },

  isReviewDue(word, now = Date.now()) {
    return word.srs.learned && word.srs.nextReviewDate != null && word.srs.nextReviewDate <= now;
  },

  // Готово к практике "Письмо": слово выучено и пережило хотя бы 2 успешных повтора.
  isWritingReady(word) {
    return word.srs.learned && word.srs.reviewStep >= 2;
  },

  // Грейдинг во время изучения новых слов (карточка / выбор перевода).
  // isCorrect: boolean — ответ засчитан верным или нет.
  gradeNewWord(word, isCorrect) {
    const srs = { ...word.srs };
    srs.totalReviews += 1;
    const now = Date.now();

    if (isCorrect) {
      srs.totalCorrect += 1;
      srs.stageStreak = (srs.stageStreak || 0) + 1;
      if (srs.stageStreak >= STAGE_STREAK_TO_ADVANCE) {
        srs.stage += 1;
        srs.stageStreak = 0;
        if (srs.stage > NEW_WORD_STAGE_MAX) {
          // Прошло 3-ю стадию (вставка в предложение) — "выучено сегодня", уходит в очередь повторения.
          srs.learned = true;
          srs.reviewStep = 0;
          srs.nextReviewDate = now + REVIEW_INTERVALS_DAYS[0] * DAY_MS;
        }
      }
    } else {
      srs.stageStreak = 0;
    }
    srs.lastReviewed = now;
    return srs;
  },

  // Грейдинг в очереди повторения. isCorrect: boolean.
  gradeReview(word, isCorrect) {
    const srs = { ...word.srs };
    srs.totalReviews += 1;
    const now = Date.now();

    if (isCorrect) {
      srs.totalCorrect += 1;
      srs.reviewStep = Math.min(REVIEW_INTERVALS_DAYS.length - 1, srs.reviewStep + 1);
    } else {
      // Откат на шаг назад в лестнице интервалов, а не сброс на "1 день".
      srs.reviewStep = Math.max(0, srs.reviewStep - 1);
    }
    srs.nextReviewDate = now + REVIEW_INTERVALS_DAYS[srs.reviewStep] * DAY_MS;
    srs.lastReviewed = now;
    return srs;
  },
};
