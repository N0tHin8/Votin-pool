const express = require('express');
const http = require('node:http');
const path = require('node:path');
const session = require('express-session');
const { Server } = require('socket.io');
const os = require('node:os');
const { db, hashPassword, verifyPassword, generateHexToken } = require('./db');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

const PORT = process.env.PORT || 3000;

// Middleware configuration
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Anti-caching headers middleware to prevent back-button navigation caching
app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('Surrogate-Control', 'no-store');
  next();
});

// Session store configuration
const sessionMiddleware = session({
  secret: 'lan-voting-master-entropy-key-2026',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 24 * 60 * 60 * 1000 // 24 hours
  }
});
app.use(sessionMiddleware);

// Serve static assets from public directory
app.use(express.static(path.join(__dirname, 'public'), {
  etag: false,
  lastModified: false,
  setHeaders: (res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  }
}));

// Route Guards
function requireVoterAuth(req, res, next) {
  if (!req.session || !req.session.userId) {
    return res.redirect('/login');
  }
  next();
}

function requireAdminAuth(req, res, next) {
  if (!req.session || !req.session.adminId) {
    return res.redirect('/admin/login');
  }
  next();
}

// --------------------------------------------------------------------------
// HTML Page Routes
// --------------------------------------------------------------------------
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/register', (req, res) => res.sendFile(path.join(__dirname, 'public', 'register.html')));
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/voted-already', (req, res) => res.sendFile(path.join(__dirname, 'public', 'voted-already.html')));
app.get('/pending-activation', (req, res) => res.sendFile(path.join(__dirname, 'public', 'pending-activation.html')));
app.get('/admin/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin-login.html')));
app.get('/admin', requireAdminAuth, (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/projector', (req, res) => res.sendFile(path.join(__dirname, 'public', 'projector.html')));

app.get('/vote', requireVoterAuth, (req, res) => {
  // Query fresh DB state on every request
  const user = db.prepare('SELECT status FROM users WHERE id = ?').get(req.session.userId);
  if (!user) {
    req.session.destroy();
    return res.redirect('/login');
  }

  if (user.status === 'VOTED') {
    return res.redirect('/voted-already');
  }
  if (user.status === 'REGISTERED') {
    return res.redirect('/pending-activation');
  }
  // status === 'ACTIVATED'
  res.sendFile(path.join(__dirname, 'public', 'vote.html'));
});

// --------------------------------------------------------------------------
// Voter Authentication & API
// --------------------------------------------------------------------------

// Register User
app.post('/api/register', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password || username.trim().length < 3 || password.length < 4) {
    return res.status(400).json({ message: 'Username (min 3 chars) and password (min 4 chars) are required.' });
  }

  const cleanUsername = username.trim();
  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(cleanUsername);
  if (existing) {
    return res.status(409).json({ message: 'Username is already registered.' });
  }

  const { hash, salt } = hashPassword(password);
  const hexToken = generateHexToken();

  try {
    const insert = db.prepare(`
      INSERT INTO users (username, password_hash, salt, hex_token, status)
      VALUES (?, ?, ?, ?, 'REGISTERED')
    `);
    const info = insert.run(cleanUsername, hash, salt, hexToken);

    // Automatically set session
    req.session.userId = Number(info.lastInsertRowid);
    req.session.username = cleanUsername;

    res.status(201).json({
      message: 'Account registered successfully.',
      hex_token: hexToken,
      username: cleanUsername
    });
  } catch (err) {
    res.status(500).json({ message: 'Internal error generating voter credentials.' });
  }
});

// Voter Login
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ message: 'Username and password required.' });
  }

  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username.trim());
  if (!user || !verifyPassword(password, user.password_hash, user.salt)) {
    return res.status(401).json({ message: 'Invalid voter credentials.' });
  }

  req.session.userId = user.id;
  req.session.username = user.username;

  let redirect = '/vote';
  if (user.status === 'REGISTERED') {
    redirect = '/pending-activation';
  } else if (user.status === 'VOTED') {
    redirect = '/voted-already';
  }

  res.json({ message: 'Authenticated successfully.', redirect });
});

// Voter Status Check
app.get('/api/user/status', (req, res) => {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ message: 'Unauthorized.' });
  }

  const user = db.prepare('SELECT id, username, hex_token, status FROM users WHERE id = ?').get(req.session.userId);
  if (!user) {
    return res.status(401).json({ message: 'User record not found.' });
  }

  res.json(user);
});

// Voter Logout
app.post('/api/logout', (req, res) => {
  req.session.destroy(() => {
    res.json({ message: 'Logged out successfully.' });
  });
});

// Get Candidate List
app.get('/api/candidates', (req, res) => {
  const candidates = db.prepare('SELECT id, name, role_title, party, bio, color_hex FROM candidates').all();
  res.json(candidates);
});

