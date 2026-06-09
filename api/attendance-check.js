// 드라이버 근태 자동 점검 (ADP 없이 MIS × Samsara)
// Vercel Cron: 매일 아침 어제 점검 / 월요일엔 지난 7일 전체 점검 → Google Chat 발송.
// 로컬 버튼(attendance_check.py)은 ADP 포함 풀 3-way. 이건 ADP 없이 자동 감지용.
const https = require('https');

// ── 설정 ─────────────────────────────────────────────
// ⚠️ 저장소가 public이므로 토큰/webhook은 절대 하드코딩 금지. Vercel 환경변수로만 주입.
const SAMSARA_TOKEN = process.env.SAMSARA_TOKEN || '';
const WEBHOOK = process.env.GOI_ATTENDANCE_WEBHOOK || '';
const MIS_PROXY = 'https://greenoil-reports-greenoilincs-projects.vercel.app/api/api';

const DEPOT_LAT = 43.764, DEPOT_LON = -79.478, DEPOT_RADIUS_KM = 0.4;
const TIME_DIFF_MIN = 60;     // MIS vs 트럭 시각 차이 임계 (분)
const LONG_DAY_HRS = 12;      // 과다 외근 (시간)
const CRON_SECRET = '562fdc73afaf0b9f8702ed13f18560095449edeeee855f4e6935e863befb97d2';

// MIS 이니셜 → Samsara 풀네임 (G.H/I.N 미상)
const INITIAL_NAME = {
  'D.L': 'Dawit Lee', 'H.K': 'Homun Kwon', 'J.O': 'Jonghwan Oh', 'J.S': 'Jaehyuk Song',
  'M.K': 'Min Kim', 'S.K': 'Sungmin Kim', 'S.L': 'Samuel Lee', 'S.S': 'Sungmin Song',
  'T.K': 'Taekeun Kim', 'T.Y': 'Taegyu You', 'Y.S': 'Yoonseop Song', 'B.N': 'Byungkuk Nam',
  'J.Y': 'Junyoung Yoon', 'S.J': 'SeungRyul Jung',
};

// ── HTTP 헬퍼 ────────────────────────────────────────
function httpGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const opts = { hostname: u.hostname, path: u.pathname + u.search, method: 'GET', headers };
    https.request(opts, (res) => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(new Error('JSON parse: ' + d.slice(0, 200))); } });
    }).on('error', reject).end();
  });
}
function sendChat(text) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ text });
    const u = new URL(WEBHOOK);
    const opts = { hostname: u.hostname, path: u.pathname + u.search, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } };
    const req = https.request(opts, (res) => { let d=''; res.on('data',c=>d+=c);
      res.on('end', () => res.statusCode === 200 ? resolve() : reject(new Error('Chat HTTP ' + res.statusCode))); });
    req.on('error', reject); req.write(body); req.end();
  });
}

