---
kind: technique
title: Python Web 高危 sink 速查与利用判据
applicability: 白盒审计 Python Web 项目（尤其 stdlib/Flask/Bottle 小项目），需要快速锁定可利用 sink 并判定真伪时。
criteria: 每个锁定的 sink 都能说清「外部输入从哪个参数到哪行」+ 给出最小 PoC 或明确的不可达理由；说不清的按线索处理不当结论。
tags: 白盒,Python,sink,命令注入,路径穿越
---

## 高危 sink 与判据

1. **`os.popen(cmd)` / `os.system(cmd)` 字符串拼接**——外部输入拼进 cmd 即命令注入。判据：payload `127.0.0.1;id`，输出含 `uid=` 即实锤（经 `/bin/sh -c`）。
2. **`os.path.join(base, name)` 接外部 name**——两个利用面：相对 `../../` 穿越；**绝对路径短路**（`name` 以 `/` 开头时 join 直接返回 name，`/download?name=/etc/passwd` 直读）。判据：两种各试一次，任一读到 `/etc/passwd` 即任意文件读。注意：相对穿越要求中间目录真实存在，ENOENT 不代表安全——先试绝对路径变体。
3. **`subprocess.run(..., shell=True)`**——拼接外部输入才危险；**只拼模块级常量 = 安全（经典诱饵）**。判据：追该字符串的每个拼接分量，全部不可达外部输入 → 排除，写明理由。
4. **`pickle.loads` / `yaml.load`（非 SafeLoader）接外部数据**——反序列化 RCE。判据：数据源是否网络/文件外部可控。
5. **`rfile.read(int(headers['Content-Length']))` 直接信任**——半开连接 DoS：声明大长度不发 body，单线程 `http.server` 永久阻塞。判据：socket 直连声明 `Content-Length: 100000` 只发几字节，正常请求超时即实锤（CWE-400）。

## 判据总则

sink 存在 ≠ 漏洞；外部输入路径可达 + 最小 PoC 复现 = 漏洞。两者缺一按线索记录，不进确认清单。
