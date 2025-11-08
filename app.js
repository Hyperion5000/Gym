// === MESO App (SQL.js) ===
import * as dbModule from './db.js';
import { 
  CONFIG, 
  getTargetRIR, 
  getWeightIncrement, 
  getTMUpdateLimit, 
  isQualitySet 
} from './config.js';

// Защита от повторного выполнения модуля (после импорта)
if (window.__MESO_MODULE_LOADED__) {
  console.warn('app.js уже загружен, пропускаем повторную загрузку');
  // Модуль уже загружен, прекращаем выполнение
  // В ES6 модулях нельзя просто выйти, но можно проверить и пропустить инициализацию
}
window.__MESO_MODULE_LOADED__ = true;

// === КОНСТАНТЫ (из конфига) ===
// CONFIG импортируется через import, поэтому он должен быть доступен
// Если CONFIG не определен, это означает проблему с загрузкой config.js
const LIMITS = (CONFIG && CONFIG.LIMITS) ? CONFIG.LIMITS : {
  E1RM_FACTOR: 30,
  WEIGHT_ROUNDING: 2.5,
  MAX_WEIGHT: 500,
  MIN_WEIGHT: 0.5,
  MAX_REPS: 100,
  MIN_REPS: 1,
  MAX_TM: 500,
  DEBOUNCE_DELAY: 500,
  AUTOSAVE_INTERVAL: 5000
};

let PLAN = {};
let CURRENT_SESSION = null;
const $ = (s) => document.querySelector(s);

// DOM Cache
const DOM = {
  week: null,
  day: null,
  date: null,
  exercisesList: null,
  sessionStatus: null,
  btnFinish: null,
  btnSave: null
};

// === УТИЛИТЫ ===
// Debounce функция
function debounce(func, wait) {
  let timeout;
  return function executedFunction(...args) {
    const later = () => {
      clearTimeout(timeout);
      func(...args);
    };
    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
  };
}

// Вспомогательные функции
function e1rm(w, r) {
  if (!w || !r) return null;
  return Math.round(w * (1 + r / LIMITS.E1RM_FACTOR) * 10) / 10;
}

function estRIR(tm, w, r) {
  if (!tm || !w || !r) return null;
  const reps0 = LIMITS.E1RM_FACTOR * (tm / w - 1);
  const rir = Math.max(0, reps0 - r);
  return Math.round(rir * 10) / 10;
}

function rpeFromRir(rir) {
  if (rir == null) return null;
  return Math.round((10 - rir) * 10) / 10;
}

// Разумные ступени веса по типам упражнений (используем из конфига)
// getWeightIncrement импортирован из config.js

// Округление до стандартных блинов (1.25, 2.5, 5 кг)
// Защита от дублирования функции при повторной загрузке модуля
if (typeof window.roundToStandardPlates === 'undefined') {
  window.roundToStandardPlates = function(weight, exerciseType) {
    if (!weight || weight <= 0) return 0;
    
    // Стандартные блины: 1.25, 2.5, 5, 10, 15, 20, 25 кг
    const plates = [1.25, 2.5, 5, 10, 15, 20, 25];
    
    // Округляем до ближайшего стандартного блина
    let rounded = weight;
    let minDiff = Infinity;
    
    for (const plate of plates) {
      // Проверяем кратные блина
      for (let multiplier = 1; multiplier <= 20; multiplier++) {
        const candidate = plate * multiplier;
        const diff = Math.abs(weight - candidate);
        if (diff < minDiff) {
          minDiff = diff;
          rounded = candidate;
        }
        // Если уже слишком далеко, прекращаем
        if (candidate > weight * 1.5) break;
      }
    }
    
    // Если разница слишком большая, используем стандартное округление
    // Для типа A: 2.5, для остальных: 1-2.5 в зависимости от типа
    const increment = getWeightIncrement(exerciseType, 'medium');
    if (minDiff > increment) {
      rounded = Math.round(weight / increment) * increment;
    }
    
    return Math.max(0, Math.round(rounded * 10) / 10);
  };
}

// Используем функцию напрямую из window для избежания конфликтов модулей
// Не создаем локальную константу, чтобы избежать ошибки при повторной загрузке модуля

// Обратная функция: расчет веса по ТМ, целевому RIR и повторам
// Формула: вес ≈ TM / (1 + (repsTarget + tRIR)/30)
function weightFromRIR(tm, targetRIR, reps, exerciseType) {
  if (!tm || !targetRIR || !reps || tm <= 0 || reps <= 0) return null;
  
  // Если целевой RIR - диапазон (например, "3-4"), берем среднее
  const rir = typeof targetRIR === 'string' && targetRIR.includes('–') 
    ? targetToNumber(targetRIR) 
    : Number(targetRIR);
  
  if (isNaN(rir) || rir < 0) return null;
  
  // Формула: w = tm / (1 + (repsTarget + tRIR) / E1RM_FACTOR)
  const weight = tm / (1 + (reps + rir) / LIMITS.E1RM_FACTOR);
  
  // Используем переданный тип упражнения или 'A' по умолчанию
  const exType = exerciseType || 'A';
  
  // Округляем до стандартных блинов с учетом типа упражнения
  const rounded = window.roundToStandardPlates(weight, exType);
  
  // Проверяем минимальный вес
  return rounded >= LIMITS.MIN_WEIGHT ? rounded : null;
}

// Расчет повторов по ТМ, целевому RIR и весу
function repsFromRIR(tm, targetRIR, weight) {
  if (!tm || !targetRIR || !weight || tm <= 0 || weight <= 0) return null;
  
  // Если целевой RIR - диапазон, берем среднее
  const rir = typeof targetRIR === 'string' && targetRIR.includes('–') 
    ? targetToNumber(targetRIR) 
    : Number(targetRIR);
  
  if (isNaN(rir) || rir < 0) return null;
  
  // Формула: reps = reps0 - rir, где reps0 = LIMITS.E1RM_FACTOR * (tm / w - 1)
  const reps0 = LIMITS.E1RM_FACTOR * (tm / weight - 1);
  const reps = Math.max(1, Math.round(reps0 - rir));
  
  // Проверяем максимальное количество повторов
  return reps <= LIMITS.MAX_REPS ? reps : null;
}

