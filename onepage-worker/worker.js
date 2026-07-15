// ============================================================
// Cloudflare Worker: onepage-api.memoryking.workers.dev
// 원페이지 학습 서비스 — 인증·콘텐츠·결제 게이트·추천·진도
// ============================================================
//
// 데이터 분리:
//   Airtable (사람·돈) — OnepageUsers / OnepageChapterAccess /
//                        OnepagePayments(외부) / OnepagePointTx
//   nocodebackend (콘텐츠) — op_chapters / op_topics / op_subtopics /
//                            op_items / op_understood / op_pings
//
// Worker는 결제 webhook과 만료 알림에 관여하지 않음.
// 결제는 사용자님 자체 흐름 → Airtable Payments에 행 추가 → Automation이
// ChapterAccess upsert + 추천 보너스 적립.
// ============================================================

const ALLOWED_ORIGINS = [
  'https://memoryking.github.io',
  'https://vipup.site',
  'https://www.vipup.site',
  'https://onepage.vipup.site',
  'https://memoryking.kr',
  'https://www.memoryking.kr',
  'http://localhost:3000',
  'http://localhost:8080',
  'http://127.0.0.1:5500',
];
// Vercel 자동 도메인 (*.vercel.app) 패턴 매칭도 허용
const ALLOWED_ORIGIN_PATTERNS = [
  /^https:\/\/[a-z0-9-]+\.vercel\.app$/i,
];

const NCB_BASE = 'https://openapi.nocodebackend.com';
const NCB_INSTANCE = '55910_flashcard_app';

const AT_BASE_URL = 'https://api.airtable.com/v0';
const AT_USERS = 'OnepageUsers';
const AT_ACCESS = 'OnepageChapterAccess';
const AT_POINTTX = 'OnepagePointTx';
const AT_UNKNOWN = 'UnknownPayments';
const AT_FAILED = 'FailedPayments';
const AT_CAMPAIGN_SENDS = 'OnepageCampaignSends';

const REFERRAL_BONUS = 1000;
const REDEEM_COST = 3000;
const REDEEM_DAYS = 30;
const PING_WINDOW_MIN = 5;

const PAYAPP_API_URL = 'https://api.payapp.kr/oapi/apiLoad.html';
const STUDENT_APP_ORIGIN = 'https://memoryking.kr';

// ── CORS ──────────────────────────────────────────────────────
function isAllowedOrigin(origin) {
  if (!origin) return false;
  if (ALLOWED_ORIGINS.includes(origin)) return true;
  return ALLOWED_ORIGIN_PATTERNS.some(p => p.test(origin));
}
function corsHeaders(request) {
  const origin = request.headers.get('Origin') || '';
  const allowed = isAllowedOrigin(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
  };
}

function json(data, status = 200, request) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(request) },
  });
}

// ── KST 시간 ──────────────────────────────────────────────────
function kstNow() { return new Date(Date.now() + 9 * 3600 * 1000); }
function kstDateStr(d = kstNow()) { return d.toISOString().split('T')[0]; }
function kstISOString(d = kstNow()) { return d.toISOString(); }
// MySQL DATETIME 형식 (YYYY-MM-DD HH:MM:SS) — nocodebackend가 이것만 받음
function kstDateTime(d = kstNow()) {
  return d.toISOString().slice(0, 19).replace('T', ' ');
}
function addDays(iso, days) {
  const d = new Date(iso);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString();
}

// ── 간격 반복 (Leitner) v2 ──────────────────────────────────
// Box 1~6: 1=오늘, 2=내일, 3=4일 후, 4=8일 후, 5=16일 후, 6=32일 후
// 박스 진입 시점에 today + BOX_DUE_DAYS[box] 가 next_review_at.
const BOX_DUE_DAYS = [null, 0, 1, 4, 8, 16, 32]; // 인덱스 0 미사용
function nextReviewForBox(box) {
  const safeBox = Math.min(Math.max(Number(box) || 1, 1), 6);
  const days = BOX_DUE_DAYS[safeBox];
  const due = new Date(kstNow().getTime() + days * 24 * 3600 * 1000);
  return kstDateTime(due);
}

// 이전 시스템 호환용 (handleUnderstoodToggle 와 handleUnderstoodAdvance 가 아직 사용 중)
const SRS_INTERVALS_DAYS = [0, 1, 2, 4, 8, 16, 32];
function srsNextReviewAt(box) {
  const safeBox = Math.min(Math.max(Number(box) || 1, 1), 6);
  const days = SRS_INTERVALS_DAYS[safeBox];
  const due = new Date(kstNow().getTime() + days * 24 * 3600 * 1000);
  return kstDateTime(due);
}

// ── 정규화 / 검증 ────────────────────────────────────────────
function normalizePhone(p) { return String(p || '').replace(/\D/g, ''); }
function isValidPhone(p) { return /^01[016789]\d{7,8}$/.test(normalizePhone(p)); }
function isValidEmail(e) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(e || '')); }

// ── PBKDF2 비밀번호 해싱 ──────────────────────────────────────
async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']
  );
  const hash = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
    keyMaterial, 256
  );
  return btoa(String.fromCharCode(...salt)) + ':' + btoa(String.fromCharCode(...new Uint8Array(hash)));
}

async function verifyPassword(password, stored) {
  try {
    const [saltB64, hashB64] = String(stored).split(':');
    const salt = Uint8Array.from(atob(saltB64), c => c.charCodeAt(0));
    const keyMaterial = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']
    );
    const hash = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
      keyMaterial, 256
    );
    return btoa(String.fromCharCode(...new Uint8Array(hash))) === hashB64;
  } catch { return false; }
}

