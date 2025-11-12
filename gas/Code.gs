/**
 * GS Trainer — Google Sheets + Apps Script implementation.
 *
 * Основной сценарий:
 *   1) Пользователь открывает таблицу, выбирает меню "GS Trainer → Открыть тренировку".
 *   2) Боковая панель (Sidebar.html) показывает селекты Week/Day и таблицу сетов.
 *   3) После ввода факта нажимаем "Сохранить" → данные попадают в лист Log,
 *      рассчитываются e1RM/TM, обновляется лист TMs, возвращаются PR.
 */

const SHEET_SETTINGS = "Settings";
const SHEET_PLAN = "Plan";
const SHEET_LOG = "Log";
const SHEET_TMS = "TMs";
const SHEET_ARCHIVE = "Archive";

const LOG_COLUMNS = [
  "Timestamp",
  "Week#",
  "Day#",
  "Exercise",
  "Set #",
  "Rep Min",
  "Rep Max",
  "RIR plan",
  "Prescribed",
  "Actual Reps",
  "Actual Weight",
  "Actual RIR",
  "e1RM",
  "TM (90%)",
  "Updated",
  "Notes"
];

const SETTINGS_DEFAULTS = {
  UNITS: "kg",
  STEP_KG: 2.5,
  STEP_LB: 5,
  BAR_WEIGHT: 20,
  ARCHIVE_DAYS: 60
};

const PLAN_HEADERS = [
  "Key",
  "Week",
  "Day",
  "Exercise",
  "Set #",
  "Rep Min",
  "Rep Max",
  "RIR",
  "Prescribed",
  "PctTM"
];

const TMS_HEADERS = ["Exercise", "last e1RM", "TM (90%)", "Updated"];

const DUPLICATE_WINDOW_MS = 60 * 1000;
const MAX_DUPLICATE_SCAN_ROWS = 500;

/* --------------------------------- UI ------------------------------------ */

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu("GS Trainer")
    .addItem("Подготовить таблицу", "setupSpreadsheet")
    .addItem("Импортировать план 4×4", "importPlanTemplate")
    .addItem("Проверить конфигурацию", "validateSetup")
    .addSeparator()
    .addItem("Open Sidebar", "showSidebar")
    .addItem("Archive Old Logs", "archiveOldLogs")
    .addToUi();
}

function showSidebar() {
  const template = HtmlService.createTemplateFromFile("Sidebar");
  template.version = "1.0.0";
  const html = template.evaluate().setTitle("GS Trainer");
  SpreadsheetApp.getUi().showSidebar(html);
}

function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

/* ------------------------------- API ------------------------------------- */

/**
 * Возвращает данные по плану на конкретные неделю/день.
 * Алиас для recommendForDay (соответствие ТЗ v5).
 *
 * @param {number} week
 * @param {number} day
 * @return {Object}
 */
function getDayData(week, day) {
  return recommendForDay(week, day);
}

/**
 * Возвращает данные по плану на конкретные неделю/день (ТЗ v5).
 *
 * @param {number} week
 * @param {number} day
 * @return {Object}
 */
function recommendForDay(week, day) {
  week = Number(week) || 1;
  day = Number(day) || 1;

  const settings = getSettings_();
  const planRows = getPlanRows_(week, day);
  const tmMap = getTMsMap_();
  const warmup = {};

  const rows = planRows
    .filter((row) => row.exercise && String(row.exercise).trim())
    .map((row) => {
      const exercise = String(row.exercise || "").trim();
      if (!exercise) return null;

      const tmEntry = tmMap[exercise];
      const tm = tmEntry ? tmEntry.tm : null;
      const recommended =
        tm != null && row.pct != null
          ? roundToStep_(tm * row.pct, settings.step)
          : null;

      if (tm != null && !warmup[exercise]) {
        warmup[exercise] = buildWarmup_(exercise, tm, recommended, settings);
      }

      return {
        exercise,
        set: row.set || 0,
        repMin: row.repMin,
        repMax: row.repMax,
        rirPlan: row.rirPlan,
        pct: row.pct,
        prescribed: row.prescribed || "",
        tm,
        recommended
      };
    })
    .filter((row) => row != null);

  return {
    week,
    day,
    units: settings.units,
    step: settings.step,
    rows,
    warmup
  };
}

