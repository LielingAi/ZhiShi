package app

import (
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"
)

// 单行输入（哪怕已经有字）↑↓ 都应滚动 stream —— 以前这里落到 textarea，
// 单行没有可移动的行，等于死键。
func TestArrowsScrollWithSingleLineInput(t *testing.T) {
	m := testModel()
	for i := 0; i < 40; i++ {
		m = feed(m, toolEventFor(i))
	}
	m.View() // 建帧
	for _, r := range "打点字" {
		m, _ = m.Update(runes(string(r)))
	}
	before := m.ScrollLines
	m, _ = m.Update(tea.KeyMsg{Type: tea.KeyUp})
	if m.ScrollLines != before+1 {
		t.Fatalf("↑ 应滚一行（%d → %d）", before, m.ScrollLines)
	}
	if !strings.Contains(m.Input.Value(), "打点字") {
		t.Fatal("滚动不该动输入内容")
	}
	m, _ = m.Update(tea.KeyMsg{Type: tea.KeyDown})
	if m.ScrollLines != before {
		t.Fatalf("↓ 应滚回一行（%d）", m.ScrollLines)
	}
}

// 多行输入时 ↑↓ 归输入框（移动光标），不再抢去滚动。
func TestArrowsGoToTextareaWhenMultiline(t *testing.T) {
	m := testModel()
	for i := 0; i < 40; i++ {
		m = feed(m, toolEventFor(i))
	}
	m.View()
	for _, r := range "第一行" {
		m, _ = m.Update(runes(string(r)))
	}
	m, _ = m.Update(tea.KeyMsg{Type: tea.KeyEnter, Alt: true})
	for _, r := range "第二行" {
		m, _ = m.Update(runes(string(r)))
	}
	before := m.ScrollLines
	m, _ = m.Update(tea.KeyMsg{Type: tea.KeyUp})
	if m.ScrollLines != before {
		t.Fatalf("多行输入时 ↑ 不该滚动，实际 %d → %d", before, m.ScrollLines)
	}
}
