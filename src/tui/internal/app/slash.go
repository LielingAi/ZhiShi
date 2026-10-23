package app

// 斜杠命令 = CLI 子命令（2.2 起）。
//
// 设计取舍：TUI **不**解释这些命令，也不认识它们的业务语义——它只把
// `/model list` 翻译成一次 `zhishi model list` 子进程调用，把输出贴成一个块。
// 这样 CLI 的每一条命令（现在和将来新增的）在 TUI 里自动可用，不需要在两处
// 维护同一份命令表。命令表是给人看的（命令面板的模板），不是执行依据。
//
// 进程怎么找：启动器把 argv 前缀经 ZHISHI_CLI_ARGV（JSON 数组）传进来——
// npm 形态是 node + <pkg>/dist/cli.js，dev 是 node --import tsx/esm <ts>。
// 三种发行布局只在 src/cli/tui-launch.ts 一处认识，Go 侧不猜路径。
//
// 连哪个 sidecar：用环境变量 ZHISHI_SERVER / ZHISHI_TOKEN 传，不进 argv——
// `env exec <id> -- <cmd>` 的透传语义依赖 argv 里 `--` 之后原样保留，往 argv
// 里插 flag 会把开关漏进 guest 命令。

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"time"

	"github.com/charmbracelet/bubbletea"

	"github.com/lielingai/zhishi/tui/internal/store"
)

// cliCommandTimeout 是单条子命令的上限。足够 `model verify` 这类走网络的
// 命令；`intel update` 这种全量抓取请去真终端跑（TUI 里会超时并明确报错）。
const cliCommandTimeout = 180 * time.Second

// parseSlash 把输入切成 CLI argv。第二个返回值表示「是不是一条斜杠命令」。
//
// 切分只支持空白分隔 + 单/双引号包裹（引号内空白不切）；不支持转义与嵌套——
// 参数里真要带引号的场景，去 shell 里跑更合适。空引号参数会被丢掉。
func parseSlash(input string) ([]string, bool) {
	s := strings.TrimSpace(input)
	if !strings.HasPrefix(s, "/") {
		return nil, false
	}
	body := strings.TrimSpace(s[1:])
	if body == "" {
		return nil, true
	}
	return splitArgs(body), true
}

func splitArgs(s string) []string {
	out := make([]string, 0, 4)
	var cur strings.Builder
	var quote rune
	flush := func() {
		if cur.Len() > 0 {
			out = append(out, cur.String())
			cur.Reset()
		}
	}
	for _, r := range s {
		switch {
		case quote != 0:
			if r == quote {
				quote = 0
			} else {
				cur.WriteRune(r)
			}
		case r == '\'' || r == '"':
			quote = r
		case r == ' ' || r == '\t' || r == '\n':
			flush()
		default:
			cur.WriteRune(r)
		}
	}
	flush()
	return out
}

// cliInvocation 读启动器给的 argv 前缀。
func cliInvocation() ([]string, error) {
	raw := strings.TrimSpace(os.Getenv("ZHISHI_CLI_ARGV"))
	if raw == "" {
		return nil, fmt.Errorf("TUI 没拿到 CLI 入口（ZHISHI_CLI_ARGV 为空）——请用 `zhishi` 启动 TUI，而不是直接运行 zhishi-tui")
	}
	var argv []string
	if err := json.Unmarshal([]byte(raw), &argv); err != nil || len(argv) == 0 {
		return nil, fmt.Errorf("ZHISHI_CLI_ARGV 不是合法的 argv 数组：%s", raw)
	}
	return argv, nil
}

// cliResultMsg 是一条斜杠命令的终态。
type cliResultMsg struct {
	id  string
	out string
	ok  bool
	dur time.Duration
}

