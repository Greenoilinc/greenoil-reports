const https = require('https');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  const API_KEY  = 'GOI_DASHBOARD_2026_SECRET';
  const BASE_URL = 'mis.greenoilinc.com';

  const params = new URLSearchParams(req.query);
  const type   = params.get('type') || 'orders';

  let path;
  if (type === 'drivers') {
    path = '/assets/api/v1/drivers.php';
    params.delete('type');
  } else {
    path = '/assets/api/v1/orders.php';
  }

  const qs       = params.toString();
  const fullPath = qs ? `${path}?${qs}` : path;

  return new Promise((resolve) => {
    const options = {
      hostname: BASE_URL,
      path:     fullPath,
      method:   'GET',
      headers:  { 'X-API-Key': API_KEY },
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

    proxyReq.end();
  });
};
