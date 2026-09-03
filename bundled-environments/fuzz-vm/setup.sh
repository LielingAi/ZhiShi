#!/usr/bin/env bash
# fuzz-vm 环境初始化与自检 —— 在 guest（Ubuntu Server）内运行
set -euo pipefail

echo "[fuzz-vm] installing toolchain via apt..."
sudo apt-get update -qq
sudo apt-get install -y -qq build-essential clang gdb python3 python3-pip git

echo "[fuzz-vm] installing AFL++..."
if ! command -v afl-fuzz >/dev/null 2>&1; then
  if apt-cache show aflplusplus >/dev/null 2>&1; then
    sudo apt-get install -y -qq aflplusplus
  else
    # 源里没有就源码装（Ubuntu 24.04 源带 aflplusplus，正常走不到这里）
    git clone --depth 1 https://github.com/AFLplusplus/AFLplusplus "$HOME/AFLplusplus"
    (cd "$HOME/AFLplusplus" && make -j"$(nproc)" && sudo make install)
  fi
fi

echo "[fuzz-vm] checking toolchain..."
afl-fuzz -h 2>&1 | head -1 || true
command -v afl-clang-fast afl-fuzz afl-tmin afl-cmin afl-showmap >/dev/null
clang --version | head -1

# 插桩编译自检：最小程序过一遍 afl-clang-fast
cat > /tmp/zhishi-afl-selfcheck.c <<'EOF'
#include <stdio.h>
int main(void){ char buf[8]; if (fgets(buf, sizeof buf, stdin)) puts(buf); return 0; }
EOF
afl-clang-fast -g -O1 /tmp/zhishi-afl-selfcheck.c -o /tmp/zhishi-afl-selfcheck
echo hi | /tmp/zhishi-afl-selfcheck >/dev/null
rm -f /tmp/zhishi-afl-selfcheck /tmp/zhishi-afl-selfcheck.c

# stack-hash.sh（1.6.2：crash-triager 深挖模式验证门的栈指纹工具）。
# 与 fuzz docker 配方 examples/stack-hash.sh 同一文本（配方惯例：两基底各自带一份）。
sudo tee /usr/local/bin/stack-hash.sh >/dev/null <<'EOF'
#!/usr/bin/env bash
# stack-hash.sh — 批量取崩溃样本的栈指纹（信号/ASan 类型 + 顶帧站点）
# 用法: stack-hash.sh <target...> -- <sample...>
#   target 按 `<binary> @@` 方式运行时样本路径替换 @@，否则样本作 argv[1]
# 输出: 每行 <sample>\t<指纹hash>\t<指纹描述>
# 指纹优先取 ASan（SUMMARY 类型 + 首个目标源码帧），其次 gdb bt 顶 5 帧。
set -uo pipefail

die() { echo "usage: $0 <target...> -- <sample...>" >&2; exit 2; }
[ $# -ge 3 ] || die

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
  if printf '%s' "$out" | grep -q 'SUMMARY: AddressSanitizer'; then
    sum=$(printf '%s' "$out" | grep -m1 'SUMMARY: AddressSanitizer' | sed 's/.*SUMMARY: AddressSanitizer: //')
    frame=$(printf '%s' "$out" | grep -m1 -E '#[0-9]+ .* in [a-zA-Z_]' | sed 's/0x[0-9a-f]*//g')
    fp="asan:${sum%% *}|${frame}"
  else
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
EOF
sudo chmod +x /usr/local/bin/stack-hash.sh

echo "[fuzz-vm] ready —— adopt/build 收尾会自动做 zhishi-clean 快照"