// ── JWT (HMAC-SHA256) ─────────────────────────────────────────
function utf8ToBase64url(s) {
  const bytes = new TextEncoder().encode(s);
  let bin = ''; for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function base64urlToUtf8(b64) {
  let s = b64.replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '=';
  const bin = atob(s); const bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}
function bytesToBase64url(buf) {
  let bin = ''; for (const b of new Uint8Array(buf)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function base64urlToBytes(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '=';
  return Uint8Array.from(atob(s), c => c.charCodeAt(0));
}
async function jwtSign(payload, secret, expSec = 60 * 60 * 24 * 30) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const body = { ...payload, exp: Math.floor(Date.now() / 1000) + expSec };
  const headerB = utf8ToBase64url(JSON.stringify(header));
  const bodyB = utf8ToBase64url(JSON.stringify(body));
  const data = headerB + '.' + bodyB;
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  return data + '.' + bytesToBase64url(sig);
}
async function jwtVerify(token, secret) {
  try {
    const [headerB, bodyB, sigB] = token.split('.');
    if (!headerB || !bodyB || !sigB) return null;
    const data = headerB + '.' + bodyB;
    const key = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']
    );
    const ok = await crypto.subtle.verify(
      'HMAC', key, base64urlToBytes(sigB), new TextEncoder().encode(data)
    );
    if (!ok) return null;
    const payload = JSON.parse(base64urlToUtf8(bodyB));
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch { return null; }
}

// ── 추천 코드 생성 ─────────────────────────────────────────────
function makeReferralCode() {
  const chars = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  let out = '';
  for (let i = 0; i < 6; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

// ── nocodebackend 헬퍼 ───────────────────────────────────────
function ncbUrl(path, extra = '') {
  const sep = extra ? '&' : '';
  return `${NCB_BASE}${path}?Instance=${NCB_INSTANCE}${sep}${extra}`;
}
const ncbH = (env) => ({
  'Content-Type': 'application/json',
  'Authorization': `Bearer ${env.NCB_SECRET_KEY}`,
});

async function ncbCreate(env, table, data) {
  const res = await fetch(ncbUrl(`/create/${table}`), {
    method: 'POST', headers: ncbH(env), body: JSON.stringify(data),
  });
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch {}
  console.log(`[NCB CREATE ${table}] ${res.status} body=${text.slice(0,300)} sent=${JSON.stringify(data).slice(0,200)}`);
  if (!res.ok || !body || (!body.id && body.status !== 'success' && body.status !== undefined)) {
    const err = new Error(`nocodebackend create failed: ${res.status} ${text}`);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}
async function ncbRead(env, table, filters = '') {
  const r = await fetch(ncbUrl(`/read/${table}`, filters), { headers: ncbH(env) });
  return r.json();
}
async function ncbSearch(env, table, query) {
  const r = await fetch(ncbUrl(`/search/${table}`), {
    method: 'POST', headers: ncbH(env), body: JSON.stringify(query),
  });
  return r.json();
}
async function ncbUpdate(env, table, id, data) {
  const r = await fetch(ncbUrl(`/update/${table}/${id}`), {
    method: 'PUT', headers: ncbH(env), body: JSON.stringify(data),
  });
  return r.json();
}
async function ncbDelete(env, table, id) {
  const r = await fetch(ncbUrl(`/delete/${table}/${id}`), {
    method: 'DELETE', headers: ncbH(env),
  });
  return r.json();
}
async function ncbReadById(env, table, id) {
  const r = await ncbRead(env, table, `id=${id}&limit=1`);
  return Array.isArray(r?.data) ? r.data[0] : null;
}

// ── Airtable 헬퍼 ────────────────────────────────────────────
const atH = (env) => ({
  'Authorization': 'Bearer ' + env.AIRTABLE_TOKEN,
  'Content-Type': 'application/json',
});

async function atFindOne(env, table, formula) {
  const url = `${AT_BASE_URL}/${env.AIRTABLE_BASE}/${encodeURIComponent(table)}?filterByFormula=${encodeURIComponent(formula)}&maxRecords=1`;
  const r = await fetch(url, { headers: atH(env) });
  const j = await r.json();
  return (j.records && j.records[0]) || null;
}
async function atFindAll(env, table, formula, max = 100) {
  const url = `${AT_BASE_URL}/${env.AIRTABLE_BASE}/${encodeURIComponent(table)}?filterByFormula=${encodeURIComponent(formula)}&maxRecords=${max}`;
  const r = await fetch(url, { headers: atH(env) });
  const j = await r.json();
  return j.records || [];
}
async function atCreate(env, table, fields) {
  const url = `${AT_BASE_URL}/${env.AIRTABLE_BASE}/${encodeURIComponent(table)}`;
  const r = await fetch(url, {
    method: 'POST', headers: atH(env),
    body: JSON.stringify({ fields, typecast: true }),
  });
  return r.json();
}
async function atCreateBatch(env, table, recordsArray) {
  const url = `${AT_BASE_URL}/${env.AIRTABLE_BASE}/${encodeURIComponent(table)}`;
  const out = [];
  for (let i = 0; i < recordsArray.length; i += 10) {
    const batch = recordsArray.slice(i, i + 10);
    const r = await fetch(url, {
      method: 'POST', headers: atH(env),
      body: JSON.stringify({
        records: batch.map(fields => ({ fields })),
        typecast: true,
      }),
    });
    out.push(await r.json());
  }
  return out;
}
async function atUpdate(env, table, recordId, fields) {
  const url = `${AT_BASE_URL}/${env.AIRTABLE_BASE}/${encodeURIComponent(table)}/${recordId}`;
  const r = await fetch(url, {
    method: 'PATCH', headers: atH(env),
    body: JSON.stringify({ fields, typecast: true }),
  });
  return r.json();
}
async function atDelete(env, table, recordId) {
  const url = `${AT_BASE_URL}/${env.AIRTABLE_BASE}/${encodeURIComponent(table)}/${recordId}`;
  const r = await fetch(url, { method: 'DELETE', headers: atH(env) });
  return r.json();
}

// ── User 조회 ────────────────────────────────────────────────
async function findUserByEmail(env, email) {
  return atFindOne(env, AT_USERS, `LOWER({email})="${String(email).toLowerCase().replace(/"/g, '\\"')}"`);
}
async function findUserByPhone(env, phone) {
  return atFindOne(env, AT_USERS, `{phone}="${normalizePhone(phone)}"`);
}
async function findUserByReferralCode(env, code) {
  return atFindOne(env, AT_USERS, `{referral_code}="${String(code).toUpperCase().replace(/"/g, '')}"`);
}

// ── 인증 미들웨어 ────────────────────────────────────────────
async function verifyAuth(request, env) {
  const auth = request.headers.get('Authorization') || '';
  const m = auth.match(/^Bearer\s+(.+)$/);
  if (!m) return null;
  return await jwtVerify(m[1], env.JWT_SECRET);
}

// ── 구독 게이트 ──────────────────────────────────────────────
async function getActiveChapterIds(env, phone) {
  if (!phone) return new Set();
  const today = kstISOString();
  const records = await atFindAll(env, AT_ACCESS,
    `AND({user_phone}="${phone}", IS_AFTER({expires_at}, "${today}"))`, 100);
  return new Set(records.map(r => Number(r.fields.chapter_id)).filter(Boolean));
}

async function getChapterAccessMap(env, phone) {
  if (!phone) return {};
  const records = await atFindAll(env, AT_ACCESS, `{user_phone}="${phone}"`, 100);
  const out = {};
  for (const r of records) {
    const cid = Number(r.fields.chapter_id);
    if (!cid) continue;
    out[cid] = {
      expires_at: r.fields.expires_at || null,
      source: r.fields.source || null,
    };
  }
  return out;
}

// ── 콘텐츠 트리 탐색 (게이트 판정) ───────────────────────────
async function getSubtopicGate(env, subtopicId) {
  // 반환: { topicId, chapterId, isFree }
  const sub = await ncbReadById(env, 'op_subtopics', subtopicId);
  if (!sub) return null;
  const topic = await ncbReadById(env, 'op_topics', sub.topic_id);
  if (!topic) return null;
  const chapter = await ncbReadById(env, 'op_chapters', topic.chapter_id);
  return {
    topicId: sub.topic_id,
    chapterId: topic.chapter_id,
    isFree: !!Number(topic.is_free) || !!Number(chapter?.is_all_free),
  };
}

// ============================================================
// 핸들러 — 인증
// ============================================================

async function handleSignup(request, env) {
  const body = await request.json().catch(() => ({}));
  const name = String(body.name || '').trim();
  const phone = normalizePhone(body.phone);
  const email = String(body.email || '').trim().toLowerCase();
  const password = String(body.password || '');
  const referralCode = body.referral_code ? String(body.referral_code).toUpperCase().trim() : null;

  // UTM 어트리뷰션 — 가입 시 한 번만 기록 (이후 불변)
  const utm = body.utm || {};
  const utmFields = {
    utm_source: String(utm.source || '').slice(0, 80),
    utm_medium: String(utm.medium || '').slice(0, 80),
    utm_campaign: String(utm.campaign || '').slice(0, 120),
    utm_content: String(utm.content || '').slice(0, 120),
    utm_term: String(utm.term || '').slice(0, 120),
    landing_url: String(utm.landing_url || '').slice(0, 500),
    referrer_url: String(utm.referrer || '').slice(0, 500),
  };

  // 관심 주제 — URL ?interest=수능,토익 으로 전달된 값. 콤마 구분, 추후 사용자 편집 가능
  const interestsList = Array.isArray(body.interests)
    ? body.interests
    : String(body.interests || '').split(',');
  const interests = interestsList.map(s => String(s).trim()).filter(Boolean).slice(0, 20);

  if (!name) return json({ error: '이름을 입력하세요.' }, 400, request);
  if (!isValidPhone(phone)) return json({ error: '전화번호 형식이 올바르지 않습니다.' }, 400, request);
  if (!isValidEmail(email)) return json({ error: '이메일 형식이 올바르지 않습니다.' }, 400, request);
  if (password.length < 6) return json({ error: '비밀번호는 6자 이상이어야 합니다.' }, 400, request);

  if (await findUserByEmail(env, email)) {
    return json({ error: '이미 가입된 이메일입니다.' }, 409, request);
  }
  if (await findUserByPhone(env, phone)) {
    return json({ error: '이미 가입된 전화번호입니다.' }, 409, request);
  }

  // 추천 코드 유효성 (있을 때만)
  let referrer = null;
  if (referralCode) {
    referrer = await findUserByReferralCode(env, referralCode);
    if (!referrer) return json({ error: '유효하지 않은 추천 코드입니다.' }, 400, request);
  }

  // referral_code 생성 (충돌 시 재시도)
  let myCode = null;
  for (let i = 0; i < 5; i++) {
    const c = makeReferralCode();
    if (!await findUserByReferralCode(env, c)) { myCode = c; break; }
  }
  if (!myCode) return json({ error: '추천 코드 생성 실패. 잠시 후 다시 시도하세요.' }, 500, request);

  const pwHash = await hashPassword(password);
  const created = await atCreate(env, AT_USERS, {
    name, phone, email, password_hash: pwHash, role: 'student',
    referral_code: myCode,
    referred_by_code: referralCode || '',
    point: 0,
    interests: interests.join(','),
    ...utmFields,
  });
  if (created.error || !created.id) {
    return json({ error: '가입 처리 실패: ' + (created.error?.message || 'unknown') }, 500, request);
  }

  const token = await jwtSign({
    rid: created.id, phone, email, role: 'student', name, ref: myCode,
  }, env.JWT_SECRET);

  return json({
    token,
    user: { name, phone, email, role: 'student', point: 0, referral_code: myCode },
  }, 200, request);
}

async function handleLogin(request, env) {
  const body = await request.json().catch(() => ({}));
  const email = String(body.email || '').trim().toLowerCase();
  const password = String(body.password || '');
  if (!email || !password) return json({ error: '이메일/비밀번호를 입력하세요.' }, 400, request);

  const rec = await findUserByEmail(env, email);
  if (!rec) return json({ error: '계정을 찾을 수 없습니다.' }, 404, request);
  const f = rec.fields;
  if (!await verifyPassword(password, f.password_hash || '')) {
    return json({ error: '비밀번호가 일치하지 않습니다.' }, 401, request);
  }

  const token = await jwtSign({
    rid: rec.id,
    phone: f.phone || '',
    email: f.email || '',
    role: f.role || 'student',
    name: f.name || '',
    ref: f.referral_code || '',
  }, env.JWT_SECRET);

  return json({
    token,
    user: {
      name: f.name, phone: f.phone, email: f.email,
      role: f.role, point: Number(f.point) || 0,
      referral_code: f.referral_code,
    },
  }, 200, request);
}

async function handleMe(request, env) {
  const auth = await verifyAuth(request, env);
  if (!auth) return json({ error: 'unauthenticated' }, 401, request);

  const rec = await findUserByPhone(env, auth.phone);
  if (!rec) return json({ error: 'user_not_found' }, 404, request);
  const f = rec.fields;
  const access = await getChapterAccessMap(env, auth.phone);

  return json({
    user: {
      name: f.name, phone: f.phone, email: f.email,
      role: f.role || 'student',
      point: Number(f.point) || 0,
      referral_code: f.referral_code,
      first_paid_at: f.first_paid_at || null,
      interests: parseInterests(f.interests),
      chapter_order: parseChapterOrder(f.chapter_order),
    },
    chapter_access: access, // { chapter_id: { expires_at, source } }
  }, 200, request);
}

// 콤마 구분 문자열 또는 배열 → 정제된 배열
function parseInterests(raw) {
  if (Array.isArray(raw)) return raw.map(s => String(s).trim()).filter(Boolean);
  return String(raw || '').split(',').map(s => s.trim()).filter(Boolean);
}

// JSON 문자열 → 챕터 순서 객체 { 과목: [id, id, ...] }. 잘못된 데이터는 빈 객체.
function parseChapterOrder(raw) {
  if (!raw) return {};
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw;
  try {
    const obj = JSON.parse(String(raw));
    return (obj && typeof obj === 'object' && !Array.isArray(obj)) ? obj : {};
  } catch { return {}; }
}

// POST /auth/change-password — 현재 비밀번호 검증 후 새 비밀번호로 교체
async function handleChangePassword(request, env) {
  const auth = await verifyAuth(request, env);
  if (!auth) return json({ error: 'unauthenticated' }, 401, request);
  const body = await request.json().catch(() => ({}));
  const oldPw = String(body.old_password || '');
  const newPw = String(body.new_password || '');
  if (!oldPw || !newPw) return json({ error: '현재/새 비밀번호 모두 입력하세요.' }, 400, request);
  if (newPw.length < 6) return json({ error: '새 비밀번호는 6자 이상이어야 합니다.' }, 400, request);

  const rec = await findUserByPhone(env, auth.phone);
  if (!rec) return json({ error: 'user_not_found' }, 404, request);
  const ok = await verifyPassword(oldPw, rec.fields.password_hash || '');
  if (!ok) return json({ error: '현재 비밀번호가 일치하지 않습니다.' }, 401, request);

  const newHash = await hashPassword(newPw);
  const result = await atUpdate(env, AT_USERS, rec.id, { password_hash: newHash });
  if (result && result.error) {
    return json({ error: 'update_failed', detail: result.error }, 500, request);
  }
  return json({ ok: true }, 200, request);
}

// 휴대폰 가운데 자리 마스킹 — 010-1234-5678 → 010****5678
function maskPhone(phone) {
  const d = String(phone || '').replace(/\D/g, '');
  if (d.length < 7) return d;
  const head = d.slice(0, 3);
  const tail = d.slice(-4);
  return head + '*'.repeat(Math.max(1, d.length - 7)) + tail;
}

// POST /auth/forgot-password — 이메일로 사용자 찾고 휴대폰으로 6자리 코드 SMS
// 보안: 이메일 미존재 시에도 200 OK 응답해서 가입자 enumeration 차단
async function handleForgotPassword(request, env) {
  const body = await request.json().catch(() => ({}));
  const email = String(body.email || '').trim().toLowerCase();
  if (!email) return json({ error: '이메일을 입력하세요.' }, 400, request);

  const rec = await findUserByEmail(env, email);
  if (!rec) {
    // 존재 여부를 숨김 — UI는 "코드를 보냈습니다"로 동일하게 안내
    return json({ ok: true, sent: false }, 200, request);
  }
  const phone = rec.fields.phone || '';
  if (!phone) {
    return json({ ok: false, error: '이 계정에 휴대폰이 등록돼 있지 않습니다. 관리자에게 문의하세요.' }, 400, request);
  }

  // 6자리 코드(000000~999999), 10분 유효
  const code = String(Math.floor(Math.random() * 1000000)).padStart(6, '0');
  const expiresAt = kstISOString(new Date(kstNow().getTime() + 10 * 60 * 1000));

  await atUpdate(env, AT_USERS, rec.id, {
    reset_code: code,
    reset_code_expires_at: expiresAt,
  });

  // Pabbly 웹훅으로 SMS 발송.
  // 권장: 비밀번호 재설정 전용 워크플로우(Webhook→SOLAPI, ChatGPT 없음)를 만들고
  //       PABBLY_RESET_WEBHOOK_URL 에 그 URL을 설정하세요. ChatGPT가 코드를 변형할 위험 차단.
  // 미설정 시 기존 캠페인 웹훅(PABBLY_WEBHOOK_URL)을 사용 — Pabbly 측에서 template=password_reset
  // 일 때 ChatGPT 단계를 우회하도록 라우터를 구성해 두어야 합니다.
  const webhookUrl = env.PABBLY_RESET_WEBHOOK_URL || env.PABBLY_WEBHOOK_URL || '';
  if (webhookUrl) {
    const message = `[원페이지] 비밀번호 재설정 코드: ${code} (10분 유효). 본인이 요청하지 않았다면 무시하세요.`;
    try {
      await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          template: 'password_reset',
          channel: 'sms',
          name: rec.fields.name || '',
          phone,
          email: rec.fields.email || '',
          code,
          custom_message: message,
          sent_at: kstISOString(),
        }),
      });
    } catch (e) {
      console.error('forgot_password_webhook_failed', e);
      // 웹훅 실패해도 코드는 저장돼 있으니 200으로 응답 (재시도 가능)
    }
  } else {
    console.warn('PABBLY_WEBHOOK_URL not set — SMS not actually sent. Reset code:', code);
  }

  return json({ ok: true, sent: true, phone_masked: maskPhone(phone) }, 200, request);
}

// POST /auth/reset-password — 코드 검증 후 비밀번호 변경
async function handleResetPassword(request, env) {
  const body = await request.json().catch(() => ({}));
  const email = String(body.email || '').trim().toLowerCase();
  const code = String(body.code || '').trim();
  const newPw = String(body.new_password || '');

  if (!email || !code || !newPw) return json({ error: '이메일·코드·새 비밀번호를 모두 입력하세요.' }, 400, request);
  if (newPw.length < 6) return json({ error: '새 비밀번호는 6자 이상이어야 합니다.' }, 400, request);
  if (!/^\d{6}$/.test(code)) return json({ error: '인증 코드는 6자리 숫자입니다.' }, 400, request);

  const rec = await findUserByEmail(env, email);
  if (!rec) return json({ error: '코드가 일치하지 않거나 만료됐습니다.' }, 400, request);

  const storedCode = String(rec.fields.reset_code || '');
  const expiresAt = String(rec.fields.reset_code_expires_at || '');
  if (!storedCode || storedCode !== code) {
    return json({ error: '코드가 일치하지 않거나 만료됐습니다.' }, 400, request);
  }
  if (!expiresAt || expiresAt < kstISOString()) {
    return json({ error: '코드가 만료됐습니다. 다시 요청하세요.' }, 400, request);
  }

  const newHash = await hashPassword(newPw);
  const result = await atUpdate(env, AT_USERS, rec.id, {
    password_hash: newHash,
    reset_code: '',
    reset_code_expires_at: '',
  });
  if (result && result.error) {
    return json({ error: 'update_failed', detail: result.error }, 500, request);
  }
  return json({ ok: true }, 200, request);
}

// PUT /auth/me/chapter_order — 사용자가 챕터 순서 드래그로 변경 시 동기화
//   body: { chapter_order: { 과목: [id, id, ...] } }
//   클라이언트에서 디바운스 후 호출.
async function handleUpdateChapterOrder(request, env) {
  const auth = await verifyAuth(request, env);
  if (!auth) return json({ error: 'unauthenticated' }, 401, request);
  const body = await request.json().catch(() => ({}));
  const orderMap = body.chapter_order;
  if (!orderMap || typeof orderMap !== 'object' || Array.isArray(orderMap)) {
    return json({ error: 'chapter_order must be an object' }, 400, request);
  }
  // 정제: 각 키는 과목명(최대 80자), 값은 양수 정수 배열 (최대 100개). 과목 50개 한도.
  const clean = {};
  let subjectCount = 0;
  for (const [subj, ids] of Object.entries(orderMap)) {
    if (subjectCount >= 50) break;
    if (!Array.isArray(ids)) continue;
    const cleanIds = ids.map(Number).filter(n => Number.isFinite(n) && n > 0).slice(0, 100);
    if (cleanIds.length > 0) {
      clean[String(subj).slice(0, 80)] = cleanIds;
      subjectCount++;
    }
  }
  const jsonStr = JSON.stringify(clean);
  if (jsonStr.length > 10000) {
    return json({ error: 'chapter_order too large' }, 400, request);
  }
  const rec = await findUserByPhone(env, auth.phone);
  if (!rec) return json({ error: 'user_not_found' }, 404, request);
  const result = await atUpdate(env, AT_USERS, rec.id, { chapter_order: jsonStr });
  if (result && result.error) {
    return json({ error: 'airtable_update_failed', detail: result.error }, 500, request);
  }
  return json({ ok: true, chapter_order: clean }, 200, request);
}

// PUT /auth/me/interests — 사용자가 관심 주제 편집
async function handleUpdateInterests(request, env) {
  const auth = await verifyAuth(request, env);
  if (!auth) return json({ error: 'unauthenticated' }, 401, request);
  const body = await request.json().catch(() => ({}));
  const list = Array.isArray(body.interests)
    ? body.interests
    : String(body.interests || '').split(',');
  const interests = list.map(s => String(s).trim()).filter(Boolean).slice(0, 20);
  const rec = await findUserByPhone(env, auth.phone);
  if (!rec) return json({ error: 'user_not_found' }, 404, request);
  const joined = interests.join(',');
  console.log(`[INTERESTS UPDATE] phone=${auth.phone} interests="${joined}" recId=${rec.id}`);
  const result = await atUpdate(env, AT_USERS, rec.id, { interests: joined });
  if (result && result.error) {
    console.log(`[INTERESTS UPDATE FAIL] ${JSON.stringify(result.error)}`);
    return json({ error: 'airtable_update_failed', detail: result.error }, 500, request);
  }
  return json({ ok: true, interests, saved: joined }, 200, request);
}

async function handleReferralInfo(request, env) {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  if (!code) return json({ error: 'missing_code' }, 400, request);
  const rec = await findUserByReferralCode(env, code);
  if (!rec) return json({ valid: false }, 200, request);
  const name = String(rec.fields.name || '');
  const masked = name.length <= 1 ? name : name[0] + '*'.repeat(name.length - 1);
  return json({ valid: true, name_masked: masked }, 200, request);
}

// ============================================================
// 핸들러 — 챕터/토픽/학습 카드 (CRUD)
// ============================================================

// 챕터 목록 캐시 — 모든 사용자 공통 메타데이터, 사용자별 데이터(주문/구독/관심)는 별개 endpoint
//   캐시 키: role + subject 조합. TTL 5분 (s-maxage=300).
//   변경(POST/PUT/DELETE) 시 purgeChapterCache() 로 자동 무효화.
const CHAPTERS_CACHE_TTL = 300; // 5분
function chaptersCacheKey(role, subject) {
  return new Request(
    `https://opcache.local/chapters?role=${role}&subject=${encodeURIComponent(subject || '')}`,
    { method: 'GET' }
  );
}
async function purgeChapterCache() {
  // 학생·교사 캐시 둘 다 + subject 없는 기본 키 purge.
  // subject 필터 캐시들은 TTL 만료(5분) 의존 — 어차피 자주 안 쓰임.
  try {
    const cache = caches.default;
    await Promise.all([
      cache.delete(chaptersCacheKey('student', '')),
      cache.delete(chaptersCacheKey('teacher', '')),
    ]);
  } catch {}
}

async function handleListChapters(request, env, ctx) {
  const url = new URL(request.url);
  const subject = url.searchParams.get('subject') || '';

  // 1) auth 먼저 (역할 판정용 — JWT는 DB 조회 없이 빠름 ~10ms)
  const auth = await verifyAuth(request, env);
  const isTeacher = auth && auth.role === 'teacher';
  const role = isTeacher ? 'teacher' : 'student';
  const cacheKey = chaptersCacheKey(role, subject);
  const cache = caches.default;

  // 2) 캐시 히트 확인 — 응답에 CORS 헤더가 빠져있으니 데이터만 꺼내 새 json 생성
  try {
    const hit = await cache.match(cacheKey);
    if (hit) {
      const payload = await hit.json();
      return json(payload, 200, request);
    }
  } catch {}

  // 3) 캐시 미스 — nocodebackend에서 fetch
  const base = subject ? `subject=${encodeURIComponent(subject)}` : '';
  const filter = base ? `${base}&limit=2000` : 'limit=2000';
  const r = await ncbRead(env, 'op_chapters', filter);
  // 학생에겐 비공개(is_published=0) 챕터 숨김. 선생님은 모두 노출.
  // is_published 컬럼이 없거나 null이면 publish=1로 간주 (기존 데이터 호환)
  let list = r.data || [];
  if (!isTeacher) {
    list = list.filter(c => {
      const v = c.is_published;
      return v === undefined || v === null || Number(v) !== 0;
    });
  }
  list.sort((a, b) =>
    (a.subject || '').localeCompare(b.subject || '') ||
    (Number(a.sort_order) || 0) - (Number(b.sort_order) || 0) ||
    (Number(a.id) || 0) - (Number(b.id) || 0)
  );
  const payload = { chapters: list };

  // 4) 캐시에 저장 — 백그라운드로(응답 지연 X). ctx 없으면 await로 fallback.
  const toCache = new Response(JSON.stringify(payload), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, s-maxage=${CHAPTERS_CACHE_TTL}` },
  });
  if (ctx && ctx.waitUntil) {
    ctx.waitUntil(cache.put(cacheKey, toCache));
  } else {
    try { await cache.put(cacheKey, toCache); } catch {}
  }

  return json(payload, 200, request);
}

async function handleCreateChapter(request, env, user) {
  const b = await request.json().catch(() => ({}));
  const data = {
    subject: String(b.subject || '').trim(),
    title: String(b.title || '').trim(),
    sort_order: Number(b.sort_order) || 0,
    icon: String(b.icon || '').trim(),
    description: String(b.description || ''),
    monthly_price: Number(b.monthly_price) || 3000,
    is_all_free: b.is_all_free ? 1 : 0,
    is_published: b.is_published ? 1 : 0,  // 신규 챕터 기본 비공개 (선생님이 명시적 공개)
    pay_url: String(b.pay_url || '').trim(),
    voice_quiz_enabled: b.voice_quiz_enabled ? 1 : 0,
    voice_quiz_lang: ['ko-KR', 'en-US'].includes(b.voice_quiz_lang) ? b.voice_quiz_lang : 'ko-KR',
    voice_quiz_read_question: b.voice_quiz_read_question === undefined ? 1 : (b.voice_quiz_read_question ? 1 : 0),
    updated_at: kstDateTime(),
  };
  if (!data.subject || !data.title) return json({ error: 'subject, title 필수' }, 400, request);
  const r = await ncbCreate(env, 'op_chapters', data);
  await purgeChapterCache();
  return json({ ok: true, id: r.id, chapter: { ...data, id: r.id } }, 200, request);
}

async function handleUpdateChapter(request, env, user, id) {
  const b = await request.json().catch(() => ({}));
  const patch = {};
  if (b.subject !== undefined) patch.subject = String(b.subject).trim();
  if (b.title !== undefined) patch.title = String(b.title).trim();
  if (b.sort_order !== undefined) patch.sort_order = Number(b.sort_order) || 0;
  if (b.icon !== undefined) patch.icon = String(b.icon).trim();
  if (b.description !== undefined) patch.description = String(b.description);
  if (b.monthly_price !== undefined) patch.monthly_price = Number(b.monthly_price) || 3000;
  if (b.is_all_free !== undefined) patch.is_all_free = b.is_all_free ? 1 : 0;
  if (b.is_published !== undefined) patch.is_published = b.is_published ? 1 : 0;
  if (b.pay_url !== undefined) patch.pay_url = String(b.pay_url).trim();
  if (b.voice_quiz_enabled !== undefined) patch.voice_quiz_enabled = b.voice_quiz_enabled ? 1 : 0;
  if (b.voice_quiz_lang !== undefined) {
    patch.voice_quiz_lang = ['ko-KR', 'en-US'].includes(b.voice_quiz_lang) ? b.voice_quiz_lang : 'ko-KR';
  }
  if (b.voice_quiz_read_question !== undefined) patch.voice_quiz_read_question = b.voice_quiz_read_question ? 1 : 0;
  patch.updated_at = kstDateTime();
  const r = await ncbUpdate(env, 'op_chapters', id, patch);
  await purgeChapterCache();
  return json({ ok: true, result: r }, 200, request);
}

async function handleDeleteChapter(request, env, user, id) {
  // FK CASCADE로 자식 자동 정리
  await ncbDelete(env, 'op_chapters', id);
  await purgeChapterCache();
  return json({ ok: true }, 200, request);
}

async function handleListTopics(request, env) {
  const url = new URL(request.url);
  const chapterId = url.searchParams.get('chapter_id');
  if (!chapterId) return json({ error: 'chapter_id required' }, 400, request);
  const r = await ncbRead(env, 'op_topics', `chapter_id=${chapterId}&limit=2000`);
  const topics = (r.data || []).sort((a, b) =>
    (Number(a.sort_order) || 0) - (Number(b.sort_order) || 0) ||
    (Number(a.id) || 0) - (Number(b.id) || 0)
  );
  // 각 토픽의 학습 카드를 병렬 fetch — 한꺼번에 가져와 count + 캐시
  const subsArr = await Promise.all(
    topics.map(t => ncbRead(env, 'op_subtopics', `topic_id=${t.id}&limit=200`))
  );
  topics.forEach((t, i) => {
    const subs = (subsArr[i] && subsArr[i].data) || [];
    t.subtopic_count = subs.length;
    // 클라이언트가 별도 /subtopics 호출 없이 바로 쓰도록 동봉 + image unwrap
    t.subtopics = subs
      .map(s => ({ ...s, image_b64: unwrapImg(s.image_b64) }))
      .sort((a, b) =>
        (Number(a.sort_order) || 0) - (Number(b.sort_order) || 0) ||
        (Number(a.id) || 0) - (Number(b.id) || 0)
      );
  });
  return json({ topics }, 200, request);
}

async function handleCreateTopic(request, env) {
  const b = await request.json().catch(() => ({}));
  const data = {
    chapter_id: Number(b.chapter_id),
    title: String(b.title || '').trim(),
    sort_order: Number(b.sort_order) || 0,
    is_free: b.is_free ? 1 : 0,
    updated_at: kstDateTime(),
  };
  if (!data.chapter_id || !data.title) return json({ error: 'chapter_id, title 필수' }, 400, request);
  const r = await ncbCreate(env, 'op_topics', data);
  return json({ ok: true, id: r.id, topic: { ...data, id: r.id } }, 200, request);
}

async function handleUpdateTopic(request, env, id) {
  const b = await request.json().catch(() => ({}));
  const patch = {};
  if (b.title !== undefined) patch.title = String(b.title).trim();
  if (b.sort_order !== undefined) patch.sort_order = Number(b.sort_order) || 0;
  if (b.is_free !== undefined) patch.is_free = b.is_free ? 1 : 0;
  if (b.chapter_id !== undefined) patch.chapter_id = Number(b.chapter_id);
  patch.updated_at = kstDateTime();
  await ncbUpdate(env, 'op_topics', id, patch);
  return json({ ok: true }, 200, request);
}

async function handleDeleteTopic(request, env, id) {
  await ncbDelete(env, 'op_topics', id);
  return json({ ok: true }, 200, request);
}

async function handleListSubtopics(request, env) {
  const url = new URL(request.url);
  const topicId = url.searchParams.get('topic_id');
  if (!topicId) return json({ error: 'topic_id required' }, 400, request);
  const r = await ncbRead(env, 'op_subtopics', `topic_id=${topicId}&limit=200`);
  const subs = (r.data || [])
    .map(s => ({ ...s, image_b64: unwrapImg(s.image_b64) }))
    .sort((a, b) =>
      (Number(a.sort_order) || 0) - (Number(b.sort_order) || 0) ||
      (Number(a.id) || 0) - (Number(b.id) || 0)
    );
  return json({ subtopics: subs }, 200, request);
}

async function handleCreateSubtopic(request, env) {
  const b = await request.json().catch(() => ({}));
  const data = {
    topic_id: Number(b.topic_id),
    title: String(b.title || '').trim(),
    sort_order: Number(b.sort_order) || 0,
    image_b64: b.image_b64 ? wrapImg(b.image_b64) : null,
    caption: String(b.caption || ''),
    updated_at: kstDateTime(),
  };
  if (!data.topic_id || !data.title) return json({ error: 'topic_id, title 필수' }, 400, request);
  const r = await ncbCreate(env, 'op_subtopics', data);
  return json({
    ok: true, id: r.id,
    subtopic: { ...data, image_b64: unwrapImg(data.image_b64), id: r.id }
  }, 200, request);
}

async function handleUpdateSubtopic(request, env, id) {
  const b = await request.json().catch(() => ({}));
  const patch = {};
  if (b.title !== undefined) patch.title = String(b.title).trim();
  if (b.sort_order !== undefined) patch.sort_order = Number(b.sort_order) || 0;
  if (b.topic_id !== undefined) patch.topic_id = Number(b.topic_id);
  if (b.image_b64 !== undefined) patch.image_b64 = b.image_b64 ? wrapImg(b.image_b64) : null;
  if (b.caption !== undefined) patch.caption = String(b.caption || '');
  patch.updated_at = kstDateTime();
  await ncbUpdate(env, 'op_subtopics', id, patch);
  return json({ ok: true }, 200, request);
}

async function handleDeleteSubtopic(request, env, id) {
  await ncbDelete(env, 'op_subtopics', id);
  return json({ ok: true }, 200, request);
}

// ============================================================
// 핸들러 — 내용 블록 (items) + 구독 게이트
// ============================================================

// ── 단어풀(op_pool) 참조 — 영단어·한자 카드 뒷면을 풀에서 조합 ─────────────
// op_items.text 가 "@@WORD:ability@@" 마커면, 서빙 시 op_pool[ability] 로 뒷면 HTML 조합해 치환.
// → 풀 수정 후 op_pool 갱신만으로 그 단어가 든 모든 콘텐츠가 자동 반영. (앞면=subtopic.name, 이미지=앱 자동)
const OP_WORD_RE = /^@@WORD:([^@]+)@@$/;
function opHtmlEsc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
function composeWordCardHTML(r) {
  const e = opHtmlEsc, p = [];
  if (r.pronunciation)      p.push(`<p class="wp-pron">${e(r.pronunciation)}</p>`);
  if (r.meaning)            p.push(`<p class="wp-meaning"><b>뜻</b> ${e(r.meaning)}</p>`);
  if (r.sound_association)  p.push(`<p class="wp-sa"><b>암기법</b> ${e(r.sound_association)}</p>`);
  if (r.mnemonic_detail)    p.push(`<p class="wp-detail">${e(r.mnemonic_detail)}</p>`);
  if (r.example1_en)        p.push(`<p class="wp-ex">${e(r.example1_en)}${r.example1_ko ? `<br><span class="wp-ex-ko">${e(r.example1_ko)}</span>` : ''}</p>`);
  if (r.example2_en)        p.push(`<p class="wp-ex">${e(r.example2_en)}${r.example2_ko ? `<br><span class="wp-ex-ko">${e(r.example2_ko)}</span>` : ''}</p>`);
  if (r.video_url)          p.push(`<p class="wp-video"><a href="${e(r.video_url)}" target="_blank" rel="noopener">▶ 동영상</a></p>`);
  return p.join('\n');   // 이미지는 학생 앱이 wordImageFor(subtopic)로 자동 삽입 → 여기 미포함
}
function opPoolCacheKey(word) { return new Request(`https://oppool.local/w/${encodeURIComponent(word)}`); }
async function getPoolRow(env, word) {
  const cache = caches.default, key = opPoolCacheKey(word);
  try { const hit = await cache.match(key); if (hit) return await hit.json(); } catch {}
  let row = null;
  try {
    const r = await ncbRead(env, 'op_pool', `word=${encodeURIComponent(word)}&limit=1`);
    row = (r.data && r.data[0]) || null;
  } catch {}
  try { await cache.put(key, new Response(JSON.stringify(row), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 's-maxage=600' } })); } catch {}
  return row;
}
async function derefWordItems(env, items) {
  const out = [];
  for (const it of items) {
    const m = String(it.text || '').trim().match(OP_WORD_RE);
    if (m) {
      const row = await getPoolRow(env, m[1].trim().toLowerCase());
      out.push({ ...it, kind: 'html', text: row ? composeWordCardHTML(row) : '', word: m[1].trim().toLowerCase() });
    } else out.push(it);
  }
  return out;
}
// POST /admin/op_pool/sync — 로컬 push_op_pool.py 가 배치(≤20)로 op_pool upsert (word 키). teacherGate 뒤.
async function handleOpPoolSync(request, env) {
  const b = await request.json().catch(() => ({}));
  const rows = Array.isArray(b.rows) ? b.rows : [];
  if (!rows.length) return json({ error: 'rows required' }, 400, request);
  let created = 0, updated = 0, failed = 0;
  const cache = caches.default;
  for (const r0 of rows.slice(0, 20)) {   // 서브리퀘스트 한도 감안 배치 ≤20
    const word = String(r0.word || '').trim().toLowerCase();
    if (!word) { failed++; continue; }
    const data = {
      word, display_word: r0.display_word || '', meaning: r0.meaning || '', pronunciation: r0.pronunciation || '',
      sound_association: r0.sound_association || '', mnemonic_detail: r0.mnemonic_detail || '',
      example1_en: r0.example1_en || '', example1_ko: r0.example1_ko || '',
      example2_en: r0.example2_en || '', example2_ko: r0.example2_ko || '',
      image_url: r0.image_url || '', video_url: r0.video_url || '', subject: r0.subject || 'en',
      updated_at: kstDateTime(),
    };
    try {
      const found = await ncbRead(env, 'op_pool', `word=${encodeURIComponent(word)}&limit=1`);
      const ex = found && found.data && found.data[0];
      if (ex && ex.id) { await ncbUpdate(env, 'op_pool', ex.id, data); updated++; }
      else { await ncbCreate(env, 'op_pool', data); created++; }
      try { await cache.delete(opPoolCacheKey(word)); } catch {}
    } catch (e) { failed++; }
  }
  return json({ ok: true, created, updated, failed, took: Math.min(rows.length, 20) }, 200, request);
}

async function handleListItems(request, env) {
  const url = new URL(request.url);
  const subId = url.searchParams.get('subtopic_id');
  if (!subId) return json({ error: 'subtopic_id required' }, 400, request);

  const auth = await verifyAuth(request, env);

  // 선생님: 게이트 우회 — items만 한 번 fetch
  if (auth && auth.role === 'teacher') {
    const r = await ncbRead(env, 'op_items', `subtopic_id=${subId}&limit=200`);
    const items = (r.data || [])
      .map(it => ({ ...it, image_b64: unwrapImg(it.image_b64) }))
      .sort((a, b) =>
        (Number(a.sort_order) || 0) - (Number(b.sort_order) || 0) ||
        (Number(a.id) || 0) - (Number(b.id) || 0)
      );
    return json({ items: await derefWordItems(env, items) }, 200, request);
  }

  // 학생: 게이트 체크 + items fetch를 병렬로 (게이트 실패 시 items 버림)
  const [gate, itemsRes] = await Promise.all([
    getSubtopicGate(env, subId),
    ncbRead(env, 'op_items', `subtopic_id=${subId}&limit=200`),
  ]);
  if (!gate) return json({ error: 'subtopic_not_found' }, 404, request);

  if (!gate.isFree) {
    if (!auth) return json({ error: 'login_required', chapter_id: gate.chapterId }, 401, request);
    const active = await getActiveChapterIds(env, auth.phone);
    if (!active.has(Number(gate.chapterId))) {
      return json({ error: 'subscription_required', chapter_id: gate.chapterId }, 402, request);
    }
  }

  const items = (itemsRes.data || [])
    .map(it => ({ ...it, image_b64: unwrapImg(it.image_b64) }))
    .sort((a, b) =>
      (Number(a.sort_order) || 0) - (Number(b.sort_order) || 0) ||
      (Number(a.id) || 0) - (Number(b.id) || 0)
    );
  return json({ items: await derefWordItems(env, items) }, 200, request);
}

// nocodebackend REST API가 image_b64를 JSON-유효 값으로 검증 →
// 평문 문자열은 거부하니 JSON.stringify로 한 번 감싸 보내고 읽을 때 unwrap
function wrapImg(s) { return s ? JSON.stringify(String(s)) : null; }
function unwrapImg(s) {
  if (s == null) return '';
  if (typeof s === 'string' && s.startsWith('"') && s.endsWith('"')) {
    try { return JSON.parse(s); } catch {}
  }
  return s;
}

// 허용 kind 값 — 알려진 값만 저장, 나머지는 'text'로 fallback
const ITEM_KINDS = new Set(['text', 'image', 'link', 'html', 'svg']);
function normalizeKind(k) { return ITEM_KINDS.has(k) ? k : 'text'; }

async function handleCreateItem(request, env) {
  const b = await request.json().catch(() => ({}));
  const kind = normalizeKind(b.kind);
  // SVG에 흔한 <?xml ...?> XML 선언 + DOCTYPE 제거 — 일부 백엔드가 거부함
  let textVal = kind === 'image' ? '' : String(b.text || '');
  if (kind === 'svg' && textVal) {
    textVal = textVal
      .replace(/<\?xml[^?]*\?>/gi, '')
      .replace(/<!DOCTYPE[^>]*>/gi, '')
      .trim();
  }
  const data = {
    subtopic_id: Number(b.subtopic_id),
    kind,
    // html/svg/link/text 는 text 필드에 본문 저장. image만 image_b64 사용.
    text: textVal,
    image_b64: kind === 'image' ? wrapImg(b.image_b64) : null,
    caption: String(b.caption || ''),
    sort_order: Number(b.sort_order) || 0,
    updated_at: kstDateTime(),
  };
  if (!data.subtopic_id) return json({ error: 'subtopic_id 필수' }, 400, request);
  try {
    const r = await ncbCreate(env, 'op_items', data);
    return json({
      ok: true, id: r.id,
      item: { ...data, image_b64: unwrapImg(data.image_b64), id: r.id }
    }, 200, request);
  } catch (e) {
    // nocodebackend 에러 그대로 노출 — 사용자가 원인 파악 가능
    return json({
      error: 'create_failed',
      message: String(e?.message || e).slice(0, 500),
      kind, text_length: data.text.length,
    }, 500, request);
  }
}

async function handleUpdateItem(request, env, id) {
  const b = await request.json().catch(() => ({}));
  const patch = {};
  if (b.kind !== undefined) patch.kind = normalizeKind(b.kind);
  if (b.text !== undefined) patch.text = String(b.text || '');
  if (b.image_b64 !== undefined) patch.image_b64 = wrapImg(b.image_b64);
  if (b.caption !== undefined) patch.caption = String(b.caption || '');
  if (b.sort_order !== undefined) patch.sort_order = Number(b.sort_order) || 0;
  patch.updated_at = kstDateTime();
  await ncbUpdate(env, 'op_items', id, patch);
  return json({ ok: true }, 200, request);
}

async function handleDeleteItem(request, env, id) {
  await ncbDelete(env, 'op_items', id);
  return json({ ok: true }, 200, request);
}

// 일괄 sort_order 갱신 — 드래그앤드롭 재정렬용. ordered_ids 순서대로 1부터 부여.
// start_index 로 클라이언트 청크 분할 지원 (한 호출 ~30개씩, MAX_REQ 40 한도 안전).
async function handleReorder(request, env, table) {
  const b = await request.json().catch(() => ({}));
  const ids = Array.isArray(b.ordered_ids) ? b.ordered_ids.map(Number).filter(Boolean) : [];
  const startIndex = Number(b.start_index) || 0;
  if (!ids.length) return json({ error: 'ordered_ids required' }, 400, request);
  if (ids.length > 40) return json({ error: 'too many ids (chunk to 30 max per call)' }, 400, request);
  let updated = 0;
  for (let i = 0; i < ids.length; i++) {
    await ncbUpdate(env, table, ids[i], {
      sort_order: startIndex + i + 1,
      updated_at: kstDateTime(),
    });
    updated++;
  }
  return json({ ok: true, updated }, 200, request);
}

// ============================================================
// 일괄 입력 (TSV: 목차\t학습 카드\t내용)
// ============================================================

// Excel TSV: 셀에 줄바꿈이 있으면 셀 전체를 따옴표("...")로 감쌈.
// raw 텍스트를 "줄(=한 row) 단위"로 정확히 자르는 헬퍼.
// 핵심: `"`는 셀의 첫 글자(파일 시작·탭·줄바꿈 직후)일 때만 quote 모드 시작.
// 셀 중간의 stray `"`(영어 단어 안에 등장하는 인용부호 등)는 일반 문자로 취급.
// → 사용자 TSV에 미닫힌 quote가 있어도 다음 행을 삼키지 않음.
function tsvLines(text) {
  const out = [];
  let buf = '';
  let inQuote = false;
  let atCellStart = true; // 파일 시작 또는 직전이 \t/\n/\r
  const s = String(text || '');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '"') {
      if (inQuote) {
        // 이중 따옴표("") = 이스케이프된 "
        if (s[i + 1] === '"') { buf += '""'; i++; }
        else { inQuote = false; buf += ch; }
      } else if (atCellStart) {
        inQuote = true;
        buf += ch;
      } else {
        // 셀 중간의 stray " — 그냥 문자
        buf += ch;
      }
      atCellStart = false;
    } else if (ch === '\t' && !inQuote) {
      buf += ch;
      atCellStart = true;
    } else if ((ch === '\n' || ch === '\r') && !inQuote) {
      if (ch === '\r' && s[i + 1] === '\n') i++;
      out.push(buf); buf = '';
      atCellStart = true;
    } else {
      buf += ch;
      atCellStart = false;
    }
  }
  if (buf.length) out.push(buf);
  return out;
}
// "cell" 안의 따옴표를 벗기고, 이스케이프된 ""를 "로 복원
function unquote(c) {
  c = c == null ? '' : String(c);
  if (c.length >= 2 && c[0] === '"' && c[c.length - 1] === '"') {
    c = c.slice(1, -1).replace(/""/g, '"');
  }
  return c.trim();
}