// Cast Vote (Atomic Transaction & One-Time Guarantee)
app.post('/api/vote', requireVoterAuth, (req, res) => {
  const userId = req.session.userId;
  const { candidateId } = req.body;

  if (!candidateId) {
    return res.status(400).json({ message: 'Candidate selection required.' });
  }

  // Validate candidate existence
  const candidate = db.prepare('SELECT id FROM candidates WHERE id = ?').get(candidateId);
  if (!candidate) {
    return res.status(400).json({ message: 'Invalid candidate selection.' });
  }

  // Execute Atomic Transaction
  try {
    db.exec('BEGIN IMMEDIATE;');

    // 1. Fetch current status inside the lock
    const voter = db.prepare('SELECT status FROM users WHERE id = ?').get(userId);
    if (!voter) {
      db.exec('ROLLBACK;');
      return res.status(404).json({ message: 'Voter account not found.' });
    }

    if (voter.status === 'VOTED') {
      db.exec('ROLLBACK;');
      return res.status(403).json({ message: 'Vote has already been cast for this account. Re-voting is strictly forbidden.' });
    }

    if (voter.status !== 'ACTIVATED') {
      db.exec('ROLLBACK;');
      return res.status(403).json({ message: 'Your token has not been verified/activated by the administrator yet.' });
    }

    // 2. Perform Atomic CAS on voter status
    const updateResult = db.prepare(`
      UPDATE users
      SET status = 'VOTED', voted_at = CURRENT_TIMESTAMP
      WHERE id = ? AND status = 'ACTIVATED'
    `).run(userId);

    if (updateResult.changes === 0) {
      db.exec('ROLLBACK;');
      return res.status(409).json({ message: 'Concurrent vote collision detected. Token already used.' });
    }

    // 3. Insert anonymous ballot (Zero relational linkage to userId for complete ballot privacy)
    db.prepare('INSERT INTO votes (candidate_id) VALUES (?)').run(candidateId);

    db.exec('COMMIT;');

    // 4. Broadcast live telemetry update via Socket.io
    broadcastTally();

    res.json({ message: 'Ballot cast and committed successfully.' });
  } catch (err) {
    try { db.exec('ROLLBACK;'); } catch (_) {}
    console.error('Voting transaction failure:', err);
    res.status(500).json({ message: 'Transaction failure recording ballot.' });
  }
});

// --------------------------------------------------------------------------
// Admin API
// --------------------------------------------------------------------------

// Admin Login
app.post('/api/admin/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ message: 'Credentials required.' });
  }

  const admin = db.prepare('SELECT * FROM admins WHERE username = ?').get(username.trim());
  if (!admin || !verifyPassword(password, admin.password_hash, admin.salt)) {
    return res.status(401).json({ message: 'Invalid administrator credentials.' });
  }

  req.session.adminId = admin.id;
  req.session.adminUsername = admin.username;
  res.json({ message: 'Admin authenticated.' });
});

// Admin Logout
app.post('/api/admin/logout', (req, res) => {
  delete req.session.adminId;
  delete req.session.adminUsername;
  res.json({ message: 'Admin logged out.' });
});

// List all voters for verification ledger
app.get('/api/admin/voters', requireAdminAuth, (req, res) => {
  const voters = db.prepare(`
    SELECT id, username, hex_token, status, created_at, activated_at, voted_at
    FROM users
    ORDER BY id DESC
  `).all();
  res.json(voters);
});

// Candidate Management (CRUD)
app.post('/api/admin/reset-election', requireAdminAuth, (req, res) => {
  try {
    db.exec('BEGIN IMMEDIATE;');
    db.exec('DELETE FROM votes;');
    db.exec('DELETE FROM users;');
    db.exec("DELETE FROM sqlite_sequence WHERE name IN ('votes', 'users');");
    db.exec('COMMIT;');

    broadcastTally();

    res.json({ message: 'All votes and registered voters successfully purged. Candidates preserved intact.' });
  } catch (err) {
    try { db.exec('ROLLBACK;'); } catch (_) {}
    console.error('Reset election failed:', err);
    res.status(500).json({ message: 'Failed to reset election data.' });
  }
});

app.post('/api/admin/candidates', requireAdminAuth, (req, res) => {
  const { name, role_title, party, bio, color_hex } = req.body;
  if (!name || !name.trim()) {
    return res.status(400).json({ message: 'Candidate name is required.' });
  }

  const cleanName = name.trim();
  const cleanRole = (role_title || 'Candidate').trim();
  const cleanParty = (party || '').trim();
  const cleanBio = (bio || '').trim();
  const cleanColor = color_hex || '#3B82F6';

  const insert = db.prepare(`
    INSERT INTO candidates (name, role_title, party, bio, color_hex)
    VALUES (?, ?, ?, ?, ?)
  `);
  const result = insert.run(cleanName, cleanRole, cleanParty, cleanBio, cleanColor);

  broadcastCatalog();
  broadcastTally();

  res.status(201).json({
    message: 'Candidate added successfully.',
    id: Number(result.lastInsertRowid)
  });
});

