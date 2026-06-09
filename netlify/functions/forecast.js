const https = require('https');

exports.handler = async (event) => {
  const API_KEY  = process.env.MIS_API_KEY || '';
  const BASE_URL = 'mis.greenoilinc.com';
  const path     = '/assets/api/v1/orders.php';

  // CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    // (preflight은 키 불필요 — 아래 OPTIONS 블록에서 처리)
    return {
      statusCode: 204,
      headers: {
        'Access-Control-Allow-Origin':  '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      },
      body: ''
    };
  }

  if (!API_KEY) return { statusCode: 500, body: JSON.stringify({ success: false, error: 'MIS_API_KEY env 미설정' }) };

  const date     = event.queryStringParameters?.date || '';
  const fullPath = date ? `${path}?type=forecast&date=${date}` : `${path}?type=forecast`;
  const method   = event.httpMethod === 'POST' ? 'POST' : 'GET';
  const body     = event.body || '';

  return new Promise((resolve) => {
    const options = {
      hostname: BASE_URL,
      path:     fullPath,
      method,
      headers: {
        'X-API-Key':    API_KEY,
        'Content-Type': 'application/json',
        ...(method === 'POST' ? { 'Content-Length': Buffer.byteLength(body) } : {}),
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        resolve({
          statusCode: 200,
          headers: {
            'Content-Type':                'application/json',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods':'GET, POST, OPTIONS',
          },
          body: data
        });
      });
    });

    req.on('error', (e) => {
      resolve({
        statusCode: 500,
        body: JSON.stringify({ success: false, error: e.message })
      });
    });

    if (method === 'POST' && body) req.write(body);
    req.end();
  });
};
