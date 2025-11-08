// === MESO CONFIG ===
// Конфигурация приложения с настройками по умолчанию

export const CONFIG = {
  // RIR по типам упражнений для каждой недели
  // Формат: { week: { type: { min: number, max: number } } }
  TARGET_RIR: {
    1: {
      'A': { min: 2, max: 3 },
      'B': { min: 1, max: 2 },
      'C': { min: 0, max: 1 },
      'D': { min: 0, max: 1 }
    },
    2: {
      'A': { min: 1, max: 2 },
      'B': { min: 0, max: 1 },
      'C': { min: 0, max: 1 },
      'D': { min: 0, max: 1 }
    },
    3: {
      'A': { min: 0, max: 1 },
      'B': { min: 0, max: 1 },
      'C': { min: 0, max: 1 },
      'D': { min: 0, max: 1 }
    },
    4: {
      'A': { min: 2, max: 3 }, // Делоуд
      'B': { min: 1, max: 2 },
      'C': { min: 0, max: 1 },
      'D': { min: 0, max: 1 }
    }
  },

  // Шаги веса и округление по типам упражнений
  WEIGHT_INCREMENTS: {
    'A': { small: 2.5, medium: 5, large: 5 },    // Основные: +2.5/5 кг
    'B': { small: 2.5, medium: 2.5, large: 5 }, // Тяжелые вспомогательные: +2.5 кг
    'C': { small: 1, medium: 2, large: 2.5 },    // Изоляция: +1-2 кг
    'D': { small: 1, medium: 2, large: 2.5 }     // Вспомогательные: +1-2 кг
  },

  // Лимиты обновления TM за сессию (в процентах)
  TM_UPDATE_LIMITS: {
    up: {
      upper: 0.015,   // Верх: ≤ 1.5%
      legs: 0.03      // Ноги: ≤ 3%
    },
    down: {
      upper: 0.01,    // Верх: ≤ 1.0%
      legs: 0.015     // Ноги: ≤ 1.5%
    }
  },

  // Параметры EMA для сглаживания TM
  TM_EMA: {
    alpha: 0.2,  // Коэффициент сглаживания (0.8 × old + 0.2 × new)
    minSessions: 1  // Минимальное количество сессий для обновления
  },

  // Параметры посева TM
  TM_SEED: {
    factor: 0.93,  // 0.93-0.95 × e1RM для первого TM
    minSets: 1,    // Минимальное количество качественных сетов
    maxSets: 3     // Максимальное количество сетов для медианы
  },

  // Микро-коррекция веса на следующий сет
  MICRO_ADJUST: {
    enabled: true,
    thresholds: {
      tooEasy: 1,   // RIR выше цели на ≥1
      tooHard: 1    // RIR ниже цели на ≥1
    },
    adjustments: {
      tooEasy: 0.025,  // +2.5% веса
      tooHard: -0.0375 // -3.75% веса (среднее между -2.5% и -5%)
    }
  },

  // Фильтр "качественного" сета для TM
  QUALITY_SET_FILTER: {
    minReps: 3,
    maxReps: 12,
    rirTolerance: 1,  // |RIR_факт − RIR_целевой| ≤ 1
    excludeWarmup: true,
    excludeTechnical: true
  },

  // Общие лимиты
  LIMITS: {
    MAX_WEIGHT: 500,
    MIN_WEIGHT: 0.5,
    MAX_REPS: 100,
    MIN_REPS: 1,
    MAX_TM: 500,
    E1RM_FACTOR: 30, // Epley formula factor
    NOTIFICATION_DURATION: 3000,
    AUTOSAVE_INTERVAL: 5000,
    DEBOUNCE_DELAY: 500
  },

  // Настройки по умолчанию (могут быть переопределены пользователем)
  DEFAULTS: {
    autoTM: true,                    // Автоматическое обновление TM
    microAutoAdjust: true,            // Микро-коррекция веса на следующий сет
    applyHintsOnOpen: false,         // Применять подсказки при открытии дня
    restDurations: {                 // Длительности отдыха по типам (секунды)
      'A': 180,  // 3 минуты
      'B': 120,  // 2 минуты
      'C': 90,   // 1.5 минуты
      'D': 90    // 1.5 минуты
    }
  }
};

// Утилиты для работы с конфигом
export function getTargetRIR(week, exerciseType) {
  const weekConfig = CONFIG.TARGET_RIR[week] || CONFIG.TARGET_RIR[1];
  const typeConfig = weekConfig[exerciseType] || weekConfig['A'];
  return typeConfig;
}

export function getWeightIncrement(exerciseType, size = 'medium') {
  const type = exerciseType || 'A';
  const increments = CONFIG.WEIGHT_INCREMENTS[type] || CONFIG.WEIGHT_INCREMENTS['A'];
  return increments[size] || increments.medium;
}

export function getTMUpdateLimit(exercise, direction = 'up') {
  const isLegExercise = exercise.toLowerCase().includes('присед') ||
                        exercise.toLowerCase().includes('squat') ||
                        exercise.toLowerCase().includes('ноги') ||
                        exercise.toLowerCase().includes('deadlift') ||
                        exercise.toLowerCase().includes('тяга');
  
  const category = isLegExercise ? 'legs' : 'upper';
  const limits = CONFIG.TM_UPDATE_LIMITS[direction];
  return limits[category];
}

export function isQualitySet(set, targetRIR) {
  const filter = CONFIG.QUALITY_SET_FILTER;
  
  // Проверка повторов (если reps не передан, пропускаем эту проверку)
  if (set.reps != null && (set.reps < filter.minReps || set.reps > filter.maxReps)) {
    return false;
  }
  
  // Проверка RIR
  if (set.rir != null && targetRIR != null) {
    const targetRIRNum = typeof targetRIR === 'string' 
      ? parseFloat(targetRIR.replace('–', '-').split('-')[0])
      : Number(targetRIR);
    
    if (!isNaN(targetRIRNum)) {
      const rirDiff = Math.abs(set.rir - targetRIRNum);
      if (rirDiff > filter.rirTolerance) {
        return false;
      }
    }
  }
  
  // Проверка на warm-up/технический (если есть флаги)
  if (filter.excludeWarmup && set.isWarmup) {
    return false;
  }
  
  if (filter.excludeTechnical && set.isTechnical) {
    return false;
  }
  
  return true;
}

