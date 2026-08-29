const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://smartclass_db_b8ch_user:Z6TpdL0pDKtywB3oHDzaJgFlZ3R1Mbaf@dpg-d9bcjkecjfls73ch3rm0-a.virginia-postgres.render.com/smartclass_db_b8ch',
  ssl: {
    rejectUnauthorized: false
  }
});

pool.on('connect', () => {
  console.log('📦 SmartClass connected to SMARTCLASS-DB');
});

pool.on('error', (err) => {
  console.error('❌ Database pool error:', err);
});

module.exports = pool;