// ============================================================
// Cloudflare Worker: stats-api.memoryking.workers.dev
// 인증(PBKDF2) + JWT + 학습 로그 + 통계 API
// ============================================================

const ALLOWED_ORIGINS = [
  'https://memoryking.github.io',
  'https://vipup.site',
  'https://www.vipup.site',
  'http://localhost:3000',
  'http://localhost:8080',
  'http://127.0.0.1:5500',
];

// ── 추천 보너스 (나중에 이 숫자만 수정하면 됩니다) ─────────────
const REFERRAL_BONUS = 100; // cm_point

// ── 추천 코드 변환 (userId ↔ 코드) ──────────────────────────
function toReferralCode(userId) {
  return (Number(userId) * 7919 + 100000).toString(36).toUpperCase();
}
function fromReferralCode(code) {
  if (!code) return null;
  const n = parseInt(String(code).toLowerCase(), 36);
  if (isNaN(n) || (n - 100000) % 7919 !== 0) return null;
  const id = (n - 100000) / 7919;
  return id > 0 ? id : null;
}

// ── CORS ──────────────────────────────────────────────────────
function corsHeaders(request) {
  const origin = request.headers.get('Origin') || '';
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
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
  const [saltB64, hashB64] = stored.split(':');
  const salt = Uint8Array.from(atob(saltB64), c => c.charCodeAt(0));
  const keyMaterial = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']
  );
  const hash = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
    keyMaterial, 256
  );
  const computed = btoa(String.fromCharCode(...new Uint8Array(hash)));
  return computed === hashB64;
}

