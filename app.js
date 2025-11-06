// === MESO App (SQL.js) ===
import * as dbModule from './db.js';

// === КОНСТАНТЫ ===
const LIMITS = {
  MAX_WEIGHT: 500,
  MIN_WEIGHT: 0.5,
  MAX_REPS: 100,
  MIN_REPS: 1,
  MAX_TM: 500,
  E1RM_FACTOR: 30, // Epley formula factor
  WEIGHT_ROUNDING: 2.5, // округление веса
  NOTIFICATION_DURATION: 3000,
  AUTOSAVE_INTERVAL: 5000, // автосохранение черновика
  DEBOUNCE_DELAY: 500 // задержка для debounce
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
  min: LIMITS.MIN_WEIGHT, 
  max: LIMITS.MAX_WEIGHT, 
  positive: true, 
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

// Построение карточек упражнений
async function buildExercises() {
  const container = DOM.exercisesList || $("#exercises-list");
  const day = (DOM.day || $("#day")).value;
  const week = (DOM.week || $("#week")).value;
  const rows = PLAN[day] || [];
  
  container.innerHTML = "";
  
  // ОПТИМИЗАЦИЯ: Загружаем все TM одним запросом
  const exerciseNames = rows.map(r => r.name);
  const tmData = exerciseNames.length > 0 
    ? await dbModule.query(
        `SELECT exercise, tm_kg FROM tm WHERE exercise IN (${exerciseNames.map(() => '?').join(',')})`,
        exerciseNames
      )
    : [];
  const tmMap = Object.fromEntries(tmData.map(t => [t.exercise, t.tm_kg]));
  
  for (const [idx, ex] of rows.entries()) {
    const card = document.createElement("div");
    card.className = `exercise-card type${ex.type}`;
    card.dataset.exercise = ex.name;
    
    // O(1) lookup вместо await запроса к БД
    const lastTM = tmMap[ex.name] || null;
    
    card.dataset.target = ex.target[week] || '';
    card.innerHTML = `
      <div class="exercise-header">
        <span class="exercise-number">${idx + 1}</span>
        <div class="exercise-title-block">
          <h3 class="exercise-name">${ex.name}</h3>
          <div class="exercise-hint" data-exercise="${ex.name}"></div>
        </div>
        <span class="exercise-type type${ex.type}">${ex.type}</span>
      </div>
      <div class="exercise-info">
        <span>Сеты: ${ex.setrep}</span>
        <span>Цел. RIR: ${ex.target[week] || ''}</span>
        <span>ТМ: <input class="tm-input" type="text" inputmode="decimal" placeholder="0" value="${lastTM || ''}" style="width: 80px; padding: 4px 8px; font-size: 14px;"></span>
      </div>
      <div class="exercise-progress">
        <div class="progress-bar" style="width: 0%"></div>
      </div>
      <span class="progress-text">0/4 сетов</span>
      <div class="sets-list">
        <div class="set-row set-header">
          <div class="set-label"></div>
          <div class="set-header-label">Вес</div>
          <div class="set-header-label">Повт</div>
          <div class="set-header-label" title="e1RM: Estimated 1 Rep Max (Расчетный максимум на 1 повторение)">e1RM</div>
        </div>
              ${[1, 2, 3, 4].map((setNum) => `
                <div class="set-row" data-set="${setNum}">
                  <div class="set-label">
                    Сет ${setNum}
                    ${setNum > 1 ? `<button class="btn-copy-set" data-copy-from="${setNum - 1}" title="Копировать из предыдущего сета">↑</button>` : ''}
                  </div>
                  <input class="set-input w" type="text" inputmode="decimal" placeholder="Вес" data-set="${setNum}">
                  <input class="set-input r" type="text" inputmode="numeric" placeholder="Повт" data-set="${setNum}">
                  <div class="set-value e1rm hidden" data-set="${setNum}" title="e1RM: Estimated 1 Rep Max (Расчетный максимум на 1 повторение)"></div>
                </div>
              `).join('')}
      </div>
    `;
    
    container.appendChild(card);
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
  
  // Добавляем после подсказок
  const hintsCard = $("#hints");
  if (hintsCard && hintsCard.parentNode) {
    hintsCard.parentNode.insertBefore(container, hintsCard.nextSibling);
  }
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

// Сохранение ТМ для упражнения
async function saveTM(exercise, tm) {
  if (!tm || tm <= 0) return;
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
      const tm = card.querySelector('.tm-input')?.value || '';
      const sets = [];
      
      [1, 2, 3, 4].forEach(setNum => {
        const w = card.querySelector(`input.w[data-set="${setNum}"]`)?.value || '';
        const r = card.querySelector(`input.r[data-set="${setNum}"]`)?.value || '';
        if (w || r) {
          sets.push({ set: setNum, weight: w, reps: r });
        }
      });
      
      if (tm || sets.length > 0) {
        draft.exercises[exName] = { tm, sets };
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
        
        const tmInput = card.querySelector('.tm-input');
        if (tmInput && data.tm) tmInput.value = data.tm;
        
        (data.sets || []).forEach(({ set, weight, reps }) => {
          const wInput = card.querySelector(`input.w[data-set="${set}"]`);
          const rInput = card.querySelector(`input.r[data-set="${set}"]`);
          if (wInput) wInput.value = weight;
          if (rInput) rInput.value = reps;
        });
        
        computeCard(card);
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
  
  // Обработчик кнопок копирования сета
  container.addEventListener('click', (e) => {
    if (e.target.classList.contains('btn-copy-set')) {
      const card = e.target.closest('.exercise-card');
      const toSet = e.target.closest('.set-row').dataset.set;
      const fromSet = Number(toSet) - 1;
      
      const fromW = card.querySelector(`input.w[data-set="${fromSet}"]`).value;
      const fromR = card.querySelector(`input.r[data-set="${fromSet}"]`).value;
      
      if (!fromW && !fromR) {
        showNotification('Предыдущий сет пуст', 'warning');
        return;
      }
      
      const toW = card.querySelector(`input.w[data-set="${toSet}"]`);
      const toR = card.querySelector(`input.r[data-set="${toSet}"]`);
      
      toW.value = fromW;
      toR.value = fromR;
      
      computeCard(card);
      showNotification('Сет скопирован', 'success');
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
    computeCard(card);
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
    }
  });
  
  // Единый обработчик для blur (валидация)
  container.addEventListener('blur', async (e) => {
    const inp = e.target;
    if (!inp.matches('input')) return;
    
    const card = inp.closest('.exercise-card');
    if (!card) return;
    
    const exName = card.dataset.exercise;
    const value = Number(normalizeNumber(inp.value || 0));
    
    if (value > 0) {
      let validation;
      
      if (inp.classList.contains('tm-input')) {
        validation = validateTM(value);
        if (!validation.valid) {
          inp.classList.add('input-error');
          showNotification(validation.message, 'warning');
        } else {
          debouncedSaveTM(exName, value); // Используем debounced версию
        }
      } else if (inp.classList.contains('w')) {
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
  const wInputs = card.querySelectorAll('input.w');
  const rInputs = card.querySelectorAll('input.r');
  
  let filledSets = 0;
  const totalSets = wInputs.length;
  
  for (let i = 0; i < totalSets; i++) {
    const w = wInputs[i].value.trim();
    const r = rInputs[i].value.trim();
    if (w && r) filledSets++;
  }
  
  const percent = (filledSets / totalSets) * 100;
  
  const progressBar = card.querySelector('.progress-bar');
  const progressText = card.querySelector('.progress-text');
  
  if (progressBar) progressBar.style.width = `${percent}%`;
  if (progressText) progressText.textContent = `${filledSets}/${totalSets} сетов`;
}

// Вычисление значений для карточки
function computeCard(card) {
  const tm = Number(normalizeNumber(card.querySelector('.tm-input')?.value || 0));
  
  [1, 2, 3, 4].forEach((setNum) => {
    const w = Number(normalizeNumber(card.querySelector(`input.w[data-set="${setNum}"]`)?.value || 0));
    const r = Number(normalizeNumber(card.querySelector(`input.r[data-set="${setNum}"]`)?.value || 0));
    const e1Cell = card.querySelector(`.e1rm[data-set="${setNum}"]`);
    
    const e1 = e1rm(w, r);
    
    // Показываем e1RM только если есть вес и повторы
    if (e1 != null && w > 0 && r > 0) {
      e1Cell.textContent = e1;
      e1Cell.classList.remove('hidden');
    } else {
      e1Cell.textContent = '';
      e1Cell.classList.add('hidden');
    }
  });
  
  // Обновляем прогресс-бар
  updateSetProgress(card);
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
    const data = await dbModule.query(
      `SELECT * FROM v_last_sets WHERE exercise IN (${placeholders})`,
      exNames
    );
    
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
  
  for (let i = 0; i < wInputs.length; i++) {
    if (!wInputs[i].value && !rInputs[i].value) {
      wInputs[i].value = w;
      rInputs[i].value = reps;
      computeCard(card);
      break;
    }
  }
}

// Рекомендация веса
async function suggestForExercise(exName) {
  const week = Number((DOM.week || $("#week")).value);
  const day = (DOM.day || $("#day")).value;
  const item = (PLAN[day] || []).find(x => x.name === exName);
  if (!item) return;
  
  const repMatch = /(?:×|x)(\d+)[–-](\d+)/i.exec(item.setrep);
  const target_reps = repMatch ? Math.round((Number(repMatch[1]) + Number(repMatch[2])) / 2) : 8;
  const target_rir = targetToNumber(item.target[week]) ?? 2;
  
  try {
    const lastSet = await dbModule.getOne(
      'SELECT * FROM v_last_sets WHERE exercise = ?',
      [exName]
    );
    
    if (!lastSet) {
      alert('Нет истории для рекомендации');
      return;
    }
    
    const tm_est = lastSet.weight / (1 + lastSet.reps / LIMITS.E1RM_FACTOR);
    let w_new = tm_est * (1 + target_reps / LIMITS.E1RM_FACTOR);
    
    if (target_rir != null && lastSet.rir != null) {
      if (target_rir > lastSet.rir) w_new -= LIMITS.WEIGHT_ROUNDING;
      else if (target_rir < lastSet.rir) w_new += LIMITS.WEIGHT_ROUNDING;
    }
    
    w_new = Math.round(w_new / LIMITS.WEIGHT_ROUNDING) * LIMITS.WEIGHT_ROUNDING;
    if (w_new < 0) w_new = 0;
    
    const card = document.querySelector(`.exercise-card[data-exercise="${exName}"]`);
    if (!card) return;
    
    const inputsW = card.querySelectorAll('input.w');
    const inputsR = card.querySelectorAll('input.r');
    
    for (let i = 0; i < inputsW.length; i++) {
      if (!inputsW[i].value && !inputsR[i].value) {
        inputsW[i].value = w_new;
        inputsR[i].focus();
        computeCard(card);
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
    const tm = Number(normalizeNumber(card.querySelector('.tm-input')?.value || 0));
    
    [1, 2, 3, 4].forEach((setNum) => {
      const w = normalizeNumber(card.querySelector(`input.w[data-set="${setNum}"]`)?.value);
      const r = normalizeNumber(card.querySelector(`input.r[data-set="${setNum}"]`)?.value);
      const rir = card.querySelector(`.rir[data-set="${setNum}"]`)?.textContent;
      const rpe = card.querySelector(`.rpe[data-set="${setNum}"]`)?.textContent;
      const e1 = card.querySelector(`.e1rm[data-set="${setNum}"]`)?.textContent;
      const ex = Object.values(PLAN).flat().find(e => e.name === exer);
      const target_rir = ex ? ex.target[week] : '';
      
      if (w && r) {
        out.push({
          date,
          week,
          day,
          exercise: exer,
          set_no: setNum,
          weight: Number(w),
          reps: Number(r),
          rir: rir && rir !== '—' ? Number(rir) : null,
          rpe: rpe && rpe !== '—' ? Number(rpe) : null,
          target_rir,
          e1rm: e1 && e1 !== '—' ? Number(e1) : null,
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
    for (const row of rows) {
      await dbModule.execute(
        `INSERT INTO tracker (date, week, day, exercise, set_no, weight, reps, rir, rpe, target_rir, e1rm, note)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [row.date, row.week, row.day, row.exercise, row.set_no, row.weight, row.reps,
         row.rir, row.rpe, row.target_rir, row.e1rm, row.note]
      );
    }
    
    showNotification(`Сохранено: ${rows.length} сетов`, 'success');
    
    // Очищаем черновик после успешного сохранения
    clearDraft();
    
    // Обновляем статус сессии после сохранения
    await ensureSession();
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
    
    // Загружаем тепловую карту
    await renderHeatmap();
  } catch (error) {
    console.error('Failed to load dashboard:', error);
  }
}

// Рекорды
async function loadPRs() {
  try {
    const data = await dbModule.query('SELECT * FROM v_best_e1rm');
    const list = $("#pr-list");
    list.innerHTML = '';
    (data || []).forEach(x => {
      const li = document.createElement('li');
      li.textContent = `${x.exercise}: e1RM ${x.best_e1rm} кг (${x.date})`;
      list.appendChild(li);
    });
  } catch (error) {
    console.error('Failed to load PRs:', error);
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
    const rir = set.target_rir ? estRIR(weight * (1 + reps / LIMITS.E1RM_FACTOR), weight, reps) : null;
    const rpe = rpeFromRir(rir);
    
    await dbModule.execute(
      'UPDATE tracker SET weight = ?, reps = ?, e1rm = ?, rir = ?, rpe = ? WHERE id = ?',
      [weight, reps, e1, rir, rpe, id]
    );
    
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
    const json = await dbModule.exportDatabase();
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `meso-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  } catch (error) {
    console.error('Failed to export:', error);
    alert('Ошибка экспорта');
  }
}

async function importDatabase() {
  const input = document.getElementById('file-import');
  input.click();
  
  input.onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    
    try {
      const text = await file.text();
      await dbModule.importDatabase(text);
      alert('База данных успешно импортирована');
      location.reload();
    } catch (error) {
      console.error('Failed to import:', error);
      alert('Ошибка импорта: ' + error.message);
    }
  };
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

// Инициализация
async function initApp() {
  try {
    // Скрываем индикатор загрузки
    const loading = document.getElementById('loading');
    
    await dbModule.initDatabase();
    
    updateProgress(92, 'Загрузка плана тренировок...');
    
    // Кэшируем DOM элементы ПЕРЕД использованием
    cacheDOM();
    
    DOM.date.value = todayISO();
    await loadPlan();
    
    updateProgress(95, 'Инициализация интерфейса...');
    
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

// Обработчики событий
$("#btn-save")?.addEventListener('click', saveToDB);
$("#btn-finish")?.addEventListener('click', finishSession);
$("#btn-export")?.addEventListener('click', exportDatabase);
$("#btn-import")?.addEventListener('click', importDatabase);

// Запуск
setupOnlineIndicator();
initTheme();
initApp();

