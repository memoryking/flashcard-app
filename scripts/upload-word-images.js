#!/usr/bin/env node
/**
 * 단어 이미지 업로드 → sharemyimage.com → word-images.json (+ 자동 배포)
 * ------------------------------------------------------------------
 * 폴더 안의 dog.png, cat.png ... 를 sharemyimage에 올리고,
 * { "dog": "https://…/dog.png", ... } 매핑표를 만들어 저장합니다.
 * 학생 앱(onepage-user)이 이 JSON을 읽어 단어 카드에 이미지를 자동 표시합니다.
 *
 * 사용법:
 *   node scripts/upload-word-images.js --dir "C:\\내폴더" --key chv_… [옵션]
 *   또는 scripts/.word-images.config.json 에 dir/key 를 넣어두고 인자 없이 실행.
 *
 * 옵션:
 *   --dir   <경로>   이미지 폴더 (필수)
 *   --key   <키>     sharemyimage API 키 (필수). 환경변수 SMI_KEY / 설정파일도 가능
 *   --out   <경로>   결과 JSON (기본: onepage-user/word-images.json)
 *   --ext   <목록>   확장자 (기본: png,jpg,jpeg,webp,gif,svg)
 *   --delay <ms>     업로드 간 간격 (기본: 700)
 *   --force          변경 여부 무시하고 전부 다시 업로드
 *   --watch          폴더 감시 — 이미지를 넣을 때마다 자동 업로드 (Ctrl+C로 종료)
 *   --push           업로드 후 word-images.json 을 git commit + push (자동 배포)
 *
 * 완전 자동화: `--watch --push` → 폴더에 이미지를 드롭하면 업로드·매핑표 갱신·배포까지 자동.
 *
 * 특징:
 *   - 변경 감지: 파일 해시를 기록해 새/바뀐 파일만 업로드. 같은 이미지면 건너뜀.
 *   - 이어하기 / 실패 3회 재시도 / 파일명 dog.png → 단어 키 "dog".
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');

// ---- 설정 (CLI 인자 > 환경변수 > 설정파일) --------------------------------
function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const REPO = path.join(__dirname, '..');
const CFG_PATH = path.join(__dirname, '.word-images.config.json');
let cfg = {};
if (fs.existsSync(CFG_PATH)) { try { cfg = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8')); } catch {} }

const DIR = arg('dir', cfg.dir);
const KEY = arg('key', process.env.SMI_KEY || cfg.key);
const OUT = arg('out', cfg.out || path.join(REPO, 'onepage-user', 'word-images.json'));
const EXTS = arg('ext', cfg.ext || 'png,jpg,jpeg,webp,gif,svg').split(',').map(s => s.trim().toLowerCase());
const DELAY = parseInt(arg('delay', String(cfg.delay || 700)), 10);
const FORCE = process.argv.includes('--force');
const WATCH = process.argv.includes('--watch') || !!cfg.watch;
const PUSH = process.argv.includes('--push') || !!cfg.push;
const WATCH_INTERVAL = 4000;   // 폴더 재검사 주기(ms)
const SETTLE_MS = 2500;        // 방금 복사된(쓰는 중) 파일은 이만큼 안정된 뒤 처리
const STATE = path.join(__dirname, '.word-images.state.json');
// ⚠️ apex 도메인 + 끝 슬래시 없음 (www·끝슬래시는 301 리다이렉트로 POST 본문이 사라짐)
const ENDPOINT = 'https://sharemyimage.com/api/1/upload';
const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', svg: 'image/svg+xml' };

if (!DIR || !KEY) {
  console.error('❌ dir/key 가 필요합니다. --dir "<폴더>" --key <API키>');
  console.error('   또는 scripts/.word-images.config.json 에 { "dir": "...", "key": "..." } 저장.');
  process.exit(1);
}
if (!fs.existsSync(DIR)) { console.error('❌ 폴더가 없습니다: ' + DIR); process.exit(1); }

// 파일명 → 단어 키 (앱의 normWord 와 반드시 동일 규칙)
function wordKey(filename) {
  return path.basename(filename, path.extname(filename)).toLowerCase().replace(/\s+/g, ' ').trim();
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const md5 = buf => crypto.createHash('md5').update(buf).digest('hex');
const now = () => new Date().toTimeString().slice(0, 8);
const log = m => console.log('[' + now() + '] ' + m);

async function uploadOne(filePath) {
  const buf = fs.readFileSync(filePath);
  const name = path.basename(filePath);
  const ext = path.extname(name).slice(1).toLowerCase();
  const form = new FormData();
  form.append('source', new File([buf], name, { type: MIME[ext] || 'application/octet-stream' }));
  form.append('format', 'json');
  form.append('title', wordKey(name));
  const res = await fetch(ENDPOINT, { method: 'POST', headers: { 'X-API-Key': KEY }, body: form });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { throw new Error('비JSON 응답: ' + text.slice(0, 200)); }
  if (res.status !== 200 || !json.image || !json.image.url) {
    throw new Error('업로드 실패: ' + (json.status_txt || res.status) + ' ' + JSON.stringify(json.error || ''));
  }
  return json.image.url;
}

// 한 번 스캔 → 새/바뀐 파일 업로드. { added, updated, skipped, failed } 반환.
async function runOnce(opts) {
  opts = opts || {};
  let map = {}, state = {};
  if (fs.existsSync(OUT))   { try { map   = JSON.parse(fs.readFileSync(OUT, 'utf8'));   } catch {} }
  if (fs.existsSync(STATE)) { try { state = JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch {} }

  const files = fs.readdirSync(DIR).filter(f => EXTS.includes(path.extname(f).slice(1).toLowerCase()));
  if (!opts.quiet) log(`📁 ${DIR} — 대상 ${files.length}개, 이미 완료 ${Object.keys(map).length}개${FORCE ? ' (--force)' : ''}`);

  let added = 0, updated = 0, skipped = 0;
  const failed = [];
  const save = () => { fs.writeFileSync(OUT, JSON.stringify(map, null, 0)); fs.writeFileSync(STATE, JSON.stringify(state, null, 0)); };

  for (const f of files) {
    const fp = path.join(DIR, f);
    // 감시 모드: 방금 쓰인(복사 중) 파일은 안정될 때까지 다음 회차로 미룸
    if (opts.settle) { try { if (Date.now() - fs.statSync(fp).mtimeMs < SETTLE_MS) { continue; } } catch { continue; } }
    const key = wordKey(f);
    let hash; try { hash = md5(fs.readFileSync(fp)); } catch { continue; }
    const known = !!map[key];

    if (!FORCE) {
      if (known && state[key] === hash) { skipped++; continue; }                 // 변경 없음
      if (known && state[key] === undefined) { state[key] = hash; skipped++; save(); continue; }  // 시드
    }
    const isUpdate = known;
    let ok = false;
    for (let attempt = 1; attempt <= 3 && !ok; attempt++) {
      try {
        const url = await uploadOne(fp);
        map[key] = url; state[key] = hash; ok = true;
        if (isUpdate) { updated++; log(`🔄 ${key} (교체) → ${url}`); } else { added++; log(`✅ ${key} → ${url}`); }
        save();
      } catch (e) {
        if (attempt === 3) { failed.push({ file: f, error: e.message }); log(`❌ ${key}: ${e.message}`); }
        else await sleep(DELAY * attempt * 2);
      }
    }
    await sleep(DELAY);
  }
  return { added, updated, skipped, failed, total: Object.keys(map).length };
}

// word-images.json 자동 커밋 + push
function gitPush() {
  try {
    execSync('git add "' + OUT + '"', { cwd: REPO, stdio: 'pipe' });
    try { execSync('git diff --cached --quiet -- "' + OUT + '"', { cwd: REPO, stdio: 'pipe' }); return; }  // 변경 없음 → 종료
    catch { /* exit 1 = 스테이징된 변경 있음 → 커밋 진행 */ }
    execSync('git commit -m "단어 이미지 매핑 자동 업데이트" -- "' + OUT + '"', { cwd: REPO, stdio: 'pipe' });
    execSync('git push origin HEAD', { cwd: REPO, stdio: 'pipe' });
    log('☁️  배포 완료 (git push)');
  } catch (e) {
    const msg = e.stderr ? e.stderr.toString() : e.message;
    log('⚠️ git 배포 실패: ' + msg.split('\n')[0]);
  }
}

