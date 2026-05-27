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

const REFERRAL_BONUS = 1000;
const REDEEM_COST = 3000;
const REDEEM_DAYS = 30;
const PING_WINDOW_MIN = 5;

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
async function atUpdate(env, table, recordId, fields) {
  const url = `${AT_BASE_URL}/${env.AIRTABLE_BASE}/${encodeURIComponent(table)}/${recordId}`;
  const r = await fetch(url, {
    method: 'PATCH', headers: atH(env),
    body: JSON.stringify({ fields, typecast: true }),
  });
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
    },
    chapter_access: access, // { chapter_id: { expires_at, source } }
  }, 200, request);
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
// 핸들러 — 챕터/토픽/소목차 (CRUD)
// ============================================================

async function handleListChapters(request, env) {
  const url = new URL(request.url);
  const subject = url.searchParams.get('subject');
  const filter = subject ? `subject=${encodeURIComponent(subject)}` : '';
  const r = await ncbRead(env, 'op_chapters', filter);
  const list = (r.data || []).sort((a, b) =>
    (a.subject || '').localeCompare(b.subject || '') ||
    (Number(a.sort_order) || 0) - (Number(b.sort_order) || 0) ||
    (Number(a.id) || 0) - (Number(b.id) || 0)
  );
  return json({ chapters: list }, 200, request);
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
    updated_at: kstDateTime(),
  };
  if (!data.subject || !data.title) return json({ error: 'subject, title 필수' }, 400, request);
  const r = await ncbCreate(env, 'op_chapters', data);
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
  patch.updated_at = kstDateTime();
  const r = await ncbUpdate(env, 'op_chapters', id, patch);
  return json({ ok: true, result: r }, 200, request);
}

async function handleDeleteChapter(request, env, user, id) {
  // FK CASCADE로 자식 자동 정리
  await ncbDelete(env, 'op_chapters', id);
  return json({ ok: true }, 200, request);
}

