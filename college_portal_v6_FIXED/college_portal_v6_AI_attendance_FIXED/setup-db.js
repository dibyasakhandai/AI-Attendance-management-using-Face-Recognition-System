const mysql = require('mysql2/promise');
const fs = require('fs');
const path = require('path');

const config = {
  host: 'localhost',
  user: 'root',
  password: 'Lipsa@6292',
};

function parseSQL(sql) {
  // Split by semicolon, handling multi-line statements and comments
  const lines = sql.split('\n');
  const filtered = [];
  
  for (let line of lines) {
    // Remove -- comments
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

async function indexExists(conn, database, table, indexName) {
  const [rows] = await conn.query(
    `SELECT COUNT(*) AS cnt FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND INDEX_NAME = ?`,
    [database, table, indexName]
  );
  return rows[0].cnt > 0;
}

async function columnExists(conn, database, table, column) {
  const [rows] = await conn.query(
    `SELECT COUNT(*) AS cnt FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [database, table, column]
  );
  return rows[0].cnt > 0;
}

// Rewrites "ALTER TABLE t ADD COLUMN IF NOT EXISTS col ..."
// into only the clauses whose columns don't yet exist.
// Returns null if nothing needs adding.
async function buildSafeAlter(conn, database, statement) {
  const tableMatch = statement.match(/^ALTER\s+TABLE\s+(\w+)\s+(.+)$/is);
  if (!tableMatch) return statement;
  const tableName = tableMatch[1];
  const body = tableMatch[2];

  const clauses = body.split(/,\s*(?=ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s)/i);
  const toAdd = [];
  for (const clause of clauses) {
    const colMatch = clause.match(/ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+(\w+)\s+/i);
    if (colMatch) {
      const colName = colMatch[1];
      const exists = await columnExists(conn, database, tableName, colName);
      if (exists) {
        console.log(`  ⏭️  Column '${colName}' on '${tableName}' already exists, skipping.`);
      } else {
        toAdd.push(clause.replace(/ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+/i, 'ADD COLUMN '));
      }
    } else {
      toAdd.push(clause);
    }
  }
  if (toAdd.length === 0) return null;
  return `ALTER TABLE ${tableName} ${toAdd.join(', ')}`;
}

async function runSetup() {
  let connection;
  try {
    // Connect without database selection
    connection = await mysql.createConnection({
      host: config.host,
      user: config.user,
      password: config.password,
      multipleStatements: false
    });

    console.log('✅ Connected to MySQL');

    // Execute database.sql (includes CREATE DATABASE and USE statements)
    const dbScript = fs.readFileSync(path.join(__dirname, 'database.sql'), 'utf8');
    const dbStatements = parseSQL(dbScript);
    
    for (const statement of dbStatements) {
      if (!statement.trim()) continue;

      // Safely handle CREATE INDEX by checking information_schema first
      const idxMatch = statement.match(/^CREATE\s+INDEX\s+(\w+)\s+ON\s+(\w+)\s*\(/i);
      if (idxMatch) {
        const [, idxName, tableName] = idxMatch;
        const exists = await indexExists(connection, 'college_portal', tableName, idxName);
        if (exists) {
          console.log(`  ⏭️  Index '${idxName}' already exists, skipping.`);
          continue;
        }
      }

      try {
        await connection.query(statement);
      } catch (err) {
        console.error(`  Error in statement: ${statement.substring(0, 100)}...`);
        throw err;
      }
    }
    console.log('✅ Database created and schema setup complete');

    // Re-connect to college_portal database for seed data
    await connection.end();
    
    const dbConnection = await mysql.createConnection({
      host: config.host,
      user: config.user,
      password: config.password,
      database: 'college_portal',
      multipleStatements: false
    });

    // Run timetable_setup.sql FIRST — it creates faculty_map and other tables
    if (fs.existsSync(path.join(__dirname, 'timetable_setup.sql'))) {
      const timetableScript = fs.readFileSync(path.join(__dirname, 'timetable_setup.sql'), 'utf8');
      const timetableStatements = parseSQL(timetableScript);
      for (const statement of timetableStatements) {
        if (statement.trim() && !statement.match(/^USE\s+/i)) {
          try {
            await dbConnection.query(statement);
          } catch (err) {
            console.error(`  Error in timetable statement: ${statement.substring(0, 100)}...`);
            throw err;
          }
        }
      }
      console.log('✅ Timetable setup complete');
    }

    // Run attendance_setup.sql SECOND — creates subjects and attendance tables
    if (fs.existsSync(path.join(__dirname, 'attendance_setup.sql'))) {
      const attendanceScript = fs.readFileSync(path.join(__dirname, 'attendance_setup.sql'), 'utf8');
      const attendanceStatements = parseSQL(attendanceScript);
      for (let statement of attendanceStatements) {
        if (!statement.trim() || statement.match(/^USE\s+/i)) continue;

        if (statement.match(/^ALTER\s+TABLE/i) && statement.match(/IF\s+NOT\s+EXISTS/i)) {
          statement = await buildSafeAlter(dbConnection, 'college_portal', statement);
          if (!statement) continue;
        }

        try {
          await dbConnection.query(statement);
        } catch (err) {
          console.error(`  Error in attendance statement: ${statement.substring(0, 100)}...`);
          throw err;
        }
      }
      console.log('✅ Attendance setup complete');
    }

    // Run faculty_setup.sql THIRD — requires faculty_map to already exist
    if (fs.existsSync(path.join(__dirname, 'faculty_setup.sql'))) {
      const facultyScript = fs.readFileSync(path.join(__dirname, 'faculty_setup.sql'), 'utf8');
      const facultyStatements = parseSQL(facultyScript);
      for (let statement of facultyStatements) {
        if (!statement.trim() || statement.match(/^USE\s+/i)) continue;

        // Rewrite ALTER TABLE ... ADD COLUMN IF NOT EXISTS for old MySQL
        if (statement.match(/^ALTER\s+TABLE/i) && statement.match(/IF\s+NOT\s+EXISTS/i)) {
          statement = await buildSafeAlter(dbConnection, 'college_portal', statement);
          if (!statement) continue; // all columns already existed
        }

        try {
          await dbConnection.query(statement);
        } catch (err) {
          console.error(`  Error in faculty statement: ${statement.substring(0, 100)}...`);
          throw err;
        }
      }
      console.log('✅ Faculty setup complete');
    }

    // Run subjects_seed.sql FOURTH — requires subjects table to exist
    if (fs.existsSync(path.join(__dirname, 'subjects_seed.sql'))) {
      const subjectsScript = fs.readFileSync(path.join(__dirname, 'subjects_seed.sql'), 'utf8');
      const subjectsStatements = parseSQL(subjectsScript);
      for (const statement of subjectsStatements) {
        if (statement.trim() && !statement.match(/^USE\s+/i)) {
          try {
            await dbConnection.query(statement);
          } catch (err) {
            console.error(`  Error in subjects statement: ${statement.substring(0, 100)}...`);
            throw err;
          }
        }
      }
      console.log('✅ Subjects seed complete');
    }

    // Run ai_attendance_migration.sql LAST — requires all other tables
    if (fs.existsSync(path.join(__dirname, 'ai_attendance_migration.sql'))) {
      const aiScript = fs.readFileSync(path.join(__dirname, 'ai_attendance_migration.sql'), 'utf8');
      const aiStatements = parseSQL(aiScript);
      for (let statement of aiStatements) {
        if (!statement.trim() || statement.match(/^USE\s+/i)) continue;

        // Handle ALTER TABLE IF NOT EXISTS for old MySQL
        if (statement.match(/^ALTER\s+TABLE/i) && statement.match(/IF\s+NOT\s+EXISTS/i)) {
          statement = await buildSafeAlter(dbConnection, 'college_portal', statement);
          if (!statement) continue;
        }

        // Handle CREATE INDEX for old MySQL
        const idxMatch = statement.match(/^CREATE\s+INDEX\s+(\w+)\s+ON\s+(\w+)\s*\(/i);
        if (idxMatch) {
          const [, idxName, tableName] = idxMatch;
          const exists = await indexExists(dbConnection, 'college_portal', tableName, idxName);
          if (exists) {
            console.log(`  ⏭️  Index '${idxName}' already exists, skipping.`);
            continue;
          }
        }

        try {
          await dbConnection.query(statement);
        } catch (err) {
          console.error(`  Error in AI attendance statement: ${statement.substring(0, 100)}...`);
          throw err;
        }
      }
      console.log('✅ AI attendance migration complete');
    }

    await dbConnection.end();
    console.log('\n🎉 Database setup complete! You can now run: npm start\n');
  } catch (error) {
    console.error('❌ Error:', error.message);
    if (connection) await connection.end();
    process.exit(1);
  }
}

runSetup();