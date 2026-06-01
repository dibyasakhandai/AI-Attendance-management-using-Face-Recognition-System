const mysql = require('mysql2/promise');

const config = {
  host: 'localhost',
  user: 'root',
  password: 'Lipsa@6292',
};

async function clearDatabase() {
  let conn;
  try {
    conn = await mysql.createConnection(config);
    
    console.log('🔄 Connecting to database...');
    await conn.query('USE college_portal');
    
    console.log('🗑️  Clearing tables...');
    
    // Disable foreign key checks temporarily
    await conn.query('SET FOREIGN_KEY_CHECKS=0');
    
    // Truncate tables (faster than DELETE and resets auto-increment)
    await conn.query('TRUNCATE TABLE photos');
    console.log('✅ Cleared: photos');
    
    await conn.query('TRUNCATE TABLE students');
    console.log('✅ Cleared: students');
    
    await conn.query('TRUNCATE TABLE users');
    console.log('✅ Cleared: users');
    
    // Re-enable foreign key checks
    await conn.query('SET FOREIGN_KEY_CHECKS=1');
    
    console.log('\n✨ Database cleared successfully!');
    
  } catch (error) {
    console.error('❌ Error clearing database:', error.message);
    process.exit(1);
  } finally {
    if (conn) await conn.end();
  }
}

clearDatabase();