app.put('/api/admin/candidates/:id', requireAdminAuth, (req, res) => {
  const candidateId = Number(req.params.id);
  const { name, role_title, party, bio, color_hex } = req.body;

  if (!name || !name.trim()) {
    return res.status(400).json({ message: 'Candidate name is required.' });
  }

  const existing = db.prepare('SELECT id FROM candidates WHERE id = ?').get(candidateId);
  if (!existing) {
    return res.status(404).json({ message: 'Candidate not found.' });
  }

  db.prepare(`
    UPDATE candidates
    SET name = ?, role_title = ?, party = ?, bio = ?, color_hex = ?
    WHERE id = ?
  `).run(name.trim(), (role_title || '').trim(), (party || '').trim(), (bio || '').trim(), color_hex || '#3B82F6', candidateId);

  broadcastCatalog();
  broadcastTally();

  res.json({ message: 'Candidate updated successfully.' });
});

app.delete('/api/admin/candidates/:id', requireAdminAuth, (req, res) => {
  const candidateId = Number(req.params.id);

  // Check if votes already exist for this candidate
  const voteCheck = db.prepare('SELECT COUNT(*) AS count FROM votes WHERE candidate_id = ?').get(candidateId);
  if (voteCheck.count > 0) {
    return res.status(409).json({
      message: `Cannot delete candidate: ${voteCheck.count} votes have already been cast for this candidate.`
    });
  }

  const result = db.prepare('DELETE FROM candidates WHERE id = ?').run(candidateId);
  if (result.changes === 0) {
    return res.status(404).json({ message: 'Candidate not found.' });
  }

  broadcastCatalog();
  broadcastTally();

  res.json({ message: 'Candidate removed successfully.' });
});

// Activate Token
app.post('/api/admin/activate', requireAdminAuth, (req, res) => {
  const { hex_token } = req.body;
  if (!hex_token) {
    return res.status(400).json({ message: 'Hex token required.' });
  }

  const cleanToken = hex_token.trim().toUpperCase();
  const voter = db.prepare('SELECT * FROM users WHERE hex_token = ?').get(cleanToken);

  if (!voter) {
    return res.status(404).json({ message: 'Token not found in registry.' });
  }

  if (voter.status === 'VOTED') {
    return res.status(400).json({ message: 'Cannot activate token: Voter has already completed voting.' });
  }

  if (voter.status === 'ACTIVATED') {
    return res.status(200).json({ message: 'Token is already active and eligible.', user: voter });
  }

  // Update status to ACTIVATED
  db.prepare(`
    UPDATE users
    SET status = 'ACTIVATED', activated_at = CURRENT_TIMESTAMP
    WHERE hex_token = ?
  `).run(cleanToken);

  const updatedVoter = db.prepare('SELECT id, username, status FROM users WHERE hex_token = ?').get(cleanToken);
  res.json({ message: `Token verified. Voting booth unlocked for ${updatedVoter.username}.`, user: updatedVoter });
});

// --------------------------------------------------------------------------
// Public Telemetry & Socket.io
// --------------------------------------------------------------------------

function getTallies() {
  const rows = db.prepare(`
    SELECT candidate_id, COUNT(*) AS count
    FROM votes
    GROUP BY candidate_id
  `).all();

  const tallies = {};
  for (const r of rows) {
    tallies[r.candidate_id] = r.count;
  }

  const totalEligible = db.prepare('SELECT COUNT(*) AS count FROM users').get().count;

  return { tallies, totalEligible };
}

function broadcastTally() {
  const payload = getTallies();
  io.emit('tally_update', payload);
}

function broadcastCatalog() {
  const candidates = db.prepare('SELECT id, name, role_title, party, bio, color_hex FROM candidates').all();
  io.emit('catalog_update', candidates);
}

app.get('/api/tally', (req, res) => {
  res.json(getTallies());
});

io.on('connection', (socket) => {
  // Emit latest tally and catalog snapshots immediately upon connection
  socket.emit('tally_update', getTallies());
  const candidates = db.prepare('SELECT id, name, role_title, party, bio, color_hex FROM candidates').all();
  socket.emit('catalog_update', candidates);
});

// Detect LAN IP addresses for clear display to the operator
function getLocalIpAddresses() {
  const interfaces = os.networkInterfaces();
  const addresses = [];
  for (const ifaceName of Object.keys(interfaces)) {
    for (const iface of interfaces[ifaceName]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        addresses.push(iface.address);
      }
    }
  }
  return addresses;
}

server.listen(PORT, '0.0.0.0', () => {
  const ips = getLocalIpAddresses();
  console.log(`\n========================================================`);
  console.log(`🛡️  LAN TOKEN-VOTING SYSTEM RUNNING`);
  console.log(`========================================================`);
  console.log(`Local Access:        http://localhost:${PORT}`);
  if (ips.length > 0) {
    ips.forEach(ip => {
      console.log(`LAN Voter Access:    http://${ip}:${PORT}`);
      console.log(`LAN Projector View:  http://${ip}:${PORT}/projector`);
      console.log(`LAN Admin Dashboard: http://${ip}:${PORT}/admin`);
    });
  }
  console.log(`Default Admin:       admin / admin123`);
  console.log(`========================================================\n`);
});
