// === MESO Database Module (SQL.js + IndexedDB) ===

let SQL = null;
let db = null;
const IDB_NAME = 'meso_db';
const IDB_VERSION = 1;
const IDB_STORE = 'database';

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

// Инициализация SQL.js
async function initSQL() {
  if (SQL) return SQL;
  
  try {
    updateProgress(10, 'Загрузка SQL.js (~2 МБ)...');
    
    // initSqlJs должен быть доступен через window (устанавливается в index.html)
    const initFn = window.initSqlJs;
    
    if (typeof initFn === 'undefined') {
      // Если все еще не загружен, ждем
      await new Promise((resolve, reject) => {
        let attempts = 0;
        const maxAttempts = 200; // 10 секунд максимум
        const check = setInterval(() => {
          attempts++;
          const fn = window.initSqlJs;
          const progress = Math.min(30, 10 + (attempts / maxAttempts) * 20);
          updateProgress(progress, 'Загрузка SQL.js...');
          
          if (typeof fn !== 'undefined') {
            clearInterval(check);
            resolve();
          } else if (attempts >= maxAttempts) {
            clearInterval(check);
            reject(new Error('SQL.js не загрузился. Проверьте интернет соединение.'));
          }
        }, 50);
      });
    }
    
    updateProgress(40, 'Инициализация SQL.js...');
    
    SQL = await window.initSqlJs({
      locateFile: file => `https://cdn.jsdelivr.net/npm/sql.js@1.10.3/dist/${file}`
    });
    
    updateProgress(50, 'SQL.js загружен');
    
    return SQL;
  } catch (error) {
    console.error('Failed to load SQL.js:', error);
    updateProgress(0, 'Ошибка загрузки SQL.js');
    throw error;
  }
}

// Открытие IndexedDB
function openIDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(IDB_NAME, IDB_VERSION);
    
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
    
    request.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) {
        db.createObjectStore(IDB_STORE);
      }
    };
  });
}

// Сохранение БД в IndexedDB
async function saveDatabase() {
  if (!db) return;
  
  try {
    const data = db.export();
    const idb = await openIDB();
    const tx = idb.transaction(IDB_STORE, 'readwrite');
    await tx.objectStore(IDB_STORE).put(data, 'main');
    await tx.complete;
  } catch (error) {
    console.error('Failed to save database:', error);
  }
}

// Загрузка БД из IndexedDB
async function loadDatabase() {
  try {
    const idb = await openIDB();
    const tx = idb.transaction(IDB_STORE, 'readonly');
    const data = await tx.objectStore(IDB_STORE).get('main');
    return data;
  } catch (error) {
    console.error('Failed to load database:', error);
    return null;
  }
}

// Текущая версия схемы
const CURRENT_SCHEMA_VERSION = 2;

// Получение версии схемы
async function getSchemaVersion() {
  try {
    const result = await query('SELECT MAX(version) as version FROM schema_version');
    return result[0]?.version || 0;
  } catch (error) {
    return 0;
  }
}

