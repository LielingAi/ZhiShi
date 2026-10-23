package app

import (
	"context"
	"runtime"
	"strings"
	"testing"
	"time"

	tea "github.com/charmbracelet/bubbletea"

	"github.com/lielingai/zhishi/tui/internal/store"
)

func TestParseSlash(t *testing.T) {
	cases := []struct {
		in   string
		args []string
		ok   bool
	}{
		{"/model list", []string{"model", "list"}, true},
		{"  /status  ", []string{"status"}, true},
		{"/model set-key deepseek sk-1", []string{"model", "set-key", "deepseek", "sk-1"}, true},
		{`/env add --name "my box" --kind ssh`, []string{"env", "add", "--name", "my box", "--kind", "ssh"}, true},
		{"/", nil, true},
		{"普通消息", nil, false},
		{"not/slash", nil, false},
	}
	for _, c := range cases {
		args, ok := parseSlash(c.in)
		if ok != c.ok {
			t.Fatalf("%q: isSlash=%v，期望 %v", c.in, ok, c.ok)
		}
		if strings.Join(args, "|") != strings.Join(c.args, "|") {
			t.Fatalf("%q: args=%v，期望 %v", c.in, args, c.args)
		}
	}
}

func TestActionSendSlashCreatesLiveBlock(t *testing.T) {
	m := testModel()
	for _, r := range "/status" {
		m, _ = m.Update(runes(string(r)))
	}
	m, cmd := m.Update(tea.KeyMsg{Type: tea.KeyEnter})
	if cmd == nil {
		t.Fatal("斜杠命令应下发子进程 Cmd")
	}
	if got := m.Input.Value(); got != "" {
		t.Fatalf("发送后输入框应清空，实际 %q", got)
	}
	blocks := m.Store.List()
	if len(blocks) != 1 {
		t.Fatalf("应新增 1 个块，实际 %d", len(blocks))
	}
	b := blocks[0]
	if b.Kind != store.KindTool || !b.Live || b.Title != "$ zhishi status" {
		t.Fatalf("块应为 live 工具块且标题含命令，实际 %+v", b)
	}
}

func TestActionSendSlashHelpMapsToFlag(t *testing.T) {
	m := testModel()
	for _, r := range "/help" {
		m, _ = m.Update(runes(string(r)))
	}
	m, _ = m.Update(tea.KeyMsg{Type: tea.KeyEnter})
	b := m.Store.List()[0]
	if b.Title != "$ zhishi --help" {
		t.Fatalf("/help 应映射成 --help，实际 %q", b.Title)
	}
}

func TestCLIResultFillsBlock(t *testing.T) {
	m := testModel()
	for _, r := range "/version" {
		m, _ = m.Update(runes(string(r)))
	}
	m, _ = m.Update(tea.KeyMsg{Type: tea.KeyEnter})
	b := m.Store.List()[0]

	m, _ = m.Update(cliResultMsg{id: b.ID, out: "2.0.8", ok: true, dur: 120 * time.Millisecond})
	got, _ := m.Store.Get(b.ID)
	if got.Live {
		t.Fatal("结果回来后不该还是 live")
	}
	if got.Failed || got.Body != "2.0.8" {
		t.Fatalf("正文/成功态不对：%+v", got)
	}
	if got.Duration == 0 {
		t.Fatal("耗时应写回块")
	}
}

func TestCLIResultFailureMarksBlock(t *testing.T) {
	m := testModel()
	for _, r := range "/nope" {
		m, _ = m.Update(runes(string(r)))
	}
	m, _ = m.Update(tea.KeyMsg{Type: tea.KeyEnter})
	b := m.Store.List()[0]

	m, _ = m.Update(cliResultMsg{id: b.ID, out: "unknown command", ok: false})
	got, _ := m.Store.Get(b.ID)
	if !got.Failed {
		t.Fatal("失败命令应标记 Failed（Alt+f 能过滤到）")
	}
	if got.Body != "unknown command" {
		t.Fatalf("正文应保留输出，实际 %q", got.Body)
	}
}

func TestCLIResultEmptyOutput(t *testing.T) {
	m := testModel()
	m.Store.Upsert(store.Block{ID: "cmd:x", Kind: store.KindTool, Version: 1, Live: true})
	m, _ = m.Update(cliResultMsg{id: "cmd:x", out: "", ok: true})
	got, _ := m.Store.Get("cmd:x")
	if got.Body != "(无输出)" {
		t.Fatalf("空输出应写占位，实际 %q", got.Body)
	}
}

func TestCleanCLIOutputDropsRemoteNotice(t *testing.T) {
	in := "[zhishi] 远端模式：http://127.0.0.1:1（Bearer token 已启用）\n2.0.8\n"
	if got := cleanCLIOutput(in); got != "2.0.8" {
		t.Fatalf("应只去掉远端模式提示行，实际 %q", got)
	}
}

// TestRunCLICmdReal 真起一个子进程，验证 argv 前缀 + 输出 + 成功态。
// 用平台自带的 echo，不依赖仓库里的 CLI。
func TestRunCLICmdReal(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Setenv("ZHISHI_CLI_ARGV", `["cmd","/c","echo"]`)
	} else {
		t.Setenv("ZHISHI_CLI_ARGV", `["sh","-c","echo"]`)
	}
	msg, ok := runCLICmd(context.Background(), "cmd:1", []string{"hi"}, "", "")().(cliResultMsg)
	if !ok {
		t.Fatalf("结果类型不对")
	}
	if !msg.ok || strings.TrimSpace(msg.out) != "hi" {
		t.Fatalf("应成功输出 hi，实际 ok=%v out=%q", msg.ok, msg.out)
	}
}

func TestRunCLICmdWithoutInvocation(t *testing.T) {
	t.Setenv("ZHISHI_CLI_ARGV", "")
	msg := runCLICmd(context.Background(), "cmd:1", []string{"status"}, "", "")().(cliResultMsg)
	if msg.ok || !strings.Contains(msg.out, "ZHISHI_CLI_ARGV") {
		t.Fatalf("缺入口应给可读错误，实际 %+v", msg)
	}
}
