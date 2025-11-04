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

// Загрузка плана тренировок
async function loadPlan() {
  PLAN = {};
  try {
    const data = await dbModule.query('SELECT * FROM plan ORDER BY day');
    for (const row of data) {
      const d = row.day;
      (PLAN[d] = PLAN[d] || []).push({
        name: row.exercise,
        setrep: row.setrep,
        type: row.type,
        target: { 1: row.rir_w1, 2: row.rir_w2, 3: row.rir_w3, 4: row.rir_w4 },
        note: row.note || ''
      });
    }
    
    // Если план пустой, загружаем из CSV
    if (data.length === 0) {
      await loadPlanFromCSV();
    }
  } catch (error) {
    console.error('Failed to load plan:', error);
    await loadPlanFromCSV();
  }
}

// Загрузка плана из CSV
async function loadPlanFromCSV() {
  try {
    const response = await fetch('./plan.csv');
    if (!response.ok) {
      throw new Error(`Failed to fetch plan.csv: ${response.status} ${response.statusText}`);
    }
    const csvText = await response.text();
    if (!csvText || csvText.trim().length === 0) {
      throw new Error('plan.csv is empty');
    }
    await dbModule.loadCSVIntoTable('plan', csvText);
    await loadPlan();
  } catch (error) {
    console.error('Failed to load plan from CSV:', error);
    const errorMsg = `Не удалось загрузить план тренировок: ${error.message}`;
    console.error(errorMsg);
    // Не показываем alert, чтобы не блокировать интерфейс
    // Просто логируем ошибку
  }
}

// Построение опций дней
function buildDayOptions() {
  const sel = $("#day");
  sel.innerHTML = "";
  Object.keys(PLAN).forEach(d => {
    const o = document.createElement("option");
    o.value = d;
    o.textContent = d;
    sel.appendChild(o);
  });
  buildExercises();
}

// Построение карточек упражнений
function buildExercises() {
  const container = $("#exercises-list");
  const day = $("#day").value;
  const week = $("#week").value;
  const rows = PLAN[day] || [];
  
  container.innerHTML = "";
  
  rows.forEach((ex, idx) => {
    const card = document.createElement("div");
    card.className = `exercise-card type${ex.type}`;
    card.dataset.exercise = ex.name;
    
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
        <span>ТМ: <input class="tm-input" type="text" inputmode="decimal" placeholder="0" style="width: 80px; padding: 4px 8px; font-size: 14px;"></span>
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
      <div class="quick-actions">
        <button class="btn mini" data-step="-5">-5</button>
        <button class="btn mini" data-step="-2.5">-2.5</button>
        <button class="btn mini" data-step="+2.5">+2.5</button>
        <button class="btn mini" data-step="+5">+5</button>
      </div>
    `;
    
    container.appendChild(card);
    attachCardHandlers(card, ex, week);
  });
  
  loadHints();
  ensureSession();
}

// Привязка обработчиков к карточке
function attachCardHandlers(card, ex, week) {
  const tmInput = card.querySelector('.tm-input');
  const wInputs = card.querySelectorAll('input.w');
  const rInputs = card.querySelectorAll('input.r');
  
  // Обработка ввода веса и повторов
  [...wInputs, ...rInputs, tmInput].forEach(inp => {
    inp.addEventListener('input', () => {
      if (inp.classList.contains('w') || inp.classList.contains('tm-input')) {
        inp.value = normalizeNumber(inp.value);
      }
      computeCard(card);
      if (inp.classList.contains('r')) {
        const all = [...wInputs, ...rInputs];
        const i = all.indexOf(inp);
        const next = all[i + 1];
        if (next) next.focus();
      }
    });
  });
  
  // Быстрые действия
  card.querySelectorAll('.quick-actions .btn').forEach(b => {
    b.addEventListener('click', (e) => {
      const step = Number(b.dataset.step);
      const target = Array.from(wInputs).find(x => x === document.activeElement) ||
                     Array.from(wInputs).find(x => x.value) || wInputs[0];
      let val = Number(normalizeNumber(target.value || '0'));
      val = Math.max(0, Math.round((val + step) * 10) / 10);
      target.value = String(val);
      computeCard(card);
    });
    
    b.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const step = Number(b.dataset.step);
      wInputs.forEach(inp => {
        let val = Number(normalizeNumber(inp.value || '0'));
        val = Math.max(0, Math.round((val + step) * 10) / 10);
        inp.value = String(val);
      });
      computeCard(card);
    });
  });
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
    alert("Нет заполненных сетов.");
    return;
  }
  
  try {
    for (const row of rows) {
      await dbModule.execute(
        `INSERT INTO tracker (date, week, day, exercise, set_no, weight, reps, rir, rpe, target_rir, e1rm, note)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [row.date, row.week, row.day, row.exercise, row.set_no, row.weight, row.reps,
         row.rir, row.rpe, row.target_rir, row.e1rm, row.note]
      );
    }
    
    alert("Сохранено: " + rows.length + " рядов");
  } catch (error) {
    console.error('Failed to save:', error);
    alert("Ошибка сохранения: " + error.message);
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
    }
    
    $("#session-status").textContent = CURRENT_SESSION ?
      `Сессия: открыта (${date})` : 'Сессия: нет';
  } catch (error) {
    console.error('Failed to ensure session:', error);
  }
}

async function finishSession() {
  if (!CURRENT_SESSION) return;
  
  try {
    await dbModule.execute(
      'UPDATE sessions SET status = ? WHERE id = ?',
      ['done', CURRENT_SESSION.id]
    );
    $("#session-status").textContent = 'Сессия: завершена';
  } catch (error) {
    console.error('Failed to finish session:', error);
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

// Инициализация
async function initApp() {
  try {
    // Скрываем индикатор загрузки
    const loading = document.getElementById('loading');
    
    await dbModule.initDatabase();
    $("#date").value = todayISO();
    await loadPlan();
    buildDayOptions();
    
    $("#week").addEventListener('change', () => {
      buildExercises();
      loadDashboard();
    });
    
    $("#day").addEventListener('change', () => {
      buildExercises();
    });
    
    await loadDashboard();
    await loadPRs();
    
    // Скрываем индикатор загрузки после успешной инициализации
    if (loading) {
      loading.style.display = 'none';
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

// Обработчики событий
$("#btn-save")?.addEventListener('click', saveToDB);
$("#btn-finish")?.addEventListener('click', finishSession);
$("#btn-export")?.addEventListener('click', exportDatabase);
$("#btn-import")?.addEventListener('click', importDatabase);

// Запуск
initApp();

