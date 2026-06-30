#!/usr/bin/env node
/**
 * 단어 이미지 일괄 업로드 → sharemyimage.com → word-images.json 생성
 * ------------------------------------------------------------------
 * 폴더 안의 dog.png, cat.png ... 를 모두 sharemyimage에 올리고,
 * { "dog": "https://img.share.../...png", ... } 매핑표를 만들어 저장합니다.
 * 학생 앱(onepage-user)이 이 JSON을 읽어 단어 카드에 이미지를 자동 표시합니다.
 *
 * 사용법 (PowerShell / cmd / bash 모두 동일):
 *   node scripts/upload-word-images.js --dir "C:\\내폴더\\단어이미지" --key chv_여기에API키
 *
 * 옵션:
 *   --dir   <경로>   업로드할 이미지가 들어있는 폴더 (필수)
 *   --key   <키>     sharemyimage API 키 (필수). 환경변수 SMI_KEY 로도 가능
 *   --out   <경로>   결과 JSON 저장 위치 (기본: onepage-user/word-images.json)
 *   --ext   <목록>   업로드할 확장자 (기본: png,jpg,jpeg,webp,gif,svg)
 *   --delay <ms>     업로드 간 간격, 속도제한 회피용 (기본: 700)
 *   --force          모든 파일을 강제로 다시 업로드 (변경 여부 무시)
 *
 * 특징:
 *   - 변경 감지: 파일 내용 해시를 기록해 두고, **새 파일·내용이 바뀐 파일만** 다시 업로드.
 *     (같은 이미지면 건너뜀 → 재실행해도 빠름. 이미지를 교체하면 자동으로 새 주소로 갱신)
 *   - 이어하기: 중단돼도 다시 실행하면 남은 것만 이어서.
 *   - 실패 자동 재시도 3회. 끝에 실패 목록 요약.
 *   - 파일명 dog.png → 단어 키 "dog" (소문자, 앞뒤 공백 제거).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ---- 인자 파싱 -------------------------------------------------------------
function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const DIR = arg('dir');
const KEY = arg('key', process.env.SMI_KEY);
const OUT = arg('out', path.join(__dirname, '..', 'onepage-user', 'word-images.json'));
const EXTS = arg('ext', 'png,jpg,jpeg,webp,gif,svg').split(',').map(s => s.trim().toLowerCase());
const DELAY = parseInt(arg('delay', '700'), 10);
const FORCE = process.argv.includes('--force');
// 변경 감지용 상태 파일 (단어→파일해시). 배포 폴더를 더럽히지 않도록 스크립트 옆에 보관.
const STATE = path.join(__dirname, '.word-images.state.json');
// ⚠️ apex 도메인 + 끝 슬래시 없음. (www·끝슬래시는 301 리다이렉트로 POST 본문이 사라져 "Empty upload source" 발생)
const ENDPOINT = 'https://sharemyimage.com/api/1/upload';
const MIME = { png:'image/png', jpg:'image/jpeg', jpeg:'image/jpeg', webp:'image/webp', gif:'image/gif', svg:'image/svg+xml' };

if (!DIR || !KEY) {
  console.error('❌ 사용법: node scripts/upload-word-images.js --dir "<폴더>" --key <API키>');
  console.error('   (API 키는 sharemyimage 로그인 후 /settings/api 에서 확인)');
  process.exit(1);
}
if (!fs.existsSync(DIR)) { console.error('❌ 폴더가 없습니다: ' + DIR); process.exit(1); }

// 파일명 → 단어 키 (앱의 normWord 와 반드시 동일 규칙)
function wordKey(filename) {
  return path.basename(filename, path.extname(filename))
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const md5 = buf => crypto.createHash('md5').update(buf).digest('hex');

async function uploadOne(filePath) {
  const buf = fs.readFileSync(filePath);
  const name = path.basename(filePath);
  const ext = path.extname(name).slice(1).toLowerCase();
  const form = new FormData();
  form.append('source', new File([buf], name, { type: MIME[ext] || 'application/octet-stream' }));
  form.append('format', 'json');
  form.append('title', wordKey(name));
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'X-API-Key': KEY },   // Content-Type은 fetch가 multipart boundary와 함께 자동 설정
    body: form,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { throw new Error('비JSON 응답: ' + text.slice(0, 200)); }
  if (res.status !== 200 || !json.image || !json.image.url) {
    throw new Error('업로드 실패: ' + (json.status_txt || res.status) + ' ' + JSON.stringify(json.error || ''));
  }
  return json.image.url;   // 직접 이미지 주소
}

(async () => {
  // 기존 매핑표(단어→주소) + 상태(단어→파일해시) 로드
  let map = {}, state = {};
  if (fs.existsSync(OUT))   { try { map   = JSON.parse(fs.readFileSync(OUT, 'utf8'));   } catch {} }
  if (fs.existsSync(STATE)) { try { state = JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch {} }

  const files = fs.readdirSync(DIR)
    .filter(f => EXTS.includes(path.extname(f).slice(1).toLowerCase()));
  console.log(`📁 ${DIR}\n   대상 파일 ${files.length}개, 이미 완료 ${Object.keys(map).length}개${FORCE ? '  (--force: 전체 재업로드)' : ''}\n`);

  let added = 0, updated = 0, skipped = 0;
  const failed = [];
  const save = () => {
    fs.writeFileSync(OUT, JSON.stringify(map, null, 0));
    fs.writeFileSync(STATE, JSON.stringify(state, null, 0));
  };

  for (const f of files) {
    const key = wordKey(f);
    const hash = md5(fs.readFileSync(path.join(DIR, f)));
    const known = !!map[key];

    if (!FORCE) {
      // 변경 없음 → 건너뜀
      if (known && state[key] === hash) { skipped++; continue; }
      // 매핑표엔 있는데 해시 기록이 없으면(스크립트 업그레이드 직후) = 기존 업로드로 간주, 해시만 시드
      if (known && state[key] === undefined) { state[key] = hash; skipped++; save(); continue; }
    }
    const isUpdate = known;   // 내용이 바뀐 기존 단어 → 갱신

    let ok = false;
    for (let attempt = 1; attempt <= 3 && !ok; attempt++) {
      try {
        const url = await uploadOne(path.join(DIR, f));
        map[key] = url;
        state[key] = hash;
        ok = true;
        if (isUpdate) { updated++; console.log(`🔄 ${key} (교체)  →  ${url}`); }
        else          { added++;   console.log(`✅ ${key}  →  ${url}`); }
        save();   // 매번 저장 (중단돼도 이어서 가능)
      } catch (e) {
        if (attempt === 3) { failed.push({ file: f, error: e.message }); console.error(`❌ ${key}: ${e.message}`); }
        else await sleep(DELAY * attempt * 2);   // 재시도 전 더 길게 대기
      }
    }
    await sleep(DELAY);
  }

  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`신규 ${added} · 교체 ${updated} · 건너뜀 ${skipped} · 실패 ${failed.length}`);
  console.log(`매핑표 저장: ${OUT}  (총 ${Object.keys(map).length} 단어)`);
  if (failed.length) {
    console.log(`\n실패 목록 (다시 실행하면 이 항목만 재시도):`);
    failed.forEach(x => console.log(`  - ${x.file}: ${x.error}`));
  }
})();
