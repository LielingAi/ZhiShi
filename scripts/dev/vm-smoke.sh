#!/usr/bin/env bash
# VM / 容器通道 smoke（只读，Linux / macOS）。
#
# 与 scripts/dev/vm-smoke.ps1 同口径：只探测、不启动、不改 VM。
# VMware 在 Linux/macOS 上是 VM 生命周期的主通道；Hyper-V 仅 Windows。
#
# 用法：
#   bash scripts/dev/vm-smoke.sh          # 正常输出，退出码恒 0
#   bash scripts/dev/vm-smoke.sh --strict # 任一已安装通道探测失败 → 1
set -u

strict=0
[ "${1:-}" = "--strict" ] && strict=1
failures=0

ok()   { printf '  OK   %-10s %s\n' "$1" "$2"; }
miss() { printf '  MISS %-10s %s\n' "$1" "$2"; failures=$((failures + 1)); }

echo "VM / 容器通道 smoke（只读）"

# ── vmrun ───────────────────────────────────────────────────────────────
vmrun_path="$(command -v vmrun 2>/dev/null || true)"
if [ -z "$vmrun_path" ]; then
  for c in \
    "/usr/bin/vmrun" \
    "/usr/lib/vmware/bin/vmrun" \
    "/Applications/VMware Fusion.app/Contents/Library/vmrun"; do
    [ -x "$c" ] && vmrun_path="$c" && break
  done
fi
if [ -n "$vmrun_path" ]; then
  if out="$("$vmrun_path" list 2>&1)"; then
    count="$(printf '%s\n' "$out" | grep -vc '^Total running VMs' || true)"
    ok vmrun "$vmrun_path（running VMs: $count）"
  else
    miss vmrun "$vmrun_path list 失败"
  fi
else
  miss vmrun "未安装 / 不在 PATH 与默认安装路径"
fi

# ── docker（容器通道，顺带确认）────────────────────────────────────────
if command -v docker >/dev/null 2>&1; then
  if docker info >/dev/null 2>&1; then
    ok docker "$(docker info --format '{{.ServerVersion}}' 2>/dev/null || echo present)"
  else
    miss docker "daemon 不可达（权限 / 未启动）"
  fi
else
  miss docker "未安装"
fi

# ── VM 条目通道分布 ─────────────────────────────────────────────────────
cfg="$HOME/.zhishi/config.json"
if [ -f "$cfg" ] && command -v node >/dev/null 2>&1; then
  node -e '
    const fs=require("fs");
    try {
      const c=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
      const vms=(c.environments||[]).filter(e=>e.kind==="vm");
      console.log(`  INFO VM 条目: ${vms.length} 条`);
      for (const e of vms) console.log(`       - ${e.id}  channel=${e.address?"ssh":"guest(vmrun)"}  address=${e.address||""}`);
    } catch { console.log("  INFO config.json 解析失败（跳过）"); }
  ' "$cfg"
fi

echo
if [ "$strict" -eq 1 ] && [ "$failures" -gt 0 ]; then
  echo "严格模式：有 $failures 项失败"
  exit 1
fi
echo "完成（失败 $failures 项）"
exit 0
