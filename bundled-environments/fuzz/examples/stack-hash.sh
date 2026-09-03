#!/usr/bin/env bash
# stack-hash.sh — 批量取崩溃样本的栈指纹（信号/ASan 类型 + 顶帧站点）
# 用法: stack-hash.sh <target> <sample> [sample...]
#   target 按 `<binary> @@` 方式运行（样本路径替换 @@），或直接 `<binary>`（样本作 argv[1]）
# 输出: 每行 <sample>\t<指纹hash>\t<指纹描述>
# 指纹优先取 ASan（SUMMARY 类型 + 首个目标源码帧），其次 gdb bt 顶 5 帧。
# 1.6.2 引入：crash-triager 深挖模式的验证门（新崩溃类 = 崩溃 且 指纹 ≠ 基准指纹）。
set -uo pipefail

die() { echo "usage: $0 <target...> -- <sample...>" >&2; exit 2; }
[ $# -ge 3 ] || die

# 以 `--` 分隔 target 命令与样本列表
target=(); samples=(); seen=0
for a in "$@"; do
  if [ "$seen" = 0 ] && [ "$a" = "--" ]; then seen=1; continue; fi
  if [ "$seen" = 0 ]; then target+=("$a"); else samples+=("$a"); fi
done
[ ${#samples[@]} -ge 1 ] || die

run_one() {
  local s="$1" out
  if [[ " ${target[*]} " == *" @@ "* ]]; then
    out=$("${target[@]//@@/$s}" 2>&1)
  else
    out=$("${target[@]}" "$s" 2>&1)
  fi
  printf '%s' "$out"
}

for s in ${samples[@]+"${samples[@]}"}; do
  out=$(run_one "$s")
  fp=""
  # ASan：SUMMARY 类型 + 首个落在目标源码（非 sanitizer/libc）的帧
  if printf '%s' "$out" | grep -q 'SUMMARY: AddressSanitizer'; then
    sum=$(printf '%s' "$out" | grep -m1 'SUMMARY: AddressSanitizer' | sed 's/.*SUMMARY: AddressSanitizer: //')
    frame=$(printf '%s' "$out" | grep -m1 -E '#[0-9]+ .* in [a-zA-Z_]' | sed 's/0x[0-9a-f]*//g')
    fp="asan:${sum%% *}|${frame}"
  else
    # gdb 通道：bt 顶 5 帧
    bt=$(gdb -q -batch -ex 'run' -ex 'bt 5' --args "${target[@]}" "$s" 2>/dev/null \
         | grep '^#' | head -5 | sed 's/0x[0-9a-f]*//g')
    [ -n "$bt" ] && fp="gdb:$(printf '%s' "$bt" | tr '\n' '|')"
  fi
  if [ -n "$fp" ]; then
    h=$(printf '%s' "$fp" | cksum | cut -d' ' -f1)
    printf '%s\t%s\t%s\n' "$s" "$h" "$(printf '%s' "$fp" | head -c 160)"
  else
    printf '%s\t%s\t%s\n' "$s" "no-crash" "-"
  fi
done