/**
 * Сохраняет выполненные сеты в лог, обновляет TMs и возвращает summary.
 *
 * @param {Object} payload
 * @return {Object}
 */
function saveLog(payload) {
  if (!payload || !payload.rows || !payload.rows.length) {
    throw new Error("Нет данных для сохранения.");
  }

  const settings = getSettings_();
  const ss = SpreadsheetApp.getActive();
  const logSheet = ss.getSheetByName(SHEET_LOG);
  const tmSheet = ss.getSheetByName(SHEET_TMS);
  if (!logSheet || !tmSheet) {
    throw new Error("Листы Log или TMs не найдены.");
  }

  const now = new Date();
  const duplicateCache = buildDuplicateCache_(logSheet, now);
  const tmMap = getTMsMap_();

  const valuesToAppend = [];
  const prs = [];

  payload.rows.forEach((row) => {
    // Валидации согласно ТЗ v5
    const exercise = String(row.exercise || "").trim();
    if (!exercise) {
      throw new Error("Exercise не может быть пустым.");
    }

    const set = numberOrNull_(row.set);
    if (set == null || set < 1) {
      throw new Error(`Set должен быть положительным числом, получено: ${row.set}`);
    }

    const key = `${exercise}__${set}`;

    if (duplicateCache[key]) {
      return; // пропускаем дубликат
    }

    const week = numberOrNull_(row.week);
    const day = numberOrNull_(row.day);
    if (week != null && (week < 1 || week > 4)) {
      throw new Error(`Week должен быть 1-4, получено: ${week}`);
    }
    if (day != null && (day < 1 || day > 4)) {
      throw new Error(`Day должен быть 1-4, получено: ${day}`);
    }

    const repMin = numberOrNull_(row.repMin);
    const repMax = numberOrNull_(row.repMax);
    const reps = numberOrNull_(row.reps);
    if (reps != null && (reps < 1 || reps > 30)) {
      throw new Error(`Reps должен быть 1-30, получено: ${reps}`);
    }

    const weight = numberOrNull_(row.weight);
    if (weight != null && weight < 0) {
      throw new Error(`Weight не может быть отрицательным, получено: ${weight}`);
    }

    const rirPlan = numberOrNull_(row.rirPlan);
    const actualRir = numberOrNull_(row.rir);
    if (actualRir != null && (actualRir < 0 || actualRir > 3)) {
      throw new Error(`Actual RIR должен быть 0-3, получено: ${actualRir}`);
    }

    const prescribed = row.prescribed != null ? row.prescribed : "";
    const note = row.note || "";

    const e1rm =
      reps != null && weight != null
        ? roundToStep_(weight * (1 + reps / 30), settings.step)
        : null;
    const tm = e1rm != null ? roundToStep_(e1rm * 0.9, settings.step) : null;

    valuesToAppend.push([
      now,
      week,
      day,
      exercise,
      set,
      repMin,
      repMax,
      rirPlan,
      prescribed,
      reps,
      weight,
      actualRir,
      e1rm,
      tm,
      now,
      note
    ]);

    if (tm != null) {
      const current = tmMap[exercise];
      if (!current || (current.e1rm != null && e1rm > current.e1rm) || !current.e1rm) {
        prs.push({ exercise: exercise, e1rm, tm });
        tmMap[exercise] = { e1rm, tm, rowIndex: current ? current.rowIndex : null };
      }
    }

    duplicateCache[key] = true;
  });

  if (!valuesToAppend.length) {
    return { ok: true, added: 0, prs: 0, message: "Дубликаты не сохранены." };
  }

  appendToSheet_(logSheet, valuesToAppend);
  if (prs.length) {
    upsertTMs_(tmSheet, prs, settings.step);
  }

  return { ok: true, added: valuesToAppend.length, prs: prs.length };
}

