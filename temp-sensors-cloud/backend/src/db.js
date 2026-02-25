'use strict';

const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

pool.on('error', (err) => {
  console.error('PostgreSQL pool error:', err.message);
});

/**
 * Run a parameterised query and return the result.
 * Acquires a client from the pool and releases it when done.
 */
async function query(text, params) {
  const client = await pool.connect();
  try {
    return await client.query(text, params);
  } finally {
    client.release();
  }
}

module.exports = { query, pool };
