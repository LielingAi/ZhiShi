package app

import (
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"

	"github.com/lielingai/zhishi/tui/internal/protocol"
)

func TestQueueEventsCarryPreview(t *testing.T) {
	m := feed(testModel(),
		protocol.Event{Kind: protocol.KindSteeringAdded, QueueID: "q1", Text: "换个思路扫 8080"},
		protocol.Event{Kind: protocol.KindQueueAdded, QueueID: "q2", Text: "继续", Status: "fifo"},
	)
	if m.QueuedCount() != 2 {
		t.Fatalf("应有 2 条队列项，实际 %d", m.QueuedCount())
	}
	if m.Queued[0].Preview != "换个思路扫 8080" || m.Queued[0].Kind != "steering" {
		t.Fatalf("纠偏项预览不对：%+v", m.Queued[0])
	}
	if m.Queued[1].Kind != "fifo" {
		t.Fatalf("FIFO 项 kind 不对：%+v", m.Queued[1])
	}
	// 重放幂等：同 id 再来一次不重复入列
	m = feed(m, protocol.Event{Kind: protocol.KindSteeringAdded, QueueID: "q1", Text: "换个思路扫 8080"})
	if m.QueuedCount() != 2 {
		t.Fatalf("重放不该重复计数，实际 %d", m.QueuedCount())
	}
}

func TestQueueOverlayCancel(t *testing.T) {
	m := testModel()
	m.Admin = &fakeAdmin{}
	m = feed(m, protocol.Event{Kind: protocol.KindSteeringAdded, QueueID: "q1", Text: "换思路"})
	m, _ = m.Update(alt('q'))
	ov, ok := lastOverlayOf[*queueOverlay](&m)
	if !ok {
		t.Fatal("Alt+q 应打开队列面板")
	}
	out := m.View()
	if !strings.Contains(out, "换思路") || !strings.Contains(out, "steering") {
		t.Fatalf("面板应显示预览与类型：\n%s", out)
	}
	m, cmd := m.Update(tea.KeyMsg{Type: tea.KeyEnter})
	if cmd == nil {
		t.Fatal("Enter 应撤销选中项")
	}
	if msg := cmd().(queueCancelDoneMsg); msg.id != "q1" {
		t.Fatalf("撤销 id 不对：%+v", msg)
	}
	// 回执到达后从队列与面板中移除
	m, _ = m.Update(queueCancelDoneMsg{id: "q1"})
	if m.QueuedCount() != 0 {
		t.Fatalf("撤销后队列应为空，实际 %d", m.QueuedCount())
	}
	_ = ov
}

func TestQueueCancelledEventRemoves(t *testing.T) {
	m := feed(testModel(),
		protocol.Event{Kind: protocol.KindQueueAdded, QueueID: "q1", Text: "x"},
		protocol.Event{Kind: protocol.KindQueueCancelled, QueueID: "q1"},
	)
	if m.QueuedCount() != 0 {
		t.Fatalf("取消事件应移除，实际 %d", m.QueuedCount())
	}
}
