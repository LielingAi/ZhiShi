package app

import (
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"
)

func TestCtrlJInsertsNewline(t *testing.T) {
	m := testModel()
	for _, r := range "第一行" {
		m, _ = m.Update(runes(string(r)))
	}
	m, _ = m.Update(tea.KeyMsg{Type: tea.KeyCtrlJ})
	for _, r := range "第二行" {
		m, _ = m.Update(runes(string(r)))
	}
	got := m.Input.Value()
	if !strings.Contains(got, "\n") || !strings.Contains(got, "第二行") {
		t.Fatalf("Ctrl+J 应插入换行，实际 %q", got)
	}
	if m.InputLines() < 2 {
		t.Fatalf("输入框应变成 2 行，实际 %d", m.InputLines())
	}
}

// Windows 控制台里 Ctrl+J 与 Enter 同码，Alt+Enter 是唯一可靠的换行键。
func TestAltEnterInsertsNewline(t *testing.T) {
	m := testModel()
	for _, r := range "第一行" {
		m, _ = m.Update(runes(string(r)))
	}
	m, cmd := m.Update(tea.KeyMsg{Type: tea.KeyEnter, Alt: true})
	if cmd != nil {
		t.Fatal("Alt+Enter 是换行，不该发送")
	}
	for _, r := range "第二行" {
		m, _ = m.Update(runes(string(r)))
	}
	if got := m.Input.Value(); !strings.Contains(got, "\n") {
		t.Fatalf("应插入换行，实际 %q", got)
	}
	if len(m.Store.List()) != 0 {
		t.Fatal("换行不该产生消息块")
	}
}