/* --------------------------- REST API ------------------------------------- */

/**
 * REST эндпоинт для опциональной PWA (ТЗ v5).
 * GET /exec?fn=day&week={1..4}&day={1..4} → JSON { plan[], settings{}, tms{} }
 * GET /exec?fn=settings → JSON настроек
 *
 * @param {GoogleAppsScript.Events.DoGet} e
 * @return {GoogleAppsScript.Content.TextOutput}
 */
function doGet(e) {
  try {
    const fn = e.parameter && e.parameter.fn ? String(e.parameter.fn).toLowerCase() : "";

    if (fn === "day") {
      const week = Number(e.parameter.week) || 1;
      const day = Number(e.parameter.day) || 1;
      
      if (week < 1 || week > 4 || day < 1 || day > 4) {
        return ContentService.createTextOutput(
          JSON.stringify({ ok: false, error: "Week и Day должны быть в диапазоне 1-4" })
        ).setMimeType(ContentService.MimeType.JSON);
      }
      
      const data = recommendForDay(week, day);
      const settings = getSettings_();
      const tmMap = getTMsMap_();

      return ContentService.createTextOutput(
        JSON.stringify({
          ok: true,
          plan: data.rows,
          settings: {
            units: settings.units,
            step: settings.step,
            barWeight: settings.barWeight
          },
          tms: Object.keys(tmMap).reduce((acc, key) => {
            if (tmMap[key]) {
              acc[key] = { e1rm: tmMap[key].e1rm, tm: tmMap[key].tm };
            }
            return acc;
          }, {})
        })
      ).setMimeType(ContentService.MimeType.JSON);
    } else if (fn === "settings") {
      const settings = getSettings_();
      return ContentService.createTextOutput(
        JSON.stringify({
          ok: true,
          units: settings.units,
          step: settings.step,
          barWeight: settings.barWeight,
          archiveDays: settings.archiveDays
        })
      ).setMimeType(ContentService.MimeType.JSON);
    } else {
      return ContentService.createTextOutput(
        JSON.stringify({ ok: false, error: "Unknown function. Use fn=day|settings" })
      ).setMimeType(ContentService.MimeType.JSON);
    }
  } catch (error) {
    return ContentService.createTextOutput(
      JSON.stringify({ ok: false, error: error.message || String(error) })
    ).setMimeType(ContentService.MimeType.JSON);
  }
}

/* --------------------------- Архивация ----------------------------------- */

function archiveOldLogs() {
  const settings = getSettings_();
  const days = Number(settings.archiveDays) || 60;
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);

  const ss = SpreadsheetApp.getActive();
  const logSheet = ss.getSheetByName(SHEET_LOG);
  const archiveSheet = ss.getSheetByName(SHEET_ARCHIVE);
  if (!logSheet || !archiveSheet) {
    throw new Error("Листы Log или Archive не найдены.");
  }

  const data = logSheet.getDataRange().getValues();
  if (data.length <= 1) {
    return 0;
  }

  const header = data[0];
  const rows = data.slice(1);
  const toArchive = [];
  const toKeep = [];

  rows.forEach((row) => {
    if (!row || row.length === 0) {
      toKeep.push(row);
      return;
    }
    const ts = row[0];
    if (ts instanceof Date && ts < cutoff) {
      toArchive.push(row);
    } else {
      toKeep.push(row);
    }
  });

  if (toArchive.length) {
    appendToSheet_(archiveSheet, toArchive);
    logSheet.clearContents();
    logSheet.getRange(1, 1, 1, header.length).setValues([header]);
    if (toKeep.length) {
      appendToSheet_(logSheet, toKeep);
    }
  }

  return toArchive.length;
}

/* ------------------------- Helpers: Sheets ------------------------------- */

function appendToSheet_(sheet, values) {
  if (!values || !values.length || !values[0] || !values[0].length) {
    return;
  }
  const startRow = sheet.getLastRow() + 1;
  const startCol = 1;
  const numCols = values[0].length;
  sheet.getRange(startRow, startCol, values.length, numCols).setValues(values);
}