function parseTSV(text) {
  // 새 포맷:
  //   목차(A) | 학습 카드(B) | 내용1(C) | 내용2(D) | 내용3(E) | ...
  //   각 행은 한 학습 카드이고 C열부터 여러 내용 칸이 가로로 나열됨
  //   목차 칸이 비어 있으면 이전 목차에 계속
  const lines = tsvLines(text);
  const rows = [];
  let topicTitle = null;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (!raw.trim() && !raw.includes('\t')) continue; // 완전 빈 줄
    const cols = raw.split('\t').map(unquote);
    const a = cols[0] || '';
    const b = cols[1] || '';
    // C열부터 끝까지가 그 학습 카드의 내용 항목들
    const items = cols.slice(2).filter(c => c.length > 0);

    // 헤더 자동 스킵
    if (i === 0 && (a === '목차' || a === '대목차' || a === 'topic' || a === 'Topic')) continue;

    // 새 목차
    if (a) topicTitle = a;

    if (b) {
      if (!topicTitle) return { error: `${i + 1}행: 목차가 정해지지 않았습니다.` };
      if (!items.length) return { error: `${i + 1}행: 학습 카드 '${b}'에 내용이 없습니다 (3번째 칸부터 내용 입력).` };
      // VARCHAR(255) 제한 — 긴 지문을 학습 카드에 넣으면 nocodebackend가 422를 던집니다
      if (topicTitle.length > 255) {
        return { error: `${i + 1}행: 목차 제목이 너무 깁니다 (${topicTitle.length}자, 최대 255자). 본문은 내용 칸(C열~)에 넣으세요.` };
      }
      if (b.length > 255) {
        return { error: `${i + 1}행: 학습 카드 제목이 너무 깁니다 (${b.length}자, 최대 255자). 지문/문제 본문은 내용 칸(C열~)에 넣으세요. (현재 학습 카드 첫 60자: "${b.slice(0, 60)}…")` };
      }
      for (const text of items) {
        rows.push({ line: i + 1, topic: topicTitle, sub: b, text });
      }
    } else if (items.length) {
      return { error: `${i + 1}행: 학습 카드 칸이 비어 있는데 내용만 있습니다.` };
    }
  }

  return { rows };
}

