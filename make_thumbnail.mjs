#!/usr/bin/env node
// 썸네일 제작기: Claude가 호출하는 도구.
// Codex CLI(ChatGPT 로그인)의 이미지 생성 기능으로 썸네일을 만든다. API 키 없이 ChatGPT 구독 사용량을 쓴다.
// 사용 예:
//   node make_thumbnail.mjs --brand 내채널 --prompt "문구: '썸네일 자동화' / 노트북 앞 사람" --n 2
//   node make_thumbnail.mjs --brand 내채널 --edit output/2026-11-18/a_1.png --prompt "글자를 더 크게"
// 결과: 마지막 줄에 JSON({"ok":true,"files":[...]}) 출력.

import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TOOL_DIR = path.dirname(fileURLToPath(import.meta.url));
const IMG_EXT = new Set([".png", ".jpg", ".jpeg", ".webp"]);
const MAX_REFS = 6;

function parseArgs(argv) {
  const a = { n: 1, ref: [], noRefs: false, name: "thumb", timeout: 600, aspect: "16:9" };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i], v = () => argv[++i];
    if (k === "--brand") a.brand = v();
    else if (k === "--prompt") a.prompt = v();
    else if (k === "--prompt-file") a.prompt = fs.readFileSync(v(), "utf8");
    else if (k === "--n") a.n = Math.max(1, Math.min(4, parseInt(v(), 10) || 1));
    else if (k === "--ref") a.ref.push(v());
    else if (k === "--edit") a.edit = v();
    else if (k === "--no-refs") a.noRefs = true;
    else if (k === "--out") a.out = v();
    else if (k === "--name") a.name = v();
    else if (k === "--timeout") a.timeout = parseInt(v(), 10);
    else if (k === "--aspect") { a.aspect = v(); if (!["16:9", "9:16"].includes(a.aspect)) throw new Error("--aspect는 16:9 또는 9:16"); }
    else if (k === "-h" || k === "--help") a.help = true;
    else if (k === "--list-brands") a.listBrands = true;
    else throw new Error(`알 수 없는 옵션: ${k}`);
  }
  return a;
}

function fail(msg) {
  console.error(msg);
  console.log(JSON.stringify({ ok: false, error: msg }));
  process.exit(1);
}

function listImages(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => IMG_EXT.has(path.extname(f).toLowerCase()))
    .sort()
    .map((f) => path.join(dir, f));
}

function walk(dir, acc = new Map()) {
  if (!fs.existsSync(dir)) return acc;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (IMG_EXT.has(path.extname(e.name).toLowerCase())) acc.set(p, fs.statSync(p).mtimeMs);
  }
  return acc;
}

// Windows에서는 codex.cmd를 셸로 부르면 한글·공백 인자가 깨질 수 있어, npm 패키지의 codex.js를 node로 직접 실행한다.
function resolveCodex() {
  if (process.platform !== "win32") return { cmd: "codex", pre: [], shell: false };
  try {
    const found = execFileSync("where", ["codex.cmd"], { encoding: "utf8" }).split(/\r?\n/).filter(Boolean);
    for (const f of found) {
      const js = path.join(path.dirname(f), "node_modules", "@openai", "codex", "bin", "codex.js");
      if (fs.existsSync(js)) return { cmd: process.execPath, pre: [js], shell: false };
    }
  } catch {}
  return { cmd: "codex", pre: [], shell: true };
}

