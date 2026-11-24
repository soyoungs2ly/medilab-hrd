// 홈페이지 문의를 받아 슈파베이스 표에 저장하고, 리센드로 알림 메일을 보냅니다.
// 버셀 환경 변수: SUPABASE_URL, SUPABASE_SECRET_KEY, RESEND_API_KEY, NOTIFY_EMAIL

const DAILY_LIMIT = 50;          // 하루 접수 한도
const MIN_FILL_MS = 3000;        // 3초보다 빨리 제출하면 자동 등록으로 판단
const LIMITS = { name: 30, dept: 50, phone: 20, message: 1000 };

function clean(v, max) {
  let s = typeof v === 'string' ? v : '';
  s = s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim();
  if (s.length > max) return null;
  // 수식 입력 차단: = + - @ 탭 으로 시작하면 앞에 ' 를 붙여 글자로 저장
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return s;
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function sbHeaders(key, extra) {
  const h = Object.assign({ apikey: key, 'Content-Type': 'application/json' }, extra || {});
  if (key.startsWith('eyJ')) h.Authorization = 'Bearer ' + key; // 예전 방식 키 대응
  return h;
}

// 한국 시간 오늘 0시 (UTC 기준 ISO)
function kstMidnightIso() {
  const now = new Date(Date.now() + 9 * 3600 * 1000);
  const midnightKst = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - 9 * 3600 * 1000;
  return new Date(midnightKst).toISOString();
}

module.exports = async (req, res) => {
  const send = (code, body) => res.status(code).json(body);

  if (req.method !== 'POST') return send(405, { ok: false, error: '허용되지 않은 요청입니다.' });

  const { SUPABASE_URL, SUPABASE_SECRET_KEY, RESEND_API_KEY, NOTIFY_EMAIL } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) return send(500, { ok: false, error: '서버 설정이 끝나지 않았습니다.' });

  let b = req.body;
  if (typeof b === 'string') { try { b = JSON.parse(b); } catch { b = {}; } }
  b = b || {};

  // 자동 등록 차단: 숨은 칸이 채워졌거나, 너무 빨리 제출된 경우
  if (b.website) return send(200, { ok: true });
  const started = Number(b.startedAt);
  if (!started || Date.now() - started < MIN_FILL_MS) {
    return send(400, { ok: false, error: '잠시 후 다시 보내 주세요.' });
  }

  const name = clean(b.name, LIMITS.name);
  const dept = clean(b.dept, LIMITS.dept);
  // 연락처는 숫자·기호만 허용하므로 앞에 ' 를 붙이지 않고 검사합니다.
  const phoneRaw = typeof b.phone === 'string' ? b.phone.trim() : '';
  const phone = phoneRaw.length > LIMITS.phone ? null : phoneRaw;
  const message = clean(b.message, LIMITS.message);

  if (name === null || dept === null || phone === null || message === null) {
    return send(400, { ok: false, error: '입력할 수 있는 글자 수를 넘었습니다.' });
  }
  if (!name) return send(400, { ok: false, error: '이름을 입력해 주세요.' });
  if (!phone || !/^[0-9\-+ ()]{7,20}$/.test(phone)) return send(400, { ok: false, error: '연락처를 올바르게 입력해 주세요.' });
  if (!message) return send(400, { ok: false, error: '문의 내용을 입력해 주세요.' });
  if (b.agree !== true) return send(400, { ok: false, error: '개인정보 수집·이용에 동의해 주세요.' });

  const base = SUPABASE_URL.replace(/\/$/, '') + '/rest/v1/inquiries';

  try {
    // 하루 접수 한도 확인
    const cr = await fetch(base + '?select=id&created_at=gte.' + encodeURIComponent(kstMidnightIso()), {
      headers: sbHeaders(SUPABASE_SECRET_KEY, { Prefer: 'count=exact', Range: '0-0' })
    });
    // 개수를 확인하지 못하면 한도 검사를 건너뛰지 않고 접수를 멈춥니다.
    if (!cr.ok) {
      console.error('supabase count failed', cr.status, await cr.text());
      return send(503, { ok: false, error: '접수 중 문제가 생겼습니다. 잠시 후 다시 시도해 주세요.' });
    }
    const range = cr.headers.get('content-range') || '';
    const today = Number(range.split('/')[1]);
    if (!Number.isFinite(today) || today >= DAILY_LIMIT) {
      return send(429, { ok: false, error: '오늘 접수 가능한 문의가 마감되었습니다. 내일 다시 보내 주세요.' });
    }

    // 표에 한 줄 저장 (상태는 기본값 '신규')
    const ir = await fetch(base, {
      method: 'POST',
      headers: sbHeaders(SUPABASE_SECRET_KEY, { Prefer: 'return=minimal' }),
      body: JSON.stringify({ name, dept, phone, message })
    });
    if (!ir.ok) {
      console.error('supabase insert failed', ir.status, await ir.text());
      return send(500, { ok: false, error: '접수 중 문제가 생겼습니다. 잠시 후 다시 시도해 주세요.' });
    }
  } catch (e) {
    console.error(e);
    return send(500, { ok: false, error: '접수 중 문제가 생겼습니다. 잠시 후 다시 시도해 주세요.' });
  }

  // 알림 메일 (실패해도 접수는 완료로 처리)
  if (RESEND_API_KEY && NOTIFY_EMAIL) {
    try {
      const mr = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + RESEND_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: '메디랩코리아 홈페이지 <onboarding@resend.dev>',
          to: [NOTIFY_EMAIL],
          subject: '[사내 교육 문의] ' + name.replace(/[\r\n]+/g, ' ') + '님',
          html:
            '<h2>새 교육 문의가 접수되었습니다</h2>' +
            '<p><b>이름</b>: ' + esc(name) + '<br><b>소속</b>: ' + esc(dept || '-') +
            '<br><b>연락처</b>: ' + esc(phone) + '</p>' +
            '<p><b>문의 내용</b><br>' + esc(message).replace(/\n/g, '<br>') + '</p>' +
            '<p style="color:#888">슈파베이스 inquiries 표에서 상태를 바꿔 관리하세요.</p>'
        })
      });
      if (!mr.ok) console.error('resend failed', mr.status, await mr.text());
    } catch (e) { console.error(e); }
  }

  return send(200, { ok: true });
};
