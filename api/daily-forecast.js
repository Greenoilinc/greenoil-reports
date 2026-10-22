const https = require('https');

// 매일 아침 8시 forecast 스냅샷만 저장한다(tbl_forecast_cache).
// 드라이버 Google Chat 발송은 하지 않는다 — 7/13 부터 발송 중단, 10/22 코드에서 제거.

const MIS_HOST  = 'mis.greenoilinc.com';
const API_KEY   = process.env.MIS_API_KEY || '';

// ── 날짜 헬퍼 (토론토 시간 기준) ────────────────────
function torontoDate() {
  const s = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Toronto' });
  return s.replace(/-/g, ''); // YYYYMMDD
}
function torontoHour() {
  return parseInt(new Date().toLocaleString('en-US', { timeZone: 'America/Toronto', hour: '2-digit', hourCycle: 'h23' }), 10);
}

// ── 타겟 계산 (8시 forecast → 확정 타겟) ─────────────
// goi_live_dashboard.html 의 calcTarget() 과 반드시 같게 유지
// 기본: max 5000L 캡
// J.O 예외: <4500 그대로 / 4500~5000 → ×0.95 / >5000 → 5000×0.95=4750
// S.L 예외: <3500 그대로 / 3500~5000 →3500 / 5000~5500 그대로 / >=5500 →5500
function calcTarget(driver, raw) {
  const fc = parseFloat(raw) || 0;
  if (driver === 'J.O') {
    if (fc < 4500) return Math.round(fc);
    if (fc <= 5000) return Math.round(fc * 0.95);
    return Math.round(5000 * 0.95); // 4750
  }
  if (driver === 'S.L') {
    if (fc < 3500) return Math.round(fc);   // 3500 미만 그대로
    if (fc < 5000) return 3500;             // 3500~5000 → 3500
    if (fc < 5500) return Math.round(fc);   // 5000~5500 그대로
    return 5500;                            // 5500 이상 → 5500
  }
  return Math.min(fc, 5000);
}

// ── MIS 서버 HTTPS 요청 ──────────────────────────────
function misRequest(path, method = 'GET', body = null) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: MIS_HOST,
      path,
      method,
      headers: { 'X-API-Key': API_KEY, 'Content-Type': 'application/json' },
    };
    if (body) opts.headers['Content-Length'] = Buffer.byteLength(body);

    const req = https.request(opts, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`MIS 응답이 JSON 이 아님 (HTTP ${res.statusCode})`)); }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

const CRON_SECRET = process.env.CRON_SECRET || '';

// ── 메인 핸들러 ──────────────────────────────────────
module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json');

  // 토큰 검증 (Vercel Cron 내부 호출은 예외 허용)
  const isVercelCron = req.headers['x-vercel-cron'] === '1';
  const token = req.query.token || req.headers['x-cron-token'];
  if (!isVercelCron && (!CRON_SECRET || token !== CRON_SECRET)) {
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }
  if (!API_KEY)  return res.status(500).json({ success: false, error: 'MIS_API_KEY env 미설정' });

  const today = torontoDate();
  const log   = [];

  // 대시보드와 같은 규칙: 8시 전에는 잠그지 않는다(겨울에 UTC 고정 예약이 7시에 돌아도 안전)
  if (torontoHour() < 8) {
    log.push(`토론토 ${torontoHour()}시 — 8시 전이라 저장 안 함`);
    return res.status(200).json({ success: true, date: today, saved: false, log });
  }

  try {
    // 1. 스냅샷 확인 (saved_at 필드로 진짜 캐시인지 구분) — 있으면 덮지 않는다
    const cached = await misRequest(`/assets/api/v1/orders.php?type=forecast&date=${today}`);
    const isRealCache = cached.success && cached.saved_at && cached.data && !Array.isArray(cached.data);
    if (isRealCache) {
      log.push(`이미 저장됨: ${today} ${cached.saved_at} — 그대로 둠`);
      return res.status(200).json({ success: true, date: today, saved: false, log });
    }

    // 2. tbl_daily에서 오늘 forecast 직접 조회
    const orders = await misRequest(`/assets/api/v1/orders.php?date_from=${today}&date_to=${today}`);
    if (!orders.success || !Array.isArray(orders.data)) throw new Error('orders.php 조회 실패');

    const snapshot = {};
    for (const row of orders.data) {
      if (row.driver && row.forecast) {
        snapshot[row.driver] = calcTarget(row.driver, parseFloat(row.forecast) || 0);
      }
    }
    if (!Object.keys(snapshot).length) {
      log.push(`오늘 forecast 없음: ${today} — 저장 안 함`);
      return res.status(200).json({ success: true, date: today, saved: false, log });
    }

    // 3. 스냅샷 저장
    await misRequest(
      `/assets/api/v1/orders.php?type=forecast&date=${today}`,
      'POST',
      JSON.stringify(snapshot)
    );
    log.push(`새 스냅샷 저장: ${today} — ${Object.keys(snapshot).length}명`);

    res.status(200).json({ success: true, date: today, saved: true, snapshot, log });

  } catch (e) {
    res.status(500).json({ success: false, error: e.message, log });
  }
};
