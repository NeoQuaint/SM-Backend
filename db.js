const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://ujconnect_user:bl7B4X24gNX1H6Lkwv3ZmVbG58Nla3cM@dpg-d85456jtqb8s73efogs0-a.virginia-postgres.render.com/ujconnect',
  ssl: {
    rejectUnauthorized: false
  }
});

pool.on('connect', () => {
  console.log('📦 SmartClass connected to UJconnect database');
});

pool.on('error', (err) => {
  console.error('❌ Database pool error:', err);
});

module.exports = pool;