function targetToNumber(t) {
  if (typeof t !== 'string') t = String(t || '');
  if (t.includes('–')) {
    const [a, b] = t.split('–').map(s => Number(s.replace(',', '.')));
    return (a + b) / 2;
  }
  const n = Number(t.replace(',', '.'));
  return isNaN(n) ? null : n;
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function normalizeNumber(v) {
  if (typeof v !== 'string') v = String(v || '');
  v = v.replace(',', '.').replace(/[^0-9.\-]/g, '');
  return v;
}

// === ВАЛИДАЦИЯ (ОБОБЩЕННАЯ) ===
function validateNumber(value, options = {}) {
  const {
    min = -Infinity,
    max = Infinity,
    integer = false,
    positive = false,
    fieldName = 'Значение'
  } = options;
  
  const n = Number(value);
  if (isNaN(n)) return { valid: false, message: `${fieldName}: введите корректное число` };
  if (positive && n <= 0) return { valid: false, message: `${fieldName} должно быть > 0` };
  if (n < min) return { valid: false, message: `${fieldName} < ${min}` };
  if (n > max) return { valid: false, message: `${fieldName} > ${max} (подозрительно большое)` };
  if (integer && !Number.isInteger(n)) return { valid: false, message: `${fieldName} должно быть целым числом` };
  return { valid: true };
}

// Специализированные функции валидации
const validateWeight = (w) => validateNumber(w, { 
  min: 0, // Разрешаем 0 для подтягиваний с собственным весом
  max: LIMITS.MAX_WEIGHT, 
  positive: false, // Разрешаем 0
  fieldName: 'Вес' 
});

const validateReps = (r) => validateNumber(r, { 
  min: LIMITS.MIN_REPS, 
  max: LIMITS.MAX_REPS, 
  integer: true, 
  positive: true,
  fieldName: 'Повторы' 
});

const validateTM = (tm) => validateNumber(tm, { 
  min: 0, 
  max: LIMITS.MAX_TM, 
  positive: true, 
  fieldName: 'ТМ' 
});

// Показать уведомление
function showNotification(message, type = 'info') {
  const notification = document.createElement('div');
  notification.className = `notification notification-${type}`;
  notification.textContent = message;
  document.body.appendChild(notification);
  
  setTimeout(() => {
    notification.classList.add('show');
  }, 10);
  
  setTimeout(() => {
    notification.classList.remove('show');
    setTimeout(() => notification.remove(), 300);
  }, LIMITS.NOTIFICATION_DURATION);
}

// Загрузка плана тренировок
async function loadPlan() {
  PLAN = {};
  try {
    const data = await dbModule.query('SELECT * FROM plan ORDER BY day');
    
    if (data && data.length > 0) {
      for (const row of data) {
        const d = row.day;
        if (d) {
          (PLAN[d] = PLAN[d] || []).push({
            name: row.exercise,
            setrep: row.setrep,
            type: row.type,
            target: { 1: row.rir_w1, 2: row.rir_w2, 3: row.rir_w3, 4: row.rir_w4 },
            note: row.note || ''
          });
        }
      }
      
      console.log(`Plan loaded: ${data.length} exercises in ${Object.keys(PLAN).length} days`);
    }
    
    // Если план пустой, загружаем из CSV
    if (!data || data.length === 0) {
      console.log('Plan is empty, loading from CSV...');
      await loadPlanFromCSV();
    }
  } catch (error) {
    console.error('Failed to load plan from DB:', error);
    // Пытаемся загрузить из CSV
    await loadPlanFromCSV();
  }
}

// Загрузка плана из CSV
let isLoadingPlanFromCSV = false; // Флаг для предотвращения бесконечного цикла

async function loadPlanFromCSV() {
  // Предотвращаем бесконечный цикл
  if (isLoadingPlanFromCSV) {
    console.warn('loadPlanFromCSV already in progress, skipping...');
    return;
  }
  
  isLoadingPlanFromCSV = true;
  
  try {
    // Убеждаемся, что схема БД создана
    await dbModule.initDatabase();
    
    const response = await fetch('./plan.csv');
    if (!response.ok) {
      throw new Error(`Failed to fetch plan.csv: ${response.status} ${response.statusText}`);
    }
    const csvText = await response.text();
    if (!csvText || csvText.trim().length === 0) {
      throw new Error('plan.csv is empty');
    }
    
    console.log('Loading plan from CSV...');
    await dbModule.loadCSVIntoTable('plan', csvText);
    
    // Перезагружаем план из БД (но без вызова loadPlanFromCSV снова)
    PLAN = {};
    const data = await dbModule.query('SELECT * FROM plan ORDER BY day');
    
    if (data && data.length > 0) {
      for (const row of data) {
        const d = row.day;
        if (d) {
          (PLAN[d] = PLAN[d] || []).push({
            name: row.exercise,
            setrep: row.setrep,
            type: row.type,
            target: { 1: row.rir_w1, 2: row.rir_w2, 3: row.rir_w3, 4: row.rir_w4 },
            note: row.note || ''
          });
        }
      }
      console.log(`Plan loaded successfully: ${data.length} exercises in ${Object.keys(PLAN).length} days`);
    }
  } catch (error) {
    console.error('Failed to load plan from CSV:', error);
    const errorMsg = `Не удалось загрузить план тренировок: ${error.message}`;
    console.error(errorMsg);
    showNotification(errorMsg, 'error');
  } finally {
    isLoadingPlanFromCSV = false;
  }
}

// Кэширование DOM элементов
function cacheDOM() {
  DOM.week = $("#week");
  DOM.day = $("#day");
  DOM.date = $("#date");
  DOM.exercisesList = $("#exercises-list");
  DOM.sessionStatus = $("#session-status");
  DOM.btnFinish = $("#btn-finish");
  DOM.btnSave = $("#btn-save");
}

// Построение опций дней
async function buildDayOptions() {
  const sel = DOM.day || $("#day");
  sel.innerHTML = "";
  Object.keys(PLAN).forEach(d => {
    const o = document.createElement("option");
    o.value = d;
    o.textContent = d;
    sel.appendChild(o);
  });
  await buildExercises();
}

// Автоматический расчет ТМ на основе истории
async function getAutoTM(exercise) {
  try {
    // Получаем лучший e1RM за последние 4 недели
    const best = await dbModule.getOne(
      `SELECT MAX(e1rm) as best_e1rm 
       FROM tracker 
       WHERE exercise = ? 
       AND date >= date('now', '-28 days')
       AND e1rm IS NOT NULL`,
      [exercise]
    );
    
    if (best && best.best_e1rm) {
      // ТМ = 90% от 1RM (стандартная практика)
      return Math.round(best.best_e1rm * 0.9 * 10) / 10;
    }
    
    return null;
  } catch (error) {
    console.warn('Failed to calculate auto TM:', error);
    return null;
  }
}

// Получение коэффициента недели
function getWeekCoefficient(week) {
  const weekCoefficients = {
    1: 0.85, // 85% от ТМ (RIR 3-4)
    2: 0.90, // 90% от ТМ (RIR 2-3)
    3: 0.95, // 95% от ТМ (RIR 1-2)
    4: 0.70  // 70% от ТМ (RIR 4-5, deload)
  };
  return weekCoefficients[week] || 0.85;
}

// Расчет рекомендованного веса
function getRecommendedWeight(tm, week, reps, exerciseType, targetRIR) {
  if (!tm || tm <= 0) return null;

  // Если есть целевой RIR, используем формулу weightFromRIR
  if (targetRIR) {
    return weightFromRIR(tm, targetRIR, reps, exerciseType);
  }

  // Иначе используем старую логику с коэффициентами
  // Авто-делоуд на неделе 4
  let coefficient = getWeekCoefficient(week);
  if (week === 4) {
    // Для недели 4: 90-92% от недели 3
    coefficient = 0.91; // Среднее между 0.90 и 0.92
  }

  const baseWeight = tm * coefficient;

  // Округление с учетом типа упражнения
  return window.roundToStandardPlates(baseWeight, exerciseType);
}

// Переключение раскрытия деталей упражнения
function toggleExerciseDetails(exerciseName) {
  const card = document.querySelector(`.exercise-card[data-exercise="${exerciseName}"]`);
  if (!card) return;
  
  const detailsPanel = card.querySelector('.exercise-details-panel');
  if (!detailsPanel) return;
  
  const isVisible = detailsPanel.style.display !== 'none';
  detailsPanel.style.display = isVisible ? 'none' : 'block';
  
  // Обновляем иконку кнопки
  const toggleBtn = card.querySelector('.btn-toggle-details');
  if (toggleBtn) {
    toggleBtn.textContent = isVisible ? 'ℹ️' : '▼';
  }
}

// Обновление ТМ после завершения недели 3
async function updateTMAfterCycle() {
  const currentWeek = Number((DOM.week || $("#week")).value);
  // Только для недели 3
  if (currentWeek !== 3) return;
  
  try {
    // Получить все упражнения из плана
    const allExercises = [];
    for (const day of Object.keys(PLAN)) {
      for (const ex of PLAN[day]) {
        if (!allExercises.find(e => e.name === ex.name)) {
          allExercises.push(ex.name);
        }
      }
    }
    
    let updatedCount = 0;
    
    for (const exercise of allExercises) {
      // Проверяем тип упражнения - обновляем ТМ только для типа A
      let exerciseType = null;
      for (const day of Object.keys(PLAN)) {
        const found = PLAN[day].find(ex => ex.name === exercise);
        if (found) {
          exerciseType = found.type;
          break;
        }
      }
      
      // Обновляем ТМ только для типа A
      if (exerciseType !== 'A') {
        continue;
      }
      
      // Лучший e1RM ТОЛЬКО из недели 3 за последние 7 дней
      const best = await dbModule.getOne(
        `SELECT MAX(e1rm) as best_e1rm 
         FROM tracker 
         WHERE exercise = ? AND week = 3 AND date >= date('now', '-7 days')`,
        [exercise]
      );
      
      if (best && best.best_e1rm > 0) {
        // Новый ТМ = 90% от лучшего e1RM недели 3
        const newTM = Math.round(best.best_e1rm * 0.9 * 10) / 10;
        
        await dbModule.execute(
          `UPDATE tm
           SET tm_kg = ?, updated_at = CURRENT_TIMESTAMP
           WHERE exercise = ?`,
          [newTM, exercise]
        );
        
        console.log(`${exercise}: ТМ обновлен ${newTM} кг`);
        updatedCount++;
      }
    }
    
    if (updatedCount > 0) {
      // Показать уведомление
      showNotification(
        "🎉 Цикл завершен! Базовые веса обновлены для следующего цикла.",
        "success"
      );
    }
  } catch (error) {
    console.error('Failed to update TM after cycle:', error);
  }
}

// Сброс цикла (очистка всех ТМ)
async function resetCycle() {
  if (!confirm('Вы уверены, что хотите сбросить все базовые веса? Это действие нельзя отменить.')) {
    return;
  }
  
  try {
    await dbModule.execute('DELETE FROM tm');
    showNotification('Все базовые веса сброшены. Запустите онбординг заново.', 'success');
    
    // Перезагружаем упражнения
    await buildExercises();
  } catch (error) {
    console.error('Failed to reset cycle:', error);
    showNotification('Ошибка при сбросе цикла', 'error');
  }
}

// Автоматическое обновление ТМ после сохранения сета (только для типа A)
// Улучшенная версия: сглаживание ТМ с фильтром по RIR и ограничителем шага
// === НАСТРОЙКИ ПОЛЬЗОВАТЕЛЯ ===
function getUserSettings() {
  try {
    const stored = localStorage.getItem('meso_user_settings');
    if (stored) {
      return JSON.parse(stored);
    }
  } catch (error) {
    console.warn('Failed to load user settings:', error);
  }
  return { ...CONFIG.DEFAULTS };
}

function saveUserSettings(settings) {
  try {
    localStorage.setItem('meso_user_settings', JSON.stringify(settings));
    return true;
  } catch (error) {
    console.warn('Failed to save user settings:', error);
    return false;
  }
}

function getUserSetting(key) {
  const settings = getUserSettings();
  return settings[key] !== undefined ? settings[key] : CONFIG.DEFAULTS[key];
}

function setUserSetting(key, value) {
  const settings = getUserSettings();
  settings[key] = value;
  saveUserSettings(settings);
}

// Проверка, включено ли авто-обновление TM
function isAutoTMEnabled() {
  return getUserSetting('autoTM');
}

// Проверка, включена ли микро-коррекция
function isMicroAdjustEnabled() {
  return getUserSetting('microAutoAdjust');
}

// Проверка, зафиксирован ли TM вручную
async function isTMLocked(exercise) {
  try {
    const tm = await dbModule.getOne(
      'SELECT locked FROM tm WHERE exercise = ?',
      [exercise]
    );
    return tm && tm.locked === 1;
  } catch (error) {
    return false;
  }
}

// Фиксация/разблокировка TM
async function setTMLock(exercise, locked) {
  try {
    // Убеждаемся, что колонка locked существует
    await dbModule.execute(`
      CREATE TABLE IF NOT EXISTS tm (
        exercise TEXT PRIMARY KEY,
        tm_kg REAL NOT NULL,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        locked INTEGER DEFAULT 0,
        source TEXT DEFAULT 'auto'
      )
    `);
    
    // Добавляем колонку locked если её нет
    try {
      await dbModule.execute('ALTER TABLE tm ADD COLUMN locked INTEGER DEFAULT 0');
    } catch (e) {
      // Колонка уже существует, игнорируем
    }
    
    try {
      await dbModule.execute('ALTER TABLE tm ADD COLUMN source TEXT DEFAULT "auto"');
    } catch (e) {
      // Колонка уже существует, игнорируем
    }
    
    await dbModule.execute(
      'UPDATE tm SET locked = ? WHERE exercise = ?',
      [locked ? 1 : 0, exercise]
    );
    return true;
  } catch (error) {
    console.warn('Failed to set TM lock:', error);
    return false;
  }
}

// === ПОСЕВ TM (автоматически) ===
async function seedTMFromSet(exercise, weight, reps, actualRIR, targetRIR) {
  // Проверяем, есть ли уже TM
  const existingTM = await dbModule.getOne(
    'SELECT tm_kg, locked FROM tm WHERE exercise = ?',
    [exercise]
  );
  
  if (existingTM && existingTM.tm_kg > 0) {
    return; // TM уже есть
  }
  
  // Если weight и reps переданы, проверяем качество сета
  if (weight && reps && weight > 0 && reps > 0) {
    const set = {
      weight: weight,
      reps: reps,
      rir: actualRIR
    };
    
    if (!isQualitySet(set, targetRIR)) {
      return; // Сет не качественный
    }
  }
  
  // Получаем все качественные сеты этого упражнения
  const qualitySets = await dbModule.query(
    `SELECT weight, reps, e1rm 
     FROM tracker 
     WHERE exercise = ? 
     AND reps >= ? 
     AND reps <= ?
     AND e1rm > 0
     AND (rir IS NULL OR target_rir IS NULL OR ABS(rir - CAST(REPLACE(target_rir, '–', '-') AS REAL)) <= ?)
     ORDER BY date DESC, set_no DESC
     LIMIT ?`,
    [
      exercise,
      CONFIG.QUALITY_SET_FILTER.minReps,
      CONFIG.QUALITY_SET_FILTER.maxReps,
      CONFIG.QUALITY_SET_FILTER.rirTolerance,
      CONFIG.TM_SEED.maxSets
    ]
  );
  
  let newTM;
  
  if (qualitySets.length === 0) {
    return; // Нет качественных сетов
  }
  
  if (qualitySets.length >= CONFIG.TM_SEED.minSets) {
    // Берем медиану e1RM из качественных сетов
    const e1rms = qualitySets.map(s => s.e1rm).sort((a, b) => a - b);
    const median = e1rms[Math.floor(e1rms.length / 2)];
    newTM = Math.round(median * CONFIG.TM_SEED.factor * 10) / 10;
  } else {
    // Используем лучший e1RM из качественных сетов
    const bestE1RM = Math.max(...qualitySets.map(s => s.e1rm));
    newTM = Math.round(bestE1RM * CONFIG.TM_SEED.factor * 10) / 10;
  }
  
  // Сохраняем TM
  await dbModule.execute(
    `INSERT OR REPLACE INTO tm (exercise, tm_kg, updated_at, source) VALUES (?, ?, CURRENT_TIMESTAMP, ?)`,
    [exercise, newTM, 'seed']
  );
  
  // Логируем
  await logTMUpdate(exercise, newTM, 'seed', `Посев TM из ${qualitySets.length} качественных сетов`);
  
  const bestE1RM = Math.max(...qualitySets.map(s => s.e1rm));
  console.log(`🌱 TM посеян для ${exercise}: ${newTM} кг (из e1RM ${bestE1RM} кг)`);
  
  return newTM;
}

// === МИКРО-КОРРЕКЦИЯ ВЕСА НА СЛЕДУЮЩИЙ СЕТ ===
function calculateMicroAdjustment(actualRIR, targetRIR, currentWeight) {
  if (!isMicroAdjustEnabled()) {
    return null;
  }
  
  if (!actualRIR || !targetRIR || !currentWeight) {
    return null;
  }
  
  const targetRIRNum = typeof targetRIR === 'string' 
    ? targetToNumber(targetRIR)
    : Number(targetRIR);
  
  if (targetRIRNum == null || isNaN(targetRIRNum)) {
    return null;
  }
  
  const rirDiff = actualRIR - targetRIRNum;
  const thresholds = CONFIG.MICRO_ADJUST.thresholds;
  const adjustments = CONFIG.MICRO_ADJUST.adjustments;
  
  if (rirDiff >= thresholds.tooEasy) {
    // RIR выше цели - слишком легко, увеличиваем вес
    const adjustment = adjustments.tooEasy;
    const newWeight = currentWeight * (1 + adjustment);
    return {
      weight: window.roundToStandardPlates(newWeight),
      reason: 'tooEasy',
      adjustment: adjustment * 100
    };
  } else if (rirDiff <= -thresholds.tooHard) {
    // RIR ниже цели - слишком тяжело, уменьшаем вес
    const adjustment = adjustments.tooHard;
    const newWeight = currentWeight * (1 + adjustment);
    return {
      weight: window.roundToStandardPlates(newWeight),
      reason: 'tooHard',
      adjustment: adjustment * 100
    };
  }
  
  return null; // В коридоре, коррекция не нужна
}

// === ОБНОВЛЕНИЕ TM (Week 2+) ===
async function updateTMFromSet(exercise, e1rm, actualRIR, targetRIR, week) {
  if (!exercise || !e1rm || e1rm <= 0) return;
  
  // Проверяем, включено ли авто-обновление TM
  if (!isAutoTMEnabled()) {
    return;
  }
  
  // Нормализуем week к числу
  const weekNum = Number(week) || 1;
  
  // На неделе 4 обновления TM отключены
  if (weekNum === 4) {
    return;
  }
  
  // На неделе 1 только посев, обновление начинается с недели 2
  if (weekNum < 2) {
    return;
  }
  
  try {
    // Проверяем тип упражнения - ТМ только для типа A
    let exerciseType = null;
    for (const day of Object.keys(PLAN)) {
      const found = PLAN[day].find(ex => ex.name === exercise);
      if (found) {
        exerciseType = found.type;
        break;
      }
    }
    
    // Обновляем ТМ только для типа A
    if (exerciseType !== 'A') {
      return;
    }
    
    // Проверяем, зафиксирован ли TM
    const locked = await isTMLocked(exercise);
    if (locked) {
      return; // TM зафиксирован вручную
    }
    
    // Проверяем качество сета
    const set = {
      weight: null, // Не используется в проверке
      reps: null,   // Не используется в проверке
      rir: actualRIR
    };
    
    if (!isQualitySet(set, targetRIR)) {
      return; // Сет не качественный
    }
    
    // Получаем лучший e1RM за последние 4 недели (28 дней) с фильтром по RIR
    const bestE1RM = await dbModule.getOne(
      `SELECT MAX(t.e1rm) as best_e1rm 
       FROM tracker t
       WHERE t.exercise = ? 
       AND t.date >= date('now', '-28 days') 
       AND t.e1rm > 0
       AND t.reps >= ?
       AND t.reps <= ?
       AND (t.rir IS NULL OR t.target_rir IS NULL OR ABS(t.rir - CAST(REPLACE(t.target_rir, '–', '-') AS REAL)) <= ?)`,
      [
        exercise,
        CONFIG.QUALITY_SET_FILTER.minReps,
        CONFIG.QUALITY_SET_FILTER.maxReps,
        CONFIG.QUALITY_SET_FILTER.rirTolerance
      ]
    );
    
    const bestE1RMValue = (bestE1RM && bestE1RM.best_e1rm) ? bestE1RM.best_e1rm : e1rm;
    const sessionTM = Math.round(bestE1RMValue * 0.9 * 10) / 10;
    
    // Проверяем текущий ТМ
    const existingTM = await dbModule.getOne(
      'SELECT tm_kg, updated_at, source FROM tm WHERE exercise = ?',
      [exercise]
    );
    
    if (existingTM && existingTM.tm_kg && existingTM.tm_kg > 0) {
      // EMA сглаживание: TM_new = (1-alpha)×TM_old + alpha×e1RM_сессии
      const alpha = CONFIG.TM_EMA.alpha;
      const smoothedTM = existingTM.tm_kg * (1 - alpha) + sessionTM * alpha;
      
      // Лимит шага
      const direction = smoothedTM > existingTM.tm_kg ? 'up' : 'down';
      const maxStepPercent = getTMUpdateLimit(exercise, direction);
      const maxStep = existingTM.tm_kg * maxStepPercent;
      
      let newTM = smoothedTM;
      if (Math.abs(smoothedTM - existingTM.tm_kg) > maxStep) {
        newTM = smoothedTM > existingTM.tm_kg 
          ? existingTM.tm_kg + maxStep 
          : existingTM.tm_kg - maxStep;
      }
      
      newTM = Math.round(newTM * 10) / 10;
      
      // Анти-tilt вниз: падение >1% разрешать только если 2 последовательные сессии дали e1RM существенно ниже TM
      if (newTM < existingTM.tm_kg * 0.99) {
        // Проверяем последние 2 сессии
        const recentSessions = await dbModule.query(
          `SELECT MAX(e1rm) as max_e1rm, COUNT(DISTINCT date) as session_count
           FROM tracker
           WHERE exercise = ?
           AND date >= date('now', '-14 days')
           AND e1rm > 0
           AND reps >= ?
           AND reps <= ?
           AND (rir IS NULL OR target_rir IS NULL OR ABS(rir - CAST(REPLACE(target_rir, '–', '-') AS REAL)) <= ?)`,
          [
            exercise,
            CONFIG.QUALITY_SET_FILTER.minReps,
            CONFIG.QUALITY_SET_FILTER.maxReps,
            CONFIG.QUALITY_SET_FILTER.rirTolerance
          ]
        );
        
        const recentMaxE1RM = (recentSessions[0] && recentSessions[0].max_e1rm) ? recentSessions[0].max_e1rm : 0;
        const sessionCount = (recentSessions[0] && recentSessions[0].session_count) ? recentSessions[0].session_count : 0;
        
        // Если менее 2 сессий или e1RM не существенно ниже TM, ограничиваем падение
        if (sessionCount < 2 || recentMaxE1RM > existingTM.tm_kg * 0.95) {
          newTM = Math.max(newTM, existingTM.tm_kg * 0.99); // Не более 1% вниз
        }
      }
      
      // Обновляем ТМ
      await dbModule.execute(
        `UPDATE tm SET tm_kg = ?, updated_at = CURRENT_TIMESTAMP, source = ? WHERE exercise = ?`,
        [newTM, 'ema', exercise]
      );
      
      // Логируем в историю ТМ
      await logTMUpdate(exercise, newTM, 'ema', `EMA: ${existingTM.tm_kg} → ${newTM} (сессия: ${sessionTM})`);
      
      // Обновляем в интерфейсе
      const card = document.querySelector(`.exercise-card[data-exercise="${exercise}"]`);
      if (card) {
        card.dataset.tm = newTM;
        const tmValue = card.querySelector('.tm-value');
        if (tmValue) {
          tmValue.textContent = newTM;
        }
        scheduleComputeCard(card);
      }
      
      console.log(`✅ ТМ обновлен для ${exercise}: ${newTM} кг (EMA: ${existingTM.tm_kg} → ${newTM})`);
    } else {
      // Если ТМ нет, используем посев
      await seedTMFromSet(exercise, null, null, actualRIR, targetRIR);
    }
  } catch (error) {
    console.warn(`Failed to update TM for ${exercise}:`, error);
  }
}

// Логирование обновлений ТМ
async function logTMUpdate(exercise, tm_kg, source, note) {
  try {
    // Проверяем существование таблицы tm_log
    const tableCheck = await dbModule.query(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='tm_log'`
    );
    
    if (!tableCheck || tableCheck.length === 0) {
      // Создаем таблицу tm_log
      await dbModule.execute(`
        CREATE TABLE IF NOT EXISTS tm_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          exercise TEXT NOT NULL,
          tm_kg REAL NOT NULL,
          source TEXT,
          note TEXT,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);
    }
    
    await dbModule.execute(
      `INSERT INTO tm_log (exercise, tm_kg, source, note) VALUES (?, ?, ?, ?)`,
      [exercise, tm_kg, source || 'auto', note || '']
    );
  } catch (error) {
    console.warn('Failed to log TM update:', error);
  }
}