// Обновление версии схемы
// Если таблица не существует, создаем её перед вставкой
async function setSchemaVersion(version, description) {
  try {
    // Всегда пытаемся создать таблицу (IF NOT EXISTS безопасно)
    // Используем db.exec() для гарантии создания
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS schema_version (
          version INTEGER PRIMARY KEY,
          applied_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          description TEXT
        )
      `);
    } catch (e) {
      // Игнорируем ошибки создания (таблица может уже существовать)
    }
    
    // Небольшая задержка для гарантии создания
    await new Promise(resolve => setTimeout(resolve, 50));
    
    // Теперь пытаемся вставить или обновить версию
    try {
      const existing = await query('SELECT version FROM schema_version WHERE version = ?', [version]);
      
      if (!existing || existing.length === 0) {
        // Вставляем новую версию
        await execute(
          'INSERT INTO schema_version (version, description) VALUES (?, ?)',
          [version, description]
        );
      } else {
        // Версия уже существует, обновляем описание
        await execute(
          'UPDATE schema_version SET description = ?, applied_at = CURRENT_TIMESTAMP WHERE version = ?',
          [description, version]
        );
      }
    } catch (error) {
      // Если запрос не удался, возможно таблица все еще не создана
      // Пытаемся создать таблицу еще раз и повторить запрос
      try {
        db.exec(`
          CREATE TABLE IF NOT EXISTS schema_version (
            version INTEGER PRIMARY KEY,
            applied_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            description TEXT
          )
        `);
        await new Promise(resolve => setTimeout(resolve, 50));
        
        // Повторяем запрос
        const existing = await query('SELECT version FROM schema_version WHERE version = ?', [version]);
        if (!existing || existing.length === 0) {
          await execute(
            'INSERT INTO schema_version (version, description) VALUES (?, ?)',
            [version, description]
          );
        } else {
          await execute(
            'UPDATE schema_version SET description = ?, applied_at = CURRENT_TIMESTAMP WHERE version = ?',
            [description, version]
          );
        }
      } catch (e2) {
        // Тихая обработка ошибки - это нормально во время инициализации
      }
    }
  } catch (error) {
    // Тихая обработка ошибки - это нормально во время инициализации
  }
}

// Миграции
// Предполагается, что createSchema() уже вызвана и таблица schema_version существует
async function runMigrations() {
  try {
    // Убеждаемся, что таблица schema_version существует перед запросом версии
    // Если таблицы нет, создаем её явно
    try {
      const check = db.exec(`SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'`);
      if (!check || check.length === 0 || !check[0] || !check[0].values || check[0].values.length === 0) {
        console.warn('schema_version table not found in runMigrations, creating it...');
        db.run(`
          CREATE TABLE IF NOT EXISTS schema_version (
            version INTEGER PRIMARY KEY,
            applied_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            description TEXT
          )
        `);
        // Небольшая задержка для гарантии создания
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    } catch (e) {
      // Если проверка не удалась, пытаемся создать таблицу
      console.warn('Could not check schema_version table, creating it...');
      try {
        db.run(`
          CREATE TABLE IF NOT EXISTS schema_version (
            version INTEGER PRIMARY KEY,
            applied_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            description TEXT
          )
        `);
        await new Promise(resolve => setTimeout(resolve, 50));
      } catch (e2) {
        // Игнорируем ошибки создания
      }
    }
    
    // Получаем текущую версию схемы
    // Таблица schema_version должна уже существовать (создана через createSchema())
    const currentVersion = await getSchemaVersion();
    
    if (currentVersion < CURRENT_SCHEMA_VERSION) {
      console.log(`Running migrations from version ${currentVersion} to ${CURRENT_SCHEMA_VERSION}`);
      updateProgress(75, 'Обновление схемы БД...');
      
      // Миграция с версии 0 на 1 (начальная схема)
      if (currentVersion < 1) {
        await setSchemaVersion(1, 'Начальная схема БД');
      }
      
      // Миграция с версии 1 на 2 (добавление таблицы schema_version)
      if (currentVersion < 2) {
        // Таблица уже создана в schema.sql
        await setSchemaVersion(2, 'Добавлено версионирование схемы');
      }
      
      await saveDatabase();
    }
  } catch (error) {
    // Если версия не найдена (новая БД), устанавливаем текущую версию
    // Таблица schema_version должна уже существовать (создана через createSchema())
    console.log('Setting initial schema version...');
    try {
      await setSchemaVersion(CURRENT_SCHEMA_VERSION, 'Начальная версия схемы');
      await saveDatabase();
    } catch (e) {
      console.warn('Could not set schema version:', e.message);
    }
  }
}

// Инициализация БД
async function initDatabase() {
  await initSQL();
  
  updateProgress(60, 'Загрузка базы данных...');
  
  // Загружаем сохраненную БД или создаем новую
  const savedData = await loadDatabase();
  
  updateProgress(70, 'Инициализация таблиц...');
  
  if (savedData) {
    db = new SQL.Database(savedData);
    
    // Проверяем, что схема существует (с обработкой ошибок)
    let schemaExists = false;
    let viewsExist = false;
    
    try {
      const schemaVersionCheck = await query(`SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'`);
      schemaExists = schemaVersionCheck && schemaVersionCheck.length > 0;
    } catch (e) {
      // Игнорируем ошибки проверки
    }
    
    try {
      const viewCheck = await query(`SELECT name FROM sqlite_master WHERE type='view' AND name='v_last_sets'`);
      viewsExist = viewCheck && viewCheck.length > 0;
    } catch (e) {
      // Игнорируем ошибки проверки
    }
    
    if (!schemaExists || !viewsExist) {
      console.log('Schema or views not found in existing DB, recreating...');
      await createSchema();
    }
  } else {
    db = new SQL.Database();
    await createSchema();
  }
  
  // Задержка для гарантии, что схема создана
  await new Promise(resolve => setTimeout(resolve, 100));
  
  // Запускаем миграции после создания схемы (для всех случаев)
  await runMigrations();
  
  updateProgress(90, 'База данных готова');
  
  return db;
}