function ensureSheet_(name) {
  const ss = SpreadsheetApp.getActive();
  let sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
  }
  return sheet;
}

function setupSpreadsheet() {
  const ui = SpreadsheetApp.getUi();
  try {
    const ss = SpreadsheetApp.getActive();
    const existingData = [SHEET_PLAN, SHEET_LOG, SHEET_TMS, SHEET_ARCHIVE]
      .map((name) => {
        const sheet = ss.getSheetByName(name);
        if (!sheet) return false;
        return sheet.getLastRow() > 1;
      })
      .some(Boolean);

    if (existingData) {
      const response = ui.alert(
        "Подготовка таблицы",
        "Найдено существующее содержимое. Продолжение очистит листы Plan, Log, TMs и Archive. Продолжить?",
        ui.ButtonSet.YES_NO
      );
      if (response !== ui.Button.YES) {
        return;
      }
    }

    const settingsSheet = ensureSheet_(SHEET_SETTINGS);
    prepareSettingsSheet_(settingsSheet);

    const planSheet = ensureSheet_(SHEET_PLAN);
    preparePlanSheet_(planSheet);

    const logSheet = ensureSheet_(SHEET_LOG);
    prepareLogSheet_(logSheet);

    const tmSheet = ensureSheet_(SHEET_TMS);
    prepareTMsSheet_(tmSheet);

    const archiveSheet = ensureSheet_(SHEET_ARCHIVE);
    prepareArchiveSheet_(archiveSheet);

    ui.alert("Готово", "Структура таблицы подготовлена. Проверьте листы и импортируйте план.", ui.ButtonSet.OK);
  } catch (error) {
    ui.alert("Ошибка", error.message, ui.ButtonSet.OK);
    throw error;
  }
}

function prepareSettingsSheet_(sheet) {
  sheet.clear();
  sheet.getRange("B1").setValue("Key");
  sheet.getRange("C1").setValue("Value");
  const entries = Object.keys(SETTINGS_DEFAULTS).map((key) => [key, SETTINGS_DEFAULTS[key]]);
  sheet.getRange(2, 2, entries.length, 2).setValues(entries);
  sheet.autoResizeColumns(2, 2);
}

function preparePlanSheet_(sheet) {
  sheet.clear();
  sheet.getRange(1, 1, 1, PLAN_HEADERS.length).setValues([PLAN_HEADERS]);
  sheet.autoResizeColumns(1, PLAN_HEADERS.length);
}

function prepareLogSheet_(sheet) {
  sheet.clear();
  sheet.getRange(1, 1, 1, LOG_COLUMNS.length).setValues([LOG_COLUMNS]);
  sheet.autoResizeColumns(1, LOG_COLUMNS.length);
}

function prepareArchiveSheet_(sheet) {
  prepareLogSheet_(sheet);
}

function prepareTMsSheet_(sheet) {
  sheet.clear();
  sheet.getRange(1, 1, 1, TMS_HEADERS.length).setValues([TMS_HEADERS]);
  sheet.autoResizeColumns(1, TMS_HEADERS.length);
}

function importPlanTemplate() {
  const ui = SpreadsheetApp.getUi();
  const sheet = ensureSheet_(SHEET_PLAN);

  if (sheet.getLastRow() > 1) {
    const response = ui.alert(
      "Импорт плана",
      "Лист Plan содержит данные. Импорт заменит существующий план. Продолжить?",
      ui.ButtonSet.YES_NO
    );
    if (response !== ui.Button.YES) {
      return;
    }
  }

  preparePlanSheet_(sheet);

  const planData = buildPlanTemplate_();
  if (!planData.length) {
    ui.alert("Импорт плана", "План пуст. Проверьте buildPlanTemplate_.", ui.ButtonSet.OK);
    return;
  }

  sheet.getRange(2, 1, planData.length, PLAN_HEADERS.length).setValues(planData);
  sheet.autoResizeColumns(1, PLAN_HEADERS.length);
  ui.alert("Импорт плана", `Импортировано ${planData.length} строк плана (4 недели × 4 дня).`, ui.ButtonSet.OK);
}

