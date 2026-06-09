const https = require('https');

exports.handler = async (event) => {
  const API_KEY  = process.env.MIS_API_KEY || '';
  const BASE_URL = 'mis.greenoilinc.com';
  if (!API_KEY) return { statusCode: 500, body: JSON.stringify({ success: false, error: 'MIS_API_KEY env 미설정' }) };

  const type   = event.queryStringParameters?.type || 'orders';
  const params = new URLSearchParams(event.queryStringParameters || {});

  // path routing
  let path;
  if (type === 'drivers') {
    path = '/assets/api/v1/drivers.php';
    params.delete('type');
  } else {
    path = '/assets/api/v1/orders.php';
    // type=cs는 orders.php가 분기 처리하므로 그대로 전달
  }

  const qs = params.toString();
  const fullPath = qs ? `${path}?${qs}` : path;

  return new Promise((resolve) => {
    const options = {
      hostname: BASE_URL,
      path:     fullPath,
      method:   'GET',
      headers:  { 'X-API-Key': API_KEY }
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

    req.end();
  });
};
