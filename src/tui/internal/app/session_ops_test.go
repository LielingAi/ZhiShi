package app

import (
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"
)

func lineOverlayWith(m Model, rows ...row) Model {
	ov := newLineOverlay()
	ov.setRows(rows)
	m.PushOverlay(ov)
	return m
}

func TestLineOverlayArchiveToggle(t *testing.T) {
	m := lineOverlayWith(testModel(), row{Key: "s1", Title: "扫描线"})
	m.Admin = &fakeAdmin{}
	m, cmd := m.Update(runes("a"))
	if cmd == nil {
		t.Fatal("a 应发归档 PATCH")
	}
	if msg := cmd().(sessionWriteDoneMsg); msg.op != "archive" || msg.id != "s1" {
		t.Fatalf("归档消息不对：%+v", msg)
	}
	// 已归档的行再按 a = 取消归档
	m = lineOverlayWith(testModel(), row{Key: "s2", Title: "旧线", Flag: "已归档"})
	m.Admin = &fakeAdmin{}
	m, cmd = m.Update(runes("a"))
	if cmd == nil {
		t.Fatal("已归档行应发取消归档")
	}
}

func TestLineOverlayRenameAndDelete(t *testing.T) {
	m := lineOverlayWith(testModel(), row{Key: "s1", Title: "扫描线"})
	m.Admin = &fakeAdmin{}

	m, _ = m.Update(runes("n"))
	if ov, ok := m.TopOverlay(); !ok {
		t.Fatal("n 应弹输入框")
	} else if _, isPrompt := ov.(*promptOverlay); !isPrompt {
		t.Fatalf("栈顶应是输入框，实际 %T", ov)
	}
	for _, r := range "新标题" {
		m, _ = m.Update(runes(string(r)))
	}
	m, cmd := m.Update(tea.KeyMsg{Type: tea.KeyEnter})
	if cmd == nil {
		t.Fatal("应发重命名")
	}
	if msg := cmd().(sessionWriteDoneMsg); msg.op != "rename" {
		t.Fatalf("应为 rename，实际 %s", msg.op)
	}

	// 删除要两次确认
	m = lineOverlayWith(testModel(), row{Key: "s1", Title: "扫描线"})
	m.Admin = &fakeAdmin{}
	m, cmd = m.Update(runes("x"))
	if cmd != nil {
		t.Fatal("第一次 x 不该删除")
	}
	ov, _ := lastOverlayOf[*lineOverlay](&m)
	if !strings.Contains(ov.note, "再按一次") {
		t.Fatalf("应提示二次确认，实际 %q", ov.note)
	}
	m, cmd = m.Update(runes("x"))
	if cmd == nil {
		t.Fatal("第二次 x 应删除")
	}
	if msg := cmd().(sessionWriteDoneMsg); msg.op != "delete" {
		t.Fatalf("应为 delete，实际 %s", msg.op)
	}
}