function validateSetup() {
  const ui = SpreadsheetApp.getUi();
  const issues = [];

  // Settings
  const settingsSheet = SpreadsheetApp.getActive().getSheetByName(SHEET_SETTINGS);
  if (!settingsSheet) {
    issues.push("Отсутствует лист Settings.");
  } else {
    const allData = settingsSheet.getRange(1, 2, Math.max(1, settingsSheet.getLastRow()), 2).getValues();
    settingsSheet.getRange(1, 2, Math.max(1, settingsSheet.getLastRow()), 2).setBackground("#ffffff");

    const keyIndex = {};
    for (let i = 1; i < allData.length; i++) {
      const row = allData[i];
      if (!row || row.length < 2) continue;
      const key = String(row[0] || "").trim();
      if (key) keyIndex[key] = i + 1;
    }

    Object.keys(SETTINGS_DEFAULTS).forEach((key) => {
      if (!keyIndex[key]) {
        issues.push(`Settings: отсутствует ключ ${key}.`);
        // Подсвечиваем заголовок, так как конкретная строка не найдена
        settingsSheet.getRange(1, 2, 1, 2).setBackground("#ffcccc");
      }
    });
  }

  // Plan
  validateHeader_(SHEET_PLAN, PLAN_HEADERS, issues);
  // Log
  validateHeader_(SHEET_LOG, LOG_COLUMNS, issues);
  // TMs
  validateHeader_(SHEET_TMS, TMS_HEADERS, issues);
  // Archive
  validateHeader_(SHEET_ARCHIVE, LOG_COLUMNS, issues, "Archive");

  if (!issues.length) {
    SpreadsheetApp.getActive().toast("Конфигурация в порядке ✔️", "GS Trainer", 5);
    ui.alert("Проверка настроек", "Конфигурация таблицы соответствует ожидаемой.", ui.ButtonSet.OK);
  } else {
    const message = issues.map((issue) => `• ${issue}`).join("\n");
    ui.alert("Найдены проблемы", message, ui.ButtonSet.OK);
  }
}

function validateHeader_(sheetName, expectedHeaders, issues, displayName) {
  const ss = SpreadsheetApp.getActive();
  const sheet = ss.getSheetByName(sheetName);
  const label = displayName || sheetName;

  if (!sheet) {
    issues.push(`Отсутствует лист ${label}.`);
    return;
  }

  const lastCol = sheet.getLastColumn();
  const numCols = Math.max(expectedHeaders.length, lastCol);
  const headerRange = sheet.getRange(1, 1, 1, numCols);
  headerRange.setBackground("#ffffff");
  const headerValues = headerRange.getValues()[0].map((cell) => String(cell || "").trim());

  expectedHeaders.forEach((expected, index) => {
    const actual = headerValues[index] || "";
    if (actual !== expected) {
      issues.push(`${label}: ожидался столбец "${expected}" в позиции ${index + 1}, получен "${actual}".`);
      if (index + 1 <= numCols) {
        sheet.getRange(1, index + 1).setBackground("#ffcccc");
      }
    }
  });
}