// Построение карточек упражнений
async function buildExercises() {
  const container = DOM.exercisesList || $("#exercises-list");
  const day = (DOM.day || $("#day")).value;
  const week = (DOM.week || $("#week")).value;
  const rows = PLAN[day] || [];
  
  container.innerHTML = "";
  
  // ОПТИМИЗАЦИЯ: Загружаем все TM и историю одним запросом
  const exerciseNames = rows.map(r => r.name);
  const tmData = exerciseNames.length > 0 
    ? await dbModule.query(
        `SELECT exercise, tm_kg FROM tm WHERE exercise IN (${exerciseNames.map(() => '?').join(',')})`,
        exerciseNames
      )
    : [];
  const tmMap = Object.fromEntries(tmData.map(t => [t.exercise, t.tm_kg]));
  
  // Загружаем последние данные для placeholder
  let lastSets = [];
  let lastSetMap = {};
  if (exerciseNames.length > 0) {
    try {
      // Проверяем существование представления перед запросом
      const viewCheck = await dbModule.query(
        `SELECT name FROM sqlite_master WHERE type='view' AND name='v_last_sets'`
      );
      if (viewCheck && viewCheck.length > 0) {
        lastSets = await dbModule.query(
          `SELECT * FROM v_last_sets WHERE exercise IN (${exerciseNames.map(() => '?').join(',')})`,
          exerciseNames
        );
        lastSetMap = Object.fromEntries(lastSets.map(s => [s.exercise, s]));
      }
    } catch (error) {
      // Тихая обработка ошибки - представление еще не создано
      lastSetMap = {};
    }
  }
  
  for (const [idx, ex] of rows.entries()) {
    const card = document.createElement("div");
    card.className = `exercise-card type${ex.type}`;
    card.dataset.exercise = ex.name;
    card.dataset.setCount = "1"; // Начинаем с 1 сета
    
    // O(1) lookup вместо await запроса к БД
    let tm = tmMap[ex.name];
    // Автоматический расчет ТМ только для типа A
    if (!tm && ex.type === 'A') {
      tm = await getAutoTM(ex.name);
    }
    
    const lastSet = lastSetMap[ex.name];
    const placeholderW = lastSet ? `${lastSet.weight} кг` : 'Вес (кг)';
    const placeholderR = lastSet ? `${lastSet.reps} повт` : 'Повт';
    
    card.dataset.target = ex.target[week] || '';
    card.dataset.tm = tm || 0;
    
    // Рассчитываем рекомендацию только для типа A
    const repMatch = /(?:×|x)(\d+)[–-](\d+)/i.exec(ex.setrep);
    const targetReps = repMatch ? Math.round((Number(repMatch[1]) + Number(repMatch[2])) / 2) : 8;
    const targetRIR = ex.target[week] || '';
    const recommendedWeight = (ex.type === 'A' && tm > 0) ? getRecommendedWeight(tm, Number(week), targetReps, ex.type, targetRIR) : null;
    
    // Авто-делоуд на неделе 4: сетов −30–40% против недель 1–3
    let targetSetCount = 1;
    if (Number(week) === 4) {
      const setrepMatch = /(\d+)/.exec(ex.setrep);
      if (setrepMatch) {
        const normalSets = Number(setrepMatch[1]);
        targetSetCount = Math.max(1, Math.round(normalSets * 0.65)); // -35% в среднем
      }
    }
    
    // Получаем последний результат для истории
    const lastResult = lastSet ? `${lastSet.weight} кг × ${lastSet.reps}` : 'Нет данных';
    
    // Проверяем, зафиксирован ли TM
    const tmLocked = await isTMLocked(ex.name);
    
    card.innerHTML = `
      <div class="exercise-header">
        <span class="exercise-number">${idx + 1}</span>
        <div class="exercise-title-block">
          <h3 class="exercise-name">${ex.name}</h3>
          ${ex.type === 'A' && tm > 0 ? `
            <span class="tm-badge" title="Тренировочный максимум${tmLocked ? ' (зафиксирован)' : ' (авто)'}">
              TM ${tm} кг${tmLocked ? ' 🔒' : ' <span style="font-size: 0.7em; opacity: 0.7;">Auto</span>'}
            </span>
          ` : ''}
        </div>
        <span class="exercise-type type${ex.type}">${ex.type}</span>
      </div>
      <div class="recommendation-box">
        ${recommendedWeight ? `
          <div class="recommendation-text">
            ✨ Рекомендуем: <strong>${recommendedWeight} кг × ${targetReps}</strong>
          </div>
          <button class="btn btn-use-recommendation" data-exercise="${ex.name}" title="Использовать рекомендацию">
            Использовать рекомендацию
          </button>
        ` : ex.type === 'A' ? `
          <div class="recommendation-text" style="color: var(--text-muted);">
            Укажите базовый вес для получения рекомендаций
          </div>
        ` : `
          <div class="recommendation-text" style="color: var(--text-muted);">
            💡 Для аксессуарных упражнений: ориентируйтесь на <strong>целевой RIR</strong> (см. детали ℹ️) и <strong>диапазон повторов</strong> из плана
          </div>
        `}
        <button class="btn-icon btn-toggle-details" data-exercise="${ex.name}" title="Показать детали">ℹ️</button>
      </div>
      <div class="exercise-hint" data-exercise="${ex.name}" style="display: none;"></div>
      <div class="exercise-details-panel" style="display: none;">
        <div class="exercise-details-content">
          <div class="detail-item">
            <span class="detail-label">Прошлый результат:</span>
            <span class="detail-value">${lastResult}</span>
          </div>
          ${ex.type === 'A' ? `
          <div class="detail-item">
            <span class="detail-label">Тренировочный максимум:</span>
            <span class="detail-value">
              <span class="tm-display">
                <span class="tm-value">${tm || 'не задан'}</span> кг
                ${tm > 0 ? `
                  <button class="btn-icon btn-lock-tm" data-exercise="${ex.name}" title="${tmLocked ? 'Разблокировать TM' : 'Зафиксировать TM'}" style="margin-left: 4px;">
                    ${tmLocked ? '🔒' : '🔓'}
                  </button>
                ` : ''}
                <button class="btn-icon btn-edit-tm" title="Настроить ТМ">⚙️</button>
              </span>
              <input class="tm-input hidden" type="text" inputmode="decimal" placeholder="0" value="${tm || ''}" style="width: 80px; padding: 4px 8px; font-size: 14px;">
            </span>
          </div>
          ` : `
          <div class="detail-item">
            <span class="detail-label">Тренировочный максимум:</span>
            <span class="detail-value" style="color: var(--text-muted);">
              Не требуется для аксессуарных упражнений
            </span>
          </div>
          `}
          <div class="detail-item">
            <span class="detail-label">Целевой RIR:</span>
            <span class="detail-value" style="font-weight: 600; color: var(--primary);">${ex.target[week] || '—'}</span>
            ${ex.type !== 'A' ? '<span style="font-size: 0.85em; color: var(--text-muted); margin-left: 8px;">(ориентируйтесь на ощущения)</span>' : ''}
          </div>
          <div class="detail-item">
            <span class="detail-label">Сеты и повторы:</span>
            <span class="detail-value" style="font-weight: 600;">${ex.setrep}</span>
            ${ex.type !== 'A' ? '<span style="font-size: 0.85em; color: var(--text-muted); margin-left: 8px;">(подбирайте вес под целевой RIR)</span>' : ''}
          </div>
        </div>
      </div>
      <div class="exercise-progress">
        <div class="progress-bar" style="width: 0%"></div>
      </div>
      <div class="sets-list">
        <div class="set-row set-header">
          <div class="set-label"></div>
          <div class="set-header-label">Вес</div>
          <div class="set-header-label">Повт</div>
          <div class="set-header-label">RIR</div>
        </div>
        <div class="set-row" data-set="1">
          <div class="set-label">
            Сет 1
            <button class="btn-delete-set" title="Удалить сет" style="display: none;">❌</button>
          </div>
          <input class="set-input w" type="text" inputmode="decimal" placeholder="${placeholderW}" data-set="1">
          <input class="set-input r" type="text" inputmode="numeric" placeholder="${placeholderR}" data-set="1">
          <div class="set-rir hidden" data-set="1" title="RIR: Запас повторов до отказа">—</div>
        </div>
      </div>
      <button class="btn-add-set">+ Добавить сет</button>
      ${ex.type === 'A' ? `
        <div class="exercise-actions" style="margin-top: 8px; display: flex; gap: 8px; flex-wrap: wrap;">
          <button class="btn btn-small btn-warmup" data-exercise="${ex.name}" title="Добавить разминку">🔥 Разминка</button>
          <button class="btn btn-small btn-backoff" data-exercise="${ex.name}" title="Добавить бэкофф-сеты">📉 Бэкофф</button>
        </div>
      ` : ''}
      <div class="exercise-e1rm" style="margin-top: 8px; font-size: 14px; color: var(--color-primary); display: none;">
        💪 Макс e1RM: <strong class="e1rm-max">—</strong> кг
      </div>
    `;
    
    container.appendChild(card);
    
    // Авто-предзаполнение первого сета при рендере
    setTimeout(() => {
      const firstSetRow = card.querySelector('.set-row[data-set="1"]');
      if (firstSetRow) {
        const wInput = firstSetRow.querySelector('input.w');
        const rInput = firstSetRow.querySelector('input.r');
        
        // Проверяем, что оба поля пустые
        if (wInput && rInput && !wInput.value && !rInput.value) {
          // Проверяем, есть ли сохраненный прогноз для этой недели
          const progressionDraft = localStorage.getItem('progression_draft');
          if (progressionDraft) {
            try {
              const draft = JSON.parse(progressionDraft);
              if (draft.week === Number(week)) {
                const progItem = draft.data.find(d => d.exercise === ex.name);
                if (progItem) {
                  wInput.value = progItem.suggestedWeight;
                  rInput.value = progItem.targetReps;
                  scheduleComputeCard(card);
                  return; // Применен прогноз, выходим
                }
              }
            } catch (e) {
              console.warn('Failed to parse progression draft:', e);
            }
          }
          
          // RIR-first на неделе 1: приоритет попасть в целевой RIR
          if (ex.type === 'A') {
            const targetRIR = ex.target[week] || '';
            const repMatch = /(?:×|x)(\d+)[–-](\d+)/i.exec(ex.setrep);
            const minReps = repMatch ? Number(repMatch[1]) : 8; // Нижняя граница диапазона
            const maxReps = repMatch ? Number(repMatch[2]) : 12;
            
            if (tm > 0 && targetRIR) {
              // Есть TM: используем weightFromRIR с нижней границей повторов (RIR-first)
              const suggestedWeight = weightFromRIR(tm, targetRIR, minReps, ex.type);
              if (suggestedWeight && suggestedWeight > 0) {
                wInput.value = suggestedWeight;
                rInput.value = minReps; // На неделе 1 не принуждаем к верхней границе
                scheduleComputeCard(card);
              }
            } else if (week === 1 && lastSet) {
              // На неделе 1 без TM: используем "скромный" вес из истории
              // Берем последний вес, но делаем микро-коррекцию если был RIR
              let modestWeight = lastSet.weight;
              
              // Если был RIR, корректируем вес для попадания в целевой RIR
              if (lastSet.rir != null && targetRIR) {
                const targetRIRNum = targetToNumber(targetRIR);
                if (targetRIRNum != null) {
                  const rirDiff = lastSet.rir - targetRIRNum;
                  // Если было слишком легко, немного увеличиваем; если тяжело - уменьшаем
                  if (rirDiff > 1) {
                    modestWeight = lastSet.weight * 1.02; // +2%
                  } else if (rirDiff < -1) {
                    modestWeight = lastSet.weight * 0.98; // -2%
                  }
                }
              }
              
              const exType = ex.type || 'A';
              modestWeight = window.roundToStandardPlates(modestWeight, exType);
              
              wInput.value = modestWeight;
              rInput.value = minReps; // Нижняя граница повторов
              scheduleComputeCard(card);
            }
          } else if (lastSet) {
            // Тип B/C/D: последний валидный вес/повторы
            wInput.value = lastSet.weight;
            rInput.value = lastSet.reps;
            scheduleComputeCard(card);
          }
        }
      }
      }, 100);
    }
  
  await loadHints();
  await displayProgression();
  await ensureSession();
}

// Прогноз прогресса для следующей недели
async function generateProgression() {
  const currentWeek = Number((DOM.week || $("#week")).value);
  const day = (DOM.day || $("#day")).value;
  const rows = PLAN[day] || [];
  
  const progressionData = [];
  
  for (const ex of rows) {
    try {
      // Получаем последние 3 тренировки этого упражнения
      const history = await dbModule.query(
        'SELECT weight, reps, e1rm, rir, date FROM tracker WHERE exercise = ? ORDER BY date DESC LIMIT 3',
        [ex.name]
      );
      
      if (history.length < 2) continue; // Нужно минимум 2 тренировки для прогноза
      
      // Вычисляем средний прирост e1RM
      const e1rmValues = history.map(h => h.e1rm).filter(v => v);
      if (e1rmValues.length < 2) continue;
      
      const avgE1RM = e1rmValues.reduce((a, b) => a + b, 0) / e1rmValues.length;
      const trend = (e1rmValues[0] - e1rmValues[e1rmValues.length - 1]) / e1rmValues.length;
      
      // Прогноз на следующую неделю
      const nextWeek = currentWeek < 4 ? currentWeek + 1 : 1;
      const targetRIR = targetToNumber(ex.target[nextWeek]);
      const targetReps = 8; // средние повторы
      
      // Рекомендуемый вес
      let suggestedWeight = avgE1RM / (1 + targetReps / LIMITS.E1RM_FACTOR);
      
      // Учитываем тренд
      if (trend > 0) {
        suggestedWeight += trend * 0.5; // консервативная прогрессия
      }
      
      suggestedWeight = Math.round(suggestedWeight / LIMITS.WEIGHT_ROUNDING) * LIMITS.WEIGHT_ROUNDING;
      
      progressionData.push({
        exercise: ex.name,
        currentE1RM: Math.round(avgE1RM * 10) / 10,
        trend: Math.round(trend * 10) / 10,
        suggestedWeight,
        targetReps,
        nextWeek
      });
    } catch (error) {
      console.error(`Failed to generate progression for ${ex.name}:`, error);
    }
  }
  
  return progressionData;
}

async function displayProgression() {
  // Удаляем предыдущую карточку прогноза если есть
  const oldCard = document.querySelector('.progression-card');
  if (oldCard) oldCard.remove();
  
  const data = await generateProgression();
  
  if (data.length === 0) return; // Не показываем если нет данных
  
  const container = document.createElement('div');
  container.className = 'card progression-card';
  container.innerHTML = '<h4>🔮 Прогноз на следующую неделю</h4><div class="progression-list"></div>';
  
  const list = container.querySelector('.progression-list');
  
  list.innerHTML = data.map(item => `
    <div class="progression-item">
      <div class="progression-name">${item.exercise}</div>
      <div class="progression-stats">
        <span>Текущий e1RM: <strong>${item.currentE1RM}</strong> кг</span>
        <span class="${item.trend > 0 ? 'trend-up' : item.trend < 0 ? 'trend-down' : 'trend-neutral'}">
          Тренд: ${item.trend > 0 ? '📈' : item.trend < 0 ? '📉' : '➡️'} ${item.trend > 0 ? '+' : ''}${item.trend} кг
        </span>
      </div>
      <div class="progression-recommendation">
        💡 Рекомендация для недели ${item.nextWeek}: <strong>${item.suggestedWeight}</strong> кг × ${item.targetReps} повт
      </div>
    </div>
  `).join('');
  
  // Добавляем кнопку "Применить прогноз"
  const applyBtn = document.createElement('button');
  applyBtn.className = 'btn primary';
  applyBtn.textContent = 'Применить прогноз к неделе ' + data[0]?.nextWeek;
  applyBtn.style.marginTop = '12px';
  applyBtn.addEventListener('click', () => applyProgression(data));
  container.appendChild(applyBtn);
  
  // Добавляем после подсказок
  const hintsCard = $("#hints");
  if (hintsCard && hintsCard.parentNode) {
    hintsCard.parentNode.insertBefore(container, hintsCard.nextSibling);
  }
}

// Применить прогноз к неделе
async function applyProgression(progressionData) {
  const nextWeek = progressionData[0]?.nextWeek;
  if (!nextWeek) return;
  
  // Сохраняем прогноз в localStorage
  localStorage.setItem('progression_draft', JSON.stringify({
    week: nextWeek,
    data: progressionData,
    appliedAt: new Date().toISOString()
  }));
  
  showNotification(`Прогноз сохранен для недели ${nextWeek}. При смене недели будет применен автоматически.`, 'success');
}

// Загрузка последнего ТМ для упражнения
async function loadLastTM(exercise) {
  try {
    const row = await dbModule.getOne(
      'SELECT tm_kg FROM tm WHERE exercise = ?',
      [exercise]
    );
    return row?.tm_kg || null;
  } catch (error) {
    console.warn('Failed to load TM:', error);
    return null;
  }
}

// Сохранение ТМ для упражнения (только для типа A)
async function saveTM(exercise, tm) {
  if (!tm || tm <= 0) return;
  
  // Проверяем тип упражнения - сохраняем ТМ только для типа A
  let exerciseType = null;
  for (const day of Object.keys(PLAN)) {
    const found = PLAN[day].find(ex => ex.name === exercise);
    if (found) {
      exerciseType = found.type;
      break;
    }
  }
  
  if (exerciseType !== 'A') {
    console.warn(`ТМ не сохраняется для упражнения ${exercise}: требуется тип A, получен ${exerciseType}`);
    return;
  }
  
  try {
    await dbModule.execute(
      'INSERT OR REPLACE INTO tm (exercise, tm_kg, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)',
      [exercise, tm]
    );
  } catch (error) {
    console.warn('Failed to save TM:', error);
  }
}

// Debounced версия saveTM
const debouncedSaveTM = debounce(saveTM, LIMITS.DEBOUNCE_DELAY);

// Автосохранение завершенных сетов в БД
async function autoSaveCompletedSets() {
  try {
    const rows = collectRows();
    
    // ОПТИМИЗАЦИЯ: Фильтруем только те сеты, которые еще не сохранены (батчинг проверок)
    const newRows = [];
    if (rows.length > 0) {
      // Собираем все ключи для проверки одним запросом
      const checkKeys = rows.map(r => [r.date, r.exercise, r.set_no, r.weight, r.reps]);
      const placeholders = checkKeys.map(() => '(date = ? AND exercise = ? AND set_no = ? AND weight = ? AND reps = ?)').join(' OR ');
      const params = checkKeys.flat();
      
      const existingRows = await dbModule.query(
        `SELECT date, exercise, set_no, weight, reps FROM tracker WHERE ${placeholders}`,
        params
      );
      
      // Создаем Set для быстрой проверки
      const existingSet = new Set(
        existingRows.map(r => `${r.date}|${r.exercise}|${r.set_no}|${r.weight}|${r.reps}`)
      );
      
      // Фильтруем новые строки
      for (const row of rows) {
        const key = `${row.date}|${row.exercise}|${row.set_no}|${row.weight}|${row.reps}`;
        if (!existingSet.has(key)) {
          newRows.push(row);
        }
      }
    }
    
    if (newRows.length > 0) {
      // Валидация
      let hasErrors = false;
      for (const row of newRows) {
        const weightValidation = validateWeight(row.weight);
        const repsValidation = validateReps(row.reps);
        
        if (!weightValidation.valid || !repsValidation.valid) {
          hasErrors = true;
          break;
        }
      }
      
      if (!hasErrors) {
        // ОПТИМИЗАЦИЯ: Батчинг INSERT - один запрос вместо множественных
        const columns = ['date', 'week', 'day', 'exercise', 'set_no', 'weight', 'reps', 'rir', 'rpe', 'target_rir', 'e1rm', 'note'];
        const batchResult = await dbModule.executeBatch('tracker', columns, newRows);
        
        // Группируем по упражнениям для обновления ТМ
        const exercisesToUpdateTM = new Set();
        for (const row of newRows) {
          if (row.e1rm && row.e1rm > 0) {
            exercisesToUpdateTM.add(row.exercise);
          }
        }
        
        console.log(`Auto-saved ${newRows.length} sets`);
        
        // ОПТИМИЗАЦИЯ: Загружаем все TM одним запросом
        const week = Number((DOM.week || $("#week"))?.value || 1);
        const exerciseArray = Array.from(exercisesToUpdateTM);
        
        if (exerciseArray.length > 0) {
          // Загружаем все существующие TM одним запросом
          const existingTMs = await dbModule.query(
            `SELECT exercise, tm_kg FROM tm WHERE exercise IN (${exerciseArray.map(() => '?').join(',')})`,
            exerciseArray
          );
          const tmMap = Object.fromEntries(existingTMs.map(t => [t.exercise, t.tm_kg]));
          
          // Автоматически обновляем ТМ для упражнений
          for (const exercise of exercisesToUpdateTM) {
            // Получаем лучший e1RM для этого упражнения из только что сохраненных сетов
            const bestRow = newRows
              .filter(r => r.exercise === exercise && r.e1rm > 0)
              .reduce((best, current) => current.e1rm > best.e1rm ? current : best, { e1rm: 0, rir: null, target_rir: null });
            
            if (bestRow.e1rm > 0) {
              const existingTM = tmMap[exercise];
              if (!existingTM || existingTM <= 0) {
                // Пробуем найти вес и reps для посева
                const setRow = newRows.find(r => r.exercise === exercise && r.weight > 0 && r.reps > 0);
                if (setRow) {
                  await seedTMFromSet(exercise, setRow.weight, setRow.reps, bestRow.rir, bestRow.target_rir);
                }
              }
              // Обновляем TM (если week >= 2 и не неделя 4)
              if (week >= 2 && week !== 4) {
                // Показываем индикацию загрузки
                const card = document.querySelector(`.exercise-card[data-exercise="${exercise}"]`);
                if (card) {
                  const tmBadge = card.querySelector('.tm-badge');
                  if (tmBadge) {
                    const originalText = tmBadge.textContent;
                    tmBadge.textContent = originalText.replace(/\d+\.?\d*/, '...');
                    tmBadge.style.opacity = '0.7';
                  }
                }
                
                await updateTMFromSet(exercise, bestRow.e1rm, bestRow.rir, bestRow.target_rir, week);
                
                // Восстанавливаем бейдж
                if (card) {
                  const tmBadge = card.querySelector('.tm-badge');
                  const tmValue = card.querySelector('.tm-value');
                  if (tmBadge && tmValue) {
                    tmBadge.style.opacity = '1';
                    const newTM = tmValue.textContent;
                    if (newTM && newTM !== '...') {
                      const oldTM = tmMap[exercise] || 0;
                      if (Number(newTM) !== Number(oldTM)) {
                        showNotification(`✅ TM обновлен: ${exercise} → ${newTM} кг`, 'success', 2000);
                      }
                    }
                  }
                }
              }
            }
          }
        }
        
        // Обновляем статус сессии
        await ensureSession();
        
        // Тихое уведомление (без шумного оповещения)
        showNotification(`✓ Автосохранено: ${newRows.length} сетов`, 'success');
        
        // Проверяем завершение недели 3 и обновляем ТМ (только если все сеты заполнены)
        const currentWeek = Number((DOM.week || $("#week")).value);
        if (currentWeek === 3) {
          // Проверяем, все ли сеты заполнены для текущей тренировки
          const allRows = collectRows();
          if (allRows.length > 0) {
            await updateTMAfterCycle();
          }
        }
      }
    }
  } catch (error) {
    console.error('Auto-save failed:', error);
  }
}

