// === MESO App (SQL.js) ===
import * as dbModule from './db.js';

let PLAN = {};
let CURRENT_SESSION = null;
const $ = (s) => document.querySelector(s);

// Вспомогательные функции
function e1rm(w, r) {
  if (!w || !r) return null;
  return Math.round(w * (1 + r / 30) * 10) / 10;
}

function estRIR(tm, w, r) {
  if (!tm || !w || !r) return null;
  const reps0 = 30 * (tm / w - 1);
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

// Валидация веса
function validateWeight(weight) {
  const w = Number(weight);
  if (isNaN(w)) return { valid: false, message: 'Введите корректное число' };
  if (w < 0) return { valid: false, message: 'Вес не может быть отрицательным' };
  if (w > 500) return { valid: false, message: 'Вес выглядит подозрительно большим (>500кг)' };
  if (w > 0 && w < 0.5) return { valid: false, message: 'Вес слишком мал (<0.5кг)' };
  return { valid: true };
}

// Валидация повторов
function validateReps(reps) {
  const r = Number(reps);
  if (isNaN(r)) return { valid: false, message: 'Введите корректное число' };
  if (r < 0) return { valid: false, message: 'Повторы не могут быть отрицательными' };
  if (!Number.isInteger(r)) return { valid: false, message: 'Повторы должны быть целым числом' };
  if (r > 100) return { valid: false, message: 'Слишком много повторов (>100)' };
  if (r === 0) return { valid: false, message: 'Повторы должны быть больше 0' };
  return { valid: true };
}

// Валидация ТМ
function validateTM(tm) {
  const t = Number(tm);
  if (isNaN(t)) return { valid: false, message: 'Введите корректное число' };
  if (t <= 0) return { valid: false, message: 'ТМ должен быть больше 0' };
  if (t > 500) return { valid: false, message: 'ТМ выглядит подозрительно большим (>500кг)' };
  return { valid: true };
}

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
  }, 3000);
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