// Cloudflare Workers 서브요청 한도(Free 50 / Paid 1000) 회피를 위한 청크 처리.
// 매 호출에 안전 한도(MAX_REQ) 만큼만 처리하고 next_start·맵을 돌려보냄.
// 클라이언트가 done=true 될 때까지 반복 호출.
async function handleBulkImport(request, env, chapterId) {
  const b = await request.json().catch(() => ({}));
  // mode: 'append' (기본) | 'merge' (제목 매칭 + 내용만 교체, 학습 기록 보존) | 'replace' (목차 삭제 후 신규)
  const mode = b.mode === 'replace' ? 'replace' : (b.mode === 'merge' ? 'merge' : 'append');
  const text = String(b.tsv || b.text || '');
  const start = Number(b.start) || 0;
  const topicMap = new Map(Object.entries(b.topic_map || {}).map(([k, v]) => [k, Number(v)]));
  const subMap = new Map(Object.entries(b.sub_map || {}).map(([k, v]) => [k, Number(v)]));
  // merge 모드 전용 — 청크 간 상태 유지
  const originalSubIds = new Set((b.original_sub_ids || []).map(Number));
  const clearedSubs = new Set((b.cleared_subs || []).map(Number));
  const initialTopicIds = new Set((b.initial_topic_ids || []).map(Number));
  const loadedTopicSubs = new Set((b.loaded_topic_subs || []).map(Number));
  const baseSort = Number(b.base_sort) || 0;

  const MAX_REQ = 35; // 50 - 안전 마진. merge 모드는 read+delete+create 누적이라 wall time 보호 필요

  const chapter = await ncbReadById(env, 'op_chapters', chapterId);
  if (!chapter) return json({ error: 'chapter_not_found' }, 404, request);

  const parsed = parseTSV(text);
  if (parsed.error) return json({ error: parsed.error }, 400, request);
  if (!parsed.rows.length) return json({ error: '내용이 없습니다.' }, 400, request);

  let used = 1; // chapter read
  let topicBase = baseSort;
  let createdT = 0, createdS = 0, createdI = 0;

  // 첫 호출(start=0)에서만 초기 작업
  if (start === 0) {
    const exist = await ncbRead(env, 'op_topics', `chapter_id=${chapterId}&limit=2000`);
    used++;
    const existTopics = exist.data || [];
    if (mode === 'replace') {
      for (const t of existTopics) {
        if (used >= MAX_REQ) break; // 너무 많이 지워야 하면 다음 호출에서
        await ncbDelete(env, 'op_topics', t.id);
        used++;
      }
    } else {
      // append·merge: 기존 토픽을 topicMap에 채움 → TSV 동일 이름이 와도 중복 생성 X
      for (const t of existTopics) {
        const title = String(t.title || '');
        if (title && !topicMap.has(title)) topicMap.set(title, Number(t.id));
        topicBase = Math.max(topicBase, Number(t.sort_order) || 0);
        // merge: 어떤 토픽이 "원래 있던 것"인지 기록 (지연 로딩에 사용)
        if (mode === 'merge') initialTopicIds.add(Number(t.id));
      }
      // merge: 학습 카드는 토픽별로 지연 로딩 (init budget 보호) → 루프 안에서 처음 만났을 때 1회 로딩
    }
  }
  let tOrd = topicBase + 1;

  let i = start;
  let mergeItemsDeleted = 0;
  const itemQueue = []; // Phase 2 병렬 생성용 — 5개씩 묶어 Promise.all
  while (i < parsed.rows.length) {
    const row = parsed.rows[i];
    if (!topicMap.has(row.topic)) {
      if (used + itemQueue.length + 1 > MAX_REQ) break;
      const r = await ncbCreate(env, 'op_topics', {
        chapter_id: Number(chapterId),
        title: row.topic,
        sort_order: tOrd++,
        is_free: 0,
        updated_at: kstDateTime(),
      });
      topicMap.set(row.topic, Number(r.id));
      used++; createdT++;
    }
    const topicId = topicMap.get(row.topic);

    // merge: 기존 토픽이면 그 토픽의 학습 카드들을 한 번만 로딩 (지연 prepopulate)
    if (mode === 'merge' && initialTopicIds.has(topicId) && !loadedTopicSubs.has(topicId)) {
      if (used + itemQueue.length + 1 > MAX_REQ) break;
      const subResp = await ncbRead(env, 'op_subtopics', `topic_id=${topicId}&limit=2000`);
      used++;
      for (const s of (subResp.data || [])) {
        const key = topicId + '|' + String(s.title || '');
        if (!subMap.has(key)) subMap.set(key, Number(s.id));
        originalSubIds.add(Number(s.id));
      }
      loadedTopicSubs.add(topicId);
    }

    const subKey = topicId + '|' + row.sub;
    if (!subMap.has(subKey)) {
      if (used + itemQueue.length + 1 > MAX_REQ) break;
      const r = await ncbCreate(env, 'op_subtopics', {
        topic_id: Number(topicId),
        title: row.sub,
        sort_order: subMap.size + 1,
        updated_at: kstDateTime(),
      });
      subMap.set(subKey, Number(r.id));
      used++; createdS++;
    }
    const subId = subMap.get(subKey);

    // merge: 원래 있던 학습 카드면 기존 items 한 번 비움 (subtopic_id는 그대로 → 학습 기록 보존)
    if (mode === 'merge' && originalSubIds.has(subId) && !clearedSubs.has(subId)) {
      if (used + itemQueue.length + 1 > MAX_REQ) break;
      const itemResp = await ncbRead(env, 'op_items', `subtopic_id=${subId}&limit=2000`);
      used++;
      const existingItems = itemResp.data || [];
      const DELETE_BATCH = 5;
      let deletedAll = true;
      for (let k = 0; k < existingItems.length; k += DELETE_BATCH) {
        const remaining = MAX_REQ - used - itemQueue.length;
        if (remaining <= 0) { deletedAll = false; break; }
        const slice = existingItems.slice(k, Math.min(k + DELETE_BATCH, k + remaining));
        await Promise.all(slice.map(it => ncbDelete(env, 'op_items', it.id)));
        used += slice.length;
        mergeItemsDeleted += slice.length;
        if (k + slice.length < existingItems.length && used + itemQueue.length >= MAX_REQ) {
          deletedAll = false; break;
        }
      }
      if (deletedAll) {
        clearedSubs.add(subId);
      } else {
        break;
      }
    }

    // item은 즉시 생성하지 않고 큐에 쌓음 (Phase 2에서 5개씩 병렬 생성)
    if (used + itemQueue.length + 1 > MAX_REQ) break;
    itemQueue.push({
      subtopic_id: Number(subId),
      kind: 'text',
      text: row.text,
      image_b64: null,
      caption: '',
      sort_order: i + 1,
      updated_at: kstDateTime(),
    });
    i++;
  }

  // Phase 2: item 큐를 5개씩 병렬 생성 — wall time 1/5로 단축
  const CREATE_BATCH = 5;
  for (let k = 0; k < itemQueue.length; k += CREATE_BATCH) {
    const slice = itemQueue.slice(k, k + CREATE_BATCH);
    await Promise.all(slice.map(payload => ncbCreate(env, 'op_items', payload)));
    used += slice.length;
    createdI += slice.length;
  }

  return json({
    ok: true,
    t_added: createdT, s_added: createdS, i_added: createdI,
    next_start: i,
    done: i >= parsed.rows.length,
    total: parsed.rows.length,
    base_sort: tOrd - 1,
    topic_map: Object.fromEntries(topicMap),
    sub_map: Object.fromEntries(subMap),
    original_sub_ids: [...originalSubIds],
    cleared_subs: [...clearedSubs],
    initial_topic_ids: [...initialTopicIds],
    loaded_topic_subs: [...loadedTopicSubs],
    merge_progress: mergeItemsDeleted > 0, // i가 안 올라도 items 일부 지워졌으면 progress 인정
  }, 200, request);
}

// ============================================================
// 학생 — 이해 표시 (꾹누르기 토글)
// ============================================================

async function handleUnderstoodToggle(request, env) {
  const auth = await verifyAuth(request, env);
  if (!auth) return json({ error: 'unauthenticated' }, 401, request);
  const b = await request.json().catch(() => ({}));
  const subId = Number(b.subtopic_id);
  if (!subId) return json({ error: 'subtopic_id required' }, 400, request);

  // 기존 행 찾기
  const r = await ncbRead(env, 'op_understood',
    `user_phone=${encodeURIComponent(auth.phone)}&subtopic_id=${subId}&limit=1`);
  const existing = (r.data || [])[0];

  if (existing) {
    await ncbDelete(env, 'op_understood', existing.id);
    return json({ understood: false }, 200, request);
  } else {
    // 처음 ●  = Box 1, 다음 복습은 내일 (KST)
    const nextReview = srsNextReviewAt(1);
    await ncbCreate(env, 'op_understood', {
      user_phone: auth.phone,
      subtopic_id: subId,
      marked_at: kstDateTime(),
      review_box: 1,
      next_review_at: nextReview,
    });
    return json({ understood: true, review_box: 1, next_review_at: nextReview }, 200, request);
  }
}

// POST /understood/advance — 회상 성공 시 박스 진행 (간격 반복)
// 펼치지 않고 패스 = 능동 회상 성공 → Box+1 → 다음 due 늦춤
async function handleUnderstoodAdvance(request, env) {
  const auth = await verifyAuth(request, env);
  if (!auth) return json({ error: 'unauthenticated' }, 401, request);
  const b = await request.json().catch(() => ({}));
  const subId = Number(b.subtopic_id);
  if (!subId) return json({ error: 'subtopic_id required' }, 400, request);

  // 기존 ● 행 찾기 (행이 없으면 미암기 상태 — advance 무의미)
  const r = await ncbRead(env, 'op_understood',
    `user_phone=${encodeURIComponent(auth.phone)}&subtopic_id=${subId}&limit=1`);
  const existing = (r.data || [])[0];
  if (!existing) {
    return json({ ok: true, skipped: true, reason: 'not_understood' }, 200, request);
  }

  const currentBox = Math.min(Math.max(Number(existing.review_box) || 1, 1), 6);
  const newBox = Math.min(currentBox + 1, 6);
  const nextReview = srsNextReviewAt(newBox);

  await ncbUpdate(env, 'op_understood', existing.id, {
    review_box: newBox,
    next_review_at: nextReview,
  });

  return json({ ok: true, review_box: newBox, next_review_at: nextReview }, 200, request);
}

// ============================================================
// 학생 — 새 학습 시스템 (v2)
// new / 별표 / all / 다지기 6박스 (오늘·내일·4·8·16·32일)
// ============================================================

// POST /understood/peek — 펼친 시점에 호출. miss_count +1.
// 행이 없으면 no-op (new 모드에서는 클라이언트가 패스 시점에 행 생성)
async function handleUnderstoodPeek(request, env) {
  const auth = await verifyAuth(request, env);
  if (!auth) return json({ error: 'unauthenticated' }, 401, request);
  const b = await request.json().catch(() => ({}));
  const subId = Number(b.subtopic_id);
  if (!subId) return json({ error: 'subtopic_id required' }, 400, request);

  const r = await ncbRead(env, 'op_understood',
    `user_phone=${encodeURIComponent(auth.phone)}&subtopic_id=${subId}&limit=1`);
  const existing = (r.data || [])[0];
  if (!existing) {
    return json({ ok: true, skipped: true, reason: 'no_row' }, 200, request);
  }
  const newMiss = (Number(existing.miss_count) || 0) + 1;
  await ncbUpdate(env, 'op_understood', existing.id, { miss_count: newMiss });
  return json({ ok: true, miss_count: newMiss, review_box: Number(existing.review_box) || 1 }, 200, request);
}

// POST /understood/pass — 패스 액션. body: { subtopic_id, was_peeked }
// 행 상태 + was_peeked 조합으로 분기.
async function handleUnderstoodPass(request, env) {
  const auth = await verifyAuth(request, env);
  if (!auth) return json({ error: 'unauthenticated' }, 401, request);
  const b = await request.json().catch(() => ({}));
  const subId = Number(b.subtopic_id);
  if (!subId) return json({ error: 'subtopic_id required' }, 400, request);
  const wasPeeked = Boolean(b.was_peeked);

  const r = await ncbRead(env, 'op_understood',
    `user_phone=${encodeURIComponent(auth.phone)}&subtopic_id=${subId}&limit=1`);
  const existing = (r.data || [])[0];
  const now = kstDateTime();

  if (wasPeeked) {
    // 펼치고 패스 → box=1 (오늘)로 강등 + miss_count +1
    //   (정교화 '더 학습' 버튼, 다지기 미래박스 dissolve 등이 이 경로)
    if (existing) {
      const newMiss = (Number(existing.miss_count) || 0) + 1;
      await ncbUpdate(env, 'op_understood', existing.id, {
        review_box: 1,
        next_review_at: nextReviewForBox(1),
        last_moved_at: now,
        miss_count: newMiss,
      });
      return json({
        ok: true, review_box: 1, next_review_at: nextReviewForBox(1),
        miss_count: newMiss,
      }, 200, request);
    } else {
      // new + 펼치고 패스 → 새 행 box=1, miss=1
      await ncbCreate(env, 'op_understood', {
        user_phone: auth.phone, subtopic_id: subId, marked_at: now,
        miss_count: 1, review_box: 1, next_review_at: nextReviewForBox(1), last_moved_at: now,
      });
      return json({ ok: true, review_box: 1, miss_count: 1 }, 200, request);
    }
  }

  // 안 펼치고 패스
  if (!existing) {
    // new + 안 펼치고 패스 → box=2 (내일), miss=0
    await ncbCreate(env, 'op_understood', {
      user_phone: auth.phone, subtopic_id: subId, marked_at: now,
      miss_count: 0, review_box: 2, next_review_at: nextReviewForBox(2), last_moved_at: now,
    });
    return json({ ok: true, review_box: 2, next_review_at: nextReviewForBox(2), miss_count: 0 }, 200, request);
  }

  const currentBox = Math.min(Math.max(Number(existing.review_box) || 1, 1), 6);
  // due 판정: next_review_at <= 오늘이면 effective 오늘 박스
  const todayDate = kstDateTime().slice(0, 10);
  const nextReviewDate = String(existing.next_review_at || '').slice(0, 10);
  const isDue = !nextReviewDate || nextReviewDate <= todayDate;

  if (isDue) {
    // Model A (standard SRS): due 됐고 안 펼침 패스 → 다음 박스로 advance
    //  - box=1 → box=2 (내일)
    //  - box=2 → box=3 (4일 후)
    //  - box=3 → box=4 (8일 후)
    //  - ...
    const newBox = Math.min(currentBox + 1, 6);
    await ncbUpdate(env, 'op_understood', existing.id, {
      review_box: newBox,
      next_review_at: nextReviewForBox(newBox),
      last_moved_at: now,
    });
    return json({
      ok: true, review_box: newBox, next_review_at: nextReviewForBox(newBox),
      miss_count: Number(existing.miss_count) || 0,
    }, 200, request);
  }
  // 미래 박스 (아직 due 아님) + 안 펼치고 패스 → 변경 없음
  return json({
    ok: true, skipped: true, review_box: currentBox,
    next_review_at: existing.next_review_at || '',
    miss_count: Number(existing.miss_count) || 0,
  }, 200, request);
}

// POST /understood/promote — 꾹누르기. 무조건 다음 박스로 advance.
async function handleUnderstoodPromote(request, env) {
  const auth = await verifyAuth(request, env);
  if (!auth) return json({ error: 'unauthenticated' }, 401, request);
  const b = await request.json().catch(() => ({}));
  const subId = Number(b.subtopic_id);
  if (!subId) return json({ error: 'subtopic_id required' }, 400, request);

  const r = await ncbRead(env, 'op_understood',
    `user_phone=${encodeURIComponent(auth.phone)}&subtopic_id=${subId}&limit=1`);
  const existing = (r.data || [])[0];
  const now = kstDateTime();

  if (existing) {
    const currentBox = Math.min(Math.max(Number(existing.review_box) || 1, 1), 6);
    const newBox = Math.min(currentBox + 1, 6);
    await ncbUpdate(env, 'op_understood', existing.id, {
      review_box: newBox,
      next_review_at: nextReviewForBox(newBox),
      last_moved_at: now,
    });
    return json({
      ok: true, review_box: newBox, next_review_at: nextReviewForBox(newBox),
      miss_count: Number(existing.miss_count) || 0,
    }, 200, request);
  }
  // new 꾹누르기 → 행 생성 box=2 (내일), miss=0
  await ncbCreate(env, 'op_understood', {
    user_phone: auth.phone, subtopic_id: subId, marked_at: now,
    miss_count: 0, review_box: 2, next_review_at: nextReviewForBox(2), last_moved_at: now,
  });
  return json({ ok: true, review_box: 2, next_review_at: nextReviewForBox(2), miss_count: 0 }, 200, request);
}

