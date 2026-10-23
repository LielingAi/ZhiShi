package app

import (
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"

	"github.com/lielingai/zhishi/tui/internal/store"
)

// 2.2 — Ctrl+K 动作中心：动作可搜索、可执行；状态行给「下一步」提示。
func TestPaletteSearchesDescriptions(t *testing.T) {
	items := filterPalette("attach")
	if len(items) == 0 || items[0].Name != "attach 到环境" {
		t.Fatalf("输入 attach 应命中 attach 动作，实际 %+v", items)
	}
	// 中文动词也能命中（名称子序列）。
	if got := filterPalette("环境"); len(got) == 0 {
		t.Fatal("输入「环境」应有命中")
	}
}

func TestPaletteExecutesLocalActions(t *testing.T) {
	cases := []struct {
		query string
		check func(Overlay) bool
		want  string
	}{
		{"搜索", func(o Overlay) bool { _, ok := o.(*searchOverlay); return ok }, "搜索"},
		{"键位帮助", func(o Overlay) bool { _, ok := o.(*helpOverlay); return ok }, "键位帮助"},
		{"打开环境面板", func(o Overlay) bool { _, ok := o.(*envOverlay); return ok }, "环境面板"},
	}
	for _, tc := range cases {
		m := testModel()
		m, _ = m.Update(tea.KeyMsg{Type: tea.KeyCtrlK})
		for _, r := range tc.query {
			m, _ = m.Update(runes(string(r)))
		}
		m, _ = m.Update(tea.KeyMsg{Type: tea.KeyEnter})
		ov, ok := m.TopOverlay()
		if !ok || !tc.check(ov) {
			t.Fatalf("%s：动作没有打开预期的面板（栈顶 %T ok=%v）", tc.want, ov, ok)
		}
	}
}

func TestSecondLineContextHints(t *testing.T) {
	m := testModel()
	if line := m.secondLine(); !strings.Contains(line, "Ctrl+K 动作中心") {
		t.Fatalf("空闲时应提示动作中心，实际 %q", line)
	}

	m.SessionSt = "running"
	if line := m.secondLine(); !strings.Contains(line, "Ctrl+C 停") {
		t.Fatalf("运行中应提示停止键，实际 %q", line)
	}

	m.SessionSt = "idle"
	m.Store.Upsert(store.Block{
		ID: "t1", Kind: store.KindTool, Title: "env_exec", Version: 1,
		Body: "exit=0\n" + strings.Repeat("output line\n", 10),
	})
	m.layout()
	if line := m.secondLine(); !strings.Contains(line, "Alt+r 展开这一块") {
		t.Fatalf("选中可折叠块时应提示展开键，实际 %q", line)
	}
}
