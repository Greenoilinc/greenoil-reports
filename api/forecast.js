const https = require('https');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  const API_KEY  = 'GOI_DASHBOARD_2026_SECRET';
  const BASE_URL = 'mis.greenoilinc.com';
  const date     = req.query.date || '';
  const fullPath = `/assets/api/v1/orders.php?type=forecast${date ? '&date=' + date : ''}`;
  const method   = req.method === 'POST' ? 'POST' : 'GET';

  let body = '';
  if (method === 'POST') {
    await new Promise((resolve) => {
      req.on('data', chunk => body += chunk);
      req.on('end', resolve);
    });
  }

  return new Promise((resolve) => {
    const options = {
      hostname: BASE_URL,
      path:     fullPath,
      method,
      headers: {
        'X-API-Key':    API_KEY,
        'Content-Type': 'application/json',
        ...(method === 'POST' ? { 'Content-Length': Buffer.byteLength(body) } : {}),
      },
    };

    const proxyReq = https.request(options, (proxyRes) => {
      let data = '';
      proxyRes.on('data', chunk => data += chunk);
      proxyRes.on('end', () => {
        res.setHeader('Content-Type', 'application/json');
        res.status(200).send(data);
        resolve();
      });
    });

    proxyReq.on('error', (e) => {
      res.status(500).json({ success: false, error: e.message });
      resolve();
    });

    if (method === 'POST' && body) proxyReq.write(body);
    proxyReq.end();
  });
};