// Построение опций дней
async function buildDayOptions() {
  const sel = $("#day");
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
  const container = $("#exercises-list");
  const day = $("#day").value;
  const week = $("#week").value;
  const rows = PLAN[day] || [];
  
  container.innerHTML = "";
  
  for (const [idx, ex] of rows.entries()) {
    const card = document.createElement("div");
    card.className = `exercise-card type${ex.type}`;
    card.dataset.exercise = ex.name;
    
    // Загружаем последний ТМ
    const lastTM = await loadLastTM(ex.name);
    
    card.dataset.target = ex.target[week] || '';
    card.innerHTML = `
      <div class="exercise-header">
        <span class="exercise-number">${idx + 1}</span>
        <h3 class="exercise-name">${ex.name}</h3>
        <span class="exercise-type type${ex.type}">${ex.type}</span>
      </div>
      <div class="exercise-info">
        <span>Сеты: ${ex.setrep}</span>
        <span>Цел. RIR: ${ex.target[week] || ''}</span>
        <span>ТМ: <input class="tm-input" type="text" inputmode="decimal" placeholder="0" value="${lastTM || ''}" style="width: 80px; padding: 4px 8px; font-size: 14px;"></span>
      </div>
      <div class="sets-list">
        ${[1, 2, 3, 4].map((setNum) => `
          <div class="set-row" data-set="${setNum}">
            <div class="set-label">Сет ${setNum}</div>
            <input class="set-input w" type="text" inputmode="decimal" placeholder="Вес" data-set="${setNum}">
            <input class="set-input r" type="text" inputmode="numeric" placeholder="Повт" data-set="${setNum}">
            <div class="set-value rir" data-set="${setNum}">—</div>
            <div class="set-value rpe" data-set="${setNum}">—</div>
            <div class="set-value e1rm" data-set="${setNum}">—</div>
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
  const currentWeek = Number($("#week").value);
  const day = $("#day").value;
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
      let suggestedWeight = avgE1RM / (1 + targetReps / 30);
      
      // Учитываем тренд
      if (trend > 0) {
        suggestedWeight += trend * 0.5; // консервативная прогрессия
      }
      
      suggestedWeight = Math.round(suggestedWeight / 2.5) * 2.5; // округляем до 2.5кг
      
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

// Инициализация глобального обработчика событий (Event Delegation)
function initGlobalHandlers() {
  const container = $("#exercises-list");
  
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
    
    // Автофокус на следующее поле после ввода повторов
    if (inp.classList.contains('r') && inp.value) {
      const wInputs = card.querySelectorAll('input.w');
      const rInputs = card.querySelectorAll('input.r');
      const all = [...wInputs, ...rInputs];
      const i = all.indexOf(inp);
      const next = all[i + 1];
      if (next) next.focus();
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
          await saveTM(exName, value);
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

// Вычисление значений для карточки
function computeCard(card) {
  const tm = Number(normalizeNumber(card.querySelector('.tm-input')?.value || 0));
  const targetText = card.dataset.target || '';
  const target = targetToNumber(targetText);
  const week = Number($("#week").value);
  const exName = card.dataset.exercise;
  const ex = Object.values(PLAN).flat().find(e => e.name === exName);
  const exTarget = ex ? targetToNumber(ex.target[week]) : null;
  
  [1, 2, 3, 4].forEach((setNum) => {
    const w = Number(normalizeNumber(card.querySelector(`input.w[data-set="${setNum}"]`)?.value || 0));
    const r = Number(normalizeNumber(card.querySelector(`input.r[data-set="${setNum}"]`)?.value || 0));
    const rirCell = card.querySelector(`.rir[data-set="${setNum}"]`);
    const rpeCell = card.querySelector(`.rpe[data-set="${setNum}"]`);
    const e1Cell = card.querySelector(`.e1rm[data-set="${setNum}"]`);
    
    const rir = estRIR(tm, w, r);
    const rpe = rpeFromRir(rir);
    const e1 = e1rm(w, r);
    
    rirCell.textContent = (rir == null) ? '—' : rir;
    rpeCell.textContent = (rpe == null) ? '—' : rpe;
    e1Cell.textContent = (e1 == null) ? '—' : e1;
    
    rirCell.classList.remove("ok", "warn", "bad");
    if (rir != null && exTarget != null) {
      const diff = Math.abs(rir - exTarget);
      if (diff <= 1) rirCell.classList.add("ok");
      else if (diff <= 2) rirCell.classList.add("warn");
      else rirCell.classList.add("bad");
    }
  });
}

// Загрузка подсказок
async function loadHints() {
  const day = $("#day").value;
  const rows = PLAN[day] || [];
  const exNames = rows.map(x => x.name);
  
  if (!exNames.length) {
    $("#hints-list").innerHTML = '';
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
    
    const container = $("#hints-list");
    container.innerHTML = '';
    
    rows.forEach(ex => {
      const h = byEx[ex.name];
      const div = document.createElement("div");
      div.className = 'hint';
      
      if (h) {
        div.innerHTML = `
          <b>${ex.name}</b> • ${h.weight}×${h.reps} @RIR ${h.rir ?? '—'}
          <span class="action-mini">
            <button class="btn mini" data-act="fill-last" data-ex="${ex.name}">📝 Заполнить</button>
            <button class="btn mini" data-act="suggest" data-ex="${ex.name}">🧮 Рассчитать</button>
          </span>
        `;
      } else {
        div.innerHTML = `
          <b>${ex.name}</b> • <span class="empty-state">Нет данных — заполните первый подход</span>
          <span class="action-mini">
            <button class="btn mini" data-act="suggest" data-ex="${ex.name}">🧮 Рассчитать</button>
          </span>
        `;
      }
      
      container.appendChild(div);
    });
    
    container.addEventListener('click', async (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      const exName = b.dataset.ex;
      if (b.dataset.act === 'fill-last') {
        fillFromLast(exName);
      }
      if (b.dataset.act === 'suggest') {
        await suggestForExercise(exName);
      }
    }, { once: true });
  } catch (error) {
    console.warn('Failed to load hints:', error);
    $("#hints-list").innerHTML = '';
  }
}

// Заполнение из последнего
function fillFromLast(exName) {
  const card = document.querySelector(`.exercise-card[data-exercise="${exName}"]`);
  if (!card) return;
  
  const hint = Array.from($("#hints-list").children).find(d => 
    d.querySelector('b')?.textContent === exName
  );
  if (!hint) return;
  
  const text = hint.textContent;
  const m = text.match(/(\d+(?:[\.,]\d+)?)×(\d+)/);
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
  const week = Number($("#week").value);
  const day = $("#day").value;
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
    
    const tm_est = lastSet.weight / (1 + lastSet.reps / 30);
    let w_new = tm_est * (1 + target_reps / 30);
    
    if (target_rir != null && lastSet.rir != null) {
      if (target_rir > lastSet.rir) w_new -= 2.5;
      else if (target_rir < lastSet.rir) w_new += 2.5;
    }
    
    w_new = Math.round(w_new / 2.5) * 2.5;
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
  const date = $("#date").value;
  const week = Number($("#week").value);
  const day = $("#day").value;
  
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
    
    // Обновляем статус сессии после сохранения
    await ensureSession();
  } catch (error) {
    console.error('Failed to save:', error);
    showNotification("Ошибка сохранения: " + error.message, 'error');
  }
}

// Сессии
async function ensureSession() {
  const date = $("#date").value;
  const week = Number($("#week").value);
  const day = $("#day").value;
  
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
    $("#session-status").textContent = statusText;
    
    // Показываем/скрываем кнопку завершения
    const finishBtn = $("#btn-finish");
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
    $("#session-status").textContent = 'Тренировка завершена ✓';
    $("#btn-finish").style.display = 'none';
    CURRENT_SESSION = null;
  } catch (error) {
    console.error('Failed to finish session:', error);
    showNotification('Ошибка завершения тренировки', 'error');
  }
}

// Дашборд
async function loadDashboard() {
  const week = Number($("#week").value);
  
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
    const rir = set.target_rir ? estRIR(weight * (1 + reps / 30), weight, reps) : null;
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
    $("#date").value = todayISO();
    await loadPlan();
    
    updateProgress(95, 'Инициализация интерфейса...');
    
    // Инициализируем глобальные обработчики событий (Event Delegation)
    initGlobalHandlers();
    
    await buildDayOptions();
    
    $("#week").addEventListener('change', async () => {
      await buildExercises();
      await loadDashboard();
    });
    
    $("#day").addEventListener('change', async () => {
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
initTheme();
initApp();