function buildPrompt({ style, userPrompt, refCount, edit, aspect = "16:9" }) {
  const lines = [
    "$imagegen",
    "유튜브 썸네일 이미지 1장을 생성한다.",
    aspect === "9:16"
      ? "- 비율: 9:16 세로(쇼츠 썸네일). 가로나 정사각형으로 만들지 않는다. 레퍼런스가 가로여도 구성은 세로에 맞게 새로 잡는다."
      : "- 비율: 16:9 가로. 정사각형이나 세로로 만들지 않는다.",
    "- 화면 글자는 아래 요청에 적힌 한글 문구만 정확히 넣는다. 철자를 바꾸거나 다른 글자를 덧붙이지 않는다.",
  ];
  if (edit) {
    lines.push("- 첫 번째 첨부 이미지를 수정 대상으로 삼는다. 요청한 부분만 고치고 나머지 구성은 최대한 유지한다.");
    if (refCount > 1) lines.push("- 나머지 첨부 이미지는 스타일 참고용이다.");
  } else if (refCount > 0) {
    lines.push("- 첨부 이미지는 이 채널의 기존 썸네일(스타일 레퍼런스)이다. 색감·조명·글자 배치·질감을 따르되, 내용은 요청에 맞게 새로 만든다. 첨부 이미지를 그대로 복제하지 않는다.");
  }
  if (style) lines.push("", "[채널 썸네일 규칙]", style.trim());
  lines.push("", "[이번 썸네일 요청]", userPrompt.trim());
  lines.push("", "이미지를 생성한 뒤에는 파일을 옮기거나 다른 명령을 실행하지 말고, 한 줄로 '완료'라고만 답한다.");
  return lines.join("\n");
}

function runCodex(codex, prompt, images, cwd, timeoutSec) {
  return new Promise((resolve) => {
    const args = [...codex.pre, "exec", "--skip-git-repo-check", "-s", "read-only", "-C", cwd];
    for (const im of images) args.push("-i", im);
    args.push("--", "-"); // 프롬프트는 표준입력으로 넘긴다(한글·줄바꿈 보존).
    const q = (s) => (codex.shell ? `"${s}"` : s);
    const child = spawn(codex.shell ? q(codex.cmd) : codex.cmd, codex.shell ? args.map(q) : args,
      { cwd, shell: codex.shell, windowsHide: true });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    const timer = setTimeout(() => { child.kill(); out += "\n[시간 초과]"; }, timeoutSec * 1000);
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, out }); });
    child.stdin.end(prompt, "utf8");
  });
}

const HELP = `썸네일 제작기
  --prompt "<요청>"     이번 썸네일 요청(문구, 인물, 소품, 분위기). --prompt-file 로 파일 지정 가능
  --brand <이름>        brands/<이름>/ 의 style.md 와 refs/ 를 사용 (필수)
  --list-brands         만들어 둔 브랜드와 레퍼런스 장수를 JSON으로 출력
  --n <1~4>             같은 요청으로 시안 몇 장을 동시에 만들지 (기본 1)
  --ref <이미지>        이번에만 추가할 참고 이미지 (여러 번 가능)
  --edit <이미지>       이 이미지를 고쳐서 새로 만든다
  --no-refs             브랜드 레퍼런스 이미지를 붙이지 않는다
  --out <폴더>          저장 폴더 (기본: output/<날짜>)
  --name <이름>         파일 이름 앞부분 (기본 thumb)`;

