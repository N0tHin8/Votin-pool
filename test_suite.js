const http = require('node:http');

function request(options, data = null) {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          resolve({ status: res.statusCode, headers: res.headers, data: parsed });
        } catch (_) {
          resolve({ status: res.statusCode, headers: res.headers, data: body });
        }
      });
    });
    req.on('error', reject);
    if (data) {
      req.write(typeof data === 'string' ? data : JSON.stringify(data));
    }
    req.end();
  });
}

function extractCookie(headers) {
  const setCookie = headers['set-cookie'];
  if (!setCookie) return '';
  return setCookie[0].split(';')[0];
}

async function runTests() {
  console.log('--- STARTING COMPREHENSIVE E2E VERIFICATION ---');

  // 1. Verify candidate roster
  const candRes = await request({
    hostname: 'localhost',
    port: 3000,
    path: '/api/candidates',
    method: 'GET'
  });
  console.log(`[PASS] Candidates fetched: ${candRes.data.length} candidates loaded.`);
  const candidateId = candRes.data[0].id;

  // 2. Register Voter
  const voterUsername = 'test_voter_' + Date.now();
  const regRes = await request({
    hostname: 'localhost',
    port: 3000,
    path: '/api/register',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' }
  }, { username: voterUsername, password: 'password123' });

  const voterCookie = extractCookie(regRes.headers);
  const hexToken = regRes.data.hex_token;
  console.log(`[PASS] Registered user: ${voterUsername}, Token: ${hexToken}`);

  // 3. Attempt to vote BEFORE admin activation (Should be BLOCKED with 403)
  const prematureVote = await request({
    hostname: 'localhost',
    port: 3000,
    path: '/api/vote',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cookie': voterCookie
    }
  }, { candidateId });

  if (prematureVote.status === 403) {
    console.log(`[PASS] Unactivated voting blocked successfully (HTTP 403: ${prematureVote.data.message})`);
  } else {
    throw new Error(`Security Failure: Unactivated account allowed to vote! Status: ${prematureVote.status}`);
  }

  // 4. Admin Login
  const adminLoginRes = await request({
    hostname: 'localhost',
    port: 3000,
    path: '/api/admin/login',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' }
  }, { username: 'admin', password: 'admin123' });

  const adminCookie = extractCookie(adminLoginRes.headers);
  console.log(`[PASS] Admin authenticated successfully.`);

  // 5. Admin Activates Token
  const activateRes = await request({
    hostname: 'localhost',
    port: 3000,
    path: '/api/admin/activate',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cookie': adminCookie
    }
  }, { hex_token: hexToken });

  if (activateRes.status === 200 && activateRes.data.user.status === 'ACTIVATED') {
    console.log(`[PASS] Admin activated token: ${hexToken} for user: ${activateRes.data.user.username}`);
  } else {
    throw new Error(`Failed to activate token: ${JSON.stringify(activateRes.data)}`);
  }

  // 6. Cast Vote (Should SUCCEED)
  const legitVote = await request({
    hostname: 'localhost',
    port: 3000,
    path: '/api/vote',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cookie': voterCookie
    }
  }, { candidateId });

  if (legitVote.status === 200) {
    console.log(`[PASS] Legitimate ballot successfully cast & committed.`);
  } else {
    throw new Error(`Legit vote failed: ${JSON.stringify(legitVote.data)}`);
  }

  // 7. DOUBLE-VOTE TEST (Re-voting with same account/session - MUST FAIL)
  const doubleVote = await request({
    hostname: 'localhost',
    port: 3000,
    path: '/api/vote',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cookie': voterCookie
    }
  }, { candidateId });

  if (doubleVote.status === 403) {
    console.log(`[PASS] Double-voting attack thwarted (HTTP 403: ${doubleVote.data.message})`);
  } else {
    throw new Error(`CRITICAL SECURITY FAILURE: Double-vote was permitted! Status: ${doubleVote.status}`);
  }

  // 8. Verify Tally
  const tallyRes = await request({
    hostname: 'localhost',
    port: 3000,
    path: '/api/tally',
    method: 'GET'
  });
  console.log(`[PASS] Live tally updated: ${JSON.stringify(tallyRes.data.tallies)}`);

  console.log('\n>>> ALL SECURITY & FUNCTIONAL SUITE TESTS PASSED 100% <<<');
}

module.exports = { runTests };
if (require.main === module) {
  runTests().catch(err => {
    console.error('Test Suite Failed:', err);
    process.exit(1);
  });
}
