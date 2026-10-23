package app

import (
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"
)

// 空会话首屏要告诉新人"面板在哪"——否则 Alt+t/Alt+a 永远没人发现。
func TestEmptyStateTeachesPanels(t *testing.T) {
	m := testModel()
	out := m.View()
	for _, want := range []string{"F1", "Ctrl+K", "Alt+t 任务", "Alt+a 研究档案"} {
		if !strings.Contains(out, want) {
			t.Fatalf("空态应提到 %q：\n%s", want, out)
		}
	}
}

// F1 按"想做什么"分组：每个面板都能从帮助里被找到。
func TestHelpGroupedByIntent(t *testing.T) {
	m := testModel()
	m, _ = m.Update(tea.KeyMsg{Type: tea.KeyF1})
	out := m.View()
	for _, want := range []string{"想知道有什么", "任务中心", "研究档案", "想找东西", "Ctrl+F"} {
		if !strings.Contains(out, want) {
			t.Fatalf("帮助应包含 %q：\n%s", want, out)
		}
	}
}

// 空面板要说清"为什么空、数据从哪来"，不能只写（空）。
func TestEmptyPanelExplainsSource(t *testing.T) {
	m := testModel()
	m.Admin = &fakeAdmin{}
	m, cmd := m.Update(alt('t'))
	m = pump(t, m, cmd)
	out := m.View()
	if !strings.Contains(out, "没有任务") || !strings.Contains(out, "task 工具") {
		t.Fatalf("任务空态应解释来源：\n%s", out)
	}

	m2 := testModel()
	m2.Admin = &fakeAdmin{}
	m2, cmd2 := m2.Update(alt('l'))
	m2 = pump(t, m2, cmd2)
	if out := m2.View(); !strings.Contains(out, "没有历史会话") {
		t.Fatalf("线面板空态应解释来源：\n%s", out)
	}
}
