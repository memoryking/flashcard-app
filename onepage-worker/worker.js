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
    pay_url: String(b.pay_url || '').trim(),
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
  if (b.pay_url !== undefined) patch.pay_url = String(b.pay_url).trim();
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

// Excel TSV: 셀에 줄바꿈이 있으면 셀 전체를 따옴표("...")로 감쌈.
// raw 텍스트를 "줄(=한 row) 단위"로 정확히 자르는 헬퍼.
function tsvLines(text) {
  const out = [];
  let buf = '';
  let inQuote = false;
  const s = String(text || '');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '"') {
      // 이중 따옴표("") = 이스케이프된 ", 그렇지 않으면 토글
      if (inQuote && s[i + 1] === '"') { buf += '"'; i++; continue; }
      inQuote = !inQuote;
      buf += ch;
    } else if ((ch === '\n' || ch === '\r') && !inQuote) {
      if (ch === '\r' && s[i + 1] === '\n') i++;
      out.push(buf); buf = '';
    } else {
      buf += ch;
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
  //   대목차(A) | 소목차(B) | 내용1(C) | 내용2(D) | 내용3(E) | ...
  //   각 행은 한 소목차이고 C열부터 여러 내용 칸이 가로로 나열됨
  //   대목차 칸이 비어 있으면 이전 대목차에 계속
  const lines = tsvLines(text);
  const rows = [];
  let topicTitle = null;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (!raw.trim() && !raw.includes('\t')) continue; // 완전 빈 줄
    const cols = raw.split('\t').map(unquote);
    const a = cols[0] || '';
    const b = cols[1] || '';
    // C열부터 끝까지가 그 소목차의 내용 항목들
    const items = cols.slice(2).filter(c => c.length > 0);

    // 헤더 자동 스킵
    if (i === 0 && (a === '대목차' || a === 'topic' || a === 'Topic')) continue;

    // 새 대목차
    if (a) topicTitle = a;

    if (b) {
      if (!topicTitle) return { error: `${i + 1}행: 대목차가 정해지지 않았습니다.` };
      if (!items.length) return { error: `${i + 1}행: 소목차 '${b}'에 내용이 없습니다 (3번째 칸부터 내용 입력).` };
      for (const text of items) {
        rows.push({ line: i + 1, topic: topicTitle, sub: b, text });
      }
    } else if (items.length) {
      return { error: `${i + 1}행: 소목차 칸이 비어 있는데 내용만 있습니다.` };
    }
  }

  return { rows };
}

// Cloudflare Workers 서브요청 한도(Free 50 / Paid 1000) 회피를 위한 청크 처리.
// 매 호출에 안전 한도(MAX_REQ) 만큼만 처리하고 next_start·맵을 돌려보냄.
// 클라이언트가 done=true 될 때까지 반복 호출.
async function handleBulkImport(request, env, chapterId) {
  const b = await request.json().catch(() => ({}));
  const mode = b.mode === 'replace' ? 'replace' : 'append';
  const text = String(b.tsv || b.text || '');
  const start = Number(b.start) || 0;
  const topicMap = new Map(Object.entries(b.topic_map || {}).map(([k, v]) => [k, Number(v)]));
  const subMap = new Map(Object.entries(b.sub_map || {}).map(([k, v]) => [k, Number(v)]));
  const baseSort = Number(b.base_sort) || 0;

  const MAX_REQ = 40; // 50 - 안전 마진. 첫 호출은 read·delete도 포함되므로 더 보수적

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
    if (mode === 'replace') {
      const exist = await ncbRead(env, 'op_topics', `chapter_id=${chapterId}&limit=500`);
      used++;
      for (const t of exist.data || []) {
        if (used >= MAX_REQ) break; // 너무 많이 지워야 하면 다음 호출에서
        await ncbDelete(env, 'op_topics', t.id);
        used++;
      }
    } else {
      // append용 — 기존 토픽의 sort_order 최대값
      const exist = await ncbRead(env, 'op_topics', `chapter_id=${chapterId}&limit=500`);
      used++;
      for (const t of exist.data || []) {
        topicBase = Math.max(topicBase, Number(t.sort_order) || 0);
      }
    }
  }
  let tOrd = topicBase + 1;

  let i = start;
  while (i < parsed.rows.length) {
    const row = parsed.rows[i];
    // 토픽 생성 (필요 시)
    if (!topicMap.has(row.topic)) {
      if (used + 1 > MAX_REQ) break;
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

    // 소목차 생성 (필요 시)
    const subKey = topicId + '|' + row.sub;
    if (!subMap.has(subKey)) {
      if (used + 1 > MAX_REQ) break;
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

    // 내용 생성
    if (used + 1 > MAX_REQ) break;
    await ncbCreate(env, 'op_items', {
      subtopic_id: Number(subId),
      kind: 'text',
      text: row.text,
      image_b64: null,
      caption: '',
      sort_order: i + 1,
      updated_at: kstDateTime(),
    });
    used++; createdI++;
    i++;
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
// 관리자 CRM
// ============================================================

const AT_PAYMENTS = 'OnepagePayments';

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
    ncbRead(env, 'op_chapters', ''),
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
  for (const phone of phones) {
    const user = userMap[phone];
    if (!user) {
      results.push({ phone, ok: false, error: 'user_not_found' });
      continue;
    }
    const payload = {
      template,
      channel,
      subject,
      sent_at: kstISOString(),
      sent_by: sender.name || sender.phone || '',
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
      results.push({ phone, ok: r.ok, status: r.status });
    } catch (e) {
      results.push({ phone, ok: false, error: String(e && e.message || e) });
    }
  }

  const okCount = results.filter(r => r.ok).length;
  return json({ ok: true, sent: okCount, total: results.length, results }, 200, request);
}

async function handleAdminRevenue(request, env) {
  const url = new URL(request.url);
  const days = Math.min(365, Math.max(7, Number(url.searchParams.get('days')) || 30));
  const nowIso = kstISOString();
  const fromIso = addDays(nowIso, -days);

  const [payments, chaptersResp, users] = await Promise.all([
    atFindAllPaged(env, AT_PAYMENTS, `IS_AFTER({paid_at}, "${fromIso}")`, 5000),
    ncbRead(env, 'op_chapters', ''),
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

async function handleAdminContentStats(request, env) {
  const [chaptersResp, topicsResp, accesses] = await Promise.all([
    ncbRead(env, 'op_chapters', ''),
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

  // ── 관리자 CRM ──
  if (path.startsWith('/admin/')) {
    const g = teacherGate(); if (g) return g;
    if (m === 'GET' && path === '/admin/overview') return handleAdminOverview(request, env);
    if (m === 'GET' && path === '/admin/users') return handleAdminUsers(request, env);
    p = pathMatch(path, '/admin/user/:phone');
    if (p && m === 'GET') return handleAdminUserDetail(request, env, p.phone);
    if (m === 'POST' && path === '/admin/points') return handleAdminGrantPoints(request, env, auth);
    if (m === 'POST' && path === '/admin/webhook/send') return handleAdminWebhookSend(request, env, auth);
    if (m === 'GET' && path === '/admin/revenue') return handleAdminRevenue(request, env);
    if (m === 'GET' && path === '/admin/content-stats') return handleAdminContentStats(request, env);
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
