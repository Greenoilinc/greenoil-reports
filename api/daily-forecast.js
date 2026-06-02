const https = require('https');

// ── 드라이버별 Google Chat Webhook URL ──────────────
const DRIVER_WEBHOOKS = {
  'D.L': 'https://chat.googleapis.com/v1/spaces/AAQAkPHPSAw/messages?key=AIzaSyDdI0hCZtE6vySjMm-WEfRq3CPzqKqqsHI&token=eUeKH4MEyK12ZxrrlOUssf3U5a2-mSJwzQHexIn24lE',
  'H.K': 'https://chat.googleapis.com/v1/spaces/AAQAlHpMVPA/messages?key=AIzaSyDdI0hCZtE6vySjMm-WEfRq3CPzqKqqsHI&token=PlO2Wq_VVEpdKh27NJyXnMLEXCmZM9pzrhUF-VVvND4',
  'J.O': 'https://chat.googleapis.com/v1/spaces/AAQATEvnCMU/messages?key=AIzaSyDdI0hCZtE6vySjMm-WEfRq3CPzqKqqsHI&token=7BYlTNEhX7wo0BJS8Fv_0iCBDDhBYIbHuRBIfMo9zyk',
  'J.S': 'https://chat.googleapis.com/v1/spaces/AAQAsGnXv3Q/messages?key=AIzaSyDdI0hCZtE6vySjMm-WEfRq3CPzqKqqsHI&token=DJvSowPlh1FwRBcDoHGSG7wraDZ2eYyVQOctkgsxrJo',
  'M.K': 'https://chat.googleapis.com/v1/spaces/AAQAOnxB0a4/messages?key=AIzaSyDdI0hCZtE6vySjMm-WEfRq3CPzqKqqsHI&token=jAtBuMgjWs86XsJp1Z0mx1P3AJJMBypFMDfsITEiHo8',
  'S.K': 'https://chat.googleapis.com/v1/spaces/AAQAVoDQ6bY/messages?key=AIzaSyDdI0hCZtE6vySjMm-WEfRq3CPzqKqqsHI&token=0lFd0cm-zpZZwaopTIBBEpEOiB1FaDlUitV7xrI9djk',
  'S.L': 'https://chat.googleapis.com/v1/spaces/AAQAUEdZZNI/messages?key=AIzaSyDdI0hCZtE6vySjMm-WEfRq3CPzqKqqsHI&token=l24FQhcEG6FACVCrkuBFZ1iAgTBQNjY2w_uqEf-41hU',
  'S.S': 'https://chat.googleapis.com/v1/spaces/AAQA7A2xbYE/messages?key=AIzaSyDdI0hCZtE6vySjMm-WEfRq3CPzqKqqsHI&token=B0YvduDFAgJpjv0Um1sIrmpT6fw3obaLpDoavPshaTo',
  'T.K': 'https://chat.googleapis.com/v1/spaces/AAQARuave7E/messages?key=AIzaSyDdI0hCZtE6vySjMm-WEfRq3CPzqKqqsHI&token=2-DQN4ybcAQvN94MGeTCo_vcR8s-8wDnmf76OlN8PwA',
  'T.Y': 'https://chat.googleapis.com/v1/spaces/AAQA3OEI-Oc/messages?key=AIzaSyDdI0hCZtE6vySjMm-WEfRq3CPzqKqqsHI&token=AgfDUTvhhVAWtYSfgq6iJFezXiIK2vWL7xKwC9PX3yA',
  'Y.S': 'https://chat.googleapis.com/v1/spaces/AAQAgd4qyV8/messages?key=AIzaSyDdI0hCZtE6vySjMm-WEfRq3CPzqKqqsHI&token=M7Ew5J75QSTmddyvGnCuwGTzM9mnr1-5VI_XgUll4n4',
};

const MIS_HOST  = 'mis.greenoilinc.com';
const API_KEY   = 'GOI_DASHBOARD_2026_SECRET';

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

// ── 메인 핸들러 ──────────────────────────────────────
module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json');

  const today = torontoDate();
  const date  = displayDate(today);
  const log   = [];

  try {
    // 1. 스냅샷 확인
    let snapshot = null;
    let alreadySent = false;
    const cached = await misRequest(`/assets/api/v1/orders.php?type=forecast&date=${today}`);
    if (cached.success && cached.data) {
      snapshot = cached.data;
      // 스냅샷에 chat_sent 플래그가 있으면 이미 발송된 것 → 중복 발송 방지
      if (cached.data._chat_sent === true) {
        log.push(`이미 발송됨: ${today} — 중복 발송 건너뜀`);
        return res.status(200).json({ success: true, date: today, log });
      }
      log.push(`스냅샷 기존 사용: ${today}`);
    } else {
      // 2. tbl_daily에서 오늘 forecast 조회
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
