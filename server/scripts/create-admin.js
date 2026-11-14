import 'dotenv/config'
import readline from 'node:readline'
import bcrypt from 'bcryptjs'
import { pool } from '../src/db.js'

const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
function ask(label) { return new Promise(resolve => rl.question(label, resolve)) }
function askHidden(label) {
  return new Promise(resolve => {
    const input = process.stdin; let value = ''
    process.stdout.write(label); input.setRawMode(true); input.resume(); input.setEncoding('utf8')
    const onData = character => {
      if (character === '\u0003') { input.setRawMode(false); process.exit(1) }
      if (character === '\r' || character === '\n') { input.setRawMode(false); input.pause(); input.removeListener('data', onData); process.stdout.write('\n'); resolve(value) }
      else if (character === '\u007f' || character === '\b') value = value.slice(0, -1)
      else if (character >= ' ') value += character
    }
    input.on('data', onData)
  })
}

try {
  if (!process.stdin.isTTY) throw new Error('Run this command in an interactive terminal so the password can be entered privately.')
  const displayName = (await ask('Admin display name: ')).trim()
  const email = (await ask('Admin email: ')).trim().toLowerCase()
  const password = await askHidden('Password (minimum 12 characters; input hidden): ')
  if (!displayName || displayName.length > 100 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254 || password.length < 12 || password.length > 128) throw new Error('Invalid input. Use a name (max 100 characters), valid email and a 12–128 character password.')
  const passwordHash = await bcrypt.hash(password, 12)
  const result = await pool.query("INSERT INTO profiles (email, display_name, password_hash, role) VALUES ($1, $2, $3, 'ADMIN') ON CONFLICT (email) DO NOTHING RETURNING id", [email, displayName, passwordHash])
  if (!result.rowCount) throw new Error('An account with this email already exists; no account was changed.')
  console.log(`Initial admin created for ${email}.`)
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
} finally { rl.close(); await pool.end() }
