package app

import (
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"

	"github.com/lielingai/zhishi/tui/internal/store"
)

// 2.2 — Ctrl+K 动作中心：动作可搜索、可执行；状态行给「下一步」提示。
func TestPaletteSearchesDescriptions(t *testing.T) {
	items := filterPalette("环境", nil)
	if len(items) == 0 || items[0].Name != "打开环境面板" {
		t.Fatalf("输入环境应命中环境面板动作，实际 %+v", items)
	}
	if got := filterPalette("报告", nil); len(got) == 0 {
		t.Fatal("输入「报告」应有命中")
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

// 动作中心里的「针对当前块」动作：不新增快捷键，上下文自动判定。
func TestPaletteContextActions(t *testing.T) {
	m := testModel()
	m.Store.Upsert(store.Block{ID: "msg:7", Kind: store.KindUser, Version: 1, Body: "看这个端点"})
	m.Store.Upsert(store.Block{
		ID: "t1", Kind: store.KindTool, Title: "env_exec", Version: 1,
		Body: "exit=0\n" + strings.Repeat("output\n", 10),
	})
	m.layout()

	// 当前块是工具块：回退/分叉不可用，且说明原因；展开可用。
	back := filterPalette("回退", &m)
	if len(back) == 0 || !back[0].Disabled || !strings.Contains(back[0].Why, "用户消息") {
		t.Fatalf("工具块上「回退」应置灰并说明原因，实际 %+v", back)
	}
	fork := filterPalette("分叉", &m)
	if len(fork) == 0 || !fork[0].Disabled {
		t.Fatalf("工具块上「分叉」应置灰，实际 %+v", fork)
	}

	m2, _ := m.Update(tea.KeyMsg{Type: tea.KeyCtrlK})
	for _, r := range "展开" {
		m2, _ = m2.Update(runes(string(r)))
	}
	m2, _ = m2.Update(tea.KeyMsg{Type: tea.KeyEnter})
	b, ok := m2.Store.Get("t1")
	if !ok || !b.Expanded {
		t.Fatalf("动作中心执行「展开」应展开当前块，实际 expanded=%v", b.Expanded)
	}
}