async function main() {
  const a = parseArgs(process.argv.slice(2));
  if (a.help) { console.log(HELP); return; }

  // 브랜드 = brands/ 아래 '_'로 시작하지 않는 폴더. '_템플릿'은 새 브랜드를 만들 때 복사하는 틀이다.
  const brandsRoot = path.join(TOOL_DIR, "brands");
  const brands = fs.existsSync(brandsRoot)
    ? fs.readdirSync(brandsRoot, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !e.name.startsWith("_"))
        .map((e) => ({ name: e.name, refs: listImages(path.join(brandsRoot, e.name, "refs")).length }))
    : [];
  if (a.listBrands) { console.log(JSON.stringify({ ok: true, brands })); return; }

  if (!a.brand) {
    if (brands.length === 0) fail("NEEDS_SETUP: 아직 만든 브랜드가 없습니다. 처음 사용하는 경우 레퍼런스 썸네일로 브랜드부터 만드세요(SKILL.md '처음 사용할 때').");
    fail(`--brand 가 필요합니다. 만든 브랜드: ${brands.map((b) => b.name).join(", ")}`);
  }
  if (a.brand.startsWith("_")) fail("'_'로 시작하는 폴더는 틀입니다. 복사해서 새 브랜드를 만드세요.");
  if (!a.prompt) fail("--prompt 가 필요합니다.");

  const brandDir = path.join(brandsRoot, a.brand);
  if (!fs.existsSync(brandDir)) fail(`NEEDS_SETUP: 브랜드 '${a.brand}'가 없습니다. 만든 브랜드: ${brands.map((b) => b.name).join(", ") || "없음"}`);
  if (!a.noRefs && !a.edit && listImages(path.join(brandDir, "refs")).length === 0)
    fail(`NEEDS_REFS: 브랜드 '${a.brand}'의 refs/ 에 레퍼런스 썸네일이 없습니다. 레퍼런스를 넣거나, 레퍼런스 없이 시험할 때만 --no-refs 를 쓰세요.`);
  const styleFile = path.join(brandDir, "style.md");
  const style = fs.existsSync(styleFile) ? fs.readFileSync(styleFile, "utf8") : "";

  const images = [];
  if (a.edit) {
    if (!fs.existsSync(a.edit)) fail(`수정할 이미지가 없습니다: ${a.edit}`);
    images.push(path.resolve(a.edit));
  }
  for (const r of a.ref) {
    if (!fs.existsSync(r)) fail(`참고 이미지가 없습니다: ${r}`);
    images.push(path.resolve(r));
  }
  if (!a.noRefs) images.push(...listImages(path.join(brandDir, "refs")).slice(0, MAX_REFS));

  const prompt = buildPrompt({ style, userPrompt: a.prompt, refCount: images.length, edit: !!a.edit, aspect: a.aspect });

  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  const genDir = path.join(codexHome, "generated_images");
  const before = walk(genDir);

  const today = new Date().toISOString().slice(0, 10);
  const outDir = path.resolve(a.out || path.join(TOOL_DIR, "output", today));
  fs.mkdirSync(outDir, { recursive: true });
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "thumb-"));

  const codex = resolveCodex();
  console.error(`Codex로 ${a.n}장 생성 중 (참고 이미지 ${images.length}장)... 1장에 약 1분 걸립니다.`);
  const runs = await Promise.all(Array.from({ length: a.n }, () => runCodex(codex, prompt, images, work, a.timeout)));

  // 실행마다 Codex 세션 폴더(generated_images/<session id>/)의 이미지만 가져온다.
  // 이 도구를 여러 개 동시에 돌려도 서로의 결과를 가져가지 않게 하기 위함이다.
  const isNew = ([p, t]) => !before.has(p) || before.get(p) !== t;
  const fresh = [];
  for (const r of runs) {
    const m = r.out.match(/session id:\s*([0-9a-f-]{36})/i);
    if (m) {
      fresh.push(...[...walk(path.join(genDir, m[1])).entries()].filter(isNew)
        .sort((x, y) => x[1] - y[1]).map(([p]) => p));
    } else {
      console.error("세션 id를 찾지 못해 새 이미지 전체에서 찾습니다(동시 실행 시 섞일 수 있음).");
      fresh.push(...[...walk(genDir).entries()].filter(isNew).map(([p]) => p).filter((p) => !fresh.includes(p)));
    }
  }

  if (fresh.length === 0) {
    const log = runs.map((r) => r.out).join("\n----\n");
    const hint = /login|not logged|unauthor/i.test(log) ? " Codex 로그인이 필요합니다: codex login" :
      /usage limit|rate limit/i.test(log) ? " ChatGPT 사용량 한도에 걸렸습니다. 잠시 후 다시 시도하세요." : "";
    console.error(log.slice(-3000));
    fail("이미지가 만들어지지 않았습니다." + hint);
  }

  const stamp = new Date().toTimeString().slice(0, 8).replace(/:/g, "");
  const files = fresh.map((src, i) => {
    const dst = path.join(outDir, `${a.name}_${stamp}_${i + 1}${path.extname(src)}`);
    fs.copyFileSync(src, dst);
    return dst;
  });
  fs.writeFileSync(path.join(outDir, `${a.name}_${stamp}_prompt.txt`), prompt, "utf8");
  fs.rmSync(work, { recursive: true, force: true });
  console.log(JSON.stringify({ ok: true, files, refs: images.length }));
}

main().catch((e) => fail(String(e && e.message || e)));