// Debounced версия автосохранения
const debouncedAutoSave = debounce(autoSaveCompletedSets, 2000); // 2 секунды после последнего ввода

// === АВТОСОХРАНЕНИЕ ЧЕРНОВИКА ===
function saveDraft() {
  try {
    const draft = {
      week: (DOM.week || $("#week")).value,
      day: (DOM.day || $("#day")).value,
      date: (DOM.date || $("#date")).value,
      exercises: {}
    };
    
    // Сохраняем введенные данные
    document.querySelectorAll('.exercise-card').forEach(card => {
      const exName = card.dataset.exercise;
      const tm = card.dataset.tm || '';
      const setCount = card.dataset.setCount || 1;
      const sets = [];
      
      const setRows = card.querySelectorAll('.set-row:not(.set-header)');
      setRows.forEach((row, idx) => {
        const w = row.querySelector('input.w')?.value || '';
        const r = row.querySelector('input.r')?.value || '';
        if (w || r) {
          sets.push({ set: idx + 1, weight: w, reps: r });
        }
      });
      
      if (tm || sets.length > 0 || setCount > 1) {
        draft.exercises[exName] = { tm, sets, setCount };
      }
    });
    
    localStorage.setItem('workout_draft', JSON.stringify(draft));
  } catch (error) {
    console.warn('Failed to save draft:', error);
  }
}

function restoreDraft() {
  try {
    const draftStr = localStorage.getItem('workout_draft');
    if (!draftStr) return false;
    
    const draft = JSON.parse(draftStr);
    
    // Восстанавливаем дату, неделю, день
    if (draft.week && DOM.week) DOM.week.value = draft.week;
    if (draft.day && DOM.day) DOM.day.value = draft.day;
    if (draft.date && DOM.date) DOM.date.value = draft.date;
    
    // Ждем пока упражнения загрузятся, затем восстанавливаем значения
    setTimeout(() => {
      Object.entries(draft.exercises || {}).forEach(([exName, data]) => {
        const card = document.querySelector(`.exercise-card[data-exercise="${exName}"]`);
        if (!card) return;
        
        // Восстанавливаем ТМ
        if (data.tm) {
          card.dataset.tm = data.tm;
          const tmValue = card.querySelector('.tm-value');
          if (tmValue) tmValue.textContent = data.tm;
        }
        
        // Восстанавливаем количество сетов
        const targetSetCount = data.setCount || data.sets.length;
        const currentSetCount = parseInt(card.dataset.setCount || 1);
        
        // Добавляем недостающие сеты
        const addSetBtn = card.querySelector('.btn-add-set');
        for (let i = currentSetCount; i < targetSetCount; i++) {
          addSetBtn?.click();
        }
        
        // Заполняем данные сетов
        setTimeout(() => {
          (data.sets || []).forEach(({ set, weight, reps }) => {
            const setRow = card.querySelector(`.set-row[data-set="${set}"]`);
            if (setRow) {
              const wInput = setRow.querySelector('input.w');
              const rInput = setRow.querySelector('input.r');
              if (wInput) wInput.value = weight;
              if (rInput) rInput.value = reps;
            }
          });
          
          scheduleComputeCard(card);
        }, 100);
      });
      
      showNotification('Восстановлен черновик тренировки', 'info');
    }, 500);
    
    return true;
  } catch (error) {
    console.warn('Failed to restore draft:', error);
    return false;
  }
}

function clearDraft() {
  localStorage.removeItem('workout_draft');
}

// Инициализация глобального обработчика событий (Event Delegation)
function initGlobalHandlers() {
  const container = $("#exercises-list");
  
  // Автосохранение черновика каждые 5 секунд
  setInterval(saveDraft, LIMITS.AUTOSAVE_INTERVAL);
  
  // Обработчик кнопки добавления сета
  container.addEventListener('click', (e) => {
    if (e.target.classList.contains('btn-add-set')) {
      const card = e.target.closest('.exercise-card');
      const setsList = card.querySelector('.sets-list');
      const currentCount = parseInt(card.dataset.setCount || 1);
      const newSetNum = currentCount + 1;
      
      // Получаем placeholder из первого сета
      const firstWInput = card.querySelector('input.w[data-set="1"]');
      const firstRInput = card.querySelector('input.r[data-set="1"]');
      const placeholderW = firstWInput ? firstWInput.placeholder : 'Вес';
      const placeholderR = firstRInput ? firstRInput.placeholder : 'Повт';
      
      const newSetRow = document.createElement('div');
      newSetRow.className = 'set-row';
      newSetRow.dataset.set = newSetNum;
      newSetRow.innerHTML = `
        <div class="set-label">
          Сет ${newSetNum}
          <button class="btn-delete-set" title="Удалить сет">❌</button>
        </div>
        <input class="set-input w" type="text" inputmode="decimal" placeholder="${placeholderW}" data-set="${newSetNum}">
        <input class="set-input r" type="text" inputmode="numeric" placeholder="${placeholderR}" data-set="${newSetNum}">
        <div class="set-rir hidden" data-set="${newSetNum}" title="RIR: Запас повторов до отказа">—</div>
      `;
      
      setsList.appendChild(newSetRow);
      card.dataset.setCount = newSetNum;
      
      // Показываем кнопки удаления если сетов больше 1
      if (newSetNum > 1) {
        card.querySelectorAll('.btn-delete-set').forEach(btn => {
          btn.style.display = 'inline-block';
        });
      }
      
      // Фокус на новом сете
      newSetRow.querySelector('input.w').focus();
      
      computeCard(card);
      showNotification('Сет добавлен', 'success');
    }
    
    // Обработчик кнопки удаления сета
    if (e.target.classList.contains('btn-delete-set')) {
      const card = e.target.closest('.exercise-card');
      const setRow = e.target.closest('.set-row');
      const currentCount = parseInt(card.dataset.setCount || 1);
      
      if (currentCount <= 1) {
        showNotification('Нельзя удалить единственный сет', 'warning');
        return;
      }
      
      setRow.remove();
      
      // Обновляем нумерацию оставшихся сетов
      const remainingSets = card.querySelectorAll('.set-row:not(.set-header)');
      remainingSets.forEach((row, idx) => {
        const newNum = idx + 1;
        row.dataset.set = newNum;
        row.querySelector('.set-label').firstChild.textContent = `Сет ${newNum} `;
        row.querySelectorAll('input').forEach(inp => {
          inp.dataset.set = newNum;
        });
      });
      
      card.dataset.setCount = remainingSets.length;
      
      // Скрываем кнопки удаления если остался 1 сет
      if (remainingSets.length === 1) {
        card.querySelectorAll('.btn-delete-set').forEach(btn => {
          btn.style.display = 'none';
        });
      }
      
      computeCard(card);
      
      // Обновляем статистику сессии (счетчик может измениться если сет был сохранен в БД)
      ensureSession();
      
      showNotification('Сет удален', 'success');
    }
    
    // Обработчик фиксации/разблокировки TM
    if (e.target.classList.contains('btn-lock-tm') || e.target.closest('.btn-lock-tm')) {
      const btn = e.target.closest('.btn-lock-tm');
      const exercise = btn.dataset.exercise;
      const card = e.target.closest('.exercise-card');
      
      if (!exercise) return;
      
      const currentLocked = await isTMLocked(exercise);
      const newLocked = !currentLocked;
      
      await setTMLock(exercise, newLocked);
      
      // Обновляем UI
      btn.textContent = newLocked ? '🔒' : '🔓';
      btn.title = newLocked ? 'Разблокировать TM' : 'Зафиксировать TM';
      
      const tmBadge = card.querySelector('.tm-badge');
      if (tmBadge) {
        const tmValue = card.querySelector('.tm-value')?.textContent || '';
        tmBadge.innerHTML = `TM ${tmValue} кг${newLocked ? ' 🔒' : ' <span style="font-size: 0.7em; opacity: 0.7;">Auto</span>'}`;
        tmBadge.title = `Тренировочный максимум${newLocked ? ' (зафиксирован)' : ' (авто)'}`;
      }
      
      showNotification(
        newLocked ? `TM для "${exercise}" зафиксирован` : `TM для "${exercise}" разблокирован`,
        'success'
      );
    }
    
    // Обработчик редактирования ТМ
    if (e.target.classList.contains('btn-edit-tm') || e.target.closest('.btn-edit-tm')) {
      const card = e.target.closest('.exercise-card');
      const tmInput = card.querySelector('.tm-input');
      const tmDisplay = card.querySelector('.tm-display');
      
      tmDisplay.style.display = 'none';
      tmInput.classList.remove('hidden');
      tmInput.style.display = 'inline-block';
      tmInput.focus();
      tmInput.select();
    }
    
    // Обработчик переключения деталей
    if (e.target.classList.contains('btn-toggle-details') || e.target.closest('.btn-toggle-details')) {
      const btn = e.target.closest('.btn-toggle-details');
      const exerciseName = btn.dataset.exercise;
      toggleExerciseDetails(exerciseName);
    }
    
    // Обработчик "Использовать рекомендацию"
    if (e.target.classList.contains('btn-use-recommendation') || e.target.closest('.btn-use-recommendation')) {
      const btn = e.target.closest('.btn-use-recommendation');
      const exerciseName = btn.dataset.exercise;
      const card = document.querySelector(`.exercise-card[data-exercise="${exerciseName}"]`);
      if (!card) return;
      
      const recommendationText = btn.previousElementSibling?.textContent;
      const match = /(\d+(?:\.\d+)?)\s*кг\s*×\s*(\d+)/.exec(recommendationText);
      if (match) {
        const weight = parseFloat(match[1]);
        const reps = parseInt(match[2]);
        
        // Заполняем первый сет
        const firstSetRow = card.querySelector('.set-row[data-set="1"]');
        if (firstSetRow) {
          const weightInput = firstSetRow.querySelector('input.w');
          const repsInput = firstSetRow.querySelector('input.r');
          if (weightInput) weightInput.value = weight;
          if (repsInput) repsInput.value = reps;
          
          // Пересчитываем карточку
          scheduleComputeCard(card);
          showNotification(`Рекомендация применена: ${weight} кг × ${reps}`, 'success');
        }
      }
    }
    
    // Обработчик "Разминка"
    if (e.target.classList.contains('btn-warmup') || e.target.closest('.btn-warmup')) {
      const btn = e.target.closest('.btn-warmup');
      const exerciseName = btn.dataset.exercise;
      generateWarmupSets(exerciseName);
    }
    
    // Обработчик "Бэкофф"
    if (e.target.classList.contains('btn-backoff') || e.target.closest('.btn-backoff')) {
      const btn = e.target.closest('.btn-backoff');
      const exerciseName = btn.dataset.exercise;
      generateBackoffSets(exerciseName);
    }
  });
  
  // Единый обработчик для всех input событий
  container.addEventListener('input', (e) => {
    const inp = e.target;
    if (!inp.matches('input')) return;
    
    const card = inp.closest('.exercise-card');
    if (!card) return;
    
    if (inp.classList.contains('tm-input') || inp.classList.contains('w')) {
      inp.value = normalizeNumber(inp.value);
    }
    
    inp.classList.remove('input-error');
    
    // АВТОМАТИЧЕСКИЙ РАСЧЕТ ВЕСА ПО ЦЕЛЕВОМУ RIR (при вводе повторов)
    if (inp.classList.contains('r')) {
      const reps = Number(normalizeNumber(inp.value || 0));
      const setRow = inp.closest('.set-row');
      const weightInput = setRow?.querySelector('input.w');
      const tm = Number(card.dataset.tm || 0);
      const targetRIR = card.dataset.target || '';
      
      // Если повторы введены, вес пустой или 0, ТМ задан и есть целевой RIR
      if (reps > 0 && weightInput && (!weightInput.value || Number(weightInput.value) === 0) && tm > 0 && targetRIR) {
        const calculatedWeight = weightFromRIR(tm, targetRIR, reps, card.className.match(/type([ABCD])/)?.[1] || 'A');
        if (calculatedWeight && calculatedWeight > 0) {
          weightInput.value = calculatedWeight;
          // Тихое уведомление (не навязчивое)
          const exerciseName = card.dataset.exercise;
          showNotification(`💡 ${exerciseName}: вес ${calculatedWeight} кг для RIR ${targetRIR}`, 'info', 2000);
        }
      }
    }
    
    // АВТОМАТИЧЕСКИЙ РАСЧЕТ ПОВТОРОВ ПО ЦЕЛЕВОМУ RIR (при вводе веса)
    if (inp.classList.contains('w')) {
      const weight = Number(normalizeNumber(inp.value || 0));
      const setRow = inp.closest('.set-row');
      const repsInput = setRow?.querySelector('input.r');
      const tm = Number(card.dataset.tm || 0);
      const targetRIR = card.dataset.target || '';
      
      // Если вес введен, повторы пустые или 0, ТМ задан и есть целевой RIR
      if (weight > 0 && repsInput && (!repsInput.value || Number(repsInput.value) === 0) && tm > 0 && targetRIR) {
        const calculatedReps = repsFromRIR(tm, targetRIR, weight);
        if (calculatedReps && calculatedReps > 0) {
          repsInput.value = calculatedReps;
          // Тихое уведомление
          const exerciseName = card.dataset.exercise;
          showNotification(`💡 ${exerciseName}: ${calculatedReps} повторов для RIR ${targetRIR}`, 'info', 2000);
          
          // "Липкое" фокус-ввод: после ввода веса → фокус на повторы
          setTimeout(() => {
            repsInput.focus();
            repsInput.select();
          }, 100);
        }
      }
    }
    
    // АВТОМАТИЧЕСКОЕ ЗАПОЛНЕНИЕ ВСЕХ СЕТОВ НА ОСНОВЕ ПЕРВОГО СЕТА
    // Если заполнен первый сет (вес и повторы), предлагаем заполнить остальные
    if ((inp.classList.contains('w') || inp.classList.contains('r'))) {
      const setRow = inp.closest('.set-row');
      if (setRow && setRow.dataset.set === '1') {
        const firstWeightInput = setRow.querySelector('input.w');
        const firstRepsInput = setRow.querySelector('input.r');
        const firstWeight = Number(normalizeNumber(firstWeightInput?.value || 0));
        const firstReps = Number(normalizeNumber(firstRepsInput?.value || 0));
        
        // Если первый сет полностью заполнен (вес > 0 и повторы > 0)
        if (firstWeight > 0 && firstReps > 0) {
          // Проверяем, есть ли пустые сеты
          const allSetRows = card.querySelectorAll('.set-row:not(.set-header)');
          let hasEmptySets = false;
          
          for (let i = 1; i < allSetRows.length; i++) {
            const row = allSetRows[i];
            const wInput = row.querySelector('input.w');
            const rInput = row.querySelector('input.r');
            const w = Number(normalizeNumber(wInput?.value || 0));
            const r = Number(normalizeNumber(rInput?.value || 0));
            
            if ((!w || w === 0) || (!r || r === 0)) {
              hasEmptySets = true;
              break;
            }
          }
          
          // Если есть пустые сеты, заполняем их значениями из первого сета
          if (hasEmptySets) {
            // Небольшая задержка, чтобы пользователь увидел заполнение первого сета
            setTimeout(() => {
              for (let i = 1; i < allSetRows.length; i++) {
                const row = allSetRows[i];
                const wInput = row.querySelector('input.w');
                const rInput = row.querySelector('input.r');
                const w = Number(normalizeNumber(wInput?.value || 0));
                const r = Number(normalizeNumber(rInput?.value || 0));
                
                // Заполняем только если оба поля пустые
                if ((!w || w === 0) && (!r || r === 0)) {
                  if (wInput) wInput.value = firstWeight;
                  if (rInput) rInput.value = firstReps;
                }
              }
              scheduleComputeCard(card);
            }, 500);
          }
        }
      }
    }
    
    scheduleComputeCard(card);
    
    // Автосохранение в БД при заполнении обоих полей (вес + повторы)
    if (inp.classList.contains('w') || inp.classList.contains('r')) {
      debouncedAutoSave();
    }
  });
  
  // Обработчик для Enter - переход на следующее поле
  container.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    
    const inp = e.target;
    if (!inp.matches('input')) return;
    
    const card = inp.closest('.exercise-card');
    if (!card) return;
    
    e.preventDefault();
    
    const wInputs = card.querySelectorAll('input.w');
    const rInputs = card.querySelectorAll('input.r');
    const all = [...wInputs, ...rInputs];
    const i = all.indexOf(inp);
    const next = all[i + 1];
    if (next) {
      next.focus();
      next.select(); // Выделяем текст для удобства замены
    } else {
      // Если это последнее поле, переходим к следующей карточке
      const allCards = document.querySelectorAll('.exercise-card');
      const currentCardIndex = Array.from(allCards).indexOf(card);
      if (currentCardIndex < allCards.length - 1) {
        const nextCard = allCards[currentCardIndex + 1];
        const firstWInput = nextCard.querySelector('input.w');
        if (firstWInput) {
          firstWInput.focus();
          firstWInput.select();
        }
      }
    }
  });
  
  // "Липкое" фокус-ввод: после ввода повторов → фокус на следующий сет
  container.addEventListener('blur', (e) => {
    const inp = e.target;
    if (!inp.matches('input.r')) return;
    
    const card = inp.closest('.exercise-card');
    if (!card) return;
    
    const setRow = inp.closest('.set-row');
    const w = Number(normalizeNumber(setRow?.querySelector('input.w')?.value || 0));
    const r = Number(normalizeNumber(inp.value || 0));
    
    // Если оба поля заполнены, переходим к следующему сету
    if (w > 0 && r > 0) {
      setTimeout(() => {
        const setNum = Number(setRow?.dataset.set || 1);
        const nextSetRow = card.querySelector(`.set-row[data-set="${setNum + 1}"]`);
        if (nextSetRow) {
          const nextWInput = nextSetRow.querySelector('input.w');
          if (nextWInput) {
            // Применяем микро-автокоррекцию если есть
            if (nextSetRow.dataset.suggestedWeight) {
              nextWInput.value = nextSetRow.dataset.suggestedWeight;
              if (nextSetRow.dataset.suggestedReps) {
                const nextRInput = nextSetRow.querySelector('input.r');
                if (nextRInput) nextRInput.value = nextSetRow.dataset.suggestedReps;
              }
              scheduleComputeCard(card);
            }
            nextWInput.focus();
            nextWInput.select();
          }
        }
      }, 200);
    }
  }, true);
  
  // Применяем микро-автокоррекцию при фокусе на следующий сет
  container.addEventListener('focus', (e) => {
    const inp = e.target;
    if (!inp.matches('input.w')) return;
    
    const setRow = inp.closest('.set-row');
    if (setRow && setRow.dataset.suggestedWeight && !inp.value) {
      inp.value = setRow.dataset.suggestedWeight;
      if (setRow.dataset.suggestedReps) {
        const rInput = setRow.querySelector('input.r');
        if (rInput && !rInput.value) {
          rInput.value = setRow.dataset.suggestedReps;
        }
      }
      const card = inp.closest('.exercise-card');
      if (card) scheduleComputeCard(card);
    }
  }, true);
  
  // Единый обработчик для blur (валидация)
  container.addEventListener('blur', async (e) => {
    const inp = e.target;
    if (!inp.matches('input')) return;
    
    const card = inp.closest('.exercise-card');
    if (!card) return;
    
    const exName = card.dataset.exercise;
    const value = Number(normalizeNumber(inp.value || 0));
    
    if (inp.classList.contains('tm-input')) {
      // Проверяем тип упражнения - ТМ только для типа A
      const ex = Object.values(PLAN).flat().find(e => e.name === exName);
      if (!ex || ex.type !== 'A') {
        // Для аксессуаров не сохраняем ТМ
        inp.classList.add('hidden');
        inp.style.display = 'none';
        const tmDisplay = card.querySelector('.tm-display');
        if (tmDisplay) tmDisplay.style.display = 'inline-block';
        return;
      }
      
      // Скрываем поле ввода ТМ и показываем значение
      const tmDisplay = card.querySelector('.tm-display');
      const tmValue = card.querySelector('.tm-value');
      
      if (value > 0 && value <= LIMITS.MAX_TM) {
        const validation = validateTM(value);
        if (!validation.valid) {
          inp.classList.add('input-error');
          showNotification(validation.message, 'warning');
          return;
        }
        
        card.dataset.tm = value;
        if (tmValue) tmValue.textContent = value;
        
        // Используем debounced версию (убираем прямой вызов saveTM)
        debouncedSaveTM(exName, value);
        
        // Обновляем рекомендацию после изменения ТМ
        const week = Number((DOM.week || $("#week")).value);
        if (ex) {
          const repMatch = /(?:×|x)(\d+)[–-](\d+)/i.exec(ex.setrep);
          const targetReps = repMatch ? Math.round((Number(repMatch[1]) + Number(repMatch[2])) / 2) : 8;
          const card = inp.closest('.exercise-card');
          const targetRIR = card?.dataset.target || '';
          const recommendedWeight = getRecommendedWeight(value, week, targetReps, 'A', targetRIR);
          
          const recommendationBox = card.querySelector('.recommendation-box');
          if (recommendationBox && recommendedWeight) {
            const recommendationText = recommendationBox.querySelector('.recommendation-text');
            if (recommendationText) {
              recommendationText.innerHTML = `✨ Рекомендуем: <strong>${recommendedWeight} кг × ${targetReps}</strong>`;
            }
          }
        }
      }
      
      inp.classList.add('hidden');
      inp.style.display = 'none';
      if (tmDisplay) tmDisplay.style.display = 'inline-block';
    } else if (value >= 0) { // Разрешаем 0 для подтягиваний
      let validation;
      
      if (inp.classList.contains('w')) {
        validation = validateWeight(value);
        if (validation && !validation.valid) {
          inp.classList.add('input-error');
          showNotification(`${exName}: ${validation.message}`, 'warning');
        }
      } else if (inp.classList.contains('r')) {
        validation = validateReps(value);
        if (validation && !validation.valid) {
          inp.classList.add('input-error');
          showNotification(`${exName}: ${validation.message}`, 'warning');
        }
      }
    }
  }, true); // capture phase для blur
}