async function handleUnderstoodList(request, env) {
  const auth = await verifyAuth(request, env);
  if (!auth) return json({ error: 'unauthenticated' }, 401, request);
  const url = new URL(request.url);
  const chapterId = url.searchParams.get('chapter_id');

  // 단순화: 사용자의 모든 understood 가져와 클라이언트에서 필터
  const r = await ncbRead(env, 'op_understood',
    `user_phone=${encodeURIComponent(auth.phone)}&limit=2000`);
  const rows = r.data || [];
  const ids = rows.map(x => Number(x.subtopic_id));
  const items = rows.map(x => ({
    subtopic_id: Number(x.subtopic_id),
    marked_at: x.marked_at || '',
    review_box: Number(x.review_box) || 1,        // Leitner 박스 (1~6, v2 의미: 1=오늘 2=내일 3=4일 4=8일 5=16일 6=32일)
    next_review_at: x.next_review_at || '',       // 다음 복습 due (KST DATETIME)
    miss_count: Number(x.miss_count) || 0,        // v2: 누적 펼친 횟수
    last_moved_at: x.last_moved_at || '',         // v2: 박스 이동 시각 (정렬용)
  }));
  return json({
    subtopic_ids: ids,
    items,
    chapter_id: chapterId ? Number(chapterId) : null,
  }, 200, request);
}

// ============================================================
// 통계 — ping / 오늘 학습자 수
// ============================================================

async function handleStatsPing(request, env) {
  const auth = await verifyAuth(request, env);
  if (!auth) return json({ ok: false }, 200, request); // 비로그인은 조용히 무시
  const phone = auth.phone;
  const today = kstDateStr();
  const now = kstDateTime();

  // 클라이언트가 마지막 ping 이후 학습한 카드 수(델타) — 음수·과도값 방어
  const body = await request.json().catch(() => ({}));
  const delta = Math.max(0, Math.min(Number(body && body.cards) || 0, 5000));
  const name = String((auth && auth.name) || '').slice(0, 40);

  const r = await ncbRead(env, 'op_pings',
    `user_phone=${encodeURIComponent(phone)}&limit=1`);
  const existing = (r.data || [])[0];

  if (existing) {
    // 날짜가 바뀌었으면 오늘 카드 수를 0부터 다시 누적
    const base = (existing.cards_date === today) ? (Number(existing.cards_today) || 0) : 0;
    await ncbUpdate(env, 'op_pings', existing.id, {
      first_ping_today: today,
      last_ping_at: now,
      name,
      cards_today: base + delta,
      cards_date: today,
    });
  } else {
    await ncbCreate(env, 'op_pings', {
      user_phone: phone,
      first_ping_today: today,
      last_ping_at: now,
      name,
      cards_today: delta,
      cards_date: today,
    });
  }
  return json({ ok: true }, 200, request);
}

async function handleLearnersNow(request, env) {
  const today = kstDateStr();
  const r = await ncbRead(env, 'op_pings',
    `first_ping_today=${today}&limit=2000`);
  const rows = r.data || [];
  let totalCards = 0;
  for (const p of rows) {
    if (p.cards_date === today) totalCards += Number(p.cards_today) || 0;
  }
  return json({ count: rows.length, total_cards: totalCards, date: today }, 200, request);
}

// GET /stats/live-feed — 최근 학습한 사람들의 마스킹 이름 + 오늘 카드 수 (공개)
// 랜딩/메인의 "실시간 학습 피드"용. 이름은 첫 글자만 노출.
function maskName(name) {
  const n = String(name || '').trim();
  if (!n) return '익명';
  if (n.length === 1) return n + '○';
  return n[0] + '○'.repeat(Math.min(n.length - 1, 2));
}

async function handleLiveFeed(request, env) {
  const today = kstDateStr();
  // last_ping_at 최신순 — 최근 활동한 학습자 우선
  const r = await ncbRead(env, 'op_pings',
    `first_ping_today=${today}&sort=last_ping_at&order=desc&limit=30`);
  const rows = r.data || [];
  const feed = [];
  for (const p of rows) {
    const cards = (p.cards_date === today) ? (Number(p.cards_today) || 0) : 0;
    feed.push({
      name: maskName(p.name),
      cards,
      last_ping_at: p.last_ping_at || '',
    });
    if (feed.length >= 15) break;
  }
  return json({ date: today, feed }, 200, request);
}

// ============================================================
// 챕터 접근 / 포인트 사용
// ============================================================

async function handleMyAccess(request, env) {
  const auth = await verifyAuth(request, env);
  if (!auth) return json({ error: 'unauthenticated' }, 401, request);
  const map = await getChapterAccessMap(env, auth.phone);
  return json({ chapter_access: map }, 200, request);
}

async function handleRedeemPoints(request, env) {
  const auth = await verifyAuth(request, env);
  if (!auth) return json({ error: 'unauthenticated' }, 401, request);
  const b = await request.json().catch(() => ({}));
  const chapterId = Number(b.chapter_id);
  if (!chapterId) return json({ error: 'chapter_id required' }, 400, request);

  // 사용자 조회
  const userRec = await findUserByPhone(env, auth.phone);
  if (!userRec) return json({ error: 'user_not_found' }, 404, request);
  const point = Number(userRec.fields.point) || 0;
  if (point < REDEEM_COST) {
    return json({ error: '포인트가 부족합니다.', point, need: REDEEM_COST }, 400, request);
  }

  // 챕터 정보
  const chapter = await ncbReadById(env, 'op_chapters', chapterId);
  if (!chapter) return json({ error: 'chapter_not_found' }, 404, request);

  // 기존 ChapterAccess 행 찾기
  const existing = await atFindOne(env, AT_ACCESS,
    `AND({user_phone}="${auth.phone}", {chapter_id}=${chapterId})`);

  const nowIso = kstISOString();
  let newExpires;
  if (existing) {
    const curr = existing.fields.expires_at;
    const base = curr && new Date(curr) > new Date(nowIso) ? curr : nowIso;
    newExpires = addDays(base, REDEEM_DAYS);
    await atUpdate(env, AT_ACCESS, existing.id, {
      expires_at: newExpires,
      source: 'point_redeem',
    });
  } else {
    newExpires = addDays(nowIso, REDEEM_DAYS);
    await atCreate(env, AT_ACCESS, {
      user_phone: auth.phone,
      chapter_id: chapterId,
      chapter_title: chapter.title || '',
      expires_at: newExpires,
      source: 'point_redeem',
    });
  }

  // 포인트 차감 + 트랜잭션 기록
  const newPoint = point - REDEEM_COST;
  await atUpdate(env, AT_USERS, userRec.id, { point: newPoint });
  await atCreate(env, AT_POINTTX, {
    user_phone: auth.phone,
    delta: -REDEEM_COST,
    reason: 'redeem_chapter',
    ref_chapter_id: chapterId,
    balance_after: newPoint,
    memo: chapter.title || '',
  });

  return json({
    ok: true,
    new_point: newPoint,
    chapter_id: chapterId,
    expires_at: newExpires,
  }, 200, request);
}

// ============================================================
// 관리자 CRM
// ============================================================

const AT_PAYMENTS = 'OnepagePayments';
const AT_CAMPAIGNS = 'OnepageCampaigns';

// Airtable 페이지네이션 — 100건 초과 시 offset으로 반복 fetch
async function atFindAllPaged(env, table, formula, hardMax = 2000) {
  const out = [];
  let offset;
  for (let i = 0; i < 50 && out.length < hardMax; i++) {
    const params = new URLSearchParams();
    if (formula) params.set('filterByFormula', formula);
    params.set('pageSize', '100');
    if (offset) params.set('offset', offset);
    const url = `${AT_BASE_URL}/${env.AIRTABLE_BASE}/${encodeURIComponent(table)}?${params.toString()}`;
    const r = await fetch(url, { headers: atH(env) });
    const j = await r.json();
    const records = j.records || [];
    out.push(...records);
    if (!j.offset || records.length === 0) break;
    offset = j.offset;
  }
  return out.slice(0, hardMax);
}

function kstYMD(iso) {
  if (!iso) return '';
  // KST-as-UTC ISO를 그대로 YYYY-MM-DD로 (의도된 KST 날짜)
  return new Date(iso).toISOString().slice(0, 10);
}

async function handleAdminOverview(request, env) {
  const [users, accesses, payments, chaptersResp] = await Promise.all([
    atFindAllPaged(env, AT_USERS, '', 2000),
    atFindAllPaged(env, AT_ACCESS, '', 5000),
    atFindAllPaged(env, AT_PAYMENTS, '', 5000),
    ncbRead(env, 'op_chapters', 'limit=2000'),
  ]);
  const chapters = chaptersResp.data || [];

  const todayStr = kstDateStr();
  const monthStr = todayStr.slice(0, 7);
  const nowIso = kstISOString();
  const weekIso = addDays(nowIso, 7);
  const weekAgoIso = addDays(nowIso, -7);

  let todayRevenue = 0, monthRevenue = 0, totalRevenue = 0;
  for (const p of payments) {
    const amt = Number(p.fields.amount) || 0;
    const paid = p.fields.paid_at || '';
    totalRevenue += amt;
    if (paid) {
      const ymd = kstYMD(paid);
      if (ymd === todayStr) todayRevenue += amt;
      if (ymd.startsWith(monthStr)) monthRevenue += amt;
    }
  }

  const activePhones = new Set();
  const expiringList = [];
  for (const a of accesses) {
    const exp = a.fields.expires_at;
    if (!exp) continue;
    if (exp > nowIso) {
      activePhones.add(a.fields.user_phone);
      if (exp < weekIso) {
        expiringList.push({
          phone: a.fields.user_phone,
          chapter_id: Number(a.fields.chapter_id),
          chapter_title: a.fields.chapter_title || '',
          expires_at: exp,
        });
      }
    }
  }
  expiringList.sort((a, b) => (a.expires_at || '').localeCompare(b.expires_at || ''));

  const chapterMap = {};
  for (const c of chapters) chapterMap[c.id] = c;
  const chapterRev = {}, chapterSubs = {};
  for (const p of payments) {
    const cid = p.fields.chapter_id;
    if (cid) chapterRev[cid] = (chapterRev[cid] || 0) + (Number(p.fields.amount) || 0);
  }
  for (const a of accesses) {
    if (a.fields.expires_at > nowIso) {
      chapterSubs[a.fields.chapter_id] = (chapterSubs[a.fields.chapter_id] || 0) + 1;
    }
  }
  const topChapters = Object.keys(chapterMap).map(cid => ({
    id: Number(cid),
    title: chapterMap[cid].title || '',
    subject: chapterMap[cid].subject || '',
    revenue: chapterRev[cid] || 0,
    active_subs: chapterSubs[cid] || 0,
    mrr: (chapterSubs[cid] || 0) * (Number(chapterMap[cid].monthly_price) || 0),
  })).sort((a, b) => b.mrr - a.mrr).slice(0, 10);

  const recentPayments = payments
    .slice()
    .sort((a, b) => (b.fields.paid_at || '').localeCompare(a.fields.paid_at || ''))
    .slice(0, 20)
    .map(p => ({
      phone: p.fields.user_phone || '',
      chapter_id: Number(p.fields.chapter_id) || null,
      chapter_title: (chapterMap[p.fields.chapter_id] && chapterMap[p.fields.chapter_id].title) || '',
      amount: Number(p.fields.amount) || 0,
      paid_at: p.fields.paid_at || '',
    }));

  const newSignups7d = users.filter(u => (u.createdTime || '') > weekAgoIso).length;

  // 챔피언 (전환 가능성 높은 무료 사용자) — 가입했으나 결제 0
  const paidPhones = new Set(payments.map(p => p.fields.user_phone).filter(Boolean));
  const neverPaid = users.filter(u => u.fields.role !== 'teacher' && !paidPhones.has(u.fields.phone));

  // 휴면 (마지막 결제 30일 이상 + 만료된 사람)
  const monthAgoIso = addDays(nowIso, -30);
  const lapsedPhones = new Set();
  for (const a of accesses) {
    if (a.fields.expires_at && a.fields.expires_at < nowIso && a.fields.expires_at > monthAgoIso) {
      lapsedPhones.add(a.fields.user_phone);
    }
  }
  // 휴면에서 현재 활성 제외
  for (const p of activePhones) lapsedPhones.delete(p);

  return json({
    today_revenue: todayRevenue,
    month_revenue: monthRevenue,
    total_revenue: totalRevenue,
    total_users: users.length,
    active_subscribers: activePhones.size,
    expiring_7d_count: expiringList.length,
    new_signups_7d: newSignups7d,
    never_paid_count: neverPaid.length,
    lapsed_count: lapsedPhones.size,
    top_chapters: topChapters,
    recent_payments: recentPayments,
    expiring_list: expiringList.slice(0, 30),
  }, 200, request);
}

async function handleAdminUsers(request, env) {
  const [users, accesses, payments, pingsResp] = await Promise.all([
    atFindAllPaged(env, AT_USERS, '', 2000),
    atFindAllPaged(env, AT_ACCESS, '', 5000),
    atFindAllPaged(env, AT_PAYMENTS, '', 5000),
    ncbRead(env, 'op_pings', 'limit=2000'),
  ]);
  const pings = pingsResp.data || [];
  const nowIso = kstISOString();

  const byPhone = {};
  for (const u of users) {
    const f = u.fields;
    const phone = f.phone || '';
    byPhone[phone] = {
      rec_id: u.id,
      name: f.name || '',
      phone,
      email: f.email || '',
      role: f.role || 'student',
      point: Number(f.point) || 0,
      referral_code: f.referral_code || '',
      referred_by_code: f.referred_by_code || '',
      first_paid_at: f.first_paid_at || null,
      joined_at: u.createdTime || null,
      total_spent: 0,
      payment_count: 0,
      active_chapters: [],
      expired_chapters: [],
      last_payment_at: null,
      last_ping_at: null,
    };
  }

  for (const a of accesses) {
    const u = byPhone[a.fields.user_phone];
    if (!u) continue;
    const cid = Number(a.fields.chapter_id);
    const exp = a.fields.expires_at || '';
    const entry = { id: cid, expires_at: exp, title: a.fields.chapter_title || '' };
    if (exp > nowIso) u.active_chapters.push(entry);
    else if (exp) u.expired_chapters.push(entry);
  }

  for (const p of payments) {
    const u = byPhone[p.fields.user_phone];
    if (!u) continue;
    u.total_spent += Number(p.fields.amount) || 0;
    u.payment_count += 1;
    const paid = p.fields.paid_at || '';
    if (paid && (!u.last_payment_at || paid > u.last_payment_at)) u.last_payment_at = paid;
  }

  for (const ping of pings) {
    const u = byPhone[ping.user_phone];
    if (!u) continue;
    const t = ping.first_ping_today || '';
    if (t && (!u.last_ping_at || t > u.last_ping_at)) u.last_ping_at = t;
  }

  const list = Object.values(byPhone);
  list.sort((a, b) => {
    const ax = a.last_payment_at || a.joined_at || '';
    const bx = b.last_payment_at || b.joined_at || '';
    return bx.localeCompare(ax);
  });

  return json({ users: list, total: list.length }, 200, request);
}

