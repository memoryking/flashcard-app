#!/usr/bin/env node
// ===========================================================================
// merge-math.js — HTML + SVG 합본 생성기 (수학 콘텐츠 업로드용)
// ===========================================================================
//
// 사용법:
//   node scripts/merge-math.js <폴더경로>                # 폴더 전체 일괄 처리
//   node scripts/merge-math.js <폴더경로>/<파일명>.html  # 단일 파일 처리
//
// 예:
//   node scripts/merge-math.js "C:/Users/memoryking/00_DEV/11_math/미분가능성"
//   node scripts/merge-math.js "C:/Users/memoryking/00_DEV/11_math/미분가능성/05_미분계수.html"
//
// 동작:
//   1) HTML 안의 <img src="...svg"> 참조를 탐지
//   2) 같은 폴더에서 해당 SVG 파일을 찾아 인라인 <svg> 로 치환
//      - <?xml ...?> / <!DOCTYPE> 제거
//      - 루트 <svg>에 width="100%" 추가 (없으면)
//   3) 결과를 <원본파일명>_합본.html 로 저장
//      (이미 "_합본.html"로 끝나면 건너뜀)
//   4) SVG가 0개여도 그대로 _합본.html 생성 (업로드 단위 통일)
//
// 주의:
//   - 원본 .html / .svg 는 손대지 않음
//   - 같은 SVG가 여러 번 참조되어도 매번 인라인 (중복 ID 가능 → 향후 보완 여지)

const fs = require('fs');
const path = require('path');

function escapeForRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function inlineOneSvg(svgRaw) {
  let s = String(svgRaw || '');
  s = s.replace(/<\?xml[\s\S]*?\?>/gi, '');
  s = s.replace(/<!DOCTYPE[\s\S]*?>/gi, '');
  s = s.trim();
  // 루트 <svg에 width 속성 없으면 width="100%" 삽입
  if (/^<svg\b/i.test(s) && !/<svg\b[^>]*\bwidth=/i.test(s)) {
    s = s.replace(/^<svg\b/i, '<svg width="100%"');
  }
  return s;
}

function mergeHtml(htmlPath) {
  const dir = path.dirname(htmlPath);
  const base = path.basename(htmlPath, '.html');
  if (base.endsWith('_합본')) return { skipped: true, reason: 'already merged' };

  const html = fs.readFileSync(htmlPath, 'utf8');
  const imgRe = /<img\s+[^>]*src=["']([^"']+\.svg)["'][^>]*>/gi;
  const matches = [...html.matchAll(imgRe)];

  let merged = html;
  let inlined = 0;
  const missing = [];

  for (const m of matches) {
    const svgRel = m[1];
    const svgPath = path.join(dir, svgRel);
    if (!fs.existsSync(svgPath)) {
      missing.push(svgRel);
      continue;
    }
    const svgRaw = fs.readFileSync(svgPath, 'utf8');
    const inline = inlineOneSvg(svgRaw);
    // <img ...>를 인라인 SVG로 치환 (정확히 그 한 매치만)
    merged = merged.replace(m[0], inline);
    inlined++;
  }

  const outPath = path.join(dir, base + '_합본.html');
  fs.writeFileSync(outPath, merged, 'utf8');

  return {
    skipped: false,
    out: outPath,
    inlined,
    missing,
    sizeKb: Math.round(Buffer.byteLength(merged, 'utf8') / 1024),
  };
}

function main() {
  const target = process.argv[2];
  if (!target) {
    console.error('Usage: node scripts/merge-math.js <folder|file>');
    process.exit(1);
  }
  const abs = path.resolve(target);
  if (!fs.existsSync(abs)) {
    console.error('Not found: ' + abs);
    process.exit(1);
  }

  const stat = fs.statSync(abs);
  let files = [];
  if (stat.isDirectory()) {
    files = fs.readdirSync(abs)
      .filter(f => f.toLowerCase().endsWith('.html') && !f.endsWith('_합본.html'))
      .map(f => path.join(abs, f));
  } else {
    files = [abs];
  }

  if (files.length === 0) {
    console.log('처리할 .html 파일이 없습니다.');
    return;
  }

  console.log('── 합본 생성 시작 ──');
  console.log('대상: ' + files.length + ' 파일\n');

  let ok = 0, warned = 0;
  for (const f of files) {
    const r = mergeHtml(f);
    if (r.skipped) {
      console.log('  ⊘ ' + path.basename(f) + ' — 건너뜀 (' + r.reason + ')');
      continue;
    }
    const tag = r.missing.length ? '⚠' : '✓';
    if (r.missing.length) warned++;
    else ok++;
    console.log('  ' + tag + ' ' + path.basename(r.out)
      + ' (SVG ' + r.inlined + '개 인라인, ' + r.sizeKb + 'KB)'
      + (r.missing.length ? ' — 누락: ' + r.missing.join(', ') : ''));
  }

  console.log('\n── 완료 ──');
  console.log('성공 ' + ok + ' / 경고 ' + warned + ' / 전체 ' + files.length);
}

main();