// Обновление прогресс-бара заполнения сетов
function updateSetProgress(card) {
  const setRows = card.querySelectorAll('.set-row:not(.set-header)');
  
  let filledSets = 0;
  const totalSets = setRows.length;
  
  setRows.forEach(row => {
    const w = row.querySelector('input.w')?.value.trim();
    const r = row.querySelector('input.r')?.value.trim();
    if (w && r) filledSets++;
  });
  
  const percent = totalSets > 0 ? (filledSets / totalSets) * 100 : 0;
  
  const progressBar = card.querySelector('.progress-bar');
  if (progressBar) progressBar.style.width = `${percent}%`;
}

// ОПТИМИЗАЦИЯ: Батчинг обновлений карточек через requestAnimationFrame
let computeCardQueue = new Set();
let computeCardScheduled = false;

function scheduleComputeCard(card) {
  if (!card) return;
  computeCardQueue.add(card);
  if (!computeCardScheduled) {
    computeCardScheduled = true;
    requestAnimationFrame(() => {
      computeCardQueue.forEach(c => computeCard(c));
      computeCardQueue.clear();
      computeCardScheduled = false;
    });
  }
}

// Вычисление значений для карточки
function computeCard(card) {
  // Получаем ТМ из dataset или из поля ввода
  let tm = Number(card.dataset.tm || 0);
  const tmInput = card.querySelector('.tm-input');
  if (tmInput && tmInput.value) {
    tm = Number(normalizeNumber(tmInput.value));
    card.dataset.tm = tm;
  }
  
  // Получаем целевой RIR для цветовой индикации
  const targetRIR = targetToNumber(card.dataset.target || '');
  
  const setRows = card.querySelectorAll('.set-row:not(.set-header)');
  let maxE1RM = 0;
  let lastRIRError = null; // Сохраняем ошибку RIR для микро-автокоррекции
  
  // ОПТИМИЗАЦИЯ: Кешируем DOM элементы для всех сетов сразу
  const setData = Array.from(setRows).map((row, idx) => ({
    row: row,
    wInput: row.querySelector('input.w'),
    rInput: row.querySelector('input.r'),
    rirCell: row.querySelector('.set-rir'),
    idx: idx
  }));
  
  setData.forEach(({ row, wInput, rInput, rirCell, idx }) => {
    const w = Number(normalizeNumber(wInput?.value || 0));
    const r = Number(normalizeNumber(rInput?.value || 0));
    
    if (w >= 0 && r > 0) { // Разрешаем вес = 0 для подтягиваний
      const e1 = e1rm(w, r);
      if (e1 && e1 > maxE1RM) {
        maxE1RM = e1;
      }
      
      // Рассчитываем и показываем RIR
      if (tm > 0 && rirCell) {
        const calculatedRIR = estRIR(tm, w, r);
        if (calculatedRIR != null) {
          rirCell.textContent = Math.round(calculatedRIR * 10) / 10;
          rirCell.classList.remove('hidden');
          
          // Цветовая индикация относительно целевого RIR
          rirCell.classList.remove('rir-perfect', 'rir-good', 'rir-warning');
          
          if (targetRIR != null) {
            const diff = Math.abs(calculatedRIR - targetRIR);
            // Для диапазонов (например, 3-4 → target=3.5) учитываем ±0.5 как идеал
            if (diff <= 0.5) {
              rirCell.classList.add('rir-perfect'); // Зеленый: попали в цель (±0.5)
            } else if (diff <= 1.5) {
              rirCell.classList.add('rir-good'); // Желтый: близко к цели (±1.5)
            } else {
              rirCell.classList.add('rir-warning'); // Красный: далеко от цели (>1.5)
            }
            
            // Мгновенная микро-автокоррекция: сохраняем ошибку для следующего сета
            const rirDiff = calculatedRIR - targetRIR;
            if (rirDiff >= CONFIG.MICRO_ADJUST.thresholds.tooEasy || rirDiff <= -CONFIG.MICRO_ADJUST.thresholds.tooHard) {
              lastRIRError = rirDiff; // Положительное = слишком легко, отрицательное = слишком тяжело
            }
          }
          
          // Мгновенная микро-автокоррекция: предзаполняем следующий сет
          if (lastRIRError !== null && idx < setData.length - 1 && isMicroAdjustEnabled()) {
            const nextData = setData[idx + 1];
            const nextWInput = nextData.wInput;
            const nextRInput = nextData.rInput;
            
            // Если следующий сет пустой и есть ошибка RIR
            if (nextWInput && nextRInput && !nextWInput.value && !nextRInput.value) {
              // Используем функцию микро-коррекции из конфига
              const adjustment = calculateMicroAdjustment(calculatedRIR, card.dataset.target, w);
              
              if (adjustment) {
                // Сохраняем в data-атрибут для применения при фокусе
                nextData.row.dataset.suggestedWeight = adjustment.weight;
                nextData.row.dataset.suggestedReps = r;
                nextData.row.dataset.adjustmentReason = adjustment.reason;
                
                // ВИЗУАЛЬНАЯ ОБРАТНАЯ СВЯЗЬ: Подсвечиваем следующий сет
                nextData.row.style.backgroundColor = adjustment.reason === 'tooEasy' 
                  ? 'rgba(76, 175, 80, 0.1)' // Зеленый для "легко"
                  : 'rgba(255, 152, 0, 0.1)'; // Оранжевый для "тяжело"
                
                // УВЕДОМЛЕНИЕ: Показываем подсказку о микро-коррекции (только один раз)
                if (!nextData.row.dataset.adjustmentShown) {
                  const adjustmentText = adjustment.reason === 'tooEasy' 
                    ? `💡 Следующий сет: ${adjustment.weight} кг (было легко, +${Math.abs(adjustment.adjustment).toFixed(1)}%)`
                    : `💡 Следующий сет: ${adjustment.weight} кг (было тяжело, ${adjustment.adjustment.toFixed(1)}%)`;
                  
                  showNotification(adjustmentText, 'info', 3000);
                  nextData.row.dataset.adjustmentShown = 'true';
                  
                  // Убираем подсветку через 5 секунд
                  setTimeout(() => {
                    nextData.row.style.backgroundColor = '';
                  }, 5000);
                }
              }
            }
          }
        } else {
          rirCell.textContent = '—';
          rirCell.classList.add('hidden');
        }
      } else if (rirCell) {
        rirCell.textContent = '—';
        rirCell.classList.add('hidden');
      }
    } else if (rirCell) {
      rirCell.textContent = '—';
      rirCell.classList.add('hidden');
    }
  });
  
  // Показываем лучший e1RM в заголовке упражнения
  const e1rmDisplay = card.querySelector('.exercise-e1rm');
  const e1rmMax = card.querySelector('.e1rm-max');
  
  if (maxE1RM > 0) {
    if (e1rmMax) e1rmMax.textContent = maxE1RM;
    if (e1rmDisplay) e1rmDisplay.style.display = 'block';
  } else {
    if (e1rmDisplay) e1rmDisplay.style.display = 'none';
  }
  
  // Обновляем прогресс-бар
  updateSetProgress(card);
  
  // Проверяем авто-закрытие сессии после computeCard
  checkAutoFinishSession();
}

// Загрузка подсказок
async function loadHints() {
  const day = $("#day").value;
  const rows = PLAN[day] || [];
  const exNames = rows.map(x => x.name);
  
  if (!exNames.length) {
    return;
  }
  
  try {
    const placeholders = exNames.map(() => '?').join(', ');
    let data = [];
    try {
      // Проверяем существование представления перед запросом
      const viewCheck = await dbModule.query(
        `SELECT name FROM sqlite_master WHERE type='view' AND name='v_last_sets'`
      );
      if (viewCheck && viewCheck.length > 0) {
        data = await dbModule.query(
          `SELECT * FROM v_last_sets WHERE exercise IN (${placeholders})`,
          exNames
        );
      }
    } catch (error) {
      // Тихая обработка ошибки - представление еще не создано
      data = [];
    }
    
    const byEx = {};
    data.forEach(x => byEx[x.exercise] = x);
    
    // Добавляем подсказки непосредственно в карточки упражнений
    rows.forEach(ex => {
      const hintContainer = document.querySelector(`.exercise-hint[data-exercise="${ex.name}"]`);
      if (!hintContainer) return;
      
      const h = byEx[ex.name];
      
      if (h) {
        hintContainer.innerHTML = `
          <span class="hint-text">Прошлый: ${h.weight}кг×${h.reps} (e1RM: ${h.e1rm ?? '—'}кг)</span>
          <button class="btn-icon" data-act="fill-last" data-ex="${ex.name}" title="Заполнить прошлыми значениями">📝</button>
        `;
        hintContainer.style.display = 'flex';
      } else {
        hintContainer.style.display = 'none';
      }
    });
    
    // Добавляем обработчик клика для кнопок в подсказках
    document.querySelectorAll('.exercise-hint button').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        const exName = btn.dataset.ex;
        if (btn.dataset.act === 'fill-last') {
          fillFromLast(exName);
        }
        if (btn.dataset.act === 'suggest') {
          await suggestForExercise(exName);
        }
      });
    });
  } catch (error) {
    console.warn('Failed to load hints:', error);
  }
}

// Заполнение из последнего
function fillFromLast(exName) {
  const card = document.querySelector(`.exercise-card[data-exercise="${exName}"]`);
  if (!card) return;
  
  const hintContainer = card.querySelector('.exercise-hint');
  if (!hintContainer) return;
  
  const text = hintContainer.textContent;
  const m = text.match(/(\d+(?:[\.,]\d+)?)кг×(\d+)/);
  if (!m) return;
  
  const w = m[1].replace(',', '.');
  const reps = m[2];
  const wInputs = card.querySelectorAll('input.w');
  const rInputs = card.querySelectorAll('input.r');
  
  // Заполняем все пустые сеты
  for (let i = 0; i < wInputs.length; i++) {
    if (!wInputs[i].value && !rInputs[i].value) {
      wInputs[i].value = w;
      rInputs[i].value = reps;
    }
  }
  computeCard(card);
}

// Улучшенная рекомендация веса на основе среднего значения последних тренировок
async function suggestForExercise(exName) {
  const week = Number((DOM.week || $("#week")).value);
  const day = (DOM.day || $("#day")).value;
  const item = (PLAN[day] || []).find(x => x.name === exName);
  if (!item) return;
  
  const repMatch = /(?:×|x)(\d+)[–-](\d+)/i.exec(item.setrep);
  const target_reps = repMatch ? Math.round((Number(repMatch[1]) + Number(repMatch[2])) / 2) : 8;
  const target_rir = targetToNumber(item.target[week]) ?? 2;
  
  try {
    // Получаем последние 3-5 тренировок для более точной рекомендации
    const recentSets = await dbModule.query(
      `SELECT weight, reps, rir, e1rm, date 
       FROM tracker 
       WHERE exercise = ? AND date >= date('now', '-28 days')
       ORDER BY date DESC, set_no ASC
       LIMIT 15`,
      [exName]
    );
    
    if (!recentSets || recentSets.length === 0) {
      alert('Нет истории для рекомендации');
      return;
    }
    
    // Группируем по тренировкам (датам) и берем лучший сет из каждой тренировки
    const workouts = {};
    recentSets.forEach(set => {
      if (!workouts[set.date] || set.e1rm > workouts[set.date].e1rm) {
        workouts[set.date] = set;
      }
    });
    
    const bestSets = Object.values(workouts).slice(0, 5); // Последние 5 тренировок
    
    // Рассчитываем средний e1RM из лучших сетов последних тренировок
    const avgE1RM = bestSets.reduce((sum, set) => sum + (set.e1rm || 0), 0) / bestSets.length;
    
    // Рассчитываем средний RIR для адаптивной коррекции
    const avgRIR = bestSets
      .filter(set => set.rir != null)
      .reduce((sum, set) => sum + set.rir, 0) / bestSets.filter(set => set.rir != null).length;
    
    // Оцениваем ТМ на основе среднего e1RM
    const tm_est = avgE1RM * 0.9;
    
    // Рассчитываем вес для целевых повторов и RIR
    let w_new = weightFromRIR(tm_est, target_rir, target_reps, item.type || 'A');
    
    // Адаптивная коррекция: если пользователь постоянно не попадает в целевой RIR
    if (avgRIR != null && target_rir != null) {
      const rirDiff = avgRIR - target_rir;
      // Если средний RIR выше целевого (легче), увеличиваем вес
      // Если средний RIR ниже целевого (тяжелее), уменьшаем вес
      if (Math.abs(rirDiff) > 0.5) {
        const adjustment = Math.sign(rirDiff) * LIMITS.WEIGHT_ROUNDING;
        w_new = (w_new || 0) + adjustment;
      }
    }
    
    // Округляем до стандартных блинов
    w_new = window.roundToStandardPlates(w_new);
    if (w_new < 0) w_new = 0;
    
    const card = document.querySelector(`.exercise-card[data-exercise="${exName}"]`);
    if (!card) return;
    
    const inputsW = card.querySelectorAll('input.w');
    const inputsR = card.querySelectorAll('input.r');
    
    // Заполняем первый пустой сет
    for (let i = 0; i < inputsW.length; i++) {
      if (!inputsW[i].value && !inputsR[i].value) {
        inputsW[i].value = w_new;
        inputsR[i].focus();
        scheduleComputeCard(card);
        showNotification(`💡 Рекомендуемый вес: ${w_new} кг (на основе последних ${bestSets.length} тренировок)`, 'info', 3000);
        break;
      }
    }
  } catch (error) {
    console.warn('Failed to suggest weight:', error);
    alert('Не удалось рассчитать вес');
  }
}

// Сбор данных из карточек
function collectRows() {
  const out = [];
  const date = (DOM.date || $("#date")).value;
  const week = Number((DOM.week || $("#week")).value);
  const day = (DOM.day || $("#day")).value;
  
  document.querySelectorAll('.exercise-card').forEach(card => {
    const exer = card.dataset.exercise;
    const tm = Number(card.dataset.tm || 0);
    const setRows = card.querySelectorAll('.set-row:not(.set-header)');
    const ex = Object.values(PLAN).flat().find(e => e.name === exer);
    const target_rir = ex ? ex.target[week] : '';
    
    setRows.forEach((row, idx) => {
      const w = normalizeNumber(row.querySelector('input.w')?.value);
      const r = normalizeNumber(row.querySelector('input.r')?.value);
      
      // Разрешаем вес = 0 для подтягиваний, но r должно быть > 0
      if ((w !== '' && w !== null) && r) {
        const weight = Number(w);
        const reps = Number(r);
        const e1 = e1rm(weight, reps);
        const rir = tm > 0 ? estRIR(tm, weight, reps) : null;
        const rpe = rir != null ? rpeFromRir(rir) : null;
        
        out.push({
          date,
          week,
          day,
          exercise: exer,
          set_no: idx + 1,
          weight,
          reps,
          rir,
          rpe,
          target_rir,
          e1rm: e1,
          note: ''
        });
      }
    });
  });
  
  return out;
}

