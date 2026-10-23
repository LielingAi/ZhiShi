package app

import (
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"

	"github.com/lielingai/zhishi/tui/internal/protocol"
	"github.com/lielingai/zhishi/tui/internal/store"
)

// 发消息立刻出现 "you" 块：流里只有助手输出，不回显等于自己说的话消失了。
func TestSendEchoesUserBlock(t *testing.T) {
	m := testModel()
	for _, r := range "扫一下端口" {
		m, _ = m.Update(runes(string(r)))
	}
	m, _ = m.Update(tea.KeyMsg{Type: tea.KeyEnter})

	blocks := m.Store.List()
	if len(blocks) != 1 {
		t.Fatalf("应有 1 条本地回显，实际 %d", len(blocks))
	}
	if blocks[0].Kind != store.KindUser || blocks[0].Body != "扫一下端口" {
		t.Fatalf("回显块形状不对：%+v", blocks[0])
	}
	if len(m.PendingUserEcho) != 1 {
		t.Fatal("应记入待确认表（回放到达时用来去重）")
	}
}

func TestSlashCommandDoesNotEchoUserBlock(t *testing.T) {
	m := testModel()
	for _, r := range "/status" {
		m, _ = m.Update(runes(string(r)))
	}
	m, _ = m.Update(tea.KeyMsg{Type: tea.KeyEnter})
	for _, b := range m.Store.List() {
		if b.Kind == store.KindUser {
			t.Fatalf("命令不该回显成用户消息：%+v", b)
		}
	}
}

func TestReplayReplacesLocalEcho(t *testing.T) {
	m := testModel()
	for _, r := range "hi" {
		m, _ = m.Update(runes(string(r)))
	}
	m, _ = m.Update(tea.KeyMsg{Type: tea.KeyEnter})
	if got := len(m.Store.List()); got != 1 {
		t.Fatalf("前置条件失败：%d", got)
	}

	// 权威回放送到同一条：本地那条应被删掉，只留 msg:<id>。
	m.applySnapshot(&protocol.Snapshot{ID: "1", Role: "user", Content: "hi"})
	blocks := m.Store.List()
	if len(blocks) != 1 {
		t.Fatalf("应只留一条（回放替换本地），实际 %d", len(blocks))
	}
	if !strings.HasPrefix(blocks[0].ID, "msg:") {
		t.Fatalf("留下的应是权威块，实际 %+v", blocks[0])
	}
	if len(m.PendingUserEcho) != 0 {
		t.Fatal("去重表应清空")
	}
}
