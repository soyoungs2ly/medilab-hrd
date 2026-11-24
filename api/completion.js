// 수료 확인: 이름 + 생년월일(6자리)로 본인의 교육 수료 현황만 돌려줍니다.
// 버셀 환경 변수: SUPABASE_URL, SUPABASE_SECRET_KEY (문의 접수와 같은 값)
// 슈파베이스 표: completions, lookup_attempts (supabase/completions.sql 참고)

const crypto = require('crypto');

const COURSES = ['리더십 과정', '신입 사원 과정', '법정교육'];
const MAX_TRIES_PER_HOUR = 10;   // 같은 접속 위치에서 1시간에 조회할 수 있는 횟수

function sbHeaders(key, extra) {
  const h = Object.assign({ apikey: key, 'Content-Type': 'application/json' }, extra || {});
  if (key.startsWith('eyJ')) h.Authorization = 'Bearer ' + key;
  return h;
}

module.exports = async (req, res) => {
  const send = (code, body) => res.status(code).json(body);
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') return send(405, { ok: false, error: '허용되지 않은 요청입니다.' });

  const { SUPABASE_URL, SUPABASE_SECRET_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) return send(500, { ok: false, error: '서버 설정이 끝나지 않았습니다.' });

  let b = req.body;
  if (typeof b === 'string') { try { b = JSON.parse(b); } catch { b = {}; } }
  b = b || {};

  const name = typeof b.name === 'string' ? b.name.replace(/\s+/g, '').slice(0, 31) : '';
  const birth = typeof b.birth === 'string' ? b.birth.trim() : '';
  if (!name || name.length > 30) return send(400, { ok: false, error: '이름을 정확히 입력해 주세요.' });
  if (!/^\d{6}$/.test(birth)) return send(400, { ok: false, error: '생년월일은 숫자 6자리로 입력해 주세요. (예: 900115)' });

  const base = SUPABASE_URL.replace(/\/$/, '') + '/rest/v1/';
  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  const ipHash = crypto.createHash('sha256').update(ip + '|' + SUPABASE_SECRET_KEY).digest('hex').slice(0, 32);

  try {
    // 1) 조회 횟수 제한: 남의 생년월일을 여러 번 넣어 보는 시도를 막습니다.
    const since = new Date(Date.now() - 3600 * 1000).toISOString();
    const cr = await fetch(base + 'lookup_attempts?select=id&ip_hash=eq.' + ipHash + '&created_at=gte.' + encodeURIComponent(since), {
      headers: sbHeaders(SUPABASE_SECRET_KEY, { Prefer: 'count=exact', Range: '0-0' })
    });
    if (!cr.ok) {
      console.error('attempt count failed', cr.status, await cr.text());
      return send(503, { ok: false, error: '조회 중 문제가 생겼습니다. 잠시 후 다시 시도해 주세요.' });
    }
    const tries = Number((cr.headers.get('content-range') || '').split('/')[1]);
    if (!Number.isFinite(tries) || tries >= MAX_TRIES_PER_HOUR) {
      return send(429, { ok: false, error: '조회 횟수를 넘었습니다. 1시간 뒤에 다시 시도해 주세요.' });
    }
    await fetch(base + 'lookup_attempts', {
      method: 'POST',
      headers: sbHeaders(SUPABASE_SECRET_KEY, { Prefer: 'return=minimal' }),
      body: JSON.stringify({ ip_hash: ipHash })
    });

    // 2) 본인 기록만 가져오기 (이름은 띄어쓰기 없이 비교)
    const q = base + 'completions?select=course,status,completed_on&name_key=eq.' + encodeURIComponent(name) + '&birth=eq.' + birth;
    const r = await fetch(q, { headers: sbHeaders(SUPABASE_SECRET_KEY) });
    if (!r.ok) {
      console.error('completion lookup failed', r.status, await r.text());
      return send(503, { ok: false, error: '조회 중 문제가 생겼습니다. 잠시 후 다시 시도해 주세요.' });
    }
    const rows = await r.json();
    if (!Array.isArray(rows) || rows.length === 0) {
      return send(404, { ok: false, error: '일치하는 교육 대상자 정보가 없습니다. 이름과 생년월일을 확인해 주세요.' });
    }

    // 3) 과정 3개 기준으로 정리 (기록이 없는 과정은 '대상 아님')
    const result = COURSES.map(course => {
      const row = rows.find(x => x.course === course);
      if (!row) return { course, status: '대상 아님', date: null };
      return { course, status: row.status === '수료' ? '수료' : (row.status === '진행 중' ? '진행 중' : '미수료'), date: row.status === '수료' ? (row.completed_on || null) : null };
    });
    return send(200, { ok: true, result });
  } catch (e) {
    console.error(e);
    return send(500, { ok: false, error: '조회 중 문제가 생겼습니다. 잠시 후 다시 시도해 주세요.' });
  }
};