function buildPlanTemplate_() {
  const rows = [];

  const phases = [
    { week: 1, topPct: 0.82, topReps: [4, 6], topRir: 2, backPct: 0.72, backReps: [5, 6], backRir: 2 },
    { week: 2, topPct: 0.85, topReps: [3, 5], topRir: 2, backPct: 0.75, backReps: [4, 6], backRir: 2 },
    { week: 3, topPct: 0.88, topReps: [2, 4], topRir: 1, backPct: 0.8, backReps: [3, 5], backRir: 1 },
    { week: 4, topPct: 0.7, topReps: [5, 6], topRir: 2, backPct: 0.65, backReps: [6, 8], backRir: 2 }
  ];

  phases.forEach((phase) => {
    const week = phase.week;

    // День 1 — Жим (тяжёлый) + плечи + трицепс
    addMainLift_(rows, week, 1, "Жим лёжа (штанга)", phase);
    addAccessory_(rows, week, 1, "Жим гантелей сидя", 3, 6, 8, 2);
    addAccessory_(rows, week, 1, "Махи в стороны", 4, 12, 20, 2);
    addMainLiftWithPct_(rows, week, 1, "Брусья (нагруженные)", 3, 6, 10, 2, phase.backPct);
    addAccessory_(rows, week, 1, "Канат на трицепс", 3, 10, 15, 2);

    // День 2 — Тяга (становая) + спина + бицепс + задняя цепь + предплечья
    addMainLift_(rows, week, 2, "Становая тяга (классика)", phase);
    addAccessory_(rows, week, 2, "Тяга в наклоне (горизонтальная)", 4, 6, 10, 2);
    addAccessory_(rows, week, 2, "Тяга верхнего блока", 3, 8, 12, 2);
    addAccessory_(rows, week, 2, "Сгибания ног сидя", 3, 10, 15, 2);
    addAccessory_(rows, week, 2, "Бицепс штанга/EZ", 3, 8, 12, 2);
    addAccessory_(rows, week, 2, "Reverse Curl (EZ)", 2, 8, 12, 2);
    addAccessory_(rows, week, 2, "Wrist Curl", 2, 10, 15, 2);

    // День 3 — Жим (лёгкий/техничный) + плечи/руки + реабилитация + предплечья
    addPlanRow_(rows, week, 3, "Жим лёжа пауза/узкий", 1, 6, 8, 2, "", 0.7);
    addPlanRow_(rows, week, 3, "Жим лёжа пауза/узкий", 2, 6, 8, 2, "", 0.7);
    addPlanRow_(rows, week, 3, "Жим лёжа пауза/узкий", 3, 6, 8, 2, "", 0.7);
    addAccessory_(rows, week, 3, "Арнольд-пресс", 3, 10, 12, 2);
    addAccessory_(rows, week, 3, "Махи в стороны", 3, 15, 25, 2);
    addAccessory_(rows, week, 3, "Обратные разведения (задняя дельта)", 3, 15, 20, 2);
    addAccessory_(rows, week, 3, "Трицепс над головой (канат/гантель)", 3, 10, 15, 2);
    addAccessory_(rows, week, 3, "Кабель на бицепс", 3, 10, 15, 2);
    addAccessory_(rows, week, 3, "Quad-rehab (Reverse Sled Drag/TKE)", 3, 20, 30, 2);
    addAccessory_(rows, week, 3, "Wrist Extension", 2, 10, 15, 2);

    // День 4 — Ноги (HSR, защищённый ROM) + задняя цепь + реабилитация
    addMainLiftReduced_(rows, week, 4, "Присед широкой стойкой на бокс (≤параллели)", phase, 3);
    addAccessory_(rows, week, 4, "Румынская тяга", 3, 6, 10, 2);
    addAccessory_(rows, week, 4, "Жим ногами (ступни высоко, 0–90°)", 3, 12, 20, 2);
    addAccessory_(rows, week, 4, "Икры", 3, 8, 12, 2);
    addAccessory_(rows, week, 4, "Молотковые сгибания", 2, 10, 15, 2);
    addAccessory_(rows, week, 4, "Decline Eccentric Squat (~25°, ROM ≤60–70°)", 3, 15, 15, 2);
  });

  return rows;
}

function addMainLift_(rows, week, day, exercise, phase) {
  const [topMin, topMax] = phase.topReps;
  const [backMin, backMax] = phase.backReps;

  addPlanRow_(rows, week, day, exercise, 1, topMin, topMax, phase.topRir, "", phase.topPct);
  for (let set = 2; set <= 4; set++) {
    addPlanRow_(rows, week, day, exercise, set, backMin, backMax, phase.backRir, "", phase.backPct);
  }
}