async function handleListTopics(request, env) {
  const url = new URL(request.url);
  const chapterId = url.searchParams.get('chapter_id');
  if (!chapterId) return json({ error: 'chapter_id required' }, 400, request);
  const r = await ncbRead(env, 'op_topics', `chapter_id=${chapterId}`);
  const topics = (r.data || []).sort((a, b) =>
    (Number(a.sort_order) || 0) - (Number(b.sort_order) || 0) ||
    (Number(a.id) || 0) - (Number(b.id) || 0)
  );
  // 각 토픽의 소목차를 병렬 fetch — 한꺼번에 가져와 count + 캐시
  const subsArr = await Promise.all(
    topics.map(t => ncbRead(env, 'op_subtopics', `topic_id=${t.id}&limit=200`))
  );
  topics.forEach((t, i) => {
    const subs = (subsArr[i] && subsArr[i].data) || [];
    t.subtopic_count = subs.length;
    // 클라이언트가 별도 /subtopics 호출 없이 바로 쓰도록 동봉
    t.subtopics = subs.sort((a, b) =>
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
  const subs = (r.data || []).sort((a, b) =>
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
    updated_at: kstDateTime(),
  };
  if (!data.topic_id || !data.title) return json({ error: 'topic_id, title 필수' }, 400, request);
  const r = await ncbCreate(env, 'op_subtopics', data);
  return json({ ok: true, id: r.id, subtopic: { ...data, id: r.id } }, 200, request);
}

async function handleUpdateSubtopic(request, env, id) {
  const b = await request.json().catch(() => ({}));
  const patch = {};
  if (b.title !== undefined) patch.title = String(b.title).trim();
  if (b.sort_order !== undefined) patch.sort_order = Number(b.sort_order) || 0;
  if (b.topic_id !== undefined) patch.topic_id = Number(b.topic_id);
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
    return json({ items }, 200, request);
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
  return json({ items }, 200, request);
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

async function handleCreateItem(request, env) {
  const b = await request.json().catch(() => ({}));
  const kind = b.kind === 'image' ? 'image' : 'text';
  const data = {
    subtopic_id: Number(b.subtopic_id),
    kind,
    text: kind === 'text' ? String(b.text || '') : '',
    image_b64: kind === 'image' ? wrapImg(b.image_b64) : null,
    caption: String(b.caption || ''),
    sort_order: Number(b.sort_order) || 0,
    updated_at: kstDateTime(),
  };
  if (!data.subtopic_id) return json({ error: 'subtopic_id 필수' }, 400, request);
  const r = await ncbCreate(env, 'op_items', data);
  return json({
    ok: true, id: r.id,
    item: { ...data, image_b64: unwrapImg(data.image_b64), id: r.id }
  }, 200, request);
}

async function handleUpdateItem(request, env, id) {
  const b = await request.json().catch(() => ({}));
  const patch = {};
  if (b.kind !== undefined) patch.kind = b.kind === 'image' ? 'image' : 'text';
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

// ============================================================
// 일괄 입력 (TSV: 대목차\t소목차\t내용)
// ============================================================

function parseTSV(text) {
  const lines = String(text || '').split(/\r?\n/);
  const rows = [];
  let topicTitle = null, subTitle = null;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (!raw.trim() && !raw.includes('\t')) continue; // 완전 빈줄 스킵
    const cols = raw.split('\t');
    const a = (cols[0] || '').trim();
    const b = (cols[1] || '').trim();
    const c = (cols[2] || '').trim();

    // 헤더 자동 인식
    if (i === 0 && (a === '대목차' || a === 'topic' || a === 'Topic')) continue;

    // 새 대목차
    if (a) { topicTitle = a; subTitle = null; }
    // 새 소목차
    if (b) { subTitle = b; }

    // 내용 행이 있으면 검증
    if (c) {
      if (!subTitle) return { error: `${i + 1}행: 소목차 없이 내용이 시작됩니다.` };
      rows.push({ line: i + 1, topic: topicTitle, sub: subTitle, text: c });
    } else if (b && !topicTitle) {
      return { error: `${i + 1}행: 대목차 없이 소목차가 시작됩니다.` };
    }
  }
  return { rows };
}

async function handleBulkImport(request, env, chapterId) {
  const b = await request.json().catch(() => ({}));
  const mode = b.mode === 'replace' ? 'replace' : 'append';
  const text = String(b.tsv || b.text || '');

  const chapter = await ncbReadById(env, 'op_chapters', chapterId);
  if (!chapter) return json({ error: 'chapter_not_found' }, 404, request);

  const parsed = parseTSV(text);
  if (parsed.error) return json({ error: parsed.error }, 400, request);
  if (!parsed.rows.length) return json({ error: '내용이 없습니다.' }, 400, request);

  // replace 모드: 기존 토픽 모두 삭제 (CASCADE로 하위까지)
  if (mode === 'replace') {
    const exist = await ncbRead(env, 'op_topics', `chapter_id=${chapterId}&limit=500`);
    for (const t of exist.data || []) {
      await ncbDelete(env, 'op_topics', t.id);
    }
  }

  // 기존 sort_order 최대값 (append용)
  let topicBase = 0;
  if (mode === 'append') {
    const exist = await ncbRead(env, 'op_topics', `chapter_id=${chapterId}&limit=500`);
    for (const t of exist.data || []) {
      topicBase = Math.max(topicBase, Number(t.sort_order) || 0);
    }
  }

  const topicMap = new Map(); // title → id
  const subMap = new Map();   // topicId|title → id

  let createdT = 0, createdS = 0, createdI = 0;
  let tOrd = topicBase + 1;

  for (const row of parsed.rows) {
    // 토픽
    let topicId = topicMap.get(row.topic);
    if (!topicId) {
      const r = await ncbCreate(env, 'op_topics', {
        chapter_id: Number(chapterId),
        title: row.topic,
        sort_order: tOrd++,
        is_free: 0,
        updated_at: kstDateTime(),
      });
      topicId = r.id;
      topicMap.set(row.topic, topicId);
      createdT++;
    }

    // 소목차
    const subKey = topicId + '|' + row.sub;
    let subId = subMap.get(subKey);
    if (!subId) {
      const r = await ncbCreate(env, 'op_subtopics', {
        topic_id: Number(topicId),
        title: row.sub,
        sort_order: subMap.size + 1,
        updated_at: kstDateTime(),
      });
      subId = r.id;
      subMap.set(subKey, subId);
      createdS++;
    }

    // 내용
    await ncbCreate(env, 'op_items', {
      subtopic_id: Number(subId),
      kind: 'text',
      text: row.text,
      image_b64: null,
      caption: '',
      sort_order: createdI + 1,
      updated_at: kstDateTime(),
    });
    createdI++;
  }

  return json({
    ok: true,
    topics_added: createdT,
    subtopics_added: createdS,
    items_added: createdI,
    mode,
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
    await ncbCreate(env, 'op_understood', {
      user_phone: auth.phone,
      subtopic_id: subId,
      marked_at: kstDateTime(),
    });
    return json({ understood: true }, 200, request);
  }
}

async function handleUnderstoodList(request, env) {
  const auth = await verifyAuth(request, env);
  if (!auth) return json({ error: 'unauthenticated' }, 401, request);
  const url = new URL(request.url);
  const chapterId = url.searchParams.get('chapter_id');

  // 단순화: 사용자의 모든 understood 가져와 클라이언트에서 필터
  const r = await ncbRead(env, 'op_understood',
    `user_phone=${encodeURIComponent(auth.phone)}&limit=2000`);
  const ids = (r.data || []).map(x => Number(x.subtopic_id));
  return json({ subtopic_ids: ids, chapter_id: chapterId ? Number(chapterId) : null }, 200, request);
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

  const r = await ncbRead(env, 'op_pings',
    `user_phone=${encodeURIComponent(phone)}&limit=1`);
  const existing = (r.data || [])[0];

  if (existing) {
    await ncbUpdate(env, 'op_pings', existing.id, {
      first_ping_today: today,
      last_ping_at: now,
    });
  } else {
    await ncbCreate(env, 'op_pings', {
      user_phone: phone,
      first_ping_today: today,
      last_ping_at: now,
    });
  }
  return json({ ok: true }, 200, request);
}

async function handleLearnersNow(request, env) {
  const today = kstDateStr();
  const r = await ncbRead(env, 'op_pings',
    `first_ping_today=${today}&limit=2000`);
  return json({ count: (r.data || []).length, date: today }, 200, request);
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

async function route(request, env) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/$/, '') || '/';
  const m = request.method;

  // ── 공개 ──
  if (m === 'POST' && path === '/auth/signup') return handleSignup(request, env);
  if (m === 'POST' && path === '/auth/login') return handleLogin(request, env);
  if (m === 'GET' && path === '/auth/me') return handleMe(request, env);
  if (m === 'GET' && path === '/referral/info') return handleReferralInfo(request, env);
  if (m === 'GET' && path === '/stats/learners-now') return handleLearnersNow(request, env);
  if (m === 'POST' && path === '/stats/ping') return handleStatsPing(request, env);

  // ── 콘텐츠 읽기 (게이트는 items에만) ──
  if (m === 'GET' && path === '/chapters') return handleListChapters(request, env);
  if (m === 'GET' && path === '/topics') return handleListTopics(request, env);
  if (m === 'GET' && path === '/subtopics') return handleListSubtopics(request, env);
  if (m === 'GET' && path === '/items') return handleListItems(request, env);
  if (m === 'GET' && path === '/understood') return handleUnderstoodList(request, env);

  // ── 학생 (로그인 필수) ──
  if (m === 'POST' && path === '/understood') return handleUnderstoodToggle(request, env);
  if (m === 'GET' && path === '/access') return handleMyAccess(request, env);
  if (m === 'POST' && path === '/access/redeem') return handleRedeemPoints(request, env);

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
      return await route(request, env);
    } catch (e) {
      console.error('worker_error', e);
      return json({ error: 'server_error', message: String(e?.message || e) }, 500, request);
    }
  },
};
