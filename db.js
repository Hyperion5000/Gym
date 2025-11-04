// === MESO Database Module (SQL.js + IndexedDB) ===

let SQL = null;
let db = null;
const IDB_NAME = 'meso_db';
const IDB_VERSION = 1;
const IDB_STORE = 'database';

// Инициализация SQL.js
async function initSQL() {
  if (SQL) return SQL;
  
  try {
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
    
    SQL = await window.initSqlJs({
      locateFile: file => `https://cdn.jsdelivr.net/npm/sql.js@1.10.3/dist/${file}`
    });
    return SQL;
  } catch (error) {
    console.error('Failed to load SQL.js:', error);
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

// Инициализация БД
async function initDatabase() {
  await initSQL();
  
  // Загружаем сохраненную БД или создаем новую
  const savedData = await loadDatabase();
  
  if (savedData) {
    db = new SQL.Database(savedData);
  } else {
    db = new SQL.Database();
    await createSchema();
  }
  
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
    console.error('Execute failed:', sql, error);
    throw error;
  }
}

// Получить одну запись
async function getOne(sql, params = []) {
  const results = await query(sql, params);
  return results.length > 0 ? results[0] : null;
}

// Экспорт БД в JSON
async function exportDatabase() {
  if (!db) await initDatabase();
  
  const data = db.export();
  const base64 = btoa(String.fromCharCode(...new Uint8Array(data)));
  return JSON.stringify({ version: 1, data: base64, timestamp: new Date().toISOString() });
}

// Импорт БД из JSON
async function importDatabase(jsonData) {
  try {
    const parsed = typeof jsonData === 'string' ? JSON.parse(jsonData) : jsonData;
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
  
  if (lines.length < 2) return;
  
  // Парсим заголовки
  const headers = lines[0].split(',').map(h => {
    h = h.trim();
    if (h.startsWith('"') && h.endsWith('"')) {
      h = h.slice(1, -1);
    }
    return h;
  });
  
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
      } catch (e) {
        // Игнорируем дубликаты
        if (!e.message.includes('UNIQUE constraint')) {
          console.warn('Failed to insert row:', e);
        }
      }
    }
  }
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