// Сохранение в БД
async function saveToDB() {
  await ensureSession();
  const rows = collectRows();
  
  if (!rows.length) {
    showNotification("Нет заполненных сетов.", 'warning');
    return;
  }
  
  // Валидация всех данных перед сохранением
  let hasErrors = false;
  for (const row of rows) {
    const weightValidation = validateWeight(row.weight);
    const repsValidation = validateReps(row.reps);
    
    if (!weightValidation.valid) {
      showNotification(`${row.exercise}, сет ${row.set_no}: ${weightValidation.message}`, 'error');
      hasErrors = true;
      break;
    }
    
    if (!repsValidation.valid) {
      showNotification(`${row.exercise}, сет ${row.set_no}: ${repsValidation.message}`, 'error');
      hasErrors = true;
      break;
    }
  }
  
  if (hasErrors) return;
  
  try {
    // ОПТИМИЗАЦИЯ: Батчинг INSERT - один запрос вместо множественных
    const columns = ['date', 'week', 'day', 'exercise', 'set_no', 'weight', 'reps', 'rir', 'rpe', 'target_rir', 'e1rm', 'note'];
    const batchResult = await dbModule.executeBatch('tracker', columns, rows);
    
    // Группируем по упражнениям для обновления ТМ
    const exercisesToUpdateTM = new Set();
    for (const row of rows) {
      if (row.e1rm && row.e1rm > 0) {
        exercisesToUpdateTM.add(row.exercise);
      }
    }
    
    // ОПТИМИЗАЦИЯ: Загружаем все TM одним запросом
    const week = Number((DOM.week || $("#week"))?.value || 1);
    const exerciseArray = Array.from(exercisesToUpdateTM);
    
    if (exerciseArray.length > 0) {
      // Загружаем все существующие TM одним запросом
      const existingTMs = await dbModule.query(
        `SELECT exercise, tm_kg FROM tm WHERE exercise IN (${exerciseArray.map(() => '?').join(',')})`,
        exerciseArray
      );
      const tmMap = Object.fromEntries(existingTMs.map(t => [t.exercise, t.tm_kg]));
      
      // Автоматически обновляем ТМ для упражнений
      for (const exercise of exercisesToUpdateTM) {
        // Получаем лучший e1RM для этого упражнения из только что сохраненных сетов
        const bestRow = rows
          .filter(r => r.exercise === exercise && r.e1rm > 0)
          .reduce((best, current) => current.e1rm > best.e1rm ? current : best, { e1rm: 0, rir: null, target_rir: null });
        
        if (bestRow.e1rm > 0) {
          const existingTM = tmMap[exercise];
          if (!existingTM || existingTM <= 0) {
            // Пробуем найти вес и reps для посева
            const setRow = rows.find(r => r.exercise === exercise && r.weight > 0 && r.reps > 0);
            if (setRow) {
              await seedTMFromSet(exercise, setRow.weight, setRow.reps, bestRow.rir, bestRow.target_rir);
            }
          }
          // Обновляем TM (если week >= 2 и не неделя 4)
          if (week >= 2 && week !== 4) {
            // Показываем индикацию загрузки
            const card = document.querySelector(`.exercise-card[data-exercise="${exercise}"]`);
            if (card) {
              const tmBadge = card.querySelector('.tm-badge');
              if (tmBadge) {
                const originalText = tmBadge.textContent;
                tmBadge.textContent = originalText.replace(/\d+\.?\d*/, '...');
                tmBadge.style.opacity = '0.7';
              }
            }
            
            await updateTMFromSet(exercise, bestRow.e1rm, bestRow.rir, bestRow.target_rir, week);
            
            // Восстанавливаем бейдж и показываем уведомление
            if (card) {
              const tmBadge = card.querySelector('.tm-badge');
              const tmValue = card.querySelector('.tm-value');
              if (tmBadge && tmValue) {
                tmBadge.style.opacity = '1';
                const newTM = tmValue.textContent;
                if (newTM && newTM !== '...') {
                  const oldTM = tmMap[exercise] || 0;
                  if (Number(newTM) !== Number(oldTM)) {
                    showNotification(`✅ TM обновлен: ${exercise} → ${newTM} кг`, 'success', 2000);
                  }
                }
              }
            }
          }
        }
      }
    }
    
    showNotification(`Сохранено: ${rows.length} сетов`, 'success');
    
    // Очищаем черновик после успешного сохранения
    clearDraft();
    
    // Обновляем статус сессии после сохранения
    await ensureSession();
    
    // Проверяем авто-закрытие сессии
    checkAutoFinishSession();
  } catch (error) {
    console.error('Failed to save:', error);
    showNotification("Ошибка сохранения: " + error.message, 'error');
  }
}

// Сессии
async function ensureSession() {
  const date = (DOM.date || $("#date")).value;
  const week = Number((DOM.week || $("#week")).value);
  const day = (DOM.day || $("#day")).value;
  
  try {
    const existing = await dbModule.getOne(
      'SELECT * FROM sessions WHERE date = ? AND day = ? AND status = ?',
      [date, day, 'open']
    );
    
    if (existing) {
      CURRENT_SESSION = existing;
    } else {
      await dbModule.execute(
        'INSERT INTO sessions (date, week, day, status, note) VALUES (?, ?, ?, ?, ?)',
        [date, week, day, 'open', '']
      );
      CURRENT_SESSION = await dbModule.getOne(
        'SELECT * FROM sessions WHERE date = ? AND day = ? AND status = ?',
        [date, day, 'open']
      );
      showNotification('Тренировка начата! Заполняйте сеты.', 'info');
    }
    
    // Получаем статистику текущей сессии
    const stats = await dbModule.getOne(
      'SELECT COUNT(*) as sets, SUM(weight * reps) as tonnage FROM tracker WHERE date = ? AND day = ?',
      [date, day]
    );
    
    const statusText = `Тренировка: ${day} • Сеты: ${stats?.sets || 0} • Тоннаж: ${Math.round(stats?.tonnage || 0)} кг`;
    (DOM.sessionStatus || $("#session-status")).textContent = statusText;
    
    // Показываем/скрываем кнопку завершения
    const finishBtn = DOM.btnFinish || $("#btn-finish");
    if (stats?.sets > 0) {
      finishBtn.style.display = 'inline-flex';
    } else {
      finishBtn.style.display = 'none';
    }
  } catch (error) {
    console.error('Failed to ensure session:', error);
  }
}

// Проверка авто-закрытия сессии
async function checkAutoFinishSession() {
  if (!CURRENT_SESSION) return;
  
  const cards = document.querySelectorAll('.exercise-card');
  let allCardsComplete = true;
  
  for (const card of cards) {
    const setRows = card.querySelectorAll('.set-row:not(.set-header)');
    const targetSetCount = parseInt(card.dataset.setCount || 1);
    
    // Проверяем, что все целевые сеты заполнены
    let filledSets = 0;
    for (let i = 0; i < Math.min(setRows.length, targetSetCount); i++) {
      const row = setRows[i];
      const w = Number(normalizeNumber(row.querySelector('input.w')?.value || 0));
      const r = Number(normalizeNumber(row.querySelector('input.r')?.value || 0));
      if (w >= 0 && r > 0) {
        filledSets++;
      }
    }
    
    if (filledSets < targetSetCount) {
      allCardsComplete = false;
      break;
    }
  }
  
  // Если все карточки завершены, подсвечиваем кнопку "Завершить"
  const finishBtn = DOM.btnFinish || $("#btn-finish");
  if (allCardsComplete && cards.length > 0) {
    finishBtn.style.display = 'inline-flex';
    finishBtn.classList.add('btn-highlight');
    finishBtn.style.animation = 'pulse 2s ease-in-out infinite';
    
    // Предлагаем закрыть автоматически через 3 секунды
    setTimeout(async () => {
      if (finishBtn.classList.contains('btn-highlight')) {
        const autoFinish = confirm('Все упражнения завершены! Завершить тренировку автоматически?');
        if (autoFinish) {
          await finishSession();
        } else {
          finishBtn.classList.remove('btn-highlight');
          finishBtn.style.animation = '';
        }
      }
    }, 3000);
  } else {
    finishBtn.classList.remove('btn-highlight');
    finishBtn.style.animation = '';
  }
}

async function finishSession() {
  if (!CURRENT_SESSION) return;
  
  try {
    // Получаем финальную статистику
    const stats = await dbModule.getOne(
      'SELECT COUNT(*) as sets, SUM(weight * reps) as tonnage FROM tracker WHERE date = ? AND day = ?',
      [CURRENT_SESSION.date, CURRENT_SESSION.day]
    );
    
    await dbModule.execute(
      'UPDATE sessions SET status = ?, note = ? WHERE id = ?',
      ['done', `Завершено: ${stats?.sets || 0} сетов, ${Math.round(stats?.tonnage || 0)} кг`, CURRENT_SESSION.id]
    );
    
    showNotification(`Тренировка завершена! ${stats?.sets || 0} сетов, ${Math.round(stats?.tonnage || 0)} кг тоннажа`, 'success');
    (DOM.sessionStatus || $("#session-status")).textContent = 'Тренировка завершена ✓';
    (DOM.btnFinish || $("#btn-finish")).style.display = 'none';
    CURRENT_SESSION = null;
    
    // Проверяем завершение недели 3 и обновляем ТМ
    await updateTMAfterCycle();
  } catch (error) {
    console.error('Failed to finish session:', error);
    showNotification('Ошибка завершения тренировки', 'error');
  }
}

// === LAZY LOADING ДЛЯ БИБЛИОТЕК ===
// Функция для динамической загрузки Chart.js (если потребуется в будущем)
async function loadChartJS() {
  if (window.Chart) return window.Chart; // уже загружен
  
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.js';
    script.onload = () => resolve(window.Chart);
    script.onerror = () => reject(new Error('Failed to load Chart.js'));
    document.head.appendChild(script);
  });
}

// Использование (пример):
// async function showChart() {
//   const Chart = await loadChartJS();
//   // теперь можно рисовать графики
// }

// Тепловая карта тренировок
async function renderHeatmap() {
  try {
    const data = await dbModule.query(`
      SELECT date, COUNT(DISTINCT exercise) as exercises_count, SUM(CASE WHEN weight > 0 AND reps > 0 THEN 1 ELSE 0 END) as sets_count
      FROM tracker 
      WHERE date >= date('now', '-90 days')
      GROUP BY date
      ORDER BY date
    `);
    
    const heatmapContainer = document.getElementById('heatmap-container');
    if (!heatmapContainer) return;
    
    const heatmap = document.createElement('div');
    heatmap.className = 'heatmap';
    
    // Генерируем 91 день (13 недель)
    const today = new Date();
    for (let i = 90; i >= 0; i--) {
      const date = new Date(today);
      date.setDate(date.getDate() - i);
      const dateStr = date.toISOString().slice(0, 10);
      
      const dayData = data.find(d => d.date === dateStr);
      const intensity = dayData ? Math.min(dayData.sets_count / 20, 1) : 0;
      
      const cell = document.createElement('div');
      cell.className = 'heatmap-cell';
      if (intensity > 0) cell.classList.add('active');
      cell.style.opacity = intensity || 0.1;
      cell.title = `${dateStr}: ${dayData?.sets_count || 0} сетов, ${dayData?.exercises_count || 0} упражнений`;
      heatmap.appendChild(cell);
    }
    
    heatmapContainer.innerHTML = '<h4>📅 Активность за 90 дней</h4>';
    heatmapContainer.appendChild(heatmap);
    
    const legend = document.createElement('div');
    legend.className = 'heatmap-legend';
    legend.innerHTML = '<span>Меньше</span><span>Больше тренировок</span>';
    heatmapContainer.appendChild(legend);
  } catch (error) {
    console.warn('Failed to render heatmap:', error);
  }
}

// Дашборд
async function loadDashboard() {
  const week = Number((DOM.week || $("#week")).value);
  
  try {
    const vol = await dbModule.getOne(
      'SELECT * FROM v_weekly_volume WHERE week = ?',
      [week]
    );
    
    $("#m-tonnage").textContent = vol?.tonnage ?? '—';
    $("#m-reps").textContent = vol?.reps ?? '—';
    $("#m-sets").textContent = vol?.sets ?? '—';
    $("#m-rir").textContent = vol?.avg_rir_diff ?
      (Math.round(vol.avg_rir_diff * 10) / 10) : '—';
    
    const byType = [
      ['A', vol?.a_sets ?? 0],
      ['B', vol?.b_sets ?? 0],
      ['C', vol?.c_sets ?? 0],
      ['D', vol?.d_sets ?? 0]
    ];
    
    const ul = $("#by-type");
    ul.innerHTML = '';
    byType.forEach(([t, v]) => {
      const li = document.createElement('li');
      li.textContent = `Тип ${t}: ${v} сетов`;
      ul.appendChild(li);
    });
    
    const best = await dbModule.query('SELECT * FROM v_best_e1rm');
    const ul2 = $("#best-e1rm");
    ul2.innerHTML = '';
    (best || []).forEach(x => {
      const li = document.createElement('li');
      li.textContent = `${x.exercise}: ${x.best_e1rm} кг (${x.date})`;
      ul2.appendChild(li);
    });
    
    // Загружаем историю ТМ
    await loadTMHistory();
    
    // Загружаем тепловую карту
    await renderHeatmap();
  } catch (error) {
    console.error('Failed to load dashboard:', error);
  }
}

