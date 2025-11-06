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
async function setSchemaVersion(version, description) {
  try {
    await execute(
      'INSERT INTO schema_version (version, description) VALUES (?, ?)',
      [version, description]
    );
  } catch (error) {
    console.error('Failed to update schema version:', error);
  }
}

// Миграции
async function runMigrations() {
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
    // Запускаем миграции для существующей БД
    await runMigrations();
  } else {
    db = new SQL.Database();
    await createSchema();
    // Устанавливаем текущую версию для новой БД
    await setSchemaVersion(CURRENT_SCHEMA_VERSION, 'Новая БД');
  }
  
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
    if (params.length > 0) {
      db.run(sql, params);
    } else {
      db.run(sql);
    }
    await saveDatabase();
    return true;
  } catch (error) {
    // Улучшенная обработка ошибок
    const errorMsg = error.message || String(error);
    
    // Игнорируем некоторые известные ошибки
    if (errorMsg.includes('UNIQUE constraint') ||
        errorMsg.includes('already exists') ||
        errorMsg.includes('duplicate')) {
      // Это нормально для некоторых операций
      return true;
    }
    
    console.error('Execute failed:', sql);
    console.error('Params:', params);
    console.error('Error:', errorMsg);
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
  
  const data = db.export();
  const base64 = btoa(String.fromCharCode(...new Uint8Array(data)));
  const jsonString = JSON.stringify({ 
    version: 2, 
    data: base64, 
    timestamp: new Date().toISOString(),
    compressed: false 
  });
  
  // Пытаемся сжать
  try {
    const compressed = await compressData(jsonString);
    const compressedBase64 = btoa(String.fromCharCode(...compressed));
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
  
  // Очищаем таблицу перед загрузкой (только для plan)
  if (tableName === 'plan') {
    try {
      await execute('DELETE FROM plan');
    } catch (e) {
      console.warn('Failed to clear plan table:', e);
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
      const placeholders = headers.map(() => '?').join(', ');
      const columns = headers.join(', ');
      const sql = `INSERT INTO ${tableName} (${columns}) VALUES (${placeholders})`;
      
      try {
        await execute(sql, values);
        successCount++;
      } catch (e) {
        errorCount++;
        // Игнорируем дубликаты и другие известные ошибки
        if (!e.message.includes('UNIQUE constraint') && 
            !e.message.includes('already exists') &&
            !e.message.includes('duplicate')) {
          console.warn(`Failed to insert row ${i}:`, e.message);
          console.warn('SQL:', sql);
          console.warn('Values:', values);
        }
      }
    } else {
      errorCount++;
      console.warn(`Row ${i} has ${values.length} values but expected ${headers.length}`);
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