// Создание схемы из schema.sql
async function createSchema() {
  if (!db) throw new Error('Database not initialized');
  
  try {
    const response = await fetch('./schema.sql');
    if (!response.ok) {
      throw new Error(`Failed to fetch schema.sql: ${response.status} ${response.statusText}`);
    }
    const schema = await response.text();
    
    if (!schema || schema.trim().length === 0) {
      throw new Error('schema.sql is empty');
    }
    
    // Выполняем SQL команды (разделяем по ;)
    const statements = schema
      .split(';')
      .map(s => s.trim())
      .filter(s => s && !s.startsWith('--') && s.length > 0);
    
    if (statements.length === 0) {
      throw new Error('No valid SQL statements found in schema.sql');
    }
    
    for (const statement of statements) {
      if (statement) {
        try {
          db.run(statement);
        } catch (e) {
          // Игнорируем ошибки "already exists" для CREATE TABLE IF NOT EXISTS
          if (!e.message.includes('already exists') && !e.message.includes('duplicate column name')) {
            console.warn('SQL statement failed:', statement, e);
          }
        }
      }
    }
    
    // Проверяем, что таблица schema_version создана (используем прямой вызов db, чтобы избежать рекурсии)
    // Создаем таблицу явно, если она не существует
    try {
      db.run(`
        CREATE TABLE IF NOT EXISTS schema_version (
          version INTEGER PRIMARY KEY,
          applied_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          description TEXT
        )
      `);
    } catch (e) {
      // Игнорируем ошибки создания (таблица может уже существовать)
      if (!e.message.includes('already exists')) {
        console.warn('Could not create schema_version table:', e.message);
      }
    }
    
    await saveDatabase();
  } catch (error) {
    console.error('Failed to create schema:', error);
    throw new Error(`Не удалось загрузить схему БД: ${error.message}`);
  }
}

// SQL запросы
async function query(sql, params = []) {
  if (!db) await initDatabase();
  
  try {
    const stmt = db.prepare(sql);
    if (params.length > 0) {
      stmt.bind(params);
    }
    
    const result = [];
    while (stmt.step()) {
      result.push(stmt.getAsObject());
    }
    stmt.free();
    
    return result;
  } catch (error) {
    // Тихая обработка ошибок для системных запросов во время инициализации
    if (sql.includes('schema_version') || sql.includes('v_last_sets') || sql.includes('sqlite_master')) {
      // Для системных запросов возвращаем пустой результат
      if (sql.trim().toUpperCase().startsWith('SELECT')) {
        return [];
      }
      throw error;
    }
    console.error('Query failed:', sql, error);
    // Возвращаем пустой массив вместо ошибки для некоторых запросов
    if (sql.trim().toUpperCase().startsWith('SELECT')) {
      return [];
    }
    throw error;
  }
}

// Выполнение SQL (INSERT, UPDATE, DELETE)
async function execute(sql, params = []) {
  if (!db) await initDatabase();
  
  try {
    // SQL.js использует другой синтаксис для prepared statements
    if (params.length > 0) {
      const stmt = db.prepare(sql);
      try {
        stmt.bind(params);
        stmt.step();
        stmt.free();
      } catch (bindError) {
        stmt.free();
        throw bindError;
      }
    } else {
      db.run(sql);
    }
    await saveDatabase();
    return true;
  } catch (error) {
    // Улучшенная обработка ошибок
    const errorMsg = error.message || String(error);
    const errorStr = String(error);
    
    // Тихая обработка ошибок для системных операций (schema_version)
    if (sql.includes('schema_version') && errorMsg.includes('no such table')) {
      // Это нормально во время инициализации - таблица еще не создана
      return true;
    }
    
    // Игнорируем некоторые известные ошибки
    if (errorMsg.includes('UNIQUE constraint') ||
        errorMsg.includes('already exists') ||
        errorMsg.includes('duplicate') ||
        errorStr.includes('UNIQUE constraint') ||
        errorStr.includes('already exists') ||
        errorStr.includes('duplicate')) {
      // Это нормально для некоторых операций
      return true;
    }
    
    console.error('Execute failed:', sql);
    console.error('Params:', params);
    console.error('Error message:', errorMsg);
    console.error('Error string:', errorStr);
    console.error('Full error:', error);
    throw error;
  }
}