// Загрузка истории ТМ для дашборда
async function loadTMHistory() {
  try {
    // Проверяем существование таблицы tm_log
    const tableCheck = await dbModule.query(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='tm_log'`
    );
    
    if (!tableCheck || tableCheck.length === 0) {
      return; // Таблица еще не создана
    }
    
    // Получаем последние обновления ТМ (по одному на упражнение)
    const tmHistory = await dbModule.query(`
      SELECT exercise, tm_kg, updated_at, note
      FROM tm_log
      WHERE id IN (
        SELECT MAX(id) 
        FROM tm_log 
        GROUP BY exercise
      )
      ORDER BY updated_at DESC
      LIMIT 10
    `);
    
    // Добавляем мини-спарклайн истории ТМ в дашборд
    const dashboardCard = document.querySelector('#dash .card');
    if (dashboardCard && tmHistory && tmHistory.length > 0) {
      // Удаляем предыдущий блок истории ТМ если есть
      const oldBlock = document.getElementById('tm-history-block');
      if (oldBlock) oldBlock.remove();
      
      const tmBlock = document.createElement('div');
      tmBlock.id = 'tm-history-block';
      tmBlock.className = 'card sub';
      tmBlock.style.marginTop = '16px';
      tmBlock.innerHTML = `
        <div class="sub-title">📈 История ТМ (последние обновления)</div>
        <ul id="tm-history-list"></ul>
      `;
      
      dashboardCard.appendChild(tmBlock);
      
      const tmList = document.getElementById('tm-history-list');
      tmHistory.forEach(item => {
        const li = document.createElement('li');
        const date = new Date(item.updated_at).toLocaleDateString('ru-RU', { 
          day: '2-digit', 
          month: '2-digit' 
        });
        li.textContent = `${item.exercise}: ${item.tm_kg} кг (${date})`;
        if (item.note) {
          li.title = item.note;
        }
        tmList.appendChild(li);
      });
    }
  } catch (error) {
    console.warn('Failed to load TM history:', error);
  }
}

// Рекорды с фильтром ложных PR (только при близком RIR)
async function loadPRs() {
  try {
    // Фильтруем PR: только если факт RIR близок к целевому (±1) - валидные PR
    const data = await dbModule.query(`
      SELECT t.exercise, t.e1rm as best_e1rm, t.date, t.rir, t.target_rir,
             CASE 
               WHEN t.rir IS NOT NULL AND t.target_rir IS NOT NULL 
               AND ABS(t.rir - CAST(REPLACE(t.target_rir, '–', '-') AS REAL)) <= 1 
               THEN 1 
               ELSE 0 
             END as is_valid
      FROM tracker t
      INNER JOIN (
        SELECT exercise, MAX(e1rm) as max_e1rm
        FROM tracker
        WHERE e1rm > 0
        GROUP BY exercise
      ) best ON t.exercise = best.exercise AND t.e1rm = best.max_e1rm
      WHERE t.e1rm > 0
      ORDER BY t.exercise, t.date DESC
    `);
    
    const list = $("#pr-list");
    list.innerHTML = '';
    
    // Группируем по упражнениям (берем последний PR)
    const prMap = new Map();
    (data || []).forEach(x => {
      if (!prMap.has(x.exercise)) {
        prMap.set(x.exercise, x);
      }
    });
    
    prMap.forEach(x => {
      const li = document.createElement('li');
      const isValid = x.is_valid === 1;
      const validBadge = isValid ? ' ✅' : ' ⚠️';
      li.textContent = `${x.exercise}: e1RM ${x.best_e1rm} кг (${x.date})${validBadge}`;
      li.title = isValid 
        ? 'Валидный PR (RIR близок к целевому)' 
        : 'Условный PR (RIR далек от целевого)';
      if (!isValid) {
        li.style.opacity = '0.7';
        li.style.fontStyle = 'italic';
      }
      list.appendChild(li);
    });
  } catch (error) {
    console.error('Failed to load PRs:', error);
    // Фолбэк на старый метод если запрос не работает
    try {
      const data = await dbModule.query('SELECT * FROM v_best_e1rm');
      const list = $("#pr-list");
      list.innerHTML = '';
      (data || []).forEach(x => {
        const li = document.createElement('li');
        li.textContent = `${x.exercise}: e1RM ${x.best_e1rm} кг (${x.date})`;
        list.appendChild(li);
      });
    } catch (e) {
      console.error('Fallback PR loading failed:', e);
    }
  }
}

// История тренировок
async function loadHistory() {
  const week = $("#history-week").value;
  const day = $("#history-day").value;
  
  let sql = 'SELECT * FROM tracker WHERE 1=1';
  const params = [];
  
  if (week) {
    sql += ' AND week = ?';
    params.push(Number(week));
  }
  
  if (day) {
    sql += ' AND day = ?';
    params.push(day);
  }
  
  sql += ' ORDER BY date DESC, exercise, set_no';
  
  try {
    const data = await dbModule.query(sql, params);
    displayHistory(data);
  } catch (error) {
    console.error('Failed to load history:', error);
    showNotification('Ошибка загрузки истории', 'error');
  }
}

function displayHistory(data) {
  const container = $("#history-list");
  container.innerHTML = '';
  
  if (!data || data.length === 0) {
    container.innerHTML = '<p class="empty-state">Нет данных. Попробуйте изменить фильтры.</p>';
    return;
  }
  
  // Группируем по дате и упражнению
  const grouped = {};
  data.forEach(row => {
    const key = `${row.date}_${row.exercise}`;
    if (!grouped[key]) {
      grouped[key] = {
        date: row.date,
        week: row.week,
        day: row.day,
        exercise: row.exercise,
        sets: []
      };
    }
    grouped[key].sets.push(row);
  });
  
  Object.values(grouped).forEach(group => {
    const card = document.createElement('div');
    card.className = 'history-card';
    
    card.innerHTML = `
      <div class="history-header">
        <div>
          <strong>${group.exercise}</strong>
          <div class="history-meta">${group.date} • Неделя ${group.week} • ${group.day}</div>
        </div>
        <button class="btn mini delete" data-date="${group.date}" data-exercise="${group.exercise}">
          🗑️ Удалить
        </button>
      </div>
      <div class="history-sets">
        ${group.sets.map(set => `
          <div class="history-set" data-id="${set.id}">
            <span>Сет ${set.set_no}</span>
            <span>${set.weight} кг × ${set.reps}</span>
            <span>RIR: ${set.rir || '—'}</span>
            <span>e1RM: ${set.e1rm || '—'}</span>
            <button class="btn mini edit" data-id="${set.id}">✏️</button>
            <button class="btn mini delete-set" data-id="${set.id}">❌</button>
          </div>
        `).join('')}
      </div>
    `;
    
    container.appendChild(card);
  });
  
  // Обработчики удаления
  container.querySelectorAll('.delete').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const date = btn.dataset.date;
      const exercise = btn.dataset.exercise;
      
      if (confirm(`Удалить все сеты упражнения "${exercise}" от ${date}?`)) {
        try {
          await dbModule.execute(
            'DELETE FROM tracker WHERE date = ? AND exercise = ?',
            [date, exercise]
          );
          showNotification('Данные удалены', 'success');
          await loadHistory();
          await loadDashboard();
          await loadPRs();
        } catch (error) {
          console.error('Failed to delete:', error);
          showNotification('Ошибка удаления', 'error');
        }
      }
    });
  });
  
  // Обработчики удаления одного сета
  container.querySelectorAll('.delete-set').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const id = btn.dataset.id;
      
      if (confirm('Удалить этот сет?')) {
        try {
          await dbModule.execute('DELETE FROM tracker WHERE id = ?', [id]);
          showNotification('Сет удален', 'success');
          await loadHistory();
          await loadDashboard();
          await loadPRs();
        } catch (error) {
          console.error('Failed to delete set:', error);
          showNotification('Ошибка удаления', 'error');
        }
      }
    });
  });
  
  // Обработчики редактирования
  container.querySelectorAll('.edit').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const id = btn.dataset.id;
      await editSet(id);
    });
  });
}

async function editSet(id) {
  try {
    const set = await dbModule.getOne('SELECT * FROM tracker WHERE id = ?', [id]);
    if (!set) return;
    
    const newWeight = prompt(`Вес (текущий: ${set.weight} кг):`, set.weight);
    if (newWeight === null) return;
    
    const newReps = prompt(`Повторы (текущий: ${set.reps}):`, set.reps);
    if (newReps === null) return;
    
    const weight = Number(newWeight);
    const reps = Number(newReps);
    
    // Валидация
    const weightValidation = validateWeight(weight);
    const repsValidation = validateReps(reps);
    
    if (!weightValidation.valid) {
      showNotification(weightValidation.message, 'warning');
      return;
    }
    
    if (!repsValidation.valid) {
      showNotification(repsValidation.message, 'warning');
      return;
    }
    
    // Пересчитываем значения
    const e1 = e1rm(weight, reps);
    
    // RIR считается от TM, а не от e1RM
    const tmRow = await dbModule.getOne('SELECT tm_kg FROM tm WHERE exercise = ?', [set.exercise]);
    const tm = tmRow?.tm_kg ?? null;
    const rir = (set.target_rir && tm) ? estRIR(tm, weight, reps) : null;
    const rpe = rpeFromRir(rir);
    
    await dbModule.execute(
      'UPDATE tracker SET weight = ?, reps = ?, e1rm = ?, rir = ?, rpe = ? WHERE id = ?',
      [weight, reps, e1, rir, rpe, id]
    );
    
    // Обновляем TM если это упражнение типа A
    const week = Number((DOM.week || $("#week"))?.value || 1);
    // Сначала пробуем посев TM, если его нет
    const existingTM = await dbModule.getOne('SELECT tm_kg FROM tm WHERE exercise = ?', [set.exercise]);
    if (!existingTM || !existingTM.tm_kg) {
      await seedTMFromSet(set.exercise, weight, reps, rir, null);
    }
    // Обновляем TM (если week >= 2)
    if (week >= 2 && week !== 4) {
      await updateTMFromSet(set.exercise, e1, rir, null, week);
    }
    
    // Обновляем карточку упражнения, если она открыта
    const card = document.querySelector(`.exercise-card[data-exercise="${set.exercise}"]`);
    if (card) {
      // Обновляем TM в карточке
      const tmRow = await dbModule.getOne('SELECT tm_kg FROM tm WHERE exercise = ?', [set.exercise]);
      if (tmRow?.tm_kg) {
        card.dataset.tm = tmRow.tm_kg;
        const tmValue = card.querySelector('.tm-value');
        if (tmValue) {
          tmValue.textContent = tmRow.tm_kg;
          const tmDisplay = card.querySelector('.tm-display');
          if (tmDisplay) {
            const bestE1RM = await dbModule.getOne(
              `SELECT MAX(e1rm) as best_e1rm 
               FROM tracker 
               WHERE exercise = ? AND date >= date('now', '-28 days') AND e1rm > 0`,
              [set.exercise]
            );
            const bestE1RMValue = bestE1RM?.best_e1rm || e1;
            tmDisplay.title = `Тренировочный максимум (90% от лучшего e1RM за 4 недели: ${bestE1RMValue} кг) - авто`;
          }
        }
        scheduleComputeCard(card);
      }
    }
    
    showNotification('Сет обновлен', 'success');
    await loadHistory();
    await loadDashboard();
    await loadPRs();
  } catch (error) {
    console.error('Failed to edit set:', error);
    showNotification('Ошибка редактирования', 'error');
  }
}

function initHistoryFilters() {
  // Заполняем фильтр дней
  const daySelect = $("#history-day");
  daySelect.innerHTML = '<option value="">Все дни</option>';
  Object.keys(PLAN).forEach(d => {
    const o = document.createElement('option');
    o.value = d;
    o.textContent = d;
    daySelect.appendChild(o);
  });
  
  // Обработчик кнопки загрузки
  $("#btn-load-history")?.addEventListener('click', loadHistory);
}

// Экспорт/импорт
async function exportDatabase() {
  try {
    showNotification('Подготовка данных к экспорту...', 'info');
    
    // КРИТИЧНО: Сохраняем актуальные данные перед экспортом!
    await dbModule.saveDatabase();
    
    const json = await dbModule.exportDatabase();
    
    // Улучшенное название файла с информацией о содержимом
    const stats = await dbModule.query('SELECT COUNT(DISTINCT date) as workouts FROM tracker');
    const workoutCount = stats[0]?.workouts || 0;
    const dateStr = new Date().toISOString().slice(0, 10);
    
    const blob = new Blob([json], { type: 'application/json' });
    const fileName = `meso-backup-${dateStr}-${workoutCount}workouts.json`;
    const file = new File([blob], fileName, { type: 'application/json' });
    
    // Пытаемся использовать Web Share API
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({
          title: 'Резервная копия MESO',
          text: `Резервная копия тренировок: ${workoutCount} тренировок`,
          files: [file]
        });
        showNotification(`✅ Резервная копия отправлена через Share API`, 'success');
        localStorage.setItem('last_export_date', new Date().toISOString());
        return;
      } catch (error) {
        // Если пользователь отменил или произошла ошибка, используем фолбэк
        if (error.name !== 'AbortError') {
          console.warn('Share API failed, using fallback:', error);
        }
      }
    }
    
    // Фолбэк: обычная ссылка скачивания
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    a.click();
    URL.revokeObjectURL(url);
    
    showNotification(`✅ Экспорт завершен: ${workoutCount} тренировок`, 'success');
    
    // Обновляем метку последнего экспорта
    localStorage.setItem('last_export_date', new Date().toISOString());
  } catch (error) {
    console.error('Failed to export:', error);
    showNotification('Ошибка экспорта: ' + error.message, 'error');
  }
}

async function importDatabase() {
  const input = document.getElementById('file-import');
  input.click();
  
  input.onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    
    try {
      showNotification('Импорт данных...', 'info');
      
      const text = await file.text();
      
      // Валидация импорта
      let parsed;
      try {
        parsed = JSON.parse(text);
        if (!parsed.version || !parsed.data) {
          throw new Error('Неверный формат файла. Ожидается JSON с полями version и data.');
        }
      } catch (parseError) {
        throw new Error('Не удалось прочитать файл. Убедитесь, что это корректный backup файл.');
      }
      
      // Проверяем наличие данных
      const hasData = await dbModule.query('SELECT COUNT(*) as count FROM tracker');
      const existingCount = hasData[0]?.count || 0;
      
      if (existingCount > 0) {
        // Предлагаем режим слияния
        const mode = confirm(
          `⚠️ В базе данных уже есть ${existingCount} записей.\n\n` +
          `Выберите режим импорта:\n` +
          `OK - Слить с данными (обновить/добавить)\n` +
          `Отмена - Перезаписать все данные`
        ) ? 'merge' : 'replace';
        
        if (mode === 'merge') {
          await importDatabaseMerge(parsed);
          return;
        }
      }
      
      // Режим перезаписи
      await dbModule.importDatabase(text);
      
      showNotification('✅ Импорт завершен. Страница обновится через 2 секунды...', 'success');
      
      setTimeout(() => {
        location.reload();
      }, 2000);
    } catch (error) {
      console.error('Failed to import:', error);
      showNotification('Ошибка импорта: ' + error.message, 'error');
    }
  };
}

// Умный импорт: слияние данных
async function importDatabaseMerge(parsed) {
  try {
    showNotification('Слияние данных...', 'info');
    
    let added = 0;
    let updated = 0;
    let skipped = 0;
    
    // Импортируем данные из parsed.data
    if (parsed.data && parsed.data.tracker) {
      for (const row of parsed.data.tracker) {
        // Проверяем существование по ключу (date, day, exercise, set_no)
        const existing = await dbModule.getOne(
          'SELECT id FROM tracker WHERE date = ? AND day = ? AND exercise = ? AND set_no = ?',
          [row.date, row.day, row.exercise, row.set_no]
        );
        
        if (existing) {
          // Обновляем существующую запись
          await dbModule.execute(
            `UPDATE tracker SET weight = ?, reps = ?, rir = ?, rpe = ?, target_rir = ?, e1rm = ?, note = ? WHERE id = ?`,
            [row.weight, row.reps, row.rir, row.rpe, row.target_rir, row.e1rm, row.note || '', existing.id]
          );
          updated++;
        } else {
          // Добавляем новую запись
          await dbModule.execute(
            `INSERT INTO tracker (date, week, day, exercise, set_no, weight, reps, rir, rpe, target_rir, e1rm, note)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [row.date, row.week, row.day, row.exercise, row.set_no, row.weight, row.reps,
             row.rir, row.rpe, row.target_rir, row.e1rm, row.note || '']
          );
          added++;
        }
      }
    }
    
    // Импортируем TM (слияние)
    if (parsed.data && parsed.data.tm) {
      for (const row of parsed.data.tm) {
        const existing = await dbModule.getOne(
          'SELECT tm_kg FROM tm WHERE exercise = ?',
          [row.exercise]
        );
        
        if (existing) {
          // Берем максимальный ТМ
          const newTM = Math.max(existing.tm_kg || 0, row.tm_kg || 0);
          if (newTM > existing.tm_kg) {
            await dbModule.execute(
              'UPDATE tm SET tm_kg = ?, updated_at = CURRENT_TIMESTAMP WHERE exercise = ?',
              [newTM, row.exercise]
            );
            updated++;
          } else {
            skipped++;
          }
        } else {
          await dbModule.execute(
            'INSERT INTO tm (exercise, tm_kg, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)',
            [row.exercise, row.tm_kg]
          );
          added++;
        }
      }
    }
    
    showNotification(
      `✅ Слияние завершено: добавлено ${added}, обновлено ${updated}, пропущено ${skipped}`,
      'success'
    );
    
    // Обновляем страницу
    setTimeout(() => {
      location.reload();
    }, 2000);
  } catch (error) {
    console.error('Failed to merge:', error);
    showNotification('Ошибка слияния: ' + error.message, 'error');
  }
}

// Обновление прогресса загрузки
function updateProgress(percent, status) {
  const progressBar = document.getElementById('loading-progress');
  const statusText = document.getElementById('loading-status');
  
  if (progressBar) {
    progressBar.style.width = `${percent}%`;
  }
  
  if (statusText && status) {
    statusText.textContent = status;
  }
}

// Проверка первого запуска
async function checkFirstLaunch() {
  try {
    // Проверяем наличие данных в tracker или sessions - если есть, значит не первый запуск
    const trackerData = await dbModule.query('SELECT COUNT(*) as count FROM tracker');
    const sessionsData = await dbModule.query('SELECT COUNT(*) as count FROM sessions');
    
    const hasTrackerData = trackerData && trackerData.length > 0 && trackerData[0].count > 0;
    const hasSessionsData = sessionsData && sessionsData.length > 0 && sessionsData[0].count > 0;
    
    // Если есть данные в tracker или sessions, значит не первый запуск (даже если нет ТМ)
    if (hasTrackerData || hasSessionsData) {
      return false;
    }
    
    // Если нет данных в tracker/sessions, проверяем ТМ
    const tmData = await dbModule.query('SELECT COUNT(*) as count FROM tm WHERE tm_kg IS NOT NULL AND tm_kg > 0');
    return !tmData || tmData.length === 0 || tmData[0].count === 0;
  } catch (error) {
    console.warn('Failed to check first launch:', error);
    return true; // В случае ошибки считаем первым запуском
  }
}

// Показ онбординга
async function showOnboarding() {
  // Скрываем основной интерфейс
  document.querySelector('main').style.display = 'none';
  document.querySelector('header').style.display = 'none';
  document.querySelector('.bottom-nav')?.style.setProperty('display', 'none');
  
  // Создаем экран онбординга
  const onboarding = document.createElement('div');
  onboarding.className = 'onboarding-screen';
  onboarding.innerHTML = `
    <div class="onboarding-content">
      <h2>Добро пожаловать в MESO!</h2>
      <p style="margin: 16px 0 24px 0; color: var(--text-muted); line-height: 1.6;">
        Укажите базовые веса для <strong>основных упражнений типа A</strong> (присед, жим, тяга).<br>
        Для аксессуарных упражнений (B, C, D) веса можно указать позже во время тренировки.
      </p>
      <div id="onboarding-exercises" class="onboarding-exercises"></div>
      <div class="onboarding-actions">
        <button id="onboarding-save" class="btn primary">Сохранить и начать</button>
      </div>
    </div>
  `;
  document.body.appendChild(onboarding);
  
  // Загружаем все упражнения из плана
  const allExercises = [];
  for (const day of Object.keys(PLAN)) {
    for (const ex of PLAN[day]) {
      if (!allExercises.find(e => e.name === ex.name)) {
        allExercises.push(ex);
      }
    }
  }
  
  const exercisesContainer = document.getElementById('onboarding-exercises');
  allExercises.forEach(ex => {
    const exerciseItem = document.createElement('div');
    exerciseItem.className = 'onboarding-exercise-item';
    
    // Только для типа A показываем поля для ТМ
    if (ex.type === 'A') {
      exerciseItem.innerHTML = `
        <label>${ex.name}</label>
        <div style="display: flex; gap: 8px; align-items: center; flex-wrap: wrap;">
          <input type="number" step="0.5" min="0" placeholder="Вес (кг)" data-exercise="${ex.name}" data-type="weight" inputmode="decimal" style="flex: 1; min-width: 120px;">
          <span style="color: var(--text-muted);">×</span>
          <input type="number" step="1" min="1" max="20" placeholder="6" value="6" data-exercise="${ex.name}" data-type="reps" inputmode="numeric" style="width: 80px;">
          <span style="color: var(--text-muted); font-size: 0.9em;">повт.</span>
        </div>
        <div style="font-size: 0.85em; color: var(--text-muted); margin-top: 6px;">
          Пример: 80кг × 6 повторов → ТМ рассчитается автоматически
        </div>
      `;
    } else {
      // Для типов B, C, D не показываем поля
      exerciseItem.style.display = 'none';
    }
    exercisesContainer.appendChild(exerciseItem);
  });
  
  // Обработчик сохранения
  document.getElementById('onboarding-save').addEventListener('click', async () => {
    await saveOnboardingWeights();
  });
}