// ── JWT (HMAC-SHA256, Web Crypto) ─────────────────────────────
// UTF-8 안전한 base64 인코딩/디코딩 (한글 닉네임 등 지원)
function utf8ToBase64url(str) {
  const bytes = new TextEncoder().encode(str);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64urlToUtf8(b64) {
  let str = b64.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  const binary = atob(str);
  const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function bytesToBase64url(buf) {
  let binary = '';
  for (const b of new Uint8Array(buf)) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64urlToBytes(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  return Uint8Array.from(atob(str), c => c.charCodeAt(0));
}

async function getJwtKey(secret) {
  return crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']
  );
}

async function createJwt(payload, secret) {
  const header = utf8ToBase64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const now = Math.floor(Date.now() / 1000);
  const body = utf8ToBase64url(JSON.stringify({ ...payload, iat: now, exp: now + 30 * 24 * 3600 }));
  const data = header + '.' + body;
  const key = await getJwtKey(secret);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  return data + '.' + bytesToBase64url(sig);
}

async function verifyJwt(token, secret) {
  try {
    const [header, body, sig] = token.split('.');
    if (!header || !body || !sig) return null;
    const key = await getJwtKey(secret);
    const valid = await crypto.subtle.verify(
      'HMAC', key, base64urlToBytes(sig), new TextEncoder().encode(header + '.' + body)
    );
    if (!valid) return null;
    const payload = JSON.parse(base64urlToUtf8(body));
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch { return null; }
}

// ── nocodebackend 헬퍼 ────────────────────────────────────────
// Base: https://openapi.nocodebackend.com
// 모든 요청에 ?Instance=... 필수
const NCB_BASE = 'https://openapi.nocodebackend.com';
const NCB_INSTANCE = '55910_flashcard_app';

function ncbUrl(path, extraParams = '') {
  const sep = extraParams ? '&' : '';
  return `${NCB_BASE}${path}?Instance=${NCB_INSTANCE}${sep}${extraParams}`;
}

const ncbHeaders = (env) => ({
  'Content-Type': 'application/json',
  'Authorization': `Bearer ${env.NCB_SECRET_KEY}`,
});

// POST /create/{table} → { status, message, id }
async function ncbCreate(env, table, data) {
  const res = await fetch(ncbUrl(`/create/${table}`), {
    method: 'POST', headers: ncbHeaders(env), body: JSON.stringify(data),
  });
  return res.json();
}

// GET /read/{table}?field=value&limit=... → { status, data: [...] }
async function ncbRead(env, table, filters = '') {
  const res = await fetch(ncbUrl(`/read/${table}`, filters), {
    method: 'GET', headers: ncbHeaders(env),
  });
  return res.json();
}

// POST /search/{table} → { status, data: [...] }
async function ncbSearch(env, table, query) {
  const res = await fetch(ncbUrl(`/search/${table}`), {
    method: 'POST', headers: ncbHeaders(env), body: JSON.stringify(query),
  });
  return res.json();
}

// PUT /update/{table}/{id}
async function ncbUpdate(env, table, id, data) {
  const res = await fetch(ncbUrl(`/update/${table}/${id}`), {
    method: 'PUT', headers: ncbHeaders(env), body: JSON.stringify(data),
  });
  return res.json();
}

// 단일 레코드 읽기 (id 필터)
async function ncbReadById(env, table, id) {
  const res = await ncbRead(env, table, 'id=' + id + '&limit=1');
  return { data: Array.isArray(res?.data) ? res.data[0] : null };
}

// ── Airtable 회원 미러 ──────────────────────────────────────
const AT_BASE_URL = 'https://api.airtable.com/v0';
const AT_TABLE = 'Users';

const atHeaders = (env) => ({
  'Authorization': 'Bearer ' + env.AIRTABLE_TOKEN,
  'Content-Type': 'application/json',
});

async function atFindByNcbId(env, ncbId) {
  const formula = encodeURIComponent(`{ncb_id}="${ncbId}"`);
  const res = await fetch(
    `${AT_BASE_URL}/${env.AIRTABLE_BASE}/${AT_TABLE}?filterByFormula=${formula}&maxRecords=1`,
    { headers: atHeaders(env) }
  );
  const json = await res.json();
  const rec = json.records?.[0];
  return rec ? rec.id : null;
}

async function atCreate(env, fields) {
  await fetch(`${AT_BASE_URL}/${env.AIRTABLE_BASE}/${AT_TABLE}`, {
    method: 'POST',
    headers: atHeaders(env),
    body: JSON.stringify({ fields }),
  });
}

async function atResolveBuddyNames(env, buddiesRaw) {
  let buddies = [];
  try { buddies = Array.isArray(buddiesRaw) ? buddiesRaw : JSON.parse(buddiesRaw || '[]'); } catch {}
  if (!Array.isArray(buddies) || buddies.length === 0) return [];
  const names = [];
  for (const bid of buddies) {
    try {
      const r = await ncbReadById(env, 'users', bid);
      names.push(r.data?.nickname || String(bid));
    } catch { names.push(String(bid)); }
  }
  return names;
}

async function atUpsert(env, ncbId, fields) {
  const recId = await atFindByNcbId(env, ncbId);
  if (recId) {
    await fetch(`${AT_BASE_URL}/${env.AIRTABLE_BASE}/${AT_TABLE}/${recId}`, {
      method: 'PATCH',
      headers: atHeaders(env),
      body: JSON.stringify({ fields }),
    });
  } else {
    // 새 레코드 → NCB에서 전체 사용자 정보 가져와서 병합
    let baseFields = {};
    try {
      const u = (await ncbReadById(env, 'users', ncbId)).data;
      if (u) {
        let refName = '';
        if (u.referred_by) {
          try {
            const rr = await ncbReadById(env, 'users', u.referred_by);
            refName = rr.data?.nickname || String(u.referred_by);
          } catch {}
        }
        const buddyNames = await atResolveBuddyNames(env, u.buddies);
        let buddies = [];
        try { buddies = Array.isArray(u.buddies) ? u.buddies : JSON.parse(u.buddies || '[]'); } catch {}
        baseFields = {
          email: u.email || '',
          nickname: u.nickname || '',
          point: Number(u.point) || 0,
          cm_point: Number(u.cm_point) || 0,
          referred_by: refName,
          buddy_count: Array.isArray(buddies) ? buddies.length : 0,
          buddy_names: buddyNames,
          last_roulette: u.last_roulette || '',
          created_at: u.created_at || '',
        };
      }
    } catch {}
    await atCreate(env, { ncb_id: String(ncbId), ...baseFields, ...fields });
  }
}

function syncToAirtable(ctx, env, ncbId, fields) {
  if (!env.AIRTABLE_TOKEN || !env.AIRTABLE_BASE) return;
  ctx.waitUntil(
    atUpsert(env, ncbId, fields).catch(e => console.error('AT sync:', e))
  );
}

// ── Rate Limiting (메모리 기반, Worker 재시작 시 초기화) ───────
const rateLimitMap = new Map();
function rateLimit(ip, limit = 10, windowSec = 60) {
  const now = Date.now();
  const key = ip;
  const entry = rateLimitMap.get(key);
  if (!entry || now - entry.start > windowSec * 1000) {
    rateLimitMap.set(key, { start: now, count: 1 });
    return true;
  }
  entry.count++;
  if (entry.count > limit) return false;
  return true;
}

// ── 라우터 ────────────────────────────────────────────────────
export default {
  async fetch(request, env, ctx) {
    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(request) });
    }

    const url = new URL(request.url);
    const path = url.pathname;
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';

    try {
      // ── POST /auth/signup ───────────────────────────────
      if (path === '/auth/signup' && request.method === 'POST') {
        if (!rateLimit(ip, 5, 300)) return json({ error: '요청이 너무 많습니다. 잠시 후 다시 시도해주세요.' }, 429, request);

        const { email, password, nickname, referral_code } = await request.json();
        if (!email || !password || !nickname) {
          return json({ error: '이메일, 비밀번호, 닉네임을 모두 입력해주세요.' }, 400, request);
        }
        if (password.length < 6) {
          return json({ error: '비밀번호는 6자 이상이어야 합니다.' }, 400, request);
        }

        // 이메일 중복 체크
        const existing = await ncbSearch(env, 'users', { email });
        const existingList = existing?.data || [];
        if (existingList.length > 0) {
          return json({ error: '이미 사용 중인 이메일입니다.' }, 409, request);
        }

        const password_hash = await hashPassword(password);
        const created_at = new Date(Date.now() + 9 * 3600000).toISOString().replace('Z', '+09:00');

        const result = await ncbCreate(env, 'users', { email, password_hash, nickname, created_at });

        const userId = result.id || result?.data?.id;
        if (!userId) {
          return json({ error: '회원가입에 실패했습니다.' }, 500, request);
        }

        // ── 추천 코드 처리 (실패해도 가입은 성공) ──
        let _refNickname = '';   // AT sync용: 추천인 닉네임
        let _refBuddyNames = ''; // AT sync용: 추천인의 친구 닉네임 목록
        if (referral_code) {
          try {
            const refId = fromReferralCode(referral_code);
            if (refId && refId !== Number(userId)) {
              const refRes = await ncbReadById(env, 'users', refId);
              if (refRes.data) {
                _refNickname = refRes.data.nickname || '';

                // 추천인 cm_point 보너스
                const oldCm = Number(refRes.data.cm_point) || 0;
                await ncbUpdate(env, 'users', refId, { cm_point: oldCm + REFERRAL_BONUS });

                // 새 유저에 referred_by 저장
                await ncbUpdate(env, 'users', userId, { referred_by: refId });

                // 서로 공부친구 자동 추가
                let refBuddies = [];
                try { refBuddies = Array.isArray(refRes.data.buddies) ? refRes.data.buddies : JSON.parse(refRes.data.buddies || '[]'); } catch {}
                if (!Array.isArray(refBuddies)) refBuddies = [];
                if (!refBuddies.includes(Number(userId))) {
                  refBuddies.push(Number(userId));
                  await ncbUpdate(env, 'users', refId, { buddies: JSON.stringify(refBuddies) });
                }

                // 새 유저에게도 추천인을 친구로 추가
                await ncbUpdate(env, 'users', userId, { buddies: JSON.stringify([refId]) });

                // ── AT sync: 추천인 업데이트 ──
                // 추천인의 친구 닉네임 목록 직접 조회
                ctx.waitUntil((async () => {
                  try {
                    const names = await atResolveBuddyNames(env, JSON.stringify(refBuddies));
                    _refBuddyNames = names;
                    await atUpsert(env, refId, {
                      cm_point: oldCm + REFERRAL_BONUS,
                      buddy_count: refBuddies.length,
                      buddy_names: names,
                    });
                  } catch (e) { console.error('AT sync:', e); }
                })());
              }
            }
          } catch (e) {
            console.error('Referral processing error:', e);
          }
        }

        // ── AT sync: 새 유저 생성 ──
        // referred_by, buddy_names를 직접 전달 (NCB 재조회 의존 X)
        syncToAirtable(ctx, env, userId, {
          email,
          nickname,
          point: 0,
          cm_point: 0,
          referred_by: _refNickname,
          buddy_count: _refNickname ? 1 : 0,
          buddy_names: _refNickname ? [_refNickname] : [],
          last_roulette: '',
          created_at,
        });

        const token = await createJwt({ sub: String(userId), email, nickname }, env.JWT_SECRET);
        return json({ token, user: { id: String(userId), email, nickname } }, 201, request);
      }

      // ── POST /auth/login ────────────────────────────────
      if (path === '/auth/login' && request.method === 'POST') {
        if (!rateLimit(ip, 10, 300)) return json({ error: '요청이 너무 많습니다. 잠시 후 다시 시도해주세요.' }, 429, request);

        const { email, password } = await request.json();
        if (!email || !password) {
          return json({ error: '이메일과 비밀번호를 입력해주세요.' }, 400, request);
        }

        const users = await ncbSearch(env, 'users', { email });
        const userList = users?.data || [];
        if (userList.length === 0) {
          return json({ error: '이메일 또는 비밀번호가 올바르지 않습니다.' }, 401, request);
        }

        const user = userList[0];
        const valid = await verifyPassword(password, user.password_hash);
        if (!valid) {
          return json({ error: '이메일 또는 비밀번호가 올바르지 않습니다.' }, 401, request);
        }

        const token = await createJwt(
          { sub: String(user.id), email: user.email, nickname: user.nickname },
          env.JWT_SECRET
        );
        return json({ token, user: { id: String(user.id), email: user.email, nickname: user.nickname } }, 200, request);
      }

      // ── GET /auth/verify ────────────────────────────────
      if (path === '/auth/verify' && request.method === 'GET') {
        const auth = request.headers.get('Authorization');
        if (!auth || !auth.startsWith('Bearer ')) {
          return json({ valid: false }, 200, request);
        }
        const payload = await verifyJwt(auth.slice(7), env.JWT_SECRET);
        if (!payload) return json({ valid: false }, 200, request);
        return json({ valid: true, user: { id: payload.sub, email: payload.email, nickname: payload.nickname } }, 200, request);
      }

      // ── POST /study-log ─────────────────────────────────
      if (path === '/study-log' && request.method === 'POST') {
        const body = await request.json();
        let userId = null;

        // JWT가 있으면 user_id 추출, 없거나 만료여도 에러 없이 anonymous
        const auth = request.headers.get('Authorization');
        if (auth && auth.startsWith('Bearer ')) {
          const payload = await verifyJwt(auth.slice(7), env.JWT_SECRET);
          if (payload) userId = payload.sub;
        }

        const log = {
          user_id: userId || '',
          device_id: body.device_id || '',
          content_name: body.content_name || '',
          quiz_mode: body.quiz_mode || '',
          words_studied: Number(body.words_studied) || 0,
          words_correct: Number(body.words_correct) || 0,
          words_wrong: Number(body.words_wrong) || 0,
          study_date: body.study_date || new Date().toLocaleDateString('ko-KR', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).replace(/\. /g, '-').replace('.', ''),
          created_at: new Date(Date.now() + 9 * 3600000).toISOString().replace('Z', '+09:00'),
        };

        // KST 날짜 포맷 보정 (YYYY-MM-DD)
        if (!/^\d{4}-\d{2}-\d{2}$/.test(log.study_date)) {
          const kst = new Date(Date.now() + 9 * 3600000);
          log.study_date = kst.toISOString().slice(0, 10);
        }

        await ncbCreate(env, 'study_logs', log);

        // ── 포인트 적립 (인증 사용자만) ──
        if (userId && log.words_studied > 0) {
          try {
            const userRes = await ncbReadById(env, 'users', userId);
            const user = userRes.data;
            if (user) {
              const oldPoint = Number(user.point) || 0;
              const newPoint = oldPoint + log.words_studied;
              await ncbUpdate(env, 'users', userId, { point: newPoint });

              // ── AT sync: 포인트 업데이트 ──
              syncToAirtable(ctx, env, userId, { point: newPoint });

              // 100 단위 경계 넘을 때마다 내 공부친구들에게 cm_point 적립
              // (내가 공부 → 나를 친구로 등록한 친구들이 혜택 = 서로 추가해야 상호 혜택)
              const crossings = Math.floor(newPoint / 100) - Math.floor(oldPoint / 100);
              if (crossings > 0) {
                let buddies = [];
                try { buddies = Array.isArray(user.buddies) ? user.buddies : JSON.parse(user.buddies || '[]'); } catch {}
                if (Array.isArray(buddies) && buddies.length > 0) {
                  const reward = crossings * 100;
                  for (const buddyId of buddies) {
                    try {
                      const bRes = await ncbReadById(env, 'users', buddyId);
                      if (bRes.data) {
                        const oldCm = Number(bRes.data.cm_point) || 0;
                        await ncbUpdate(env, 'users', buddyId, { cm_point: oldCm + reward });
                        // ── AT sync: 버디 cm_point 업데이트 ──
                        syncToAirtable(ctx, env, buddyId, { cm_point: oldCm + reward });
                      }
                    } catch {}
                  }
                }
              }
            }
          } catch (e) {
            console.error('포인트 적립 오류:', e);
          }
        }

        return json({ ok: true }, 201, request);
      }

      // ── GET /stats/today ────────────────────────────────
      if (path === '/stats/today' && request.method === 'GET') {
        const kst = new Date(Date.now() + 9 * 3600000);
        const today = kst.toISOString().slice(0, 10);

        const logs = await ncbRead(env, 'study_logs', `study_date=${today}&limit=1000`);
        const list = logs?.data || [];

        const uniqueUsers = new Set();
        const userWords = new Map();
        let totalStudied = 0;
        let totalCorrect = 0;
        let totalSessions = list.length;

        for (const log of list) {
          const uid = log.user_id || log.device_id || 'anon';
          uniqueUsers.add(uid);
          const w = Number(log.words_studied) || 0;
          totalStudied += w;
          totalCorrect += Number(log.words_correct) || 0;
          userWords.set(uid, (userWords.get(uid) || 0) + w);
        }

        let maxWords = 0;
        for (const w of userWords.values()) {
          if (w > maxWords) maxWords = w;
        }

        return json({
          date: today,
          active_users: uniqueUsers.size,
          total_sessions: totalSessions,
          total_words_studied: totalStudied,
          total_words_correct: totalCorrect,
          max_words: maxWords,
        }, 200, request);
      }

      // ── GET /stats/me (JWT 필수) ─────────────────────────────
      if (path === '/stats/me' && request.method === 'GET') {
        const auth = request.headers.get('Authorization');
        if (!auth || !auth.startsWith('Bearer ')) {
          return json({ error: '로그인이 필요합니다.' }, 401, request);
        }
        const payload = await verifyJwt(auth.slice(7), env.JWT_SECRET);
        if (!payload) return json({ error: '인증이 만료되었습니다.' }, 401, request);

        const userId = payload.sub;
        const kst = new Date(Date.now() + 9 * 3600000);
        const today = kst.toISOString().slice(0, 10);

        // 오늘 학습 로그
        const todayLogs = await ncbRead(env, 'study_logs', `user_id=${userId}&study_date=${today}&limit=1000`);
        const todayList = todayLogs?.data || [];

        let todayWords = 0, todayCorrect = 0, todaySessions = todayList.length;
        for (const log of todayList) {
          todayWords += Number(log.words_studied) || 0;
          todayCorrect += Number(log.words_correct) || 0;
        }

        // 전체 학습 단어 & streak 계산
        const allLogs = await ncbRead(env, 'study_logs', `user_id=${userId}&limit=10000`);
        const allList = allLogs?.data || [];

        let totalWords = 0;
        const dateSet = new Set();
        const dateWordsMap = new Map();
        for (const log of allList) {
          const w = Number(log.words_studied) || 0;
          totalWords += w;
          if (log.study_date) {
            dateSet.add(log.study_date);
            dateWordsMap.set(log.study_date, (dateWordsMap.get(log.study_date) || 0) + w);
          }
        }

        // Streak: 오늘부터 역순 연속일 + 연속일 동안 학습 단어수
        let streak = 0;
        let streakWords = 0;
        const d = new Date(Date.now() + 9 * 3600000);
        while (true) {
          const ds = d.toISOString().slice(0, 10);
          if (dateSet.has(ds)) {
            streak++;
            streakWords += dateWordsMap.get(ds) || 0;
            d.setDate(d.getDate() - 1);
          } else {
            break;
          }
        }

        // 어제 학습 단어
        const yesterdayDate = new Date(Date.now() + 9 * 3600000);
        yesterdayDate.setDate(yesterdayDate.getDate() - 1);
        const yesterdayStr = yesterdayDate.toISOString().slice(0, 10);
        const yesterdayWords = dateWordsMap.get(yesterdayStr) || 0;

        // 최근 7일 학습 단어 & 학습 일수 & 일별 데이터
        let weekWords = 0;
        let weekDays = 0;
        const weekDaily = [];
        for (let i = 6; i >= 0; i--) {
          const wd = new Date(Date.now() + 9 * 3600000);
          wd.setDate(wd.getDate() - i);
          const wds = wd.toISOString().slice(0, 10);
          const dayWords = dateWordsMap.get(wds) || 0;
          weekDaily.push({ date: wds, words: dayWords });
          weekWords += dayWords;
          if (dayWords > 0) weekDays++;
        }

        // 주간 전체 유저 평균 계산 (7일 병렬 조회)
        let weekAvg = 0;
        try {
          const weekDateStrs = weekDaily.map(d => d.date);
          const weekAllResults = await Promise.all(
            weekDateStrs.map(ds => ncbRead(env, 'study_logs', `study_date=${ds}&limit=1000`))
          );
          const weekUserTotals = new Map();
          for (const res of weekAllResults) {
            for (const log of (res?.data || [])) {
              if (!log.user_id) continue;
              weekUserTotals.set(log.user_id, (weekUserTotals.get(log.user_id) || 0) + (Number(log.words_studied) || 0));
            }
          }
          if (weekUserTotals.size > 0) {
            let sum = 0;
            for (const v of weekUserTotals.values()) sum += v;
            weekAvg = Math.round(sum / weekUserTotals.size);
          }
        } catch {}

        // point / cm_point 읽기
        let point = 0, cm_point = 0;
        try {
          const userRes = await ncbReadById(env, 'users', userId);
          if (userRes.data) {
            point = Number(userRes.data.point) || 0;
            cm_point = Number(userRes.data.cm_point) || 0;
          }
        } catch {}

        return json({
          today_words: todayWords,
          today_correct: todayCorrect,
          today_sessions: todaySessions,
          total_words: totalWords,
          streak,
          streak_words: streakWords,
          yesterday_words: yesterdayWords,
          week_words: weekWords,
          week_days: weekDays,
          week_daily: weekDaily,
          week_avg: weekAvg,
          point,
          cm_point,
        }, 200, request);
      }

      // ── GET /stats/ranking ────────────────────────────────────
      if (path === '/stats/ranking' && request.method === 'GET') {
        const kst = new Date(Date.now() + 9 * 3600000);
        const today = kst.toISOString().slice(0, 10);

        const logs = await ncbRead(env, 'study_logs', `study_date=${today}&limit=1000`);
        const list = logs?.data || [];

        // user_id별 단어수 집계
        const userMap = new Map();
        for (const log of list) {
          if (!log.user_id) continue;
          const uid = log.user_id;
          userMap.set(uid, (userMap.get(uid) || 0) + (Number(log.words_studied) || 0));
        }

        // 전체 정렬 (내 순위 찾기용)
        const allSorted = [...userMap.entries()].sort((a, b) => b[1] - a[1]);
        const sorted = allSorted.slice(0, 10);
        const totalUsers = userMap.size;

        // 내 순위 (JWT 있을 때)
        let myRank = null, myWords = null;
        const auth = request.headers.get('Authorization');
        if (auth && auth.startsWith('Bearer ')) {
          try {
            const payload = await verifyJwt(auth.slice(7), env.JWT_SECRET);
            if (payload) {
              const uid = String(payload.sub);
              const idx = allSorted.findIndex(([id]) => String(id) === uid);
              if (idx >= 0) {
                myRank = idx + 1;
                myWords = allSorted[idx][1];
              }
            }
          } catch {}
        }

        if (sorted.length === 0) {
          return json({ date: today, ranking: [], total_users: totalUsers, my_rank: myRank, my_words: myWords }, 200, request);
        }

        // 닉네임 배치 조회
        const userIds = sorted.map(([uid]) => uid).join(',');
        const users = await ncbRead(env, 'users', `id[in]=${userIds}`);
        const userList = users?.data || [];
        const nickMap = new Map();
        for (const u of userList) {
          nickMap.set(String(u.id), u.nickname || '학습자');
        }

        const ranking = sorted.map(([uid, words]) => ({
          nickname: nickMap.get(String(uid)) || '학습자',
          words,
        }));

        return json({ date: today, ranking, total_users: totalUsers, my_rank: myRank, my_words: myWords }, 200, request);
      }

      // ── PUT /buddies/update ──────────────────────────────
      if (path === '/buddies/update' && request.method === 'PUT') {
        const auth = request.headers.get('Authorization');
        if (!auth || !auth.startsWith('Bearer ')) return json({ error: '로그인이 필요합니다.' }, 401, request);
        const payload = await verifyJwt(auth.slice(7), env.JWT_SECRET);
        if (!payload) return json({ error: '인증이 만료되었습니다.' }, 401, request);

        const { action, buddy_id } = await request.json();
        if (!action || !buddy_id) return json({ error: 'action과 buddy_id를 입력해주세요.' }, 400, request);
        if (String(buddy_id) === payload.sub) return json({ error: '본인을 친구로 추가할 수 없습니다.' }, 400, request);

        const userRes = await ncbReadById(env, 'users', payload.sub);
        if (!userRes.data) return json({ error: '사용자를 찾을 수 없습니다.' }, 404, request);

        let buddies = [];
        try { buddies = Array.isArray(userRes.data.buddies) ? userRes.data.buddies : JSON.parse(userRes.data.buddies || '[]'); } catch {}
        if (!Array.isArray(buddies)) buddies = [];

        if (action === 'add') {
          if (buddies.includes(Number(buddy_id))) return json({ error: '이미 추가된 친구입니다.' }, 400, request);
          // 존재하는 사용자인지 확인
          const buddyRes = await ncbReadById(env, 'users', buddy_id);
          if (!buddyRes.data) return json({ error: '해당 사용자를 찾을 수 없습니다.' }, 404, request);
          buddies.push(Number(buddy_id));
        } else if (action === 'remove') {
          buddies = buddies.filter(id => id !== Number(buddy_id));
        } else {
          return json({ error: 'action은 add 또는 remove만 가능합니다.' }, 400, request);
        }

        await ncbUpdate(env, 'users', payload.sub, { buddies: JSON.stringify(buddies) });

        // ── AT sync: buddy_count + buddy_names 업데이트 ──
        // buddy_names는 비동기로 조회 (atUpsert 내부에서 신규 레코드면 자동 채움, 기존이면 여기서 직접)
        ctx.waitUntil((async () => {
          try {
            const names = await atResolveBuddyNames(env, JSON.stringify(buddies));
            await atUpsert(env, payload.sub, { buddy_count: buddies.length, buddy_names: names });
          } catch (e) { console.error('AT sync:', e); }
        })());

        return json({ ok: true, buddies }, 200, request);
      }

      // ── GET /buddies/list ──────────────────────────────
      if (path === '/buddies/list' && request.method === 'GET') {
        const auth = request.headers.get('Authorization');
        if (!auth || !auth.startsWith('Bearer ')) return json({ error: '로그인이 필요합니다.' }, 401, request);
        const payload = await verifyJwt(auth.slice(7), env.JWT_SECRET);
        if (!payload) return json({ error: '인증이 만료되었습니다.' }, 401, request);

        const userRes = await ncbReadById(env, 'users', payload.sub);
        if (!userRes.data) return json({ error: '사용자를 찾을 수 없습니다.' }, 404, request);

        const point = Number(userRes.data.point) || 0;
        const cm_point = Number(userRes.data.cm_point) || 0;

        let buddies = [];
        try { buddies = Array.isArray(userRes.data.buddies) ? userRes.data.buddies : JSON.parse(userRes.data.buddies || '[]'); } catch {}
        if (!Array.isArray(buddies)) buddies = [];

        const buddyList = [];
        for (const bid of buddies) {
          try {
            const bRes = await ncbReadById(env, 'users', bid);
            if (bRes.data) {
              buddyList.push({ id: bRes.data.id, nickname: bRes.data.nickname || '학습자' });
            }
          } catch {}
        }

        return json({ point, cm_point, buddies: buddyList, referral_count: buddyList.length }, 200, request);
      }

      // ── POST /daily/roulette ─────────────────────────────
      if (path === '/daily/roulette' && request.method === 'POST') {
        const auth = request.headers.get('Authorization');
        if (!auth || !auth.startsWith('Bearer ')) return json({ error: '로그인이 필요합니다.' }, 401, request);
        const payload = await verifyJwt(auth.slice(7), env.JWT_SECRET);
        if (!payload) return json({ error: '인증이 만료되었습니다.' }, 401, request);

        const userRes = await ncbReadById(env, 'users', payload.sub);
        if (!userRes.data) return json({ error: '사용자를 찾을 수 없습니다.' }, 404, request);

        const now = new Date(Date.now() + 9 * 60 * 60 * 1000);
        const today = now.toISOString().slice(0, 10);

        if (userRes.data.last_roulette === today) {
          return json({ ok: false, already: true }, 200, request);
        }

        const rand = Math.random();
        let prize = 100;
        if (rand < 0.60) prize = 10;
        else if (rand < 0.85) prize = 20;
        else if (rand < 0.95) prize = 50;

        const oldPoint = Number(userRes.data.cm_point) || 0;
        const newPoint = oldPoint + prize;
        await ncbUpdate(env, 'users', payload.sub, { cm_point: newPoint, last_roulette: today });

        // ── AT sync: 룰렛 결과 ──
        syncToAirtable(ctx, env, payload.sub, { cm_point: newPoint, last_roulette: today });

        return json({ ok: true, prize, cm_point: newPoint }, 200, request);
      }

      // ── GET /referral/info?code=ID ─────────────────────────
      if (path === '/referral/info' && request.method === 'GET') {
        const code = url.searchParams.get('code');
        if (!code) return json({ valid: false, error: '추천 코드를 입력해주세요.' }, 400, request);
        const refId = fromReferralCode(code);
        if (!refId) return json({ valid: false }, 200, request);
        try {
          const refRes = await ncbReadById(env, 'users', refId);
          if (refRes.data && refRes.data.nickname) {
            return json({ valid: true, nickname: refRes.data.nickname }, 200, request);
          }
        } catch {}
        return json({ valid: false }, 200, request);
      }

      return json({ error: 'Not found' }, 404, request);

    } catch (err) {
      console.error('Worker error:', err);
      return json({ error: '서버 오류가 발생했습니다.' }, 500, request);
    }
  },
};