async function handleAdminUserDetail(request, env, phoneRaw) {
  const phone = normalizePhone(decodeURIComponent(phoneRaw));
  const userRec = await findUserByPhone(env, phone);
  if (!userRec) return json({ error: 'user_not_found' }, 404, request);

  const phoneEsc = phone.replace(/"/g, '');
  const [accesses, payments, pointTx, understoodResp] = await Promise.all([
    atFindAllPaged(env, AT_ACCESS, `{user_phone}="${phoneEsc}"`, 200),
    atFindAllPaged(env, AT_PAYMENTS, `{user_phone}="${phoneEsc}"`, 500),
    atFindAllPaged(env, AT_POINTTX, `{user_phone}="${phoneEsc}"`, 500),
    ncbRead(env, 'op_understood', `user_phone=${encodeURIComponent(phone)}&limit=5000`),
  ]);
  const understood = understoodResp.data || [];
  const f = userRec.fields;

  return json({
    user: {
      name: f.name || '',
      phone: f.phone || '',
      email: f.email || '',
      role: f.role || 'student',
      point: Number(f.point) || 0,
      referral_code: f.referral_code || '',
      referred_by_code: f.referred_by_code || '',
      first_paid_at: f.first_paid_at || null,
      joined_at: userRec.createdTime || null,
      utm_source: f.utm_source || '',
      utm_medium: f.utm_medium || '',
      utm_campaign: f.utm_campaign || '',
      utm_content: f.utm_content || '',
      utm_term: f.utm_term || '',
      landing_url: f.landing_url || '',
      referrer_url: f.referrer_url || '',
    },
    chapter_access: accesses.map(a => ({
      chapter_id: Number(a.fields.chapter_id),
      chapter_title: a.fields.chapter_title || '',
      expires_at: a.fields.expires_at || '',
      source: a.fields.source || '',
    })).sort((a, b) => (b.expires_at || '').localeCompare(a.expires_at || '')),
    payments: payments.map(p => ({
      amount: Number(p.fields.amount) || 0,
      chapter_id: Number(p.fields.chapter_id) || null,
      paid_at: p.fields.paid_at || '',
      mul_no: p.fields.mul_no || '',
    })).sort((a, b) => (b.paid_at || '').localeCompare(a.paid_at || '')),
    point_tx: pointTx.map(t => ({
      delta: Number(t.fields.delta) || 0,
      reason: t.fields.reason || '',
      ref_chapter_id: t.fields.ref_chapter_id || null,
      balance_after: Number(t.fields.balance_after) || 0,
      memo: t.fields.memo || '',
      created_at: t.createdTime || '',
    })).sort((a, b) => (b.created_at || '').localeCompare(a.created_at || '')),
    understood_count: understood.length,
    total_spent: payments.reduce((s, p) => s + (Number(p.fields.amount) || 0), 0),
  }, 200, request);
}

async function handleAdminGrantPoints(request, env, granter) {
  const b = await request.json().catch(() => ({}));
  const phone = normalizePhone(String(b.phone || ''));
  const delta = Math.trunc(Number(b.delta) || 0);
  const reason = String(b.reason || 'admin_grant').slice(0, 60);
  const memo = String(b.memo || '').slice(0, 200);

  if (!phone) return json({ error: 'phone required' }, 400, request);
  if (delta === 0) return json({ error: 'delta cannot be 0' }, 400, request);

  const userRec = await findUserByPhone(env, phone);
  if (!userRec) return json({ error: 'user_not_found' }, 404, request);

  const currentPoint = Number(userRec.fields.point) || 0;
  const newPoint = Math.max(0, currentPoint + delta);
  const actualDelta = newPoint - currentPoint;

  await atUpdate(env, AT_USERS, userRec.id, { point: newPoint });
  await atCreate(env, AT_POINTTX, {
    user_phone: phone,
    delta: actualDelta,
    reason,
    balance_after: newPoint,
    memo: `[관리자:${granter.name || granter.phone || ''}] ${memo}`.slice(0, 200),
  });

  return json({ ok: true, new_point: newPoint, applied_delta: actualDelta }, 200, request);
}

async function handleAdminWebhookSend(request, env, sender) {
  const b = await request.json().catch(() => ({}));
  const phones = (Array.isArray(b.phones) ? b.phones : []).map(String).map(normalizePhone).filter(Boolean);
  if (!phones.length) return json({ error: 'phones required' }, 400, request);

  const webhookUrl = String(b.webhook_url || '').trim() || env.PABBLY_WEBHOOK_URL || '';
  if (!webhookUrl) {
    return json({
      error: 'webhook URL not configured. Set PABBLY_WEBHOOK_URL secret on Worker or pass webhook_url in request body.',
    }, 400, request);
  }

  const template = String(b.template || 'custom');
  const channel = String(b.channel || 'sms');  // 'sms' | 'email' | 'both'
  const customMessage = String(b.custom_message || '');
  const subject = String(b.subject || '');
  const campaignId = (typeof crypto !== 'undefined' && crypto.randomUUID)
    ? crypto.randomUUID()
    : `cmp_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  const sentAt = kstISOString();

  // 사용자 정보 일괄 조회
  const users = await atFindAllPaged(env, AT_USERS, '', 2000);
  const userMap = {};
  for (const u of users) userMap[u.fields.phone] = u.fields;

  // 만료 정보가 필요한 템플릿
  let accessByPhone = {};
  if (['renewal', 'winback', 'expiring'].includes(template)) {
    const accesses = await atFindAllPaged(env, AT_ACCESS, '', 5000);
    for (const a of accesses) {
      const p = a.fields.user_phone;
      if (!p) continue;
      if (!accessByPhone[p]) accessByPhone[p] = [];
      accessByPhone[p].push({
        chapter_id: Number(a.fields.chapter_id),
        chapter_title: a.fields.chapter_title || '',
        expires_at: a.fields.expires_at || '',
      });
    }
  }

  const results = [];
  const senderName = sender.name || sender.phone || '';
  for (const phone of phones) {
    const user = userMap[phone];
    if (!user) {
      results.push({ phone, email: '', name: '', channel, ok: false, error: 'user_not_found' });
      continue;
    }
    const payload = {
      template,
      channel,
      subject,
      sent_at: sentAt,
      sent_by: senderName,
      name: user.name || '',
      phone: user.phone || '',
      email: user.email || '',
      point: Number(user.point) || 0,
      first_paid_at: user.first_paid_at || null,
      referral_code: user.referral_code || '',
      custom_message: customMessage,
    };
    if (accessByPhone[phone]) payload.chapter_access = accessByPhone[phone];

    try {
      const r = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      results.push({ phone, email: user.email || '', name: user.name || '', channel, ok: r.ok, status: r.status });
    } catch (e) {
      results.push({ phone, email: user.email || '', name: user.name || '', channel, ok: false, error: String(e && e.message || e) });
    }
  }

  // Airtable에 발송 결과 영구 저장 (실패해도 발송 자체는 성공으로 응답)
  try {
    const records = results.map(r => ({
      campaign_id: campaignId,
      template,
      channel,
      subject,
      custom_message: customMessage,
      sent_at: sentAt,
      sent_by: senderName,
      phone: r.phone || '',
      email: r.email || '',
      recipient_name: r.name || '',
      ok: !!r.ok,
      status_code: Number(r.status) || 0,
      error: r.error || '',
    }));
    await atCreateBatch(env, AT_CAMPAIGN_SENDS, records);
  } catch (e) {
    console.log('WARN campaign log persist failed:', String(e && e.message || e));
  }

  const okCount = results.filter(r => r.ok).length;
  return json({ ok: true, campaign_id: campaignId, sent_at: sentAt, sent: okCount, total: results.length, results }, 200, request);
}

async function handleAdminCampaigns(request, env) {
  const url = new URL(request.url);
  const days = Math.min(365, Math.max(1, Number(url.searchParams.get('days')) || 30));
  const nowIso = kstISOString();
  const fromIso = addDays(nowIso, -days);

  let sends = [];
  try {
    sends = await atFindAllPaged(env, AT_CAMPAIGN_SENDS,
      `IS_AFTER({sent_at}, "${fromIso}")`, 10000);
  } catch (e) {
    return json({
      ok: false,
      error: 'campaign_table_missing',
      message: 'OnepageCampaignSends 테이블이 Airtable에 없거나 접근 권한이 없습니다. CRM 문서의 스키마대로 테이블을 먼저 만드세요.',
    }, 200, request);
  }

  const byCampaign = {};
  const byChannel = { sms: 0, email: 0, both: 0 };
  const byTemplate = {};
  const byDay = {};
  let totalOk = 0;

  for (const s of sends) {
    const f = s.fields || {};
    const id = f.campaign_id || '(no-id)';
    if (!byCampaign[id]) {
      byCampaign[id] = {
        campaign_id: id,
        template: f.template || '',
        channel: f.channel || '',
        subject: f.subject || '',
        custom_message: f.custom_message || '',
        sent_at: f.sent_at || '',
        sent_by: f.sent_by || '',
        total: 0,
        sent: 0,
        recipients: [],
      };
    }
    const c = byCampaign[id];
    c.total++;
    if (f.ok) { c.sent++; totalOk++; }
    c.recipients.push({
      phone: f.phone || '',
      email: f.email || '',
      name: f.recipient_name || '',
      ok: !!f.ok,
      status_code: Number(f.status_code) || 0,
      error: f.error || '',
    });
    byChannel[f.channel] = (byChannel[f.channel] || 0) + 1;
    byTemplate[f.template] = (byTemplate[f.template] || 0) + 1;
    if (f.sent_at) {
      const ymd = kstYMD(f.sent_at);
      byDay[ymd] = (byDay[ymd] || 0) + 1;
    }
  }

  const campaigns = Object.values(byCampaign).sort((a, b) =>
    String(b.sent_at).localeCompare(String(a.sent_at)));

  const dailyArr = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = addDays(nowIso, -i);
    const ymd = kstYMD(d);
    dailyArr.push({ date: ymd, count: byDay[ymd] || 0 });
  }

  const total = sends.length;
  return json({
    ok: true,
    days,
    total_sends: total,
    success_count: totalOk,
    success_rate: total ? Math.round(totalOk / total * 1000) / 10 : 0,
    campaign_count: campaigns.length,
    by_channel: byChannel,
    by_template: byTemplate,
    by_day: dailyArr,
    campaigns,
  }, 200, request);
}

async function handleAdminCampaignConversion(request, env) {
  const url = new URL(request.url);
  const days = Math.min(365, Math.max(1, Number(url.searchParams.get('days')) || 30));
  const windowDays = Math.min(60, Math.max(1, Number(url.searchParams.get('window')) || 7));
  const nowIso = kstISOString();
  const fromIso = addDays(nowIso, -days);

  let sends = [];
  try {
    sends = await atFindAllPaged(env, AT_CAMPAIGN_SENDS,
      `IS_AFTER({sent_at}, "${fromIso}")`, 10000);
  } catch (e) {
    return json({
      ok: false,
      error: 'campaign_table_missing',
      message: 'OnepageCampaignSends 테이블이 없습니다.',
    }, 200, request);
  }

  // 결제는 발송 이후에 일어나므로 fromIso 이후만 조회
  const payments = await atFindAllPaged(env, AT_PAYMENTS,
    `IS_AFTER({paid_at}, "${fromIso}")`, 10000);

  const paymentsByPhone = {};
  for (const p of payments) {
    const ph = p.fields.user_phone;
    if (!ph) continue;
    if (!paymentsByPhone[ph]) paymentsByPhone[ph] = [];
    paymentsByPhone[ph].push({
      paid_at: p.fields.paid_at || '',
      amount: Number(p.fields.amount) || 0,
      chapter_id: p.fields.chapter_id,
    });
  }
  for (const ph of Object.keys(paymentsByPhone)) {
    paymentsByPhone[ph].sort((a, b) => a.paid_at.localeCompare(b.paid_at));
  }

  const byTemplate = {};
  const byChannel = {};
  let totalSends = 0;
  let totalConv = 0;
  let totalRevenue = 0;

  for (const s of sends) {
    const f = s.fields || {};
    if (!f.ok) continue;
    const ph = f.phone;
    if (!ph) continue;
    const sentAtMs = new Date(f.sent_at).getTime();
    if (!sentAtMs) continue;
    const windowEndMs = sentAtMs + windowDays * 86400 * 1000;

    const userPays = paymentsByPhone[ph] || [];
    const matched = userPays.filter(p => {
      const m = new Date(p.paid_at).getTime();
      return m > sentAtMs && m <= windowEndMs;
    });

    totalSends++;
    const t = f.template || 'unknown';
    const ch = f.channel || 'unknown';
    if (!byTemplate[t]) byTemplate[t] = { sends: 0, conv: 0, revenue: 0 };
    if (!byChannel[ch]) byChannel[ch] = { sends: 0, conv: 0, revenue: 0 };
    byTemplate[t].sends++;
    byChannel[ch].sends++;

    if (matched.length > 0) {
      totalConv++;
      byTemplate[t].conv++;
      byChannel[ch].conv++;
      const rev = matched.reduce((sum, p) => sum + p.amount, 0);
      totalRevenue += rev;
      byTemplate[t].revenue += rev;
      byChannel[ch].revenue += rev;
    }
  }

  return json({
    ok: true,
    days,
    window_days: windowDays,
    total_sends: totalSends,
    total_conversions: totalConv,
    conversion_rate: totalSends ? Math.round(totalConv / totalSends * 1000) / 10 : 0,
    total_revenue: totalRevenue,
    arpc: totalConv ? Math.round(totalRevenue / totalConv) : 0,
    by_template: byTemplate,
    by_channel: byChannel,
  }, 200, request);
}

async function handleAdminRevenue(request, env) {
  const url = new URL(request.url);
  const days = Math.min(365, Math.max(7, Number(url.searchParams.get('days')) || 30));
  const nowIso = kstISOString();
  const fromIso = addDays(nowIso, -days);

  const [payments, chaptersResp, users] = await Promise.all([
    atFindAllPaged(env, AT_PAYMENTS, `IS_AFTER({paid_at}, "${fromIso}")`, 5000),
    ncbRead(env, 'op_chapters', 'limit=2000'),
    atFindAllPaged(env, AT_USERS, '', 2000),
  ]);
  const chapters = chaptersResp.data || [];
  const chapterMap = {};
  for (const c of chapters) chapterMap[c.id] = c;
  const userMap = {};
  for (const u of users) userMap[u.fields.phone] = u.fields;

  const daily = {}, byChapter = {}, byPhone = {};
  for (const p of payments) {
    const amt = Number(p.fields.amount) || 0;
    const paid = p.fields.paid_at || '';
    if (!paid) continue;
    const ymd = kstYMD(paid);
    daily[ymd] = (daily[ymd] || 0) + amt;
    const cid = p.fields.chapter_id;
    if (cid) byChapter[cid] = (byChapter[cid] || 0) + amt;
    const ph = p.fields.user_phone;
    if (ph) byPhone[ph] = (byPhone[ph] || 0) + amt;
  }

  const dailyArr = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = addDays(nowIso, -i);
    const ymd = kstYMD(d);
    dailyArr.push({ date: ymd, amount: daily[ymd] || 0 });
  }

  const byChapterArr = Object.keys(byChapter).map(cid => ({
    chapter_id: Number(cid),
    title: (chapterMap[cid] && chapterMap[cid].title) || '(삭제됨)',
    subject: (chapterMap[cid] && chapterMap[cid].subject) || '',
    amount: byChapter[cid],
  })).sort((a, b) => b.amount - a.amount);

  const topSpenders = Object.keys(byPhone).map(ph => ({
    phone: ph,
    name: (userMap[ph] && userMap[ph].name) || '',
    email: (userMap[ph] && userMap[ph].email) || '',
    amount: byPhone[ph],
  })).sort((a, b) => b.amount - a.amount).slice(0, 20);

  return json({
    days,
    daily: dailyArr,
    by_chapter: byChapterArr,
    top_spenders: topSpenders,
    total: dailyArr.reduce((s, d) => s + d.amount, 0),
    payment_count: payments.length,
  }, 200, request);
}

async function handleAdminAttribution(request, env) {
  const url = new URL(request.url);
  const days = Math.min(365, Math.max(7, Number(url.searchParams.get('days')) || 90));
  const nowIso = kstISOString();
  const fromIso = addDays(nowIso, -days);

  const [users, payments] = await Promise.all([
    atFindAllPaged(env, AT_USERS, '', 2000),
    atFindAllPaged(env, AT_PAYMENTS, '', 5000),
  ]);

  // 결제 사용자별 집계
  const paidByPhone = {};
  for (const p of payments) {
    const ph = p.fields.user_phone;
    if (!ph) continue;
    paidByPhone[ph] = (paidByPhone[ph] || 0) + (Number(p.fields.amount) || 0);
  }

  // 사용자 필터: 가입 기간 내 + 기본은 utm 있는 사용자
  const inRange = users.filter(u => {
    const j = u.createdTime || '';
    return j >= fromIso && j <= nowIso;
  });

  // 가입자별 기본 정보
  const summary = {
    total_signups: inRange.length,
    paid_signups: 0,
    total_revenue: 0,
    by_source: {},
    by_medium: {},
    by_campaign: {},   // key: "source|campaign|content"
  };

  for (const u of inRange) {
    const f = u.fields;
    const source = f.utm_source || '(직접)';
    const medium = f.utm_medium || '(없음)';
    const campaign = f.utm_campaign || '(없음)';
    const content = f.utm_content || '(없음)';
    const phone = f.phone || '';
    const spent = paidByPhone[phone] || 0;
    const paid = spent > 0 ? 1 : 0;

    if (paid) {
      summary.paid_signups += 1;
      summary.total_revenue += spent;
    }

    // by_source
    if (!summary.by_source[source]) summary.by_source[source] = { signups: 0, paid: 0, revenue: 0 };
    summary.by_source[source].signups += 1;
    summary.by_source[source].paid += paid;
    summary.by_source[source].revenue += spent;

    // by_medium
    const mKey = `${source} / ${medium}`;
    if (!summary.by_medium[mKey]) summary.by_medium[mKey] = { source, medium, signups: 0, paid: 0, revenue: 0 };
    summary.by_medium[mKey].signups += 1;
    summary.by_medium[mKey].paid += paid;
    summary.by_medium[mKey].revenue += spent;

    // by_campaign (가장 세부)
    const cKey = `${source} / ${medium} / ${campaign} / ${content}`;
    if (!summary.by_campaign[cKey]) summary.by_campaign[cKey] = {
      source, medium, campaign, content,
      signups: 0, paid: 0, revenue: 0,
      sample_users: [],
    };
    const c = summary.by_campaign[cKey];
    c.signups += 1;
    c.paid += paid;
    c.revenue += spent;
    if (c.sample_users.length < 3) c.sample_users.push({ name: f.name || '', phone, joined_at: u.createdTime });
  }

  // 객체 → 배열로 변환 + 정렬
  const bySource = Object.keys(summary.by_source).map(k => ({
    source: k,
    ...summary.by_source[k],
    conversion_rate: summary.by_source[k].signups ? summary.by_source[k].paid / summary.by_source[k].signups : 0,
    arpu: summary.by_source[k].signups ? Math.round(summary.by_source[k].revenue / summary.by_source[k].signups) : 0,
  })).sort((a, b) => b.revenue - a.revenue || b.signups - a.signups);

  const byMedium = Object.values(summary.by_medium).map(r => ({
    ...r,
    conversion_rate: r.signups ? r.paid / r.signups : 0,
    arpu: r.signups ? Math.round(r.revenue / r.signups) : 0,
  })).sort((a, b) => b.revenue - a.revenue || b.signups - a.signups);

  const byCampaign = Object.values(summary.by_campaign).map(r => ({
    ...r,
    conversion_rate: r.signups ? r.paid / r.signups : 0,
    arpu: r.signups ? Math.round(r.revenue / r.signups) : 0,
  })).sort((a, b) => b.revenue - a.revenue || b.signups - a.signups);

  return json({
    days,
    total_signups: summary.total_signups,
    paid_signups: summary.paid_signups,
    total_revenue: summary.total_revenue,
    overall_conversion: summary.total_signups ? summary.paid_signups / summary.total_signups : 0,
    by_source: bySource,
    by_medium: byMedium,
    by_campaign: byCampaign,
  }, 200, request);
}

// ── 저장된 캐페인 (UTM 라이브러리) — 서버 영구 저장 ──
async function handleListCampaigns(request, env) {
  const records = await atFindAllPaged(env, AT_CAMPAIGNS, '', 1000);
  const list = records.map(r => ({
    id: r.id,
    name: r.fields.name || '',
    source: r.fields.utm_source || '',
    medium: r.fields.utm_medium || '',
    campaign: r.fields.utm_campaign || '',
    content: r.fields.utm_content || '',
    term: r.fields.utm_term || '',
    notes: r.fields.notes || '',
    created_by_name: r.fields.created_by_name || '',
    created_by_phone: r.fields.created_by_phone || '',
    created_at: r.createdTime || '',
  })).sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
  return json({ campaigns: list }, 200, request);
}

async function handleCreateCampaign(request, env, creator) {
  const b = await request.json().catch(() => ({}));
  const name = String(b.name || '').trim().slice(0, 200);
  if (!name) return json({ error: '캐페인 이름이 필요합니다' }, 400, request);
  const data = {
    name,
    utm_source: String(b.source || '').slice(0, 80),
    utm_medium: String(b.medium || '').slice(0, 80),
    utm_campaign: String(b.campaign || '').slice(0, 120),
    utm_content: String(b.content || '').slice(0, 120),
    utm_term: String(b.term || '').slice(0, 120),
    notes: String(b.notes || '').slice(0, 1000),
    created_by_name: creator.name || '',
    created_by_phone: creator.phone || '',
  };
  const r = await atCreate(env, AT_CAMPAIGNS, data);
  if (r.error || !r.id) {
    return json({ error: '저장 실패: ' + (r.error?.message || 'unknown') }, 500, request);
  }
  return json({
    ok: true,
    campaign: { id: r.id, ...data, created_at: r.createdTime || new Date().toISOString() },
  }, 200, request);
}

async function handleUpdateCampaign(request, env, id) {
  const b = await request.json().catch(() => ({}));
  const patch = {};
  if (b.name !== undefined) patch.name = String(b.name).trim().slice(0, 200);
  if (b.source !== undefined) patch.utm_source = String(b.source).slice(0, 80);
  if (b.medium !== undefined) patch.utm_medium = String(b.medium).slice(0, 80);
  if (b.campaign !== undefined) patch.utm_campaign = String(b.campaign).slice(0, 120);
  if (b.content !== undefined) patch.utm_content = String(b.content).slice(0, 120);
  if (b.term !== undefined) patch.utm_term = String(b.term).slice(0, 120);
  if (b.notes !== undefined) patch.notes = String(b.notes).slice(0, 1000);
  const r = await atUpdate(env, AT_CAMPAIGNS, id, patch);
  if (r.error) return json({ error: r.error.message || 'update_failed' }, 500, request);
  return json({ ok: true }, 200, request);
}

async function handleDeleteCampaign(request, env, id) {
  const r = await atDelete(env, AT_CAMPAIGNS, id);
  if (r.error) return json({ error: r.error.message || 'delete_failed' }, 500, request);
  return json({ ok: true }, 200, request);
}

// ── 전단지 기본틀(템플릿) — nocodebackend op_flyer_templates ──
//   { name, html(LONGTEXT), size, updated_at }
async function handleFlyerTplList(request, env) {
  const r = await ncbRead(env, 'op_flyer_templates', 'limit=500');
  const list = (r.data || []).map(t => ({ id: t.id, name: t.name || '', size: t.size || 'A4', updated_at: t.updated_at || '' }));
  list.sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''));
  return json({ templates: list }, 200, request);
}
async function handleFlyerTplGet(request, env, id) {
  const t = await ncbReadById(env, 'op_flyer_templates', id);
  if (!t) return json({ error: 'not_found' }, 404, request);
  return json({ template: { id: t.id, name: t.name || '', size: t.size || 'A4', html: t.html || '' } }, 200, request);
}
async function handleFlyerTplCreate(request, env) {
  const b = await request.json().catch(() => ({}));
  const name = String(b.name || '').trim().slice(0, 200);
  const html = String(b.html || '');
  if (!name || !html) return json({ error: 'name·html이 필요합니다' }, 400, request);
  const r = await ncbCreate(env, 'op_flyer_templates', { name, html, size: String(b.size || 'A4').slice(0, 8), updated_at: kstDateTime() });
  return json({ ok: true, id: r.id || (r.data && r.data.id) }, 200, request);
}
async function handleFlyerTplUpdate(request, env, id) {
  const b = await request.json().catch(() => ({}));
  const patch = { updated_at: kstDateTime() };
  if (b.name !== undefined) patch.name = String(b.name).trim().slice(0, 200);
  if (b.html !== undefined) patch.html = String(b.html);
  if (b.size !== undefined) patch.size = String(b.size).slice(0, 8);
  await ncbUpdate(env, 'op_flyer_templates', id, patch);
  return json({ ok: true }, 200, request);
}
async function handleFlyerTplDelete(request, env, id) {
  await ncbDelete(env, 'op_flyer_templates', id);
  return json({ ok: true }, 200, request);
}

// ── 전단지 문구 세트 — nocodebackend op_flyer_copysets ──
//   { name, data(LONGTEXT JSON: {edit-id: text}), updated_at }
async function handleFlyerCopyList(request, env) {
  const r = await ncbRead(env, 'op_flyer_copysets', 'limit=500');
  const list = (r.data || []).map(c => ({ id: c.id, name: c.name || '', data: c.data || '{}', updated_at: c.updated_at || '' }));
  list.sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''));
  return json({ copysets: list }, 200, request);
}
async function handleFlyerCopyCreate(request, env) {
  const b = await request.json().catch(() => ({}));
  const name = String(b.name || '').trim().slice(0, 200);
  if (!name) return json({ error: 'name이 필요합니다' }, 400, request);
  const data = (typeof b.data === 'string') ? b.data : JSON.stringify(b.data || {});
  const r = await ncbCreate(env, 'op_flyer_copysets', { name, data, updated_at: kstDateTime() });
  return json({ ok: true, id: r.id || (r.data && r.data.id) }, 200, request);
}
async function handleFlyerCopyUpdate(request, env, id) {
  const b = await request.json().catch(() => ({}));
  const patch = { updated_at: kstDateTime() };
  if (b.name !== undefined) patch.name = String(b.name).trim().slice(0, 200);
  if (b.data !== undefined) patch.data = (typeof b.data === 'string') ? b.data : JSON.stringify(b.data);
  await ncbUpdate(env, 'op_flyer_copysets', id, patch);
  return json({ ok: true }, 200, request);
}
async function handleFlyerCopyDelete(request, env, id) {
  await ncbDelete(env, 'op_flyer_copysets', id);
  return json({ ok: true }, 200, request);
}

// 관리자가 사용자에게 챕터 권한 지급/연장
async function handleAdminAccessGrant(request, env, admin) {
  const b = await request.json().catch(() => ({}));
  const userPhone = normalizePhone(String(b.user_phone || ''));
  const chapterId = Number(b.chapter_id);
  const days = b.days !== undefined && b.days !== null ? Number(b.days) : null;
  const customExpires = b.expires_at ? String(b.expires_at).trim() : null;
  const reason = String(b.reason || 'admin_grant').slice(0, 100);
  const memo = String(b.memo || '').slice(0, 200);

  if (!userPhone) return json({ error: 'user_phone required' }, 400, request);
  if (!chapterId) return json({ error: 'chapter_id required' }, 400, request);
  if (days === null && !customExpires) {
    return json({ error: 'days or expires_at required' }, 400, request);
  }

  // 챕터 조회 (chapter_title 보강)
  let chapter_title = '';
  try {
    const ch = await ncbReadById(env, 'op_chapters', chapterId);
    if (ch && ch.title) chapter_title = ch.title;
  } catch (e) {}

  // 기존 행 검색
  const phoneEsc = userPhone.replace(/"/g, '');
  const existing = await atFindOne(env, AT_ACCESS,
    `AND({user_phone}="${phoneEsc}", {chapter_id}=${chapterId})`);

  // 새 expires_at 계산
  const nowIso = kstISOString();
  let newExpires;

  if (customExpires) {
    // 직접 지정 (YYYY-MM-DD 또는 ISO)
    newExpires = customExpires.length === 10 ? customExpires + 'T00:00:00.000Z' : customExpires;
  } else {
    // N일 연장 (활성이면 기존부터, 만료/신규면 NOW부터)
    const baseIso = existing && existing.fields.expires_at && existing.fields.expires_at > nowIso
      ? existing.fields.expires_at
      : nowIso;
    newExpires = addDays(baseIso, days);
  }

  const adminLabel = admin && (admin.name || admin.phone) ? (admin.name || admin.phone) : 'admin';
  const lastPaymentId = `ADMIN-${adminLabel}-${Date.now().toString(36)}`.slice(0, 100);

  const fields = {
    user_phone: userPhone,
    chapter_id: chapterId,
    chapter_title,
    expires_at: newExpires,
    source: 'admin_grant',
    last_payment_id: lastPaymentId,
  };

  let result;
  if (existing) {
    result = await atUpdate(env, AT_ACCESS, existing.id, fields);
  } else {
    result = await atCreate(env, AT_ACCESS, fields);
  }

  if (result && result.error) {
    return json({ error: 'airtable_error', message: result.error.message || 'unknown' }, 500, request);
  }

  return json({
    ok: true,
    action: existing ? 'updated' : 'created',
    user_phone: userPhone,
    chapter_id: chapterId,
    chapter_title,
    expires_at: newExpires,
    reason,
    memo,
  }, 200, request);
}

// 관리자가 사용자의 챕터 권한 회수 (행 삭제)
async function handleAdminAccessRevoke(request, env, admin, phone, chapterIdStr) {
  const userPhone = normalizePhone(decodeURIComponent(phone));
  const chapterId = Number(chapterIdStr);

  if (!userPhone || !chapterId) {
    return json({ error: 'invalid_parameters' }, 400, request);
  }

  const phoneEsc = userPhone.replace(/"/g, '');
  const existing = await atFindOne(env, AT_ACCESS,
    `AND({user_phone}="${phoneEsc}", {chapter_id}=${chapterId})`);

  if (!existing) {
    return json({ error: 'access_not_found' }, 404, request);
  }

  const result = await atDelete(env, AT_ACCESS, existing.id);
  if (result && result.error) {
    return json({ error: 'airtable_error', message: result.error.message || 'unknown' }, 500, request);
  }

  return json({
    ok: true,
    deleted_id: existing.id,
    user_phone: userPhone,
    chapter_id: chapterId,
  }, 200, request);
}

// DELETE /admin/user/:phone — 회원과 관련 데이터 일괄 삭제
// 영향 테이블 7곳: OnepageUsers / OnepageChapterAccess / OnepagePayments / OnepagePointTx
// / OnepageCampaignSends / op_understood / op_pings
// Worker 무료 플랜 서브요청 한도(50) 보호: 총 행 수가 너무 많으면 413으로 거부하고
// 수동 정리 안내 — 일반 회원은 거의 다 한 번에 처리됨.
async function handleAdminDeleteUser(request, env, phoneRaw) {
  const phone = normalizePhone(decodeURIComponent(phoneRaw));
  if (!phone) return json({ error: 'invalid_phone' }, 400, request);

  const userRec = await findUserByPhone(env, phone);
  if (!userRec) return json({ error: 'user_not_found' }, 404, request);
  if (String(userRec.fields.role || '') === 'teacher') {
    return json({ error: '관리자 계정은 삭제할 수 없습니다.' }, 403, request);
  }

  const phoneEsc = phone.replace(/"/g, '\\"');

  // Phase 1: 모든 관련 행 ID 병렬 수집
  let accessRecs = [], paymentRecs = [], pointTxRecs = [], sendRecs = [];
  let understoodItems = [], pingsItems = [];
  try {
    const [a, p, t, s, u, pg] = await Promise.all([
      atFindAllPaged(env, AT_ACCESS, `{user_phone}="${phoneEsc}"`, 500),
      atFindAllPaged(env, AT_PAYMENTS, `{user_phone}="${phoneEsc}"`, 500),
      atFindAllPaged(env, AT_POINTTX, `{user_phone}="${phoneEsc}"`, 1000),
      atFindAllPaged(env, AT_CAMPAIGN_SENDS, `{phone}="${phoneEsc}"`, 500).catch(() => []),
      ncbRead(env, 'op_understood', `user_phone=${encodeURIComponent(phone)}&limit=5000`),
      ncbRead(env, 'op_pings', `user_phone=${encodeURIComponent(phone)}&limit=100`),
    ]);
    accessRecs = a; paymentRecs = p; pointTxRecs = t; sendRecs = s;
    understoodItems = (u && u.data) || [];
    pingsItems = (pg && pg.data) || [];
  } catch (e) {
    return json({ error: 'lookup_failed', message: String(e?.message || e) }, 500, request);
  }

  const totalToDelete = accessRecs.length + paymentRecs.length + pointTxRecs.length
                      + sendRecs.length + understoodItems.length + pingsItems.length + 1;

  // 안전 한도: 무료 플랜 서브요청 50개 중 조회에 이미 7~20 정도 소진 → 삭제는 30개 정도 가능
  const MAX_DELETES = 30;
  if (totalToDelete > MAX_DELETES) {
    return json({
      error: 'too_many_records',
      message: `이 회원은 삭제할 데이터가 ${totalToDelete}건으로 한 번에 처리할 수 없습니다 (한 번 ${MAX_DELETES}건). 학습 이력이 많은 경우는 nocodebackend·Airtable에서 user_phone="${phone}" 으로 검색해 수동 정리해 주세요.`,
      total: totalToDelete,
      counts: {
        access: accessRecs.length,
        payments: paymentRecs.length,
        point_tx: pointTxRecs.length,
        sends: sendRecs.length,
        understood: understoodItems.length,
        pings: pingsItems.length,
      },
    }, 413, request);
  }

  // Phase 2: 병렬 삭제 (10개씩 묶어서 wall time 단축)
  const ops = [
    ...accessRecs.map(r => atDelete(env, AT_ACCESS, r.id)),
    ...paymentRecs.map(r => atDelete(env, AT_PAYMENTS, r.id)),
    ...pointTxRecs.map(r => atDelete(env, AT_POINTTX, r.id)),
    ...sendRecs.map(r => atDelete(env, AT_CAMPAIGN_SENDS, r.id)),
    ...understoodItems.map(it => ncbDelete(env, 'op_understood', it.id)),
    ...pingsItems.map(it => ncbDelete(env, 'op_pings', it.id)),
  ];
  const CHUNK = 10;
  try {
    for (let i = 0; i < ops.length; i += CHUNK) {
      await Promise.all(ops.slice(i, i + CHUNK));
    }
  } catch (e) {
    return json({
      error: 'partial_delete_failed',
      message: `중간 삭제 실패: ${String(e?.message || e)}. 일부 데이터가 남아 있을 수 있습니다. 다시 시도하세요.`,
    }, 500, request);
  }

  // 마지막: 사용자 본인 삭제 (실패해도 나머지는 이미 정리됨)
  try {
    await atDelete(env, AT_USERS, userRec.id);
  } catch (e) {
    return json({
      error: 'user_delete_failed',
      message: `관련 데이터는 모두 삭제했으나 마지막 사용자 레코드 삭제에 실패했습니다: ${String(e?.message || e)}`,
    }, 500, request);
  }

  return json({
    ok: true,
    deleted_phone: phone,
    total: totalToDelete,
    deleted: {
      user: 1,
      access: accessRecs.length,
      payments: paymentRecs.length,
      point_tx: pointTxRecs.length,
      sends: sendRecs.length,
      understood: understoodItems.length,
      pings: pingsItems.length,
    },
  }, 200, request);
}

async function handleAdminContentStats(request, env) {
  const [chaptersResp, topicsResp, accesses] = await Promise.all([
    ncbRead(env, 'op_chapters', 'limit=2000'),
    ncbRead(env, 'op_topics', 'limit=2000'),
    atFindAllPaged(env, AT_ACCESS, '', 5000),
  ]);
  const chapters = chaptersResp.data || [];
  const topics = topicsResp.data || [];
  const nowIso = kstISOString();

  const subsByCh = {};
  for (const a of accesses) {
    if (a.fields.expires_at > nowIso) {
      subsByCh[a.fields.chapter_id] = (subsByCh[a.fields.chapter_id] || 0) + 1;
    }
  }

  const topicsByCh = {}, freeTopicsByCh = {};
  for (const t of topics) {
    const cid = t.chapter_id;
    topicsByCh[cid] = (topicsByCh[cid] || 0) + 1;
    if (Number(t.is_free) === 1) freeTopicsByCh[cid] = (freeTopicsByCh[cid] || 0) + 1;
  }

  const stats = chapters.map(c => ({
    id: c.id,
    subject: c.subject || '',
    title: c.title || '',
    icon: c.icon || '',
    monthly_price: Number(c.monthly_price) || 0,
    is_all_free: Number(c.is_all_free) === 1,
    has_pay_url: !!(c.pay_url && String(c.pay_url).trim()),
    topic_count: topicsByCh[c.id] || 0,
    free_topic_count: freeTopicsByCh[c.id] || 0,
    active_subscribers: subsByCh[c.id] || 0,
    mrr: (subsByCh[c.id] || 0) * (Number(c.monthly_price) || 0),
  })).sort((a, b) => b.mrr - a.mrr);

  return json({
    chapters: stats,
    total_chapters: chapters.length,
    total_topics: topics.length,
    total_active_subs: Object.values(subsByCh).reduce((a, b) => a + b, 0),
    total_mrr: stats.reduce((s, c) => s + c.mrr, 0),
  }, 200, request);
}

// ============================================================
// PayApp 결제 (동적 세션 생성 + webhook 수신)
// ============================================================

// PayApp이 요구하는 정확한 응답 — HTTP 200 + body 'SUCCESS'
function payAppOk() {
  return new Response('SUCCESS', {
    status: 200,
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
}

// PayApp이 비-SUCCESS로 해석 → 최대 10회 retry (Airtable 다운 등 일시적 장애 시)
function payAppRetry(reason) {
  return new Response(String(reason || 'INTERNAL_ERROR'), {
    status: 500,
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
}

// form-urlencoded body 파싱
function parseFormUrlEncoded(text) {
  const out = {};
  if (!text) return out;
  for (const pair of text.split('&')) {
    const eq = pair.indexOf('=');
    if (eq < 0) continue;
    const k = decodeURIComponent(pair.slice(0, eq));
    const v = decodeURIComponent(pair.slice(eq + 1).replace(/\+/g, ' '));
    out[k] = v;
  }
  return out;
}

// 학생 앱 → Worker: 챕터 결제 세션 생성
async function handlePaymentRequest(request, env) {
  const auth = await verifyAuth(request, env);
  if (!auth) return json({ error: 'unauthenticated' }, 401, request);
  if (!env.PAYAPP_USERID) return json({ error: 'payapp_not_configured' }, 500, request);

  const b = await request.json().catch(() => ({}));
  const chapterId = Number(b.chapter_id);
  if (!chapterId) return json({ error: 'chapter_id required' }, 400, request);

  // 챕터 조회
  const chapter = await ncbReadById(env, 'op_chapters', chapterId);
  if (!chapter) return json({ error: 'chapter_not_found' }, 404, request);
  if (Number(chapter.is_all_free) === 1) {
    return json({ error: 'chapter_is_free' }, 400, request);
  }

  const price = Number(chapter.monthly_price) || 3000;
  const title = String(chapter.title || '').slice(0, 100);
  const userPhone = normalizePhone(auth.phone || '');

  // Worker 자신의 webhook 엔드포인트 (이 요청과 같은 origin)
  const workerOrigin = new URL(request.url).origin;
  const feedbackUrl = workerOrigin + '/payapp/webhook';
  const returnUrl = STUDENT_APP_ORIGIN + '/?paid=1&chapter=' + chapterId;

  // PayApp REST API 호출
  // skip_cstpage 제거: y 옵션은 returnurl로 POST 리다이렉트해서 Vercel 정적 호스팅 405 발생
  // → 학생은 페이앱 매출전표(영수증) 1초 본 후 "확인" 클릭 → GET 방식으로 returnurl 이동
  const params = new URLSearchParams({
    cmd: 'payrequest',
    userid: env.PAYAPP_USERID,
    goodname: title,
    price: String(price),
    recvphone: userPhone,
    feedbackurl: feedbackUrl,
    var1: String(chapterId),
    var2: userPhone,
    smsuse: 'n',
    checkretry: 'y',
    returnurl: returnUrl,
  });

  let r;
  try {
    r = await fetch(PAYAPP_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });
  } catch (e) {
    return json({ error: 'payapp_unreachable', message: String(e && e.message || e) }, 502, request);
  }

  const text = await r.text();
  const result = parseFormUrlEncoded(text);

  if (result.state !== '1') {
    return json({
      error: 'payapp_request_failed',
      errno: result.errno || '',
      message: result.errorMessage || 'unknown',
    }, 500, request);
  }

  return json({
    ok: true,
    payurl: result.payurl || '',
    mul_no: result.mul_no || '',
  }, 200, request);
}

// PayApp → Worker: 결제 완료 webhook
async function handlePayAppWebhook(request, env) {
  const text = await request.text();
  const fields = parseFormUrlEncoded(text);

  // DEBUG — wrangler tail로 추적 (운영 안정화 후 제거 권장)
  console.log('[payapp/webhook] body_len:', text.length);
  console.log('[payapp/webhook] fields:', JSON.stringify({
    userid: fields.userid || '(missing)',
    linkkey: fields.linkkey ? '(present:' + fields.linkkey.length + 'chars)' : '(missing)',
    linkval: fields.linkval ? '(present:' + fields.linkval.length + 'chars)' : '(missing)',
    pay_state: fields.pay_state || '(missing)',
    mul_no: fields.mul_no || '(missing)',
    var1: fields.var1 || '(missing)',
    var2: fields.var2 || '(missing)',
    price: fields.price || '(missing)',
    feedbacktype: fields.feedbacktype || '(missing)',
  }));
  console.log('[payapp/webhook] match:', JSON.stringify({
    userid_ok: fields.userid === env.PAYAPP_USERID,
    linkkey_ok: fields.linkkey === env.PAYAPP_LINKKEY,
    linkval_ok: fields.linkval === env.PAYAPP_LINKVAL,
    PAYAPP_USERID_set: !!env.PAYAPP_USERID,
    PAYAPP_LINKKEY_set: !!env.PAYAPP_LINKKEY,
    PAYAPP_LINKVAL_set: !!env.PAYAPP_LINKVAL,
  }));

  // 1. 보안 검증 — userid만 엄격히 검사
  //    (linkkey/linkval은 페이앱 콘솔의 사용자 입력값이라 운영자가 잘못 등록 가능 → silent skip 사고 위험)
  //    다른 보호 장치: mul_no 멱등성, feedbackurl 결제별 동적 지정, HTTPS
  if (env.PAYAPP_USERID && fields.userid && fields.userid !== env.PAYAPP_USERID) {
    console.log('[payapp/webhook] SKIP: userid mismatch (got: ' + fields.userid + ')');
    return payAppOk();
  }
  // linkkey/linkval은 일치하면 좋지만 강제 X — 로그로만 기록 (추후 시크릿 정확히 등록되면 enforce 가능)
  if (env.PAYAPP_LINKKEY && fields.linkkey && fields.linkkey !== env.PAYAPP_LINKKEY) {
    console.log('[payapp/webhook] WARN: linkkey mismatch (got len:' + fields.linkkey.length + ' expected len:' + env.PAYAPP_LINKKEY.length + ')');
    // 처리 계속 진행 (return 안 함)
  }
  if (env.PAYAPP_LINKVAL && fields.linkval && fields.linkval !== env.PAYAPP_LINKVAL) {
    console.log('[payapp/webhook] WARN: linkval mismatch (got len:' + fields.linkval.length + ' expected len:' + env.PAYAPP_LINKVAL.length + ')');
    // 처리 계속 진행 (return 안 함)
  }

  // 2. pay_state=4(결제완료)만 처리, 그 외는 SUCCESS만
  if (fields.pay_state !== '4') {
    console.log('[payapp/webhook] SKIP: pay_state=' + fields.pay_state);
    return payAppOk();
  }

  const mul_no = String(fields.mul_no || '').trim();
  if (!mul_no) {
    console.log('[payapp/webhook] SKIP: mul_no empty');
    return payAppOk();
  }

  const phone = String(fields.var2 || fields.recvphone || '').replace(/\D/g, '');
  const email = String(fields.buyer_email || '').toLowerCase().trim();
  const amount = parseInt(fields.price, 10) || 0;
  const goodname = String(fields.goodname || '').trim();
  const chapter_id = parseInt(fields.var1, 10) || 0;
  const raw_json = JSON.stringify(fields);

  console.log('[payapp/webhook] processing: mul_no=' + mul_no + ' chapter_id=' + chapter_id + ' phone=' + phone + ' amount=' + amount);

  // 3. 멱등성 검사 — 3 테이블 모두
  const mulNoEsc = mul_no.replace(/"/g, '');
  try {
    for (const t of [AT_PAYMENTS, AT_UNKNOWN, AT_FAILED]) {
      const dup = await atFindOne(env, t, `{mul_no}="${mulNoEsc}"`);
      if (dup) {
        console.log('[payapp/webhook] SKIP: duplicate in ' + t);
        return payAppOk();
      }
    }
  } catch (e) {
    console.log('[payapp/webhook] LOOKUP_FAILED: ' + (e && e.message || e));
    // 멱등성 검사 자체가 실패 → Airtable 다운 → retry 유도
    return payAppRetry('LOOKUP_FAILED');
  }

  // 4. 챕터 제목 보강 (var1이 있으면 nocodebackend에서 정확한 제목 가져오기)
  let chapter_title = goodname;
  if (chapter_id > 0) {
    try {
      const ch = await ncbReadById(env, 'op_chapters', chapter_id);
      if (ch && ch.title) chapter_title = ch.title;
    } catch (e) {}
  }

  const paid_at = kstDateTime();

  // 5. 저장 — chapter_id 있으면 OnepagePayments, 없으면 UnknownPayments
  try {
    if (chapter_id > 0) {
      const created = await atCreate(env, AT_PAYMENTS, {
        mul_no,
        user_phone: phone,
        user_email: email,
        chapter_id,
        chapter_title,
        amount,
        paid_at,
        status: 'paid',
        raw: raw_json,
      });
      if (created && created.error) {
        console.log('[payapp/webhook] OnepagePayments create error: ' + JSON.stringify(created.error));
        throw new Error(created.error.message || 'create_failed');
      }
      console.log('[payapp/webhook] CREATED in OnepagePayments: ' + (created && created.id || 'no-id'));
    } else {
      const created = await atCreate(env, AT_UNKNOWN, {
        mul_no,
        goodname,
        phone,
        email,
        amount,
        raw: raw_json,
        notes: 'var1 missing — chapter_id not provided in payment request',
      });
      if (created && created.error) {
        console.log('[payapp/webhook] UnknownPayments create error: ' + JSON.stringify(created.error));
        throw new Error(created.error.message || 'create_failed');
      }
      console.log('[payapp/webhook] CREATED in UnknownPayments: ' + (created && created.id || 'no-id'));
    }
    return payAppOk();
  } catch (err) {
    console.log('[payapp/webhook] caught error, writing to FailedPayments: ' + (err && err.message || err));
    // 6. 안전망 — FailedPayments에 기록
    try {
      const failed = await atCreate(env, AT_FAILED, {
        mul_no,
        goodname,
        phone,
        email,
        amount,
        raw: raw_json,
        error_message: String(err && err.message || err).slice(0, 500),
      });
      if (failed && failed.error) {
        console.log('[payapp/webhook] FailedPayments create error: ' + JSON.stringify(failed.error));
        return payAppRetry('AIRTABLE_DOWN');
      }
      console.log('[payapp/webhook] CREATED in FailedPayments: ' + (failed && failed.id || 'no-id'));
      return payAppOk();
    } catch (e2) {
      console.log('[payapp/webhook] FailedPayments also failed: ' + (e2 && e2.message || e2));
      return payAppRetry('AIRTABLE_DOWN');
    }
  }
}

// ============================================================
// 라우터
// ============================================================

function pathMatch(path, pattern) {
  // /chapters/123 vs /chapters/:id → { id: '123' } 또는 null
  const ps = path.split('/').filter(Boolean);
  const ts = pattern.split('/').filter(Boolean);
  if (ps.length !== ts.length) return null;
  const params = {};
  for (let i = 0; i < ps.length; i++) {
    if (ts[i].startsWith(':')) params[ts[i].slice(1)] = ps[i];
    else if (ts[i] !== ps[i]) return null;
  }
  return params;
}

async function route(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/$/, '') || '/';
  const m = request.method;

  // ── 공개 ──
  if (m === 'POST' && path === '/auth/signup') return handleSignup(request, env);
  if (m === 'POST' && path === '/auth/login') return handleLogin(request, env);
  if (m === 'GET' && path === '/auth/me') return handleMe(request, env);
  if (m === 'PUT' && path === '/auth/me/interests') return handleUpdateInterests(request, env);
  if (m === 'PUT' && path === '/auth/me/chapter_order') return handleUpdateChapterOrder(request, env);
  if (m === 'POST' && path === '/auth/change-password') return handleChangePassword(request, env);
  if (m === 'POST' && path === '/auth/forgot-password') return handleForgotPassword(request, env);
  if (m === 'POST' && path === '/auth/reset-password') return handleResetPassword(request, env);
  if (m === 'GET' && path === '/referral/info') return handleReferralInfo(request, env);
  if (m === 'GET' && path === '/stats/learners-now') return handleLearnersNow(request, env);
  if (m === 'GET' && path === '/stats/live-feed') return handleLiveFeed(request, env);
  if (m === 'POST' && path === '/stats/ping') return handleStatsPing(request, env);

  // ── PayApp webhook (공개, 페이앱 서버가 직접 호출) ──
  if (m === 'POST' && path === '/payapp/webhook') return handlePayAppWebhook(request, env);

  // ── 콘텐츠 읽기 (게이트는 items에만) ──
  if (m === 'GET' && path === '/chapters') return handleListChapters(request, env, ctx);
  if (m === 'GET' && path === '/topics') return handleListTopics(request, env);
  if (m === 'GET' && path === '/subtopics') return handleListSubtopics(request, env);
  if (m === 'GET' && path === '/items') return handleListItems(request, env);
  if (m === 'GET' && path === '/understood') return handleUnderstoodList(request, env);

  // ── 학생 (로그인 필수) ──
  if (m === 'POST' && path === '/understood') return handleUnderstoodToggle(request, env);
  if (m === 'POST' && path === '/understood/advance') return handleUnderstoodAdvance(request, env);
  if (m === 'POST' && path === '/understood/peek') return handleUnderstoodPeek(request, env);
  if (m === 'POST' && path === '/understood/pass') return handleUnderstoodPass(request, env);
  if (m === 'POST' && path === '/understood/promote') return handleUnderstoodPromote(request, env);
  if (m === 'GET' && path === '/access') return handleMyAccess(request, env);
  if (m === 'POST' && path === '/access/redeem') return handleRedeemPoints(request, env);
  if (m === 'POST' && path === '/payment/request') return handlePaymentRequest(request, env);

  // ── 선생님 (role check) ──
  const auth = await verifyAuth(request, env);
  const teacher = auth && auth.role === 'teacher';
  function teacherGate() {
    if (!auth) return json({ error: 'unauthenticated' }, 401, request);
    if (!teacher) return json({ error: 'teacher_only' }, 403, request);
    return null;
  }

  // chapters
  if (m === 'POST' && path === '/chapters') {
    const g = teacherGate(); if (g) return g;
    return handleCreateChapter(request, env, auth);
  }
  let p = pathMatch(path, '/chapters/:id');
  if (p) {
    const g = teacherGate(); if (g) return g;
    if (m === 'PUT') return handleUpdateChapter(request, env, auth, Number(p.id));
    if (m === 'DELETE') return handleDeleteChapter(request, env, auth, Number(p.id));
  }
  p = pathMatch(path, '/chapters/:id/bulk');
  if (p && m === 'POST') {
    const g = teacherGate(); if (g) return g;
    return handleBulkImport(request, env, Number(p.id));
  }

  // topics
  if (m === 'POST' && path === '/topics/reorder') {
    const g = teacherGate(); if (g) return g;
    return handleReorder(request, env, 'op_topics');
  }
  if (m === 'POST' && path === '/topics') {
    const g = teacherGate(); if (g) return g;
    return handleCreateTopic(request, env);
  }
  p = pathMatch(path, '/topics/:id');
  if (p) {
    const g = teacherGate(); if (g) return g;
    if (m === 'PUT') return handleUpdateTopic(request, env, Number(p.id));
    if (m === 'DELETE') return handleDeleteTopic(request, env, Number(p.id));
  }

  // subtopics
  if (m === 'POST' && path === '/subtopics/reorder') {
    const g = teacherGate(); if (g) return g;
    return handleReorder(request, env, 'op_subtopics');
  }
  if (m === 'POST' && path === '/subtopics') {
    const g = teacherGate(); if (g) return g;
    return handleCreateSubtopic(request, env);
  }
  p = pathMatch(path, '/subtopics/:id');
  if (p) {
    const g = teacherGate(); if (g) return g;
    if (m === 'PUT') return handleUpdateSubtopic(request, env, Number(p.id));
    if (m === 'DELETE') return handleDeleteSubtopic(request, env, Number(p.id));
  }

  // items
  if (m === 'POST' && path === '/items/reorder') {
    const g = teacherGate(); if (g) return g;
    return handleReorder(request, env, 'op_items');
  }
  if (m === 'POST' && path === '/items') {
    const g = teacherGate(); if (g) return g;
    return handleCreateItem(request, env);
  }
  p = pathMatch(path, '/items/:id');
  if (p) {
    const g = teacherGate(); if (g) return g;
    if (m === 'PUT') return handleUpdateItem(request, env, Number(p.id));
    if (m === 'DELETE') return handleDeleteItem(request, env, Number(p.id));
  }

  // ── 관리자 CRM ──
  if (path.startsWith('/admin/')) {
    const g = teacherGate(); if (g) return g;
    if (m === 'POST' && path === '/admin/op_pool/sync') return handleOpPoolSync(request, env);
    if (m === 'GET' && path === '/admin/overview') return handleAdminOverview(request, env);
    if (m === 'GET' && path === '/admin/users') return handleAdminUsers(request, env);
    p = pathMatch(path, '/admin/user/:phone');
    if (p && m === 'GET') return handleAdminUserDetail(request, env, p.phone);
    if (p && m === 'DELETE') return handleAdminDeleteUser(request, env, p.phone);
    if (m === 'POST' && path === '/admin/points') return handleAdminGrantPoints(request, env, auth);
    if (m === 'POST' && path === '/admin/webhook/send') return handleAdminWebhookSend(request, env, auth);
    if (m === 'GET' && path === '/admin/campaign-sends') return handleAdminCampaigns(request, env);
    if (m === 'GET' && path === '/admin/campaign-conversion') return handleAdminCampaignConversion(request, env);
    if (m === 'GET' && path === '/admin/revenue') return handleAdminRevenue(request, env);
    if (m === 'GET' && path === '/admin/content-stats') return handleAdminContentStats(request, env);
    if (m === 'GET' && path === '/admin/attribution') return handleAdminAttribution(request, env);
    // 챕터 권한 수동 관리
    if (m === 'POST' && path === '/admin/access/grant') return handleAdminAccessGrant(request, env, auth);
    p = pathMatch(path, '/admin/access/:phone/:chapter_id');
    if (p && m === 'DELETE') return handleAdminAccessRevoke(request, env, auth, p.phone, p.chapter_id);
    // 저장된 캐페인 (UTM 라이브러리)
    if (m === 'GET' && path === '/admin/campaigns') return handleListCampaigns(request, env);
    if (m === 'POST' && path === '/admin/campaigns') return handleCreateCampaign(request, env, auth);
    p = pathMatch(path, '/admin/campaigns/:id');
    if (p) {
      if (m === 'PUT') return handleUpdateCampaign(request, env, p.id);
      if (m === 'DELETE') return handleDeleteCampaign(request, env, p.id);
    }
    // 전단지 기본틀(템플릿) — 서버 저장
    if (m === 'GET' && path === '/admin/flyer-templates') return handleFlyerTplList(request, env);
    if (m === 'POST' && path === '/admin/flyer-templates') return handleFlyerTplCreate(request, env);
    p = pathMatch(path, '/admin/flyer-templates/:id');
    if (p) {
      if (m === 'GET') return handleFlyerTplGet(request, env, p.id);
      if (m === 'PUT') return handleFlyerTplUpdate(request, env, p.id);
      if (m === 'DELETE') return handleFlyerTplDelete(request, env, p.id);
    }
    // 전단지 문구 세트 — 서버 저장
    if (m === 'GET' && path === '/admin/flyer-copysets') return handleFlyerCopyList(request, env);
    if (m === 'POST' && path === '/admin/flyer-copysets') return handleFlyerCopyCreate(request, env);
    p = pathMatch(path, '/admin/flyer-copysets/:id');
    if (p) {
      if (m === 'PUT') return handleFlyerCopyUpdate(request, env, p.id);
      if (m === 'DELETE') return handleFlyerCopyDelete(request, env, p.id);
    }
  }

  return json({ error: 'not_found', path, method: m }, 404, request);
}

// ============================================================
// Worker entry
// ============================================================

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(request) });
    }
    try {
      return await route(request, env, ctx);
    } catch (e) {
      console.error('worker_error', e);
      return json({ error: 'server_error', message: String(e?.message || e) }, 500, request);
    }
  },
};
