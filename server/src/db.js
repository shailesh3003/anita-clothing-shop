import dotenv from 'dotenv'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

const { Pool } = pg
dotenv.config({ path: fileURLToPath(new URL('../../.env', import.meta.url)) })
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required')

export const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: true } : undefined, max: 10, idleTimeoutMillis: 30_000 })
pool.on('error', error => console.error('Unexpected PostgreSQL pool error', error))
