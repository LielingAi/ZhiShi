package app

// 队列（纠偏 / FIFO）——从"状态行一个数字"升级成可查看、可撤销的列表。
//
// 服务端语义（1.9.6 起）：
//   - busy 时发消息进 **steering** 队列（chat:steering-added，模型在 turn 间接住）
//   - 历史 FIFO 入口仍在（queue:added/cancelled），给自动续跑等场景用
//   - 撤销统一走 POST /chat/queue/cancel {queueId}，两种队列都支持
//
// 队列项带 messageText 预览：不给预览的话，"撤销哪条"只能靠 id 猜。

import (
	"context"
	"fmt"
	"strings"
	"time"

	tea "github.com/charmbracelet/bubbletea"
)

// QueueItem 是一条待处理消息。
type QueueItem struct {
	ID      string
	Preview string
	Kind    string // steering / fifo
}

func (m *Model) queueAdd(id, preview, kind string) {
	if id == "" {
		return
	}
	for i := range m.Queued {
		if m.Queued[i].ID == id {
			// 重放幂等：只补空字段，不重复入列。
			if m.Queued[i].Preview == "" {
				m.Queued[i].Preview = preview
			}
			return
		}
	}
	m.Queued = append(m.Queued, QueueItem{ID: id, Preview: preview, Kind: kind})
}

func (m *Model) queueRemove(id string) {
	out := m.Queued[:0]
	for _, it := range m.Queued {
		if it.ID != id {
			out = append(out, it)
		}
	}
	m.Queued = out
}

// ── 覆盖层（Alt+q）──────────────────────────────────────────────────────

type queueOverlay struct {
	sel  int
	note string
}

func newQueueOverlay() *queueOverlay { return &queueOverlay{} }

func (o *queueOverlay) Title() string { return "队列" }

func (o *queueOverlay) Handle(m *Model, msg tea.KeyMsg) tea.Cmd {
	n := len(m.Queued)
	switch msg.String() {
	case "up", "ctrl+p":
		o.sel--
	case "down", "ctrl+n":
		o.sel++
	case "enter", "x":
		if n == 0 {
			return nil
		}
		it := m.Queued[o.sel]
		o.note = "撤销中…"
		return queueCancelCmd(m.Ctx, m.sessionClient(), it.ID)
	}
	if o.sel < 0 {
		o.sel = 0
	}
	if o.sel >= n {
		o.sel = n - 1
	}
	if o.sel < 0 {
		o.sel = 0
	}
	return nil
}

func (o *queueOverlay) Render(m Model, width, height int) string {
	lines := []string{headerStyle.Render("队列")}
	if o.note != "" {
		lines = append(lines, noticeStyle.Render("· "+o.note))
	}
	if len(m.Queued) == 0 {
		lines = append(lines, dimStyle.Render("  队列是空的（运行中直接打字 = 纠偏，会进这里）"))
	} else {
		maxRows := listOverlayRows(height) - 2
		start := 0
		if o.sel >= maxRows {
			start = o.sel - maxRows + 1
		}
		for i := start; i < len(m.Queued) && i < start+maxRows; i++ {
			it := m.Queued[i]
			mark := "  "
			style := valueStyle
			if i == o.sel {
				mark = "▸ "
				style = selStyle
			}
			kind := it.Kind
			if kind == "" {
				kind = "queued"
			}
			lines = append(lines, mark+style.Render(truncateWidth(it.Preview, width-16))+
				"  "+dimStyle.Render(kind))
		}
	}
	lines = append(lines, "", footerHint("↑↓ 选择  Enter/x 撤销  Esc 关闭", ""))
	return strings.Join(lines, "\n")
}

func (o *queueOverlay) Summary() Summary {
	return Summary{Kind: "queue", Title: "队列", State: "ready", Count: 0}
}

// ── 撤销 ────────────────────────────────────────────────────────────────

type queueCancelDoneMsg struct {
	id  string
	err error
}

func queueCancelCmd(ctx context.Context, client sessionOps, id string) tea.Cmd {
	return func() tea.Msg {
		if client == nil {
			return queueCancelDoneMsg{id: id, err: fmt.Errorf("没有可用的 sidecar 连接")}
		}
		reqCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
		defer cancel()
		return queueCancelDoneMsg{id: id, err: client.CancelQueueItem(reqCtx, id)}
	}
}

// 队列预览为空时的兜底文案。
func queuePreview(text string) string {
	t := strings.TrimSpace(strings.ReplaceAll(text, "\n", " "))
	if t == "" {
		return "（无预览）"
	}
	return t
}
