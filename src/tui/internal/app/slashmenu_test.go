package app

import (
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"
)

func typeString(m Model, s string) Model {
	for _, r := range s {
		m, _ = m.Update(runes(string(r)))
	}
	return m
}

func TestBuildSlashMenu(t *testing.T) {
	if got := buildSlashMenu("普通消息"); got != nil {
		t.Fatalf("非斜杠输入不该有候选，实际 %+v", got)
	}
	if got := buildSlashMenu("/model list"); got != nil {
		t.Fatalf("已经开始打参数就不该再弹候选，实际 %+v", got)
	}
	all := buildSlashMenu("/")
	if all == nil || len(all.items) != len(commandTemplates()) {
		t.Fatalf("`/` 应列出全部模板，实际 %+v", all)
	}
	mod := buildSlashMenu("/mod")
	if mod == nil || len(mod.items) == 0 {
		t.Fatal("/mod 应有候选")
	}
	for _, it := range mod.items {
		if !strings.HasPrefix(strings.TrimPrefix(it.Insert, "/"), "mod") {
			t.Fatalf("候选不该混进不匹配项：%+v", it)
		}
	}
	if got := buildSlashMenu("/zzz"); got != nil {
		t.Fatalf("无匹配应返回 nil（不显示空浮层），实际 %+v", got)
	}
}

func TestTypingSlashShowsMenuInView(t *testing.T) {
	m := typeString(testModel(), "/mod")
	if m.MenuRows() == 0 {
		t.Fatal("输入 /mod 后候选应可见")
	}
	out := m.View()
	if !strings.Contains(out, "▸ /model list") {
		t.Fatalf("画面里应有选中候选：\n%s", out)
	}
	if got := m.StreamHeight(); got != m.Height-1-1-m.InputLines()-2-2-m.MenuRows() {
		t.Fatalf("候选应占布局行（stream 相应变矮），实际 stream=%d menu=%d", got, m.MenuRows())
	}
}

func TestMenuArrowMovesSelection(t *testing.T) {
	m := typeString(testModel(), "/model")
	before := m.Menu.sel
	m, _ = m.Update(tea.KeyMsg{Type: tea.KeyDown})
	if m.Menu.sel != before+1 {
		t.Fatalf("↓ 应下移选中项，实际 %d → %d", before, m.Menu.sel)
	}
	m, _ = m.Update(tea.KeyMsg{Type: tea.KeyUp})
	if m.Menu.sel != before {
		t.Fatalf("↑ 应回到原位，实际 %d", m.Menu.sel)
	}
}

func TestEnterCompletesPartialCommand(t *testing.T) {
	m := typeString(testModel(), "/mod")
	m, cmd := m.Update(tea.KeyMsg{Type: tea.KeyEnter})
	if cmd != nil {
		t.Fatal("候选在场且未完全匹配时，Enter 只补全、不执行")
	}
	if got := m.Input.Value(); got != "/model list " {
		t.Fatalf("应补全为选中项（带尾随空格），实际 %q", got)
	}
	if m.MenuRows() != 0 {
		t.Fatal("补全后候选应收起")
	}
	if len(m.Store.List()) != 0 {
		t.Fatal("补全阶段不该产生命令块")
	}
}

func TestEnterExecutesExactCommand(t *testing.T) {
	m := typeString(testModel(), "/status")
	m, cmd := m.Update(tea.KeyMsg{Type: tea.KeyEnter})
	if cmd == nil {
		t.Fatal("完全匹配的命令应直接执行")
	}
	if got := m.Input.Value(); got != "" {
		t.Fatalf("执行后输入框应清空，实际 %q", got)
	}
	if blocks := m.Store.List(); len(blocks) != 1 || blocks[0].Title != "$ zhishi status" {
		t.Fatalf("应生成命令块，实际 %+v", blocks)
	}
}

func TestTabAcceptsMenu(t *testing.T) {
	m := typeString(testModel(), "/ver")
	m, _ = m.Update(tea.KeyMsg{Type: tea.KeyTab})
	if got := m.Input.Value(); got != "/version " {
		t.Fatalf("Tab 应接受选中项，实际 %q", got)
	}
	if m.MenuRows() != 0 {
		t.Fatal("接受后候选应收起")
	}
}

func TestEscClosesMenuFirst(t *testing.T) {
	m := typeString(testModel(), "/mod")
	m, _ = m.Update(tea.KeyMsg{Type: tea.KeyEsc})
	if m.Menu != nil {
		t.Fatal("Esc 应先收候选")
	}
	if got := m.Input.Value(); got != "/mod" {
		t.Fatalf("收候选不该动输入框，实际 %q", got)
	}
	if _, ok := m.TopOverlay(); ok {
		t.Fatal("没有覆盖层时不该压栈/弹栈")
	}
}