function addAccessory_(rows, week, day, exercise, sets, repMin, repMax, rir) {
  for (let i = 1; i <= sets; i++) {
    addPlanRow_(rows, week, day, exercise, i, repMin, repMax, rir, "", "");
  }
}

function addMainLiftWithPct_(rows, week, day, exercise, sets, repMin, repMax, rir, pct) {
  for (let i = 1; i <= sets; i++) {
    addPlanRow_(rows, week, day, exercise, i, repMin, repMax, rir, "", pct);
  }
}

function addMainLiftReduced_(rows, week, day, exercise, phase, backOffSets) {
  const [topMin, topMax] = phase.topReps;
  const [backMin, backMax] = phase.backReps;
  
  addPlanRow_(rows, week, day, exercise, 1, topMin, topMax, phase.topRir, "", phase.topPct);
  for (let set = 2; set <= backOffSets + 1; set++) {
    addPlanRow_(rows, week, day, exercise, set, backMin, backMax, phase.backRir, "", phase.backPct);
  }
}

function addPlanRow_(rows, week, day, exercise, setNumber, repMin, repMax, rir, prescribed, pct) {
  const exerciseKey = String(exercise || "").replace(/[^A-Za-z0-9А-Яа-я]+/g, "_");
  rows.push([
    `W${week}D${day}-${exerciseKey}-S${setNumber}`,
    Number(week) || 0,
    Number(day) || 0,
    String(exercise || ""),
    Number(setNumber) || 0,
    numberOrNull_(repMin),
    numberOrNull_(repMax),
    numberOrNull_(rir),
    prescribed != null ? String(prescribed) : "",
    pct === "" || pct == null || pct === undefined ? "" : numberOrNull_(pct)
  ]);
}

function getSettings_() {
  const ss = SpreadsheetApp.getActive();
  const sheet = ss.getSheetByName(SHEET_SETTINGS);
  if (!sheet) throw new Error("Лист Settings не найден.");

  const lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    throw new Error("Лист Settings пуст или содержит только заголовки.");
  }

  const range = sheet.getRange(1, 2, lastRow, 2).getValues();
  const map = {};
  range.forEach((row) => {
    const key = String(row[0] || "").trim();
    const value = row[1];
    if (key) {
      map[key] = value;
    }
  });

  const units = (map.UNITS || "kg").toLowerCase();
  const step =
    units === "lb"
      ? Number(map.STEP_LB) || 5
      : Number(map.STEP_KG) || 2.5;

  return {
    units,
    step,
    barWeight: Number(map.BAR_WEIGHT) || 20,
    archiveDays: Number(map.ARCHIVE_DAYS) || 60
  };
}

function getPlanRows_(week, day) {
  const ss = SpreadsheetApp.getActive();
  const sheet = ss.getSheetByName(SHEET_PLAN);
  if (!sheet) throw new Error("Лист Plan не найден.");

  const data = sheet.getDataRange().getValues();
  if (data.length <= 1) {
    return [];
  }

  const rows = [];

  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    if (!row || row.length < PLAN_HEADERS.length) continue;
    
    const rowWeek = Number(row[1]);
    const rowDay = Number(row[2]);
    if (isNaN(rowWeek) || isNaN(rowDay) || rowWeek !== week || rowDay !== day) continue;

    rows.push({
      exercise: String(row[3] || "").trim(),
      set: Number(row[4]) || 0,
      repMin: numberOrNull_(row[5]),
      repMax: numberOrNull_(row[6]),
      rirPlan: numberOrNull_(row[7]),
      prescribed: row[8] != null ? String(row[8]) : "",
      pct: row[9] !== "" && row[9] != null && row[9] !== undefined ? numberOrNull_(row[9]) : null
    });
  }

  return rows;
}