// ── 날짜 (토론토) ────────────────────────────────────
function torontoOffset(date) { // 4=EDT, 5=EST
  return date.toLocaleString('en-US', { timeZone: 'America/Toronto', timeZoneName: 'short' }).includes('EDT') ? 4 : 5;
}
function torontoYMD(date) {
  return date.toLocaleDateString('en-CA', { timeZone: 'America/Toronto' }); // YYYY-MM-DD
}
function addDays(ymd, n) {
  const d = new Date(ymd + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
// 토론토 날짜의 00:00 → UTC ISO
function dayStartUTC(ymd) {
  const off = torontoOffset(new Date(ymd + 'T12:00:00Z'));
  return `${ymd}T0${off}:00:00Z`;
}

function haversineKm(la1, lo1, la2, lo2) {
  const r = Math.PI / 180, R = 6371;
  const dla = (la2 - la1) * r, dlo = (lo2 - lo1) * r;
  const a = Math.sin(dla/2)**2 + Math.cos(la1*r)*Math.cos(la2*r)*Math.sin(dlo/2)**2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
function nameKey(s) { return (s || '').toLowerCase().replace(/[^a-z0-9]/g, '').split('').sort().join(''); }
function hhmm(d) { return d.toLocaleTimeString('en-GB', { timeZone: 'America/Toronto', hour: '2-digit', minute: '2-digit' }); }
function normTime(v) {
  if (v == null || v === '') return null;
  const s = String(v).trim();
  if (s.includes(':')) { const [h, m] = s.split(':'); return (h.match(/^\d+$/) && m.match(/^\d+$/)) ? h.padStart(2,'0')+':'+m.padStart(2,'0') : s; }
  if (s.match(/^\d+$/)) { const n = s.padStart(4, '0'); return n.slice(0,2)+':'+n.slice(2,4); }
  return s;
}
function toMin(t) { if (!t || !t.includes(':')) return null; const [h,m]=t.split(':'); return (h.match(/^\d+$/)&&m.match(/^\d+$/)) ? +h*60+ +m : null; }

// ── Samsara ──────────────────────────────────────────
async function samsaraGet(path, params) {
  let after = '', out = [];
  do {
    const qs = new URLSearchParams({ ...params, ...(after ? { after } : {}) }).toString();
    const j = await httpGet(`https://api.samsara.com${path}?${qs}`, { Authorization: 'Bearer ' + SAMSARA_TOKEN });
    out = out.concat(j.data || []);
    after = (j.pagination && j.pagination.hasNextPage) ? j.pagination.endCursor : '';
  } while (after);
  return out;
}
async function fetchDrivers() {
  const ds = await samsaraGet('/fleet/drivers', { limit: '100' });
  const id2name = {}, key2id = {};
  ds.forEach(d => { id2name[d.id] = d.name; key2id[nameKey(d.name)] = d.id; });
  return { id2name, key2id };
}
// 차고지 출발~복귀 (집에 주차하면 무효 → null)
async function fetchWorkWindows(ids, startISO, endISO) {
  const logs = await samsaraGet('/fleet/hos/logs', { driverIds: ids.join(','), startTime: startISO, endTime: endISO });
  const raw = {};
  logs.forEach(row => {
    const did = row.driver.id;
    (row.hosLogs || []).forEach(l => {
      const s = new Date(l.logStartTime), e = new Date(l.logEndTime);
      const loc = l.logRecordedLocation || {};
      const dist = (loc.latitude != null) ? haversineKm(DEPOT_LAT, DEPOT_LON, loc.latitude, loc.longitude) : null;
      const day = torontoYMD(s);
      ((raw[did] = raw[did] || {})[day] = raw[did][day] || []).push({ s, e, st: l.hosStatusType, dist });
    });
  });
  const res = {};
  for (const did in raw) for (const day in raw[did]) {
    const evs = raw[did][day].sort((a, b) => a.s - b.s);
    let depart = null, ret = null, firstDrive = null, lastDrive = null, driveMs = 0;
    const startedDepot = evs[0].dist != null && evs[0].dist <= DEPOT_RADIUS_KM;
    const endedDepot = evs[evs.length-1].dist != null && evs[evs.length-1].dist <= DEPOT_RADIUS_KM;
    for (const ev of evs) {
      if (ev.st === 'driving') { if (!firstDrive) firstDrive = ev.s; lastDrive = ev.e; driveMs += ev.e - ev.s; }
      if (ev.dist != null && ev.dist > DEPOT_RADIUS_KM && ev.st !== 'offDuty') {
        if (startedDepot && !depart) depart = ev.s;
        ret = ev.e;
      }
    }
    if (!startedDepot) depart = null;
    if (!endedDepot) ret = null;
    const ws = depart || firstDrive, we = ret || lastDrive;
    (res[did] = res[did] || {})[day] = {
      ws, we, driveHrs: driveMs / 3.6e6,
      spanHrs: (ws && we && we > ws) ? (we - ws) / 3.6e6 : 0,
    };
  }
  return res;
}

// ── MIS (이니셜 → Samsara id 기준) ───────────────────
async function fetchMis(fromYMD, toYMD, key2id) {
  const init2id = {};
  for (const init in INITIAL_NAME) { const id = key2id[nameKey(INITIAL_NAME[init])]; if (id) init2id[init] = id; }
  const j = await httpGet(`${MIS_PROXY}?date_from=${fromYMD.replace(/-/g,'')}&date_to=${toYMD.replace(/-/g,'')}`);
  const out = {};
  (j.data || []).forEach(r => {
    const id = init2id[r.driver]; if (!id) return;
    const od = String(r.order_date); if (od.length !== 8) return;
    const day = `${od.slice(0,4)}-${od.slice(4,6)}-${od.slice(6,8)}`;
    (out[id] = out[id] || {})[day] = { dep: normTime(r.departure), arr: normTime(r.arrival), init: r.driver };
  });
  return out;
}

// ── 교차검증 (ADP 없이) ──────────────────────────────
function crossCheck(windows, mis, id2name, days) {
  // 평소 MIS를 쓰는 드라이버 집합 (기간 내 1건이라도 MIS 기록 있음) — 이들만 "미기록" 판정 대상
  const misActive = new Set(Object.keys(mis).filter(did => Object.keys(mis[did]).length > 0));
  const findings = [];
  for (const did in windows) for (const day of days) {
    const w = windows[did][day]; if (!w || !w.ws) continue;
    if (w.driveHrs < 0.5) continue; // 트럭이 실제 운행한 날만
    const name = id2name[did] || did;
    const m = (mis[did] || {})[day];
    const issues = [];

    if (!m || (!m.dep && !m.arr)) {
      if (misActive.has(did))  // 평소 MIS 쓰는 사람이 그날만 빠뜨린 경우만
        issues.push(`📋 MIS 미기록 (트럭 ${hhmm(w.ws)}~${hhmm(w.we)}, ${w.spanHrs.toFixed(1)}h 외근했는데 출발/도착 입력 없음)`);
    } else {
      // 차고지 로딩(출발 전)·언로딩(복귀 후) 때문에 MIS가 트럭보다 이른 출발/늦은 도착인 건 정상.
      // 물리적으로 이상한 방향만 플래그.
      const dDep = toMin(m.dep), dArr = toMin(m.arr);
      const tDep = toMin(hhmm(w.ws)), tArr = toMin(hhmm(w.we));
      if (dDep != null && tDep != null && dDep - tDep >= TIME_DIFF_MIN)  // MIS 출발이 트럭보다 늦음
        issues.push(`🕐 MIS 출발 ${m.dep}인데 트럭은 ${hhmm(w.ws)}에 이미 떠남 (${dDep-tDep}분 늦게 기록)`);
      if (dArr != null && tArr != null && tArr - dArr >= TIME_DIFF_MIN)  // MIS 도착이 트럭 복귀보다 이름
        issues.push(`🕐 MIS 도착 ${m.arr}인데 트럭은 ${hhmm(w.we)}에 복귀 (${tArr-dArr}분 일찍 기록 — 복귀 전)`);
    }
    if (w.spanHrs >= LONG_DAY_HRS) issues.push(`🔴 트럭 ${w.spanHrs.toFixed(1)}h 외근 (과다)`);

    if (issues.length) findings.push({ name, day, issues });
  }
  return findings.sort((a, b) => a.day.localeCompare(b.day) || a.name.localeCompare(b.name));
}

function buildSummary(findings, label) {
  if (!findings.length) return `🚚 *근태 자동점검 [${label}]*\n✅ MIS×Samsara 이상 없음`;
  const lines = [`🚚 *근태 자동점검 [${label}]* (ADP 제외, MIS×트럭)`, `이상 ${findings.length}건`];
  findings.slice(0, 40).forEach(f => {
    lines.push(`\n*${f.name} ${f.day.slice(5)}*`);
    f.issues.forEach(i => lines.push(`• ${i}`));
  });
  if (findings.length > 40) lines.push(`\n…외 ${findings.length - 40}건`);
  return lines.join('\n');
}

// ── 메인 핸들러 ──────────────────────────────────────
module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  const isVercelCron = req.headers['x-vercel-cron'] === '1';
  const token = req.query.token || req.headers['x-cron-token'];
  if (!isVercelCron && token !== CRON_SECRET) return res.status(401).json({ success: false, error: 'Unauthorized' });
  if (!SAMSARA_TOKEN) return res.status(500).json({ success: false, error: 'SAMSARA_TOKEN env 미설정' });
  if (!WEBHOOK) return res.status(500).json({ success: false, error: 'GOI_ATTENDANCE_WEBHOOK env 미설정' });

  try {
    const now = new Date();
    const todayYMD = torontoYMD(now);
    const yesterday = addDays(todayYMD, -1);
    // mode: query 우선, 아니면 월요일이면 weekly
    const dow = new Date(todayYMD + 'T12:00:00Z').getUTCDay(); // 1=월
    const mode = req.query.mode || (dow === 1 ? 'weekly' : 'daily');

    let fromYMD, toYMD, days, label;
    if (mode === 'weekly') {
      fromYMD = addDays(todayYMD, -7); toYMD = yesterday; label = `주간 ${fromYMD.slice(5)}~${toYMD.slice(5)}`;
    } else {
      fromYMD = yesterday; toYMD = yesterday; label = `일간 ${yesterday.slice(5)}`;
    }
    days = []; for (let d = fromYMD; d <= toYMD; d = addDays(d, 1)) days.push(d);

    const { id2name, key2id } = await fetchDrivers();
    const ids = Object.keys(id2name);
    const startISO = dayStartUTC(fromYMD);
    const endISO = dayStartUTC(addDays(toYMD, 1));
    const [windows, mis] = await Promise.all([
      fetchWorkWindows(ids, startISO, endISO),
      fetchMis(fromYMD, toYMD, key2id),
    ]);
    const findings = crossCheck(windows, mis, id2name, days);
    await sendChat(buildSummary(findings, label));
    return res.status(200).json({ success: true, mode, label, findings: findings.length });
  } catch (e) {
    return res.status(500).json({ success: false, error: String(e && e.message || e) });
  }
};
