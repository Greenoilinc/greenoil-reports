// 드라이버 개인 채팅방으로 메시지 발송 (근태 타임라인의 💬 버튼이 호출)
// 브라우저(file://)에서 직접 Google Chat webhook 호출은 CORS로 막히므로 이 프록시 경유.
const https = require('https');

const MESSAGE_TOKEN = process.env.MESSAGE_TOKEN || '';  // 타임라인 HTML에 embed된 토큰과 일치해야 함

// HR/ADP 안내용 별도 채널(HR_DRIVER_WEBHOOKS). 미설정 시 기존 타겟 채널(DRIVER_WEBHOOKS)로 폴백.
function driverWebhooks() {
  try {
    const hr = JSON.parse(process.env.HR_DRIVER_WEBHOOKS || '{}');
    if (Object.keys(hr).length) return hr;
  } catch (e) { /* fall through */ }
  try { return JSON.parse(process.env.DRIVER_WEBHOOKS || '{}'); } catch (e) { return {}; }
}

function postChat(webhookUrl, text) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ text });
    const u = new URL(webhookUrl);
    const req = https.request({
      hostname: u.hostname, path: u.pathname + u.search, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (r) => { let d = ''; r.on('data', c => d += c); r.on('end', () => r.statusCode === 200 ? resolve() : reject(new Error('Chat HTTP ' + r.statusCode))); });
    req.on('error', reject); req.write(body); req.end();
  });
}

module.exports = async (req, res) => {
  // CORS (file:// 오리진은 null이므로 * 허용)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ success: false, error: 'POST only' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body || '{}'); } catch (e) { body = {}; } }
  const { driver, text, token } = body || {};

  if (!MESSAGE_TOKEN || token !== MESSAGE_TOKEN)
    return res.status(401).json({ success: false, error: '인증 실패 (MESSAGE_TOKEN 불일치)' });
  if (!text || !String(text).trim())
    return res.status(400).json({ success: false, error: '빈 메시지' });

  const wh = driverWebhooks()[driver];
  if (!wh) return res.status(404).json({ success: false, error: `${driver} webhook 미설정 (DRIVER_WEBHOOKS에 없음)` });

  try {
    await postChat(wh, String(text));
    return res.status(200).json({ success: true, driver });
  } catch (e) {
    return res.status(500).json({ success: false, error: String(e && e.message || e) });
  }
};