// Получить одну запись
async function getOne(sql, params = []) {
  const results = await query(sql, params);
  return results.length > 0 ? results[0] : null;
}

// Компрессия данных (gzip)
async function compressData(data) {
  try {
    // Используем CompressionStream API (современные браузеры)
    if ('CompressionStream' in window) {
      const stream = new Blob([data]).stream();
      const compressedStream = stream.pipeThrough(new CompressionStream('gzip'));
      const compressedBlob = await new Response(compressedStream).blob();
      const arrayBuffer = await compressedBlob.arrayBuffer();
      return new Uint8Array(arrayBuffer);
    } else {
      // Fallback: без компрессии
      return new TextEncoder().encode(data);
    }
  } catch (error) {
    console.warn('Compression failed, using uncompressed data:', error);
    return new TextEncoder().encode(data);
  }
}

// Декомпрессия данных
async function decompressData(compressedData) {
  try {
    if ('DecompressionStream' in window) {
      const stream = new Blob([compressedData]).stream();
      const decompressedStream = stream.pipeThrough(new DecompressionStream('gzip'));
      const decompressedBlob = await new Response(decompressedStream).blob();
      return await decompressedBlob.text();
    } else {
      // Fallback: данные не сжаты
      return new TextDecoder().decode(compressedData);
    }
  } catch (error) {
    console.warn('Decompression failed, trying as plain text:', error);
    return new TextDecoder().decode(compressedData);
  }
}

// Экспорт БД в JSON
async function exportDatabase() {
  if (!db) await initDatabase();
  
  // 1) Сырые байты SQLite
  const bytes = db.export(); // Uint8Array
  
  // 2) В base64 без ошибок (избегаем spread оператора для больших массивов)
  let bin = '';
  for (let i = 0; i < bytes.length; i++) {
    bin += String.fromCharCode(bytes[i]);
  }
  const base64 = btoa(bin);
  
  // 3) Несжатый JSON
  const jsonString = JSON.stringify({
    version: 2,
    data: base64,
    timestamp: new Date().toISOString(),
    compressed: false
  });
  
  // 4) Попробовать gzip (CompressionStream с фолбэком уже есть)
  try {
    const compressed = await compressData(jsonString); // Uint8Array
    let cbin = '';
    for (let i = 0; i < compressed.length; i++) {
      cbin += String.fromCharCode(compressed[i]);
    }
    const compressedBase64 = btoa(cbin);
    
    const originalSize = new Blob([jsonString]).size;
    const compressedSize = compressed.length;
    
    console.log(`Export: Original ${originalSize} bytes, Compressed ${compressedSize} bytes (${Math.round(compressedSize/originalSize*100)}%)`);
    
    return JSON.stringify({
      version: 2,
      data: compressedBase64,
      timestamp: new Date().toISOString(),
      compressed: true,
      originalSize,
      compressedSize
    });
  } catch (error) {
    console.warn('Compression failed, exporting uncompressed:', error);
    return jsonString;
  }
}

// Импорт БД из JSON
async function importDatabase(jsonData) {
  try {
    let parsed = typeof jsonData === 'string' ? JSON.parse(jsonData) : jsonData;
    
    // Проверяем, сжаты ли данные
    if (parsed.compressed) {
      console.log('Decompressing import data...');
      const compressedBinary = atob(parsed.data);
      const compressedBytes = new Uint8Array(compressedBinary.length);
      for (let i = 0; i < compressedBinary.length; i++) {
        compressedBytes[i] = compressedBinary.charCodeAt(i);
      }
      
      const decompressed = await decompressData(compressedBytes);
      parsed = JSON.parse(decompressed);
    }
    
    const binaryString = atob(parsed.data);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    
    if (!SQL) await initSQL();
    db = new SQL.Database(bytes);
    await saveDatabase();
    return true;
  } catch (error) {
    console.error('Failed to import database:', error);
    throw error;
  }
}

