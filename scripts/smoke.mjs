/**
 * 引擎底座升级回归一键入口（本地开发者工具；依赖真端点 + 真 VM，CI 跑不了）。
 *
 * 按序子进程执行 tmp/ 下的活体 smoke 脚本（node --import tsx/esm）：
 *   m1-smoke → m2-smoke → m3-smoke → m4a-client → m4a-sdk-observe → m4b-smoke
 * 每个脚本记录状态/耗时/exit code，单个失败不中断后续，全跑完给汇总表。
 * 任一脚本失败（含超时）→ 本编排器 exit 1（升级阻断语义）。
 *
 * 用法：
 *   node scripts/smoke.mjs                 # 全量
 *   node scripts/smoke.mjs --only m1-smoke # 只跑一个（可用名字/文件名，.mjs 可省略）
 *
 * 环境变量：
 *   SMOKE_TIMEOUT_SECONDS  单脚本超时秒数（默认 900）；超时按失败处理
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

// 顺序即回归顺序。m4 系列默认参数（sidecar 端口 / 阶段）与各脚本自身缺省一致。
const SUITES = [
  { name: "m1-smoke", file: "tmp/m1-smoke.mjs", args: [], note: "" },
  { name: "m2-smoke", file: "tmp/m2-smoke.mjs", args: [], note: "" },
  { name: "m3-smoke", file: "tmp/m3-smoke.mjs", args: [], note: "" },
  {
    name: "m4a-client",
    file: "tmp/m4a-client.mjs",
    args: [],
    note: "前置：pi 引擎 sidecar 已在 :3199 运行",
  },
  {
    name: "m4a-sdk-observe",
    file: "tmp/m4a-sdk-observe.mjs",
    args: [],
    note: "前置：SDK 引擎 sidecar 已在 :3200 运行",
  },
  {
    name: "m4b-smoke",
    file: "tmp/m4b-smoke.mjs",
    args: [],
    note: "阶段 a（默认端口 :3199）；阶段 b 需重启 sidecar 后手动跑",
  },
];

const TIMEOUT_MS =
  Number.parseInt(process.env.SMOKE_TIMEOUT_SECONDS ?? "900", 10) * 1000;

function piVersion(pkgName) {
  try {
    const pkg = JSON.parse(
      readFileSync(join(ROOT, "node_modules", pkgName, "package.json"), "utf8"),
    );
    return pkg.version ?? "?";
  } catch {
    return "未安装";
  }
}

function normalizeName(name) {
  return name
    .replace(/\\/g, "/")
    .replace(/^tmp\//, "")
    .replace(/\.mjs$/, "");
}

function parseArgs(argv) {
  const opts = { only: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--only" || argv[i] === "-o") opts.only = argv[++i];
    else if (argv[i].startsWith("--only="))
      opts.only = argv[i].slice("--only=".length);
    else {
      console.error(
        `未知参数: ${argv[i]}\n用法: node scripts/smoke.mjs [--only <name>]`,
      );
      process.exit(2);
    }
  }
  return opts;
}

/** 子进程跑一个脚本（stdio 透传），返回 { status, exitCode, ms }。 */
function runSuite(suite) {
  return new Promise((resolve) => {
    const file = join(ROOT, suite.file);
    const started = Date.now();
    if (!existsSync(file)) {
      console.error(`✗ ${suite.name}  脚本不存在: ${file}`);
      resolve({ status: "fail", exitCode: "—", ms: 0 });
      return;
    }
    const child = spawn(
      process.execPath,
      ["--import", "tsx/esm", file, ...suite.args],
      {
        cwd: ROOT,
        stdio: "inherit",
      },
    );
    let settled = false;
    const finish = (status, exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ status, exitCode: exitCode ?? "—", ms: Date.now() - started });
    };
    const timer = setTimeout(() => {
      console.error(`\n✗ ${suite.name}  超过 ${TIMEOUT_MS / 1000}s 超时，终止`);
      try {
        child.kill();
      } catch {
        /* already gone */
      }
      finish("timeout", null);
    }, TIMEOUT_MS);
    child.on("error", (err) => {
      console.error(`✗ ${suite.name}  无法启动: ${err.message}`);
      finish("fail", null);
    });
    child.on("exit", (code) => finish(code === 0 ? "pass" : "fail", code));
  });
}

function printStatus(name, status, exitCode, ms) {
  const mark = status === "pass" ? "✓" : "✗";
  const label =
    status === "pass" ? "PASS" : status === "timeout" ? "TIMEOUT" : "FAIL";
  console.log(
    `${mark} ${name}  ${label}  ${(ms / 1000).toFixed(1)}s  exit ${exitCode}`,
  );
}

const opts = parseArgs(process.argv.slice(2));
let suites = SUITES;
if (opts.only) {
  const key = normalizeName(opts.only);
  suites = SUITES.filter((s) => s.name === key);
  if (suites.length === 0) {
    console.error(`✗ 未知脚本: ${opts.only}`);
    console.error(
      `  可用: ${SUITES.map((s) => s.name).join(", ")}（.mjs 后缀 / tmp/ 前缀可省略）`,
    );
    process.exit(2);
  }
}

console.log("引擎底座升级回归（真端点 + 真 VM；CI 不可用，本地跑）");
console.log(
  `pi-agent-core ${piVersion("@earendil-works/pi-agent-core")} / pi-ai ${piVersion("@earendil-works/pi-ai")}`,
);
console.log("");

const results = [];
for (const suite of suites) {
  console.log(`\n━━ ${suite.name} ━━`);
  if (suite.note) console.log(`  ${suite.note}`);
  console.log(
    `  $ node --import tsx/esm ${suite.file}${suite.args.length ? " " + suite.args.join(" ") : ""}`,
  );
  const r = await runSuite(suite);
  printStatus(suite.name, r.status, r.exitCode, r.ms);
  results.push({ suite, ...r });
}

const failed = results.filter((r) => r.status !== "pass");
console.log("\n════════ 汇总 ════════");
console.log("  脚本名            状态       耗时     exit code");
for (const r of results) {
  const mark = r.status === "pass" ? "✓" : "✗";
  const label =
    r.status === "pass" ? "PASS" : r.status === "timeout" ? "TIMEOUT" : "FAIL";
  console.log(
    `  ${mark} ${r.suite.name.padEnd(16)} ${label.padEnd(8)} ${(r.ms / 1000).toFixed(1).padStart(7)}s  ${String(r.exitCode).padStart(4)}`,
  );
}
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
if (failed.length > 0) {
  console.error(
    `任一失败 → 编排器 exit 1（阻断升级）：${failed.map((r) => r.suite.name).join(", ")}`,
  );
  process.exit(1);
}
