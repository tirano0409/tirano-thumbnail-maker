#!/usr/bin/env node
// 썸네일 제작기 설치: 이 폴더를 클로드 스킬로 등록하고, Codex CLI 설치·로그인 상태를 점검한다.
// 사용: node install.mjs
// 결과: 마지막 줄에 JSON({"ok":..., "skill":..., "codex":..., "login":..., "next":[...]}) 출력.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TOOL_DIR = path.dirname(fileURLToPath(import.meta.url));
const next = [];

// 1) Node.js 버전
const major = parseInt(process.versions.node.split(".")[0], 10);
if (major < 18) next.push(`Node.js ${process.versions.node}는 오래됐습니다. 18 이상으로 업데이트하세요.`);

// 2) 스킬 등록: SKILL.md 의 {{TOOL_DIR}} 을 이 폴더의 실제 경로로 바꿔 ~/.claude/skills/thumbnail-maker/ 에 둔다.
const skillDir = path.join(os.homedir(), ".claude", "skills", "thumbnail-maker");
const toolDirPosix = TOOL_DIR.split(path.sep).join("/");
const skill = fs.readFileSync(path.join(TOOL_DIR, "SKILL.md"), "utf8").replaceAll("{{TOOL_DIR}}", toolDirPosix);
fs.mkdirSync(skillDir, { recursive: true });
fs.writeFileSync(path.join(skillDir, "SKILL.md"), skill, "utf8");

// 3) Codex CLI 설치·로그인 상태
// codex는 상태 메시지를 stderr로 내보내므로 stdout·stderr를 모두 읽는다.
const run = (cmd) => {
  try {
    const r = spawnSync(cmd, { shell: true, encoding: "utf8" });
    if (r.status !== 0 && !r.stdout && !r.stderr) return null;
    return `${r.stdout || ""}\n${r.stderr || ""}`.trim() || null;
  } catch { return null; }
};
// 방금 npm으로 설치해 PATH가 아직 갱신되지 않은 경우를 대비해 npm 전역 폴더의 codex도 찾는다.
let codexCmd = "codex";
let codexVersion = run("codex --version");
if (!codexVersion || /not recognized|not found|인식되지 않습니다/i.test(codexVersion)) {
  codexVersion = null;
  const prefix = run("npm prefix -g");
  if (prefix) {
    const p = prefix.split(/\r?\n/)[0].trim();
    const cand = process.platform === "win32" ? path.join(p, "codex.cmd") : path.join(p, "bin", "codex");
    if (fs.existsSync(cand)) { codexCmd = `"${cand}"`; codexVersion = run(`${codexCmd} --version`); }
  }
}
if (codexVersion) codexVersion = (codexVersion.match(/codex-cli\s+\S+/) || [codexVersion.split(/\r?\n/)[0]])[0];
let login = "unknown";
if (!codexVersion) {
  next.push("Codex CLI가 없습니다. 'npm install -g @openai/codex'로 설치한 뒤 이 스크립트를 다시 실행하세요.");
} else {
  const status = run(`${codexCmd} login status`) || "";
  login = /logged in/i.test(status) ? "ok" : "needed";
  if (login === "needed") next.push(`사용자가 새 터미널에서 '${codexCmd} login'을 직접 실행해 ChatGPT 계정(Plus 이상)으로 로그인해야 합니다. (방금 설치했다면 열려 있던 터미널은 codex를 못 찾을 수 있으니 새 터미널을 엽니다.)`);
}

// 4) 브랜드 상태
const brandsRoot = path.join(TOOL_DIR, "brands");
const brands = fs.readdirSync(brandsRoot, { withFileTypes: true })
  .filter((e) => e.isDirectory() && !e.name.startsWith("_")).map((e) => e.name);
if (brands.length === 0) next.push("아직 채널 스타일이 없습니다. SKILL.md의 '처음 사용할 때' 순서로 채널 이름과 레퍼런스 썸네일 2~6장을 받으세요.");

const ok = !!codexVersion && login === "ok" && major >= 18;
console.log(`스킬 등록: ${skillDir}`);
console.log(`Codex CLI: ${codexVersion || "없음"} / 로그인: ${login}`);
console.log(JSON.stringify({ ok, skill: skillDir, codex: codexVersion, login, brands, next }));