// Загрузка CSV в таблицу
async function loadCSVIntoTable(tableName, csvText) {
  if (!db) await initDatabase();
  
  // Проверяем, что таблица существует, если нет - создаем схему
  try {
    const tableCheck = await query(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`, [tableName]);
    if (!tableCheck || tableCheck.length === 0) {
      console.warn(`Table ${tableName} does not exist, creating schema...`);
      // Создаем схему, если таблицы нет
      await createSchema();
      // Проверяем снова
      const tableCheck2 = await query(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`, [tableName]);
      if (!tableCheck2 || tableCheck2.length === 0) {
        throw new Error(`Table ${tableName} could not be created. Please check schema.sql.`);
      }
      console.log(`Table ${tableName} created successfully`);
    } else {
      console.log(`Table ${tableName} exists, proceeding with CSV import...`);
    }
  } catch (e) {
    console.error(`Table ${tableName} check/creation failed:`, e);
    throw e;
  }
  
  // Очищаем таблицу перед загрузкой (только для plan)
  if (tableName === 'plan') {
    try {
      await execute('DELETE FROM plan');
      console.log('Plan table cleared');
    } catch (e) {
      console.warn('Failed to clear plan table (may be empty):', e.message);
      // Не критично, продолжаем
    }
  }
  
  // Парсим CSV с учетом кавычек
  const lines = [];
  let currentLine = '';
  let inQuotes = false;
  
  for (let i = 0; i < csvText.length; i++) {
    const char = csvText[i];
    if (char === '"') {
      inQuotes = !inQuotes;
      currentLine += char;
    } else if (char === '\n' && !inQuotes) {
      if (currentLine.trim()) {
        lines.push(currentLine);
        currentLine = '';
      }
    } else {
      currentLine += char;
    }
  }
  if (currentLine.trim()) {
    lines.push(currentLine);
  }
  
  if (lines.length < 2) {
    console.warn('CSV file has less than 2 lines');
    return;
  }
  
  // Парсим заголовки
  const headers = lines[0].split(',').map(h => {
    h = h.trim();
    if (h.startsWith('"') && h.endsWith('"')) {
      h = h.slice(1, -1);
    }
    return h;
  });
  
  let successCount = 0;
  let errorCount = 0;
  
  // Парсим данные
  for (let i = 1; i < lines.length; i++) {
    const values = [];
    let currentValue = '';
    let inQuotes = false;
    
    for (let j = 0; j < lines[i].length; j++) {
      const char = lines[i][j];
      if (char === '"') {
        inQuotes = !inQuotes;
      } else if (char === ',' && !inQuotes) {
        let val = currentValue.trim();
        if (val.startsWith('"') && val.endsWith('"')) {
          val = val.slice(1, -1);
        }
        values.push(val === '' ? null : val);
        currentValue = '';
      } else {
        currentValue += char;
      }
    }
    
    // Последнее значение
    let val = currentValue.trim();
    if (val.startsWith('"') && val.endsWith('"')) {
      val = val.slice(1, -1);
    }
    values.push(val === '' ? null : val);
    
    if (values.length === headers.length) {
      // Исключаем колонку id из INSERT (она autoincrement)
      const columnsToInsert = [];
      const valuesToInsert = [];
      
      for (let j = 0; j < headers.length; j++) {
        if (headers[j] !== 'id') {
          columnsToInsert.push(headers[j]);
          valuesToInsert.push(values[j]);
        }
      }
      
      const placeholders = columnsToInsert.map(() => '?').join(', ');
      const columns = columnsToInsert.join(', ');
      const sql = `INSERT INTO ${tableName} (${columns}) VALUES (${placeholders})`;
      
      try {
        await execute(sql, valuesToInsert);
        successCount++;
      } catch (e) {
        errorCount++;
        const errorMsg = e.message || String(e);
        
        // Игнорируем дубликаты и другие известные ошибки
        if (!errorMsg.includes('UNIQUE constraint') && 
            !errorMsg.includes('already exists') &&
            !errorMsg.includes('duplicate') &&
            !errorMsg.includes('constraint')) {
          console.error(`Failed to insert row ${i + 1}:`, errorMsg);
          console.error('SQL:', sql);
          console.error('Values:', valuesToInsert);
          console.error('Headers:', headers);
          console.error('Full error:', e);
        } else {
          // Это нормально для некоторых операций
          console.log(`Row ${i + 1} skipped (duplicate or constraint):`, errorMsg);
        }
      }
    } else {
      errorCount++;
      console.error(`Row ${i + 1} has ${values.length} values but expected ${headers.length} headers`);
      console.error('Headers:', headers);
      console.error('Values:', values);
    }
  }
  
  console.log(`CSV import: ${successCount} rows inserted, ${errorCount} errors`);
}

// Экспорт
export {
  initDatabase,
  query,
  execute,
  getOne,
  exportDatabase,
  importDatabase,
  loadCSVIntoTable,
  saveDatabase,
  db
};

