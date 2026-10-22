const https = require('https');

const BASE_URL    = 'mis.greenoilinc.com';
const ORDERS_PATH = '/assets/api/v1/orders.php';

function misGet(fullPath, apiKey) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: BASE_URL,
      path:     fullPath,
      method:   'GET',
      headers:  { 'X-API-Key': apiKey },
    };
    const proxyReq = https.request(options, (proxyRes) => {
      const chunks = [];
      proxyRes.on('data', chunk => chunks.push(chunk));
      proxyRes.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
    proxyReq.on('error', reject);
    proxyReq.end();
  });
}

// orders.php 기본 쿼리는 tbl_member 의 현재 기사 번호(m_currentdriver)와 맞는 tbl_daily 행만 내보낸다.
// 그래서 퇴사 처리된 기사의 지난 수거 기록이 통째로 빠진다 → 같은 기간 건별(by_account)에서
// 빠진 (날짜, 기사)를 다시 묶어 붙인다. 건별에는 tbl_memberhis·d_druid 가 없어서
// 출퇴근·마일리지·현금·driver_uid 는 비워 둔다(restored: true).
async function restoreHiddenDrivers(body, params, apiKey) {
  let main;
  try { main = JSON.parse(body); } catch (e) { return body; }
  if (!main || !main.success || !Array.isArray(main.data)) return body;

  const q = new URLSearchParams({ type: 'by_account' });
  for (const k of ['date_from', 'date_to', 'driver']) {
    if (params.get(k)) q.set(k, params.get(k));
  }

  let rows;
  try {
    const ba = JSON.parse(await misGet(`${ORDERS_PATH}?${q}`, apiKey));
    if (!ba.success || !Array.isArray(ba.data)) throw new Error('by_account 응답 형식 이상');
    rows = ba.data;
  } catch (e) {
    main.hidden_restore_error = e.message;
    return JSON.stringify(main);
  }

  const key   = (date, driver) => `${date}|${String(driver || '').trim()}`;
  const shown = new Set(main.data.map(r => key(r.order_date, r.driver)));
  const groups = new Map();
  for (const r of rows) {
    const driver = String(r.driver || '').trim();
    if (!driver || shown.has(key(r.order_date, driver))) continue;
    const k = key(r.order_date, driver);
    let g = groups.get(k);
    if (!g) groups.set(k, g = { date: String(r.order_date), driver, total: 0, done: 0, fc: 0, ac: 0 });
    g.total += 1;
    if (r.status === 'F') g.done += 1;
    g.fc += parseFloat(r.forecast) || 0;
    g.ac += parseFloat(r.actual) || 0;
  }
  if (!groups.size) return body;

  // 칸 이름·계산은 orders.php 기본 분기와 같게
  const round2 = v => Math.round(v * 100) / 100;
  const restored = [...groups.values()].map(g => {
    const fc = round2(g.fc), ac = round2(g.ac), d = g.date;
    return {
      order_date:      Number(d),
      driver_uid:      null,
      driver:          g.driver,
      total_stops:     g.total,
      completed_stops: g.done,
      forecast:        fc,
      actual:          ac,
      departure:       null,
      arrival:         null,
      mileage_start:   null,
      mileage_finish:  null,
      opening_balance: 0,
      cash_in:         0,
      cash_out:        0,
      cash_return:     0,
      gas:             0,
      extra:           0,
      balance_total:   0,
      comment:         null,
      order_date_formatted: `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`,
      achievement_pct: fc > 0 ? Math.round(ac / fc * 1000) / 10 : 0,
      remaining:       Math.max(round2(fc - ac), 0),
      status:          ac <= 0 ? 'Pending' : ac >= fc ? 'Done' : 'In Progress',
      mileage_driven:  null,
      restored:        true,
    };
  });

  // orders.php 와 같은 순서: 날짜 내림차순, 기사 오름차순
  main.data = main.data.concat(restored).sort((a, b) =>
    Number(b.order_date) - Number(a.order_date) ||
    (a.driver < b.driver ? -1 : a.driver > b.driver ? 1 : 0));
  main.count = main.data.length;
  main.hidden_restored = restored.length;
  return JSON.stringify(main);
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  const API_KEY  = process.env.MIS_API_KEY || '';
  if (!API_KEY) { res.status(500).json({ success: false, error: 'MIS_API_KEY env 미설정' }); return; }

  const params = new URLSearchParams(req.query);
  const type   = params.get('type') || 'orders';

  let path;
  if (type === 'drivers') {
    path = '/assets/api/v1/drivers.php';
    params.delete('type');
  } else {
    path = ORDERS_PATH;
  }

  const qs       = params.toString();
  const fullPath = qs ? `${path}?${qs}` : path;

  let data;
  try {
    data = await misGet(fullPath, API_KEY);
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
    return;
  }
  if (type === 'orders') data = await restoreHiddenDrivers(data, params, API_KEY);

  res.setHeader('Content-Type', 'application/json');
  res.status(200).send(data);
};
