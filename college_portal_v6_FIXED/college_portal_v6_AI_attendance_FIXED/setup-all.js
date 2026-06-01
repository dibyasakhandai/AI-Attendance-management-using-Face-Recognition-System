const mysql = require('mysql2/promise');
const fs = require('fs');
const path = require('path');

const config = {
  host: 'localhost',
  user: 'root',
  password: 'Lipsa@6292',
};

function parseSQL(sql) {
  const lines = sql.split('\n');
  const filtered = [];
  
  for (let line of lines) {
    const commentIdx = line.indexOf('--');
    if (commentIdx >= 0) line = line.substring(0, commentIdx);
    if (line.trim()) filtered.push(line);
  }
  
  const text = filtered.join('\n');
  const statements = [];
  let current = '';
  
  for (const char of text) {
    current += char;
    if (char === ';') {
      const stmt = current.slice(0, -1).trim();
      if (stmt) statements.push(stmt);
      current = '';
    }
  }
  
  return statements.filter(s => s.trim());
}

async function runSetupFile(filePath) {
  let conn;
  try {
    conn = await mysql.createConnection(config);
    
    const filename = path.basename(filePath);
    console.log(`\n📄 Running: ${filename}`);
    console.log('─'.repeat(50));
    
    const sql = fs.readFileSync(filePath, 'utf8');
    const statements = parseSQL(sql);
    
    for (const stmt of statements) {
      try {
        await conn.query(stmt);
        console.log(`✅ ${stmt.substring(0, 60)}...`);
      } catch (error) {
        if (error.code !== 'ER_DUP_ENTRY' && !error.message.includes('already exists')) {
          console.error(`❌ Error: ${error.message}`);
        } else {
          console.log(`⏭️  Skipped (already exists): ${stmt.substring(0, 50)}...`);
        }
      }
    }
    
    console.log(`✨ ${filename} completed!`);
    
  } catch (error) {
    console.error(`❌ Error running ${filePath}:`, error.message);
    process.exit(1);
  } finally {
    if (conn) await conn.end();
  }
}

async function main() {
  const files = [
    'database.sql',
    'faculty_setup.sql',
    'timetable_setup.sql',
    'subjects_seed.sql'
  ];
  
  console.log('🔄 Starting database setup...\n');
  
  for (const file of files) {
    const filePath = path.join(__dirname, file);
    if (fs.existsSync(filePath)) {
      await runSetupFile(filePath);
    } else {
      console.log(`⚠️  File not found: ${file}`);
    }
  }
  
  console.log('\n✨ All setup files completed!');
}

main();
