const https = require('https');

// ── 드라이버별 Google Chat Webhook URL ──────────────
// ⚠️ 저장소가 public이므로 webhook은 절대 하드코딩 금지.
// Vercel 환경변수 DRIVER_WEBHOOKS 에 JSON 문자열로 주입: {"D.L":"https://...","H.K":"https://...", ...}
let DRIVER_WEBHOOKS = {};
try {
  DRIVER_WEBHOOKS = JSON.parse(process.env.DRIVER_WEBHOOKS || '{}');
} catch (e) {
  console.error('DRIVER_WEBHOOKS env JSON 파싱 실패:', e.message);
}

const MIS_HOST  = 'mis.greenoilinc.com';
const API_KEY   = process.env.MIS_API_KEY || '';

// ── 날짜 헬퍼 (토론토 시간 기준) ────────────────────
function torontoDate() {
  const s = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Toronto' });
  return s.replace(/-/g, ''); // YYYYMMDD
}
function displayDate(yyyymmdd) {
  const m = parseInt(yyyymmdd.slice(4, 6), 10);
  const d = parseInt(yyyymmdd.slice(6, 8), 10);
  return `${m}/${d}`;
}

// ── 타겟 계산 (8시 forecast → 확정 타겟) ─────────────
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
      res.on('end', () => resolve(JSON.parse(data)));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// ── Google Chat 발송 ─────────────────────────────────
function sendChat(webhookUrl, text) {
  return new Promise((resolve, reject) => {
    const body    = JSON.stringify({ text });
    const url     = new URL(webhookUrl);
    const opts    = {
      hostname: url.hostname,
      path:     url.pathname + url.search,
      method:   'POST',
      headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    };
    const req = https.request(opts, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => res.statusCode === 200 ? resolve() : reject(new Error(`HTTP ${res.statusCode}`)));
    });
    req.on('error', reject);
    req.write(body);
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
  if (!Object.keys(DRIVER_WEBHOOKS).length) return res.status(500).json({ success: false, error: 'DRIVER_WEBHOOKS env 미설정' });

  const today = torontoDate();
  const date  = displayDate(today);
  const log   = [];

  try {
    // 1. 스냅샷 확인 (saved_at 필드로 진짜 캐시인지 구분)
    let snapshot = null;
    const cached = await misRequest(`/assets/api/v1/orders.php?type=forecast&date=${today}`);
    const isRealCache = cached.success && cached.saved_at && cached.data && !Array.isArray(cached.data);

    if (isRealCache) {
      // 이미 발송된 경우 중복 방지
      if (cached.data._chat_sent === true) {
        log.push(`이미 발송됨: ${today} — 중복 발송 건너뜀`);
        return res.status(200).json({ success: true, date: today, log });
      }
      snapshot = cached.data;
      log.push(`스냅샷 기존 사용: ${today}`);
    } else {
      // 2. tbl_daily에서 오늘 forecast 직접 조회
      const orders = await misRequest(`/assets/api/v1/orders.php?date_from=${today}&date_to=${today}`);
      if (!orders.success || !Array.isArray(orders.data)) throw new Error('orders.php 조회 실패');

      snapshot = {};
      for (const row of orders.data) {
        if (row.driver && row.forecast) {
          snapshot[row.driver] = calcTarget(row.driver, parseFloat(row.forecast) || 0);
        }
      }

      // 3. 스냅샷 저장
      await misRequest(
        `/assets/api/v1/orders.php?type=forecast&date=${today}`,
        'POST',
        JSON.stringify(snapshot)
      );
      log.push(`새 스냅샷 저장: ${today}`);
    }

    // 4. 드라이버별 메시지 발송
    let ok = 0, skip = 0, fail = 0;
    for (const [driver, webhookUrl] of Object.entries(DRIVER_WEBHOOKS)) {
      const qty = snapshot[driver] || 0;
      if (!qty) { skip++; log.push(`SKIP ${driver}: 0L`); continue; }

      const msg = `${date}\n오늘의 목표량은 *${Math.round(qty).toLocaleString()}L* 입니다.`;
      try {
        await sendChat(webhookUrl, msg);
        ok++;
        log.push(`OK ${driver}: ${qty}L`);
        await new Promise(r => setTimeout(r, 300));
      } catch (e) {
        fail++;
        log.push(`FAIL ${driver}: ${e.message}`);
      }
    }

    log.push(`완료 — 성공:${ok} 스킵:${skip} 실패:${fail}`);

    // 5. 발송 완료 플래그 저장 (중복 발송 방지)
    snapshot._chat_sent = true;
    await misRequest(
      `/assets/api/v1/orders.php?type=forecast&date=${today}`,
      'POST',
      JSON.stringify(snapshot)
    );

    res.status(200).json({ success: true, date: today, log });

  } catch (e) {
    res.status(500).json({ success: false, error: e.message, log });
  }
};