// runCLICmd 起子进程跑 CLI。stdin 置空（遇交互式提示立即 EOF 而不是挂住），
// 合并 stdout/stderr——用户要看的是「命令说了什么」，分流失去意义。
func runCLICmd(ctx context.Context, id string, args []string, server, token string) tea.Cmd {
	return func() tea.Msg {
		start := time.Now()
		argv, err := cliInvocation()
		if err != nil {
			return cliResultMsg{id: id, out: err.Error(), dur: time.Since(start)}
		}
		full := append(append([]string{}, argv...), args...)

		runCtx, cancel := context.WithTimeout(ctx, cliCommandTimeout)
		defer cancel()
		cmd := exec.CommandContext(runCtx, full[0], full[1:]...)
		cmd.WaitDelay = 2 * time.Second // ctx 取消后给 2s 收尾，再强杀
		cmd.Stdin = nil

		env := os.Environ()
		if server != "" {
			env = append(env, "ZHISHI_SERVER="+server)
		}
		if token != "" {
			env = append(env, "ZHISHI_TOKEN="+token)
		}
		cmd.Env = env

		out, runErr := cmd.CombinedOutput()
		text := cleanCLIOutput(string(out))
		if runCtx.Err() == context.DeadlineExceeded {
			note := fmt.Sprintf("命令超时（%s），已中止——长任务请到真终端跑", cliCommandTimeout)
			if text != "" {
				text += "\n\n" + note
			} else {
				text = note
			}
			return cliResultMsg{id: id, out: text, dur: time.Since(start)}
		}
		if runErr != nil {
			// 非零退出：块头已经有 ✗，正文里再补一句 "exit status 1" 是噪声；
			// 只有「没输出」或「根本没起来」（ENOENT 等）才需要文字说明。
			var exitErr *exec.ExitError
			if errors.As(runErr, &exitErr) {
				if text == "" {
					text = fmt.Sprintf("(退出码 %d，无输出)", exitErr.ExitCode())
				}
			} else {
				if text != "" {
					text += "\n"
				}
				text += runErr.Error()
			}
		}
		return cliResultMsg{id: id, out: text, ok: runErr == nil, dur: time.Since(start)}
	}
}

// cleanCLIOutput 去掉 CLI 在远端模式下的固定提示行——每条命令都带一遍纯噪声
// （TUI 自己已经知道 server 是谁）。
func cleanCLIOutput(s string) string {
	if s == "" {
		return ""
	}
	lines := strings.Split(s, "\n")
	kept := lines[:0]
	for _, line := range lines {
		if strings.HasPrefix(line, "[zhishi] 远端模式") {
			continue
		}
		kept = append(kept, line)
	}
	return strings.TrimSpace(strings.Join(kept, "\n"))
}

// normalizeCLIArgs 做斜杠别名映射（`/help` → `--help`）。
func normalizeCLIArgs(args []string) []string {
	if len(args) == 1 && args[0] == "help" {
		return []string{"--help"}
	}
	return args
}

// ProbeCLI 是 `--probe-cli` 的自检入口：解析与执行走与 TUI 完全相同的代码，
// 只是不建块、直接返回输出。本仓库所在环境没有 TTY，交互路径无法自动验证，
// 这条探针让「/命令 = CLI 子命令」至少能被脚本端到端跑到。
func ProbeCLI(server, token, input string) (out string, ok bool, err error) {
	args, isSlash := parseSlash(input)
	if !isSlash {
		return "", false, fmt.Errorf("不是斜杠命令：%q", input)
	}
	if len(args) == 0 {
		return "", false, fmt.Errorf("空命令")
	}
	res, _ := runCLICmd(context.Background(), "cmd:probe", normalizeCLIArgs(args), server, token)().(cliResultMsg)
	if strings.TrimSpace(res.out) == "" {
		res.out = "(无输出)"
	}
	return res.out, res.ok, nil
}

// startCLI 建块并下发子进程命令。块先以 live 态出现，结果回来再补正文。
func (m *Model) startCLI(args []string) tea.Cmd {
	if len(args) == 0 {
		m.LastNotice = "用法：/<cli 子命令>，例如 /model list、/env list、/status"
		return nil
	}
	args = normalizeCLIArgs(args)

	m.NoteSeq++
	id := fmt.Sprintf("cmd:%d", m.NoteSeq)
	m.Store.Upsert(store.Block{
		ID:      id,
		Kind:    store.KindTool,
		Version: 1,
		Title:   "$ zhishi " + strings.Join(args, " "),
		Live:    true,
	})
	m.ScrollLines = 0
	return runCLICmd(m.Ctx, id, args, m.Server, m.token())
}

func (m Model) token() string {
	if m.Client == nil {
		return ""
	}
	return m.Client.Token
}