function getTMsMap_() {
  const ss = SpreadsheetApp.getActive();
  const sheet = ss.getSheetByName(SHEET_TMS);
  if (!sheet) throw new Error("Лист TMs не найден.");

  const data = sheet.getDataRange().getValues();
  if (data.length <= 1) {
    return {};
  }

  const map = {};
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    if (!row || row.length === 0) continue;
    
    const exercise = String(row[0] || "").trim();
    if (!exercise) continue;
    
    map[exercise] = {
      e1rm: numberOrNull_(row[1]),
      tm: numberOrNull_(row[2]),
      rowIndex: i + 1
    };
  }
  return map;
}

function upsertTMs_(sheet, prs, step) {
  if (!prs.length) return;

  const header = ["Exercise", "last e1RM", "TM (90%)", "Updated"];
  let current = sheet.getDataRange().getValues();

  if (!current.length || !current[0].some((cell) => String(cell).trim())) {
    sheet.clear();
    sheet.getRange(1, 1, 1, header.length).setValues([header]);
    current = sheet.getDataRange().getValues();
  }

  const indexMap = {};
  for (let i = 1; i < current.length; i++) {
    const row = current[i];
    if (!row || row.length === 0) continue;
    const name = String(row[0] || "").trim();
    if (name) indexMap[name] = i;
  }

  prs.forEach((entry) => {
    const exercise = String(entry.exercise || "").trim();
    if (!exercise) return;

    const tmValue = roundToStep_(entry.tm, step);
    const rowValues = [exercise, entry.e1rm, tmValue, new Date()];

    if (Object.prototype.hasOwnProperty.call(indexMap, exercise)) {
      const rowIndex = indexMap[exercise] + 1;
      sheet.getRange(rowIndex, 1, 1, rowValues.length).setValues([rowValues]);
    } else {
      sheet.appendRow(rowValues);
    }
  });
}

/* ------------------------- Helpers: Logic -------------------------------- */

function buildWarmup_(exercise, tm, recommended, settings) {
  const scheme = [
    { label: "Пустой гриф", pct: null, reps: "10/5", weight: settings.barWeight },
    { label: "Разминка", pct: 0.4, reps: 8 },
    { label: "Разминка", pct: 0.55, reps: 5 },
    { label: "Разминка", pct: 0.7, reps: 3 },
    { label: "Разминка", pct: 0.8, reps: "1–2" },
    { label: "Опц.", pct: 0.9, reps: 1 },
    { label: "Рабочий", pct: 1.0, reps: "см. план" }
  ];

  return scheme.map((step) => {
    let weight = step.weight || null;
    if (step.pct != null && tm != null) {
      weight = roundToStep_(tm * step.pct, settings.step);
    }
    if (step.label === "Рабочий" && recommended != null) {
      weight = recommended;
    }
    return {
      label: step.label,
      pct: step.pct,
      reps: step.reps,
      weight: weight != null ? weight : "..."
    };
  });
}

function buildDuplicateCache_(sheet, now) {
  const lastRow = sheet.getLastRow();
  if (lastRow <= 1) return {};

  const startRow = Math.max(2, lastRow - MAX_DUPLICATE_SCAN_ROWS + 1);
  const numRows = lastRow - startRow + 1;
  if (numRows <= 0) return {};

  const data = sheet.getRange(startRow, 1, numRows, LOG_COLUMNS.length).getValues();
  const cache = {};

  data.forEach((row) => {
    if (!row || row.length < LOG_COLUMNS.length) return;
    
    const timestamp = row[0];
    const exercise = String(row[3] || "").trim();
    const set = row[4];

    if (!(timestamp instanceof Date)) return;
    if (Math.abs(now.getTime() - timestamp.getTime()) > DUPLICATE_WINDOW_MS) return;
    if (!exercise || set == null) return;

    const key = `${exercise}__${set}`;
    cache[key] = true;
  });

  return cache;
}

function roundToStep_(value, step) {
  if (value == null || step == null || step <= 0) return null;
  if (!Number.isFinite(value) || !Number.isFinite(step)) return null;
  return Math.round(value / step) * step;
}

function numberOrNull_(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

/* ------------------------- HTML includes --------------------------------- */

// Для HtmlService (см. Sidebar.html) — include("SidebarStyles"), include("SidebarApp")

