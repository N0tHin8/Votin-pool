const { DatabaseSync } = require('node:sqlite');
const crypto = require('node:crypto');
const path = require('node:path');

const DB_PATH = path.join(__dirname, 'voting.db');
const db = new DatabaseSync(DB_PATH);

// Configure WAL mode & busy timeout for concurrent safety
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA synchronous = NORMAL;');
db.exec('PRAGMA foreign_keys = ON;');

// Initialize Tables
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    salt TEXT NOT NULL,
    hex_token TEXT UNIQUE NOT NULL,
    status TEXT NOT NULL DEFAULT 'REGISTERED', -- 'REGISTERED', 'ACTIVATED', 'VOTED'
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    activated_at DATETIME,
    voted_at DATETIME
  );

  CREATE TABLE IF NOT EXISTS candidates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    role_title TEXT NOT NULL,
    party TEXT,
    bio TEXT,
    color_hex TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS votes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    candidate_id INTEGER NOT NULL,
    cast_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(candidate_id) REFERENCES candidates(id)
  );

  CREATE TABLE IF NOT EXISTS admins (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    salt TEXT NOT NULL
  );
`);

// Password hashing helper using standard scrypt
function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const derivedKey = crypto.scryptSync(password, salt, 64);
  return { hash: derivedKey.toString('hex'), salt };
}

function verifyPassword(password, hash, salt) {
  const derivedKey = crypto.scryptSync(password, salt, 64);
  const keyBuffer = Buffer.from(derivedKey.toString('hex'), 'hex');
  const hashBuffer = Buffer.from(hash, 'hex');
  return crypto.timingSafeEqual(keyBuffer, hashBuffer);
}

// Generate secure 16-character hex token (64-bit entropy)
function generateHexToken() {
  return crypto.randomBytes(8).toString('hex').toUpperCase();
}

// Seed default candidates if empty
const candidateCount = db.prepare('SELECT COUNT(*) AS count FROM candidates').get().count;
if (candidateCount === 0) {
  const insertCandidate = db.prepare(`
    INSERT INTO candidates (name, role_title, party, bio, color_hex)
    VALUES (?, ?, ?, ?, ?)
  `);

  insertCandidate.run('Sarah Jenkins', 'Presidential Candidate', 'Innovation Alliance', 'Focusing on distributed digital governance and education.', '#3B82F6');
  insertCandidate.run('Marcus Vance', 'Presidential Candidate', 'Civic Forward', 'Advocating infrastructure modernization and economic equity.', '#10B981');
  insertCandidate.run('Elena Rostova', 'Presidential Candidate', 'Independent Technologists', 'Championing open protocols and green technology initiatives.', '#8B5CF6');
  insertCandidate.run('Devon Reed', 'Presidential Candidate', 'Public Horizon', 'Focused on healthcare modernization and regional transit.', '#F59E0B');
}

// Seed default admin (admin / admin123) if none exists
const adminCount = db.prepare('SELECT COUNT(*) AS count FROM admins').get().count;
if (adminCount === 0) {
  const { hash, salt } = hashPassword('admin123');
  db.prepare('INSERT INTO admins (username, password_hash, salt) VALUES (?, ?, ?)').run('admin', hash, salt);
}

module.exports = {
  db,
  hashPassword,
  verifyPassword,
  generateHexToken
};
