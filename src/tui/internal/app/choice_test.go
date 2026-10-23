package app

import (
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"

	"github.com/lielingai/zhishi/tui/internal/protocol"
)

func decisionEvent(id, question string, options ...string) protocol.Event {
	return protocol.Event{Kind: protocol.KindDecision, RequestID: id, Question: question, Options: options}
}

func TestDecisionEventOpensOverlay(t *testing.T) {
	m := feed(testModel(), decisionEvent("d1", "用哪条线做扫描？", "主线路", "备用线路"))
	if len(m.Choices) != 1 {
		t.Fatalf("应登记 1 条待答，实际 %d", len(m.Choices))
	}
	ov, ok := m.TopOverlay()
	if !ok {
		t.Fatal("待答请求应自动弹出面板")
	}
	if _, isChoice := ov.(*choiceOverlay); !isChoice {
		t.Fatalf("栈顶应是待答面板，实际 %T", ov)
	}
	out := m.View()
	for _, want := range []string{"用哪条线做扫描", "主线路", "备用线路", "1", "2"} {
		if !strings.Contains(out, want) {
			t.Fatalf("面板应显示 %q：\n%s", want, out)
		}
	}
}

func TestDecisionEnterSubmits(t *testing.T) {
	m := feed(testModel(), decisionEvent("d1", "选一条", "A", "B"))
	m, cmd := m.Update(tea.KeyMsg{Type: tea.KeyEnter})
	if cmd == nil {
		t.Fatal("Enter 应提交第一个选项")
	}
	// 直接投递成功回执（不真跑 HTTP）。
	m, _ = m.Update(choiceRespondedMsg{id: "d1"})
	if len(m.Choices) != 0 {
		t.Fatalf("应答后应清空待答，实际 %d", len(m.Choices))
	}
	if _, ok := m.TopOverlay(); ok {
		t.Fatal("应答后面板应关闭")
	}
}

func TestDecisionHotkeyPicksOption(t *testing.T) {
	m := feed(testModel(), decisionEvent("d1", "选一条", "A", "B"))
	m, cmd := m.Update(runes("2"))
	if cmd == nil {
		t.Fatal("数字键应直接提交对应选项")
	}
	if got := m.findChoice("d1").sel; got != 1 {
		t.Fatalf("应选中第 2 项，实际 %d", got)
	}
}

func TestDecisionCustomAnswer(t *testing.T) {
	m := feed(testModel(), decisionEvent("d1", "选一条", "A", "B"))
	m, _ = m.Update(runes("c"))
	if !m.findChoice("d1").custom {
		t.Fatal("c 应切到自定义输入")
	}
	for _, r := range "第三条" {
		m, _ = m.Update(runes(string(r)))
	}
	if got := m.findChoice("d1").input; got != "第三条" {
		t.Fatalf("自定义输入未积累，实际 %q", got)
	}
	if _, cmd := m.Update(tea.KeyMsg{Type: tea.KeyEnter}); cmd == nil {
		t.Fatal("Enter 应提交自定义答案")
	}
}

func TestEscDismissesButKeepsPending(t *testing.T) {
	m := feed(testModel(), decisionEvent("d1", "选一条", "A"))
	m, _ = m.Update(tea.KeyMsg{Type: tea.KeyEsc})
	if _, ok := m.TopOverlay(); ok {
		t.Fatal("Esc 应收起面板")
	}
	if len(m.Choices) != 1 {
		t.Fatal("收起不等于作答，pending 应保留")
	}
	if !strings.Contains(m.statusLine(), "待答") {
		t.Fatalf("状态行应有待答提示：%s", m.statusLine())
	}
	// Alt+d 重开
	m, _ = m.Update(alt('d'))
	if _, ok := m.TopOverlay(); !ok {
		t.Fatal("Alt+d 应重新打开待答面板")
	}
}

func TestBoundaryAskDefaultsToApproveDeny(t *testing.T) {
	m := feed(testModel(), protocol.Event{
		Kind: protocol.KindBoundaryAsk, RequestID: "a1", BoundaryKind: "shell",
		Objects: []string{"/etc/hosts"}, ToolName: "Bash",
	})
	c := m.findChoice("a1")
	if c == nil || len(c.options) != 2 || c.options[0] != "批准" {
		t.Fatalf("越界请求应有默认 批准/拒绝，实际 %+v", c)
	}
	out := m.View()
	if !strings.Contains(out, "/etc/hosts") || !strings.Contains(out, "Bash") {
		t.Fatalf("应显示对象与工具：\n%s", out)
	}
}

func TestResolvedEventRemovesPending(t *testing.T) {
	m := feed(testModel(), decisionEvent("d1", "选一条", "A"))
	m = feed(m, protocol.Event{Kind: protocol.KindDecisionDone, RequestID: "d1"})
	if len(m.Choices) != 0 {
		t.Fatalf("resolved 后应清空，实际 %d", len(m.Choices))
	}
	if _, ok := m.TopOverlay(); ok {
		t.Fatal("resolved 后应关闭面板")
	}
}
