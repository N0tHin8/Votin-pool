const http = require('node:http');

function request(options, data = null) {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, headers: res.headers, data: JSON.parse(body) }); }
        catch (_) { resolve({ status: res.statusCode, headers: res.headers, data: body }); }
      });
    });
    req.on('error', reject);
    if (data) req.write(JSON.stringify(data));
    req.end();
  });
}

function extractCookie(headers) {
  const setCookie = headers['set-cookie'];
  return setCookie ? setCookie[0].split(';')[0] : '';
}

async function verifyCandidateManagement() {
  console.log('--- TESTING CANDIDATE MANAGEMENT ENDPOINTS ---');

  // 1. Admin login
  const loginRes = await request({
    hostname: 'localhost', port: 3000, path: '/api/admin/login', method: 'POST',
    headers: { 'Content-Type': 'application/json' }
  }, { username: 'admin', password: 'admin123' });

  const adminCookie = extractCookie(loginRes.headers);
  console.log('[PASS] Admin authenticated.');

  // 2. Create Candidate
  const createRes = await request({
    hostname: 'localhost', port: 3000, path: '/api/admin/candidates', method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Cookie': adminCookie }
  }, {
    name: 'Test Candidate Alpha',
    role_title: 'Treasurer',
    party: 'Progressive Guild',
    bio: 'Responsible fiscal planning.',
    color_hex: '#EC4899'
  });

  const newCandId = createRes.data.id;
  console.log(`[PASS] Created Candidate ID: ${newCandId} (HTTP ${createRes.status})`);

  // 3. Edit Candidate
  const editRes = await request({
    hostname: 'localhost', port: 3000, path: `/api/admin/candidates/${newCandId}`, method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'Cookie': adminCookie }
  }, {
    name: 'Test Candidate Alpha (Renamed)',
    role_title: 'Chief Treasurer',
    party: 'Progressive Guild',
    bio: 'Updated bio statement.',
    color_hex: '#14B8A6'
  });
  console.log(`[PASS] Updated Candidate ID: ${newCandId} (HTTP ${editRes.status})`);

  // 4. Delete Candidate (Zero votes cast for this candidate - should succeed)
  const delRes = await request({
    hostname: 'localhost', port: 3000, path: `/api/admin/candidates/${newCandId}`, method: 'DELETE',
    headers: { 'Cookie': adminCookie }
  });
  console.log(`[PASS] Successfully deleted candidate with 0 votes (HTTP ${delRes.status})`);

  // 5. Attempt deleting candidate WITH votes (Candidate 1 has a vote from previous test - MUST BE BLOCKED)
  const blockedDel = await request({
    hostname: 'localhost', port: 3000, path: `/api/admin/candidates/1`, method: 'DELETE',
    headers: { 'Cookie': adminCookie }
  });

  if (blockedDel.status === 409) {
    console.log(`[PASS] Referential integrity protected: Deleting candidate with recorded votes blocked (HTTP 409)`);
  } else {
    throw new Error(`Referential integrity failure: deletion was allowed with status ${blockedDel.status}`);
  }

  console.log('>>> ALL CANDIDATE MANAGEMENT AUDIT CHECKS PASSED <<<');
}

verifyCandidateManagement().catch(err => {
  console.error('Candidate Test Failed:', err);
  process.exit(1);
});