// Сохранение весов из онбординга
async function saveOnboardingWeights() {
  const inputs = document.querySelectorAll('#onboarding-exercises input');
  const weights = {};
  
  // Группируем inputs по упражнениям
  const exerciseData = {};
  for (const input of inputs) {
    const exercise = input.dataset.exercise;
    const type = input.dataset.type; // 'weight' или 'reps'
    
    if (!exerciseData[exercise]) {
      exerciseData[exercise] = { weight: null, reps: null };
    }
    
    const value = parseFloat(input.value);
    if (!isNaN(value) && value > 0) {
      if (type === 'weight') {
        exerciseData[exercise].weight = value;
      } else if (type === 'reps') {
        exerciseData[exercise].reps = value;
      }
    }
  }
  
  // Рассчитываем ТМ только для упражнений типа A
  for (const [exercise, data] of Object.entries(exerciseData)) {
    // Находим тип упражнения
    let exerciseType = null;
    for (const day of Object.keys(PLAN)) {
      const found = PLAN[day].find(ex => ex.name === exercise);
      if (found) {
        exerciseType = found.type;
        break;
      }
    }
    
    // Сохраняем ТМ только для типа A
    if (exerciseType === 'A' && data.weight > 0) {
      // Используем введенные повторы, или 6.5 по умолчанию
      const reps = data.reps && data.reps > 0 ? data.reps : 6.5;
      
      // Рассчитываем e1RM из веса и повторов
      const calculatedE1RM = e1rm(data.weight, reps);
      
      // ТМ = 90% от e1RM
      const tm = Math.round(calculatedE1RM * 0.9 * 10) / 10;
      weights[exercise] = tm;
    }
  }
  
  // Сохраняем в БД
  for (const [exercise, tm] of Object.entries(weights)) {
    try {
      await dbModule.execute(
        `INSERT OR REPLACE INTO tm (exercise, tm_kg, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)`,
        [exercise, tm]
      );
    } catch (error) {
      console.error(`Failed to save TM for ${exercise}:`, error);
    }
  }
  
  // Удаляем онбординг и показываем основной интерфейс
  document.querySelector('.onboarding-screen')?.remove();
  document.querySelector('main').style.display = '';
  document.querySelector('header').style.display = '';
  document.querySelector('.bottom-nav')?.style.removeProperty('display');
  
  // Инициализируем интерфейс после онбординга
  initGlobalHandlers();
  await buildDayOptions();
  
  DOM.week.addEventListener('change', async () => {
    await buildExercises();
    await loadDashboard();
  });
  
  DOM.day.addEventListener('change', async () => {
    await buildExercises();
  });
  
  await loadDashboard();
  await loadPRs();
  initHistoryFilters();
  
  // Обработчик кнопки сброса цикла
  const resetBtn = document.getElementById('btn-reset-cycle');
  if (resetBtn) {
    resetBtn.addEventListener('click', async () => {
      await resetCycle();
      // После сброса показываем онбординг
      const isFirstLaunch = await checkFirstLaunch();
      if (isFirstLaunch) {
        await showOnboarding();
      }
    });
  }
  
  // Перезагружаем упражнения
  await buildExercises();
  showNotification('Базовые веса сохранены! Можно начинать тренировки.', 'success');
}

// Инициализация
async function initApp() {
  const loading = document.getElementById('loading');
  
  try {
    updateProgress(10, 'Инициализация базы данных...');
    
    await dbModule.initDatabase();
    
    updateProgress(92, 'Загрузка плана тренировок...');
    
    // Кэшируем DOM элементы ПЕРЕД использованием
    cacheDOM();
    
    DOM.date.value = todayISO();
    await loadPlan();
    
    updateProgress(95, 'Инициализация интерфейса...');
    
    // Проверяем первый запуск
    const isFirstLaunch = await checkFirstLaunch();
    if (isFirstLaunch) {
      // Скрываем индикатор загрузки
      if (loading) {
        loading.style.display = 'none';
      }
      await showOnboarding();
      return; // Выходим, онбординг сам продолжит инициализацию
    }
    
    // Инициализируем глобальные обработчики событий (Event Delegation)
    initGlobalHandlers();
    
    await buildDayOptions();
    
    // Проверяем наличие черновика и предлагаем восстановить
    const hasDraft = localStorage.getItem('workout_draft');
    if (hasDraft) {
      restoreDraft();
    }
    
    DOM.week.addEventListener('change', async () => {
      await buildExercises();
      await loadDashboard();
    });
    
    DOM.day.addEventListener('change', async () => {
      await buildExercises();
    });
    
    updateProgress(98, 'Загрузка статистики...');
    await loadDashboard();
    await loadPRs();
    
    // Инициализируем фильтры истории
    initHistoryFilters();
    
    // Инициализируем настройки пользователя
    initUserSettings();
    
    // Обработчик кнопки сброса цикла
    const resetBtn = document.getElementById('btn-reset-cycle');
    if (resetBtn) {
      resetBtn.addEventListener('click', async () => {
        await resetCycle();
        // После сброса показываем онбординг
        const isFirstLaunch = await checkFirstLaunch();
        if (isFirstLaunch) {
          await showOnboarding();
        }
      });
    }
    
    updateProgress(100, 'Готово!');
    
    // Скрываем индикатор загрузки после успешной инициализации
    if (loading) {
      setTimeout(() => {
        loading.style.opacity = '0';
        loading.style.transition = 'opacity 0.3s ease';
        setTimeout(() => {
          loading.style.display = 'none';
        }, 300);
      }, 200);
    }
  } catch (error) {
    console.error('Failed to init app:', error);
    const loading = document.getElementById('loading');
    if (loading) {
      loading.innerHTML = `
        <div style="text-align: center;">
          <div style="margin-bottom: 16px;">❌ Ошибка инициализации</div>
          <div style="font-size: 14px; opacity: 0.8;">${error.message}</div>
          <button onclick="location.reload()" style="margin-top: 16px; padding: 12px 24px; background: #6366f1; color: white; border: none; border-radius: 8px; cursor: pointer;">Обновить страницу</button>
        </div>
      `;
    } else {
      alert('Ошибка инициализации приложения: ' + error.message);
    }
  }
}

// === ИНДИКАТОР ОФЛАЙН-РЕЖИМА ===
function setupOnlineIndicator() {
  const indicator = document.createElement('div');
  indicator.id = 'network-status';
  indicator.className = 'network-status';
  document.body.appendChild(indicator);
  
  function updateStatus() {
    if (navigator.onLine) {
      indicator.className = 'network-status online';
      indicator.innerHTML = '<span>🟢</span><span>Онлайн</span>';
    } else {
      indicator.className = 'network-status offline';
      indicator.innerHTML = '<span>🔴</span><span>Офлайн (данные сохраняются локально)</span>';
    }
  }
  
  window.addEventListener('online', updateStatus);
  window.addEventListener('offline', updateStatus);
  updateStatus();
}

// Управление темой
function initTheme() {
  // Загружаем сохраненную тему или используем системную
  const savedTheme = localStorage.getItem('theme');
  const systemTheme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  const theme = savedTheme || systemTheme;
  
  applyTheme(theme);
  
  // Обработчик переключения темы
  $("#btn-theme")?.addEventListener('click', toggleTheme);
  
  // Слушаем изменения системной темы
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
    if (!localStorage.getItem('theme')) {
      applyTheme(e.matches ? 'dark' : 'light');
    }
  });
}

function applyTheme(theme) {
  const root = document.documentElement;
  const btn = $("#btn-theme");
  
  if (theme === 'dark') {
    root.setAttribute('data-theme', 'dark');
    if (btn) btn.textContent = '☀️';
  } else {
    root.setAttribute('data-theme', 'light');
    if (btn) btn.textContent = '🌙';
  }
}

function toggleTheme() {
  const root = document.documentElement;
  const currentTheme = root.getAttribute('data-theme') || 'light';
  const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
  
  applyTheme(newTheme);
  localStorage.setItem('theme', newTheme);
  
  showNotification(`Тема изменена на ${newTheme === 'dark' ? 'темную' : 'светлую'}`, 'info');
}

// Генератор разминки для типа A
function generateWarmupSets(exName) {
  const card = document.querySelector(`.exercise-card[data-exercise="${exName}"]`);
  if (!card) return;
  
  // Находим топ-сет (самый тяжелый)
  const setRows = card.querySelectorAll('.set-row:not(.set-header)');
  let topWeight = 0;
  let topReps = 0;
  
  setRows.forEach(row => {
    const w = Number(normalizeNumber(row.querySelector('input.w')?.value || 0));
    const r = Number(normalizeNumber(row.querySelector('input.r')?.value || 0));
    if (w > topWeight) {
      topWeight = w;
      topReps = r;
    }
  });
  
  if (topWeight === 0) {
    showNotification('Сначала укажите рабочий вес', 'warning');
    return;
  }
  
  // Разминка: 40%x5, 55%x5, 70%x3, 80%x2
  const warmupSets = [
    { percent: 0.40, reps: 5 },
    { percent: 0.55, reps: 5 },
    { percent: 0.70, reps: 3 },
    { percent: 0.80, reps: 2 }
  ];
  
  const setsList = card.querySelector('.sets-list');
  const currentCount = parseInt(card.dataset.setCount || 1);
  
  warmupSets.forEach((set, idx) => {
    const weight = window.roundToStandardPlates(topWeight * set.percent, 'A');
    const newSetNum = currentCount + idx + 1;
    
    const newSetRow = document.createElement('div');
    newSetRow.className = 'set-row';
    newSetRow.dataset.set = newSetNum;
    newSetRow.innerHTML = `
      <div class="set-label">
        Разминка ${idx + 1}
        <button class="btn-delete-set" title="Удалить сет">❌</button>
      </div>
      <input class="set-input w" type="text" inputmode="decimal" placeholder="${weight} кг" data-set="${newSetNum}" value="${weight}">
      <input class="set-input r" type="text" inputmode="numeric" placeholder="${set.reps}" data-set="${newSetNum}" value="${set.reps}">
      <div class="set-rir hidden" data-set="${newSetNum}" title="RIR: Запас повторов до отказа">—</div>
    `;
    
    // Вставляем перед последним сетом (или в конец)
    setsList.insertBefore(newSetRow, setsList.lastElementChild);
  });
  
  card.dataset.setCount = currentCount + warmupSets.length;
  computeCard(card);
  showNotification(`Добавлено ${warmupSets.length} разминочных сетов`, 'success');
}

// Генератор бэкофф-сетов для типа A
function generateBackoffSets(exName) {
  const card = document.querySelector(`.exercise-card[data-exercise="${exName}"]`);
  if (!card) return;
  
  // Находим топ-сет
  const setRows = card.querySelectorAll('.set-row:not(.set-header)');
  let topWeight = 0;
  let topReps = 0;
  let topRIR = null;
  
  setRows.forEach(row => {
    const w = Number(normalizeNumber(row.querySelector('input.w')?.value || 0));
    const r = Number(normalizeNumber(row.querySelector('input.r')?.value || 0));
    const rirText = row.querySelector('.set-rir')?.textContent;
    if (w > topWeight) {
      topWeight = w;
      topReps = r;
      topRIR = rirText && rirText !== '—' ? Number(rirText) : null;
    }
  });
  
  if (topWeight === 0) {
    showNotification('Сначала укажите рабочий вес', 'warning');
    return;
  }
  
  // Бэкофф: +2 сета по 90% × (RIR+1 повторов)
  const backoffWeight = window.roundToStandardPlates(topWeight * 0.9, 'A');
  const backoffReps = topRIR != null ? topReps + Math.round(topRIR) + 1 : topReps + 2;
  
  const setsList = card.querySelector('.sets-list');
  const currentCount = parseInt(card.dataset.setCount || 1);
  
  for (let i = 0; i < 2; i++) {
    const newSetNum = currentCount + i + 1;
    
    const newSetRow = document.createElement('div');
    newSetRow.className = 'set-row';
    newSetRow.dataset.set = newSetNum;
    newSetRow.innerHTML = `
      <div class="set-label">
        Бэкофф ${i + 1}
        <button class="btn-delete-set" title="Удалить сет">❌</button>
      </div>
      <input class="set-input w" type="text" inputmode="decimal" placeholder="${backoffWeight} кг" data-set="${newSetNum}" value="${backoffWeight}">
      <input class="set-input r" type="text" inputmode="numeric" placeholder="${backoffReps}" data-set="${newSetNum}" value="${backoffReps}">
      <div class="set-rir hidden" data-set="${newSetNum}" title="RIR: Запас повторов до отказа">—</div>
    `;
    
    setsList.insertBefore(newSetRow, setsList.lastElementChild);
  }
  
  card.dataset.setCount = currentCount + 2;
  computeCard(card);
  showNotification('Добавлено 2 бэкофф-сета', 'success');
}

// Применить подсказки для всех упражнений
async function applyAllHints() {
  const cards = document.querySelectorAll('.exercise-card');
  let appliedCount = 0;
  
  for (const card of cards) {
    const exName = card.dataset.exercise;
    const exType = card.className.includes('typeA') ? 'A' : 
                   card.className.includes('typeB') ? 'B' :
                   card.className.includes('typeC') ? 'C' : 'D';
    
    // Проверяем, есть ли уже заполненные сеты
    const hasFilledSets = Array.from(card.querySelectorAll('.set-row:not(.set-header)')).some(row => {
      const w = row.querySelector('input.w')?.value;
      const r = row.querySelector('input.r')?.value;
      return w && r && Number(w) > 0 && Number(r) > 0;
    });
    
    if (hasFilledSets) continue; // Пропускаем если уже есть данные
    
    if (exType === 'A') {
      // Для типа A используем suggestForExercise
      await suggestForExercise(exName);
      appliedCount++;
    } else {
      // Для B/C/D используем fillFromLast
      const hintContainer = card.querySelector('.exercise-hint');
      if (hintContainer && hintContainer.textContent.match(/(\d+(?:[\.,]\d+)?)кг×(\d+)/)) {
        fillFromLast(exName);
        appliedCount++;
      }
    }
  }
  
  if (appliedCount > 0) {
    showNotification(`✅ Применено подсказок: ${appliedCount}`, 'success');
  } else {
    showNotification('Все упражнения уже заполнены или нет данных для подсказок', 'info');
  }
}

// Обработчики событий
$("#btn-save")?.addEventListener('click', saveToDB);
$("#btn-finish")?.addEventListener('click', finishSession);
$("#btn-export")?.addEventListener('click', exportDatabase);
$("#btn-import")?.addEventListener('click', importDatabase);
$("#btn-apply-hints")?.addEventListener('click', applyAllHints);

// Система напоминаний об экспорте
function checkExportReminder() {
  try {
    const lastExport = localStorage.getItem('last_export_date');
    const dismissedUntil = localStorage.getItem('export_reminder_dismissed_until');
    
    // Если пользователь отложил напоминание
    if (dismissedUntil && new Date(dismissedUntil) > new Date()) {
      return;
    }
    
    if (!lastExport) {
      // Первый запуск - проверяем, есть ли данные
      setTimeout(async () => {
        const hasData = await dbModule.query('SELECT COUNT(*) as count FROM tracker');
        if (hasData[0].count > 10) { // Если больше 10 сетов
          showExportReminder('Рекомендуем сделать резервную копию данных!', false);
        }
      }, 5000);
      return;
    }
    
    const lastExportDate = new Date(lastExport);
    const daysSinceExport = (new Date() - lastExportDate) / (1000 * 60 * 60 * 24);
    
    // Напоминание каждые 7 дней
    if (daysSinceExport >= 7) {
      setTimeout(() => {
        showExportReminder(`Последний экспорт был ${Math.floor(daysSinceExport)} дней назад.`, true);
      }, 3000);
    }
  } catch (error) {
    console.warn('Export reminder check failed:', error);
  }
}

function showExportReminder(message, showDismiss) {
  const reminder = document.createElement('div');
  reminder.className = 'export-reminder';
  reminder.innerHTML = `
    <div class="export-reminder-content">
      <div class="export-reminder-icon">💾</div>
      <div class="export-reminder-text">
        <strong>Резервная копия данных</strong>
        <p>${message}</p>
      </div>
      <div class="export-reminder-actions">
        <button class="btn primary btn-export-now">Экспортировать + Share</button>
        ${showDismiss ? '<button class="btn btn-dismiss">Отложить на неделю</button>' : '<button class="btn btn-dismiss">Позже</button>'}
      </div>
    </div>
  `;
  
  document.body.appendChild(reminder);
  
  setTimeout(() => reminder.classList.add('show'), 100);
  
  reminder.querySelector('.btn-export-now').addEventListener('click', async () => {
    reminder.remove();
    await exportDatabase();
  });
  
  reminder.querySelector('.btn-dismiss').addEventListener('click', () => {
    const dismissUntil = new Date();
    dismissUntil.setDate(dismissUntil.getDate() + 7);
    localStorage.setItem('export_reminder_dismissed_until', dismissUntil.toISOString());
    reminder.classList.remove('show');
    setTimeout(() => reminder.remove(), 300);
  });
}

// === ИНИЦИАЛИЗАЦИЯ НАСТРОЕК ПОЛЬЗОВАТЕЛЯ ===
function initUserSettings() {
  // Загружаем настройки и применяем к UI
  const settings = getUserSettings();
  
  const autoTMCheckbox = document.getElementById('setting-auto-tm');
  const microAdjustCheckbox = document.getElementById('setting-micro-adjust');
  const applyHintsCheckbox = document.getElementById('setting-apply-hints-on-open');
  
  if (autoTMCheckbox) {
    autoTMCheckbox.checked = settings.autoTM !== false;
    autoTMCheckbox.addEventListener('change', (e) => {
      setUserSetting('autoTM', e.target.checked);
      showNotification(
        e.target.checked 
          ? 'Автоматическое обновление TM включено' 
          : 'Автоматическое обновление TM отключено',
        'success'
      );
    });
  }
  
  if (microAdjustCheckbox) {
    microAdjustCheckbox.checked = settings.microAutoAdjust !== false;
    microAdjustCheckbox.addEventListener('change', (e) => {
      setUserSetting('microAutoAdjust', e.target.checked);
      showNotification(
        e.target.checked 
          ? 'Микро-коррекция веса включена' 
          : 'Микро-коррекция веса отключена',
        'success'
      );
    });
  }
  
  if (applyHintsCheckbox) {
    applyHintsCheckbox.checked = settings.applyHintsOnOpen === true;
    applyHintsCheckbox.addEventListener('change', (e) => {
      setUserSetting('applyHintsOnOpen', e.target.checked);
      showNotification(
        e.target.checked 
          ? 'Автозаполнение при открытии дня включено' 
          : 'Автозаполнение при открытии дня отключено',
        'success'
      );
    });
  }
}

// Запуск
// Защита от повторного выполнения
if (!window.__MESO_APP_INITIALIZED__) {
  window.__MESO_APP_INITIALIZED__ = true;
  setupOnlineIndicator();
  initTheme();
  initApp();
  
  // Проверяем напоминание об экспорте через 5 секунд после загрузки
  setTimeout(checkExportReminder, 5000);
} else {
  console.warn('initApp уже был вызван, пропускаем повторный вызов');
}

