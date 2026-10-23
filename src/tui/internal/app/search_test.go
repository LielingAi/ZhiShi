package app

import (
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"

	"github.com/lielingai/zhishi/tui/internal/client"
	"github.com/lielingai/zhishi/tui/internal/protocol"
	"github.com/lielingai/zhishi/tui/internal/store"
)

// 本地搜索：边打边搜，回车跳到命中块并滚到可见。
func TestSearchLocalJump(t *testing.T) {
	m := testModel()
	m.Store.Upsert(store.Block{ID: "msg:1", Kind: store.KindUser, Version: 1, Body: "扫一下 8080"})
	m.Store.Upsert(store.Block{ID: "msg:2", Kind: store.KindAssistant, Version: 1, Body: "22 端口超时"})
	m, _ = m.Update(tea.KeyMsg{Type: tea.KeyCtrlF})
	for _, r := range "8080" {
		m, _ = m.Update(runes(string(r)))
	}
	ov, ok := lastOverlayOf[*searchOverlay](&m)
	if !ok || len(ov.hits) != 1 {
		t.Fatalf("应有 1 条本地命中，实际 %+v", ov)
	}
	m, _ = m.Update(tea.KeyMsg{Type: tea.KeyEnter})
	if _, open := m.TopOverlay(); open {
		t.Fatal("回车后应关闭搜索面板")
	}
	b, _ := m.CursorBlock()
	if b.ID != "msg:1" {
		t.Fatalf("应跳到命中的块，实际 %s", b.ID)
	}
}

// Tab 切到远程范围后，回车才发检索（不是每敲一个字都发）。
func TestSearchRemoteScopes(t *testing.T) {
	m := testModel()
	fa := &fakeAdmin{memoryHits: []client.MemoryHit{{ID: "m1", Kind: "lesson", Content: "SSH 超时先看 MTU", Source: "task-1"}}}
	m.Admin = fa
	m, _ = m.Update(tea.KeyMsg{Type: tea.KeyCtrlF})
	m, _ = m.Update(tea.KeyMsg{Type: tea.KeyTab}) // → 记忆
	for _, r := range "mtu" {
		m, _ = m.Update(runes(string(r)))
	}
	if len(fa.searchQueries) != 0 {
		t.Fatalf("打字阶段不该发远程检索：%v", fa.searchQueries)
	}
	m, cmd := m.Update(tea.KeyMsg{Type: tea.KeyEnter})
	if cmd == nil {
		t.Fatal("回车应发检索命令")
	}
	m, _ = m.Update(cmd())
	if len(fa.searchQueries) != 1 || fa.searchQueries[0] != "memory:mtu" {
		t.Fatalf("检索参数不对：%v", fa.searchQueries)
	}
	ov, _ := lastOverlayOf[*searchOverlay](&m)
	if len(ov.hits) != 1 || !strings.Contains(ov.hits[0].body, "MTU") {
		t.Fatalf("应拿到记忆命中：%+v", ov.hits)
	}
	// 回车展开正文
	m, _ = m.Update(tea.KeyMsg{Type: tea.KeyEnter})
	if !strings.Contains(m.View(), "SSH 超时先看 MTU") {
		t.Fatalf("应展开命中正文：\n%s", m.View())
	}
}

// 情报检索回的是渲染文本：一条结果，回车展开全文。
func TestSearchIntelRendersText(t *testing.T) {
	m := testModel()
	m.Admin = &fakeAdmin{intelText: "CVE-2024-1 …", intelCount: 3}
	m, _ = m.Update(tea.KeyMsg{Type: tea.KeyCtrlF})
	for i := 0; i < 3; i++ {
		m, _ = m.Update(tea.KeyMsg{Type: tea.KeyTab}) // → 情报
	}
	for _, r := range "cve" {
		m, _ = m.Update(runes(string(r)))
	}
	m, cmd := m.Update(tea.KeyMsg{Type: tea.KeyEnter})
	m, _ = m.Update(cmd())
	ov, _ := lastOverlayOf[*searchOverlay](&m)
	if len(ov.hits) != 1 || !strings.Contains(ov.hits[0].title, "3") {
		t.Fatalf("应显示命中数：%+v", ov.hits)
	}
}

var _ = protocol.KindDecision
