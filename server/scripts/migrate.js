import 'dotenv/config'
import { readdir, readFile } from 'node:fs/promises'
import { pool } from '../src/db.js'

const client = await pool.connect()
let migrationLock = false
try {
  await client.query('CREATE EXTENSION IF NOT EXISTS pgcrypto')
  await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())')
  await client.query("SELECT pg_advisory_lock(hashtext('anita-clothing-shop-migrations'))")
  migrationLock = true
  const migrationsPath = new URL('../migrations/', import.meta.url)
  const migrations = (await readdir(migrationsPath)).filter(name => /^\d+_[a-z0-9_]+\.sql$/.test(name)).sort()
  for (const migration of migrations) {
    const existing = await client.query('SELECT 1 FROM schema_migrations WHERE name = $1', [migration])
    if (existing.rowCount) {
      console.log(`${migration} is already applied`)
      continue
    }
    const sql = await readFile(new URL(migration, migrationsPath), 'utf8')
    try {
      await client.query(sql)
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [migration])
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})
      throw error
    }
    console.log(`Applied ${migration}`)
  }
} finally {
  if (migrationLock) await client.query("SELECT pg_advisory_unlock(hashtext('anita-clothing-shop-migrations'))").catch(() => {})
  client.release()
  await pool.end()
}