(async () => {
  if (WATCH) {
    log('👀 감시 시작 — 폴더에 이미지를 넣으면 자동 업로드' + (PUSH ? '·배포' : '') + '됩니다. (Ctrl+C 종료)');
    // 시작 시 1회 전체 처리
    let r = await runOnce({ settle: false });
    if ((r.added + r.updated > 0) && PUSH) gitPush();
    // 이후 주기적으로 감시
    for (;;) {
      await sleep(WATCH_INTERVAL);
      r = await runOnce({ quiet: true, settle: true });
      if (r.added + r.updated > 0) {
        log(`변경 반영 — 신규 ${r.added} · 교체 ${r.updated} · 총 ${r.total}단어`);
        if (PUSH) gitPush();
      }
    }
  } else {
    const r = await runOnce({ settle: false });
    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`신규 ${r.added} · 교체 ${r.updated} · 건너뜀 ${r.skipped} · 실패 ${r.failed.length}`);
    console.log(`매핑표: ${OUT}  (총 ${r.total} 단어)`);
    if (r.failed.length) { console.log('\n실패(재실행 시 재시도):'); r.failed.forEach(x => console.log('  - ' + x.file + ': ' + x.error)); }
    if (PUSH && (r.added + r.updated > 0)) gitPush();
  }
})();
