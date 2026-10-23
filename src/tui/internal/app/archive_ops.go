package app

// 档案写操作（2.1 P2）：纠正 / 证实·解决 / 搁置。
//
// 研究闭环里这三个动作是"人给结论定性"的唯一入口，GUI 有行内按钮，TUI 之前
// 整块面板只读。现在给档案树加了光标：
//
//   v  证实 / 解决（archive/resolve；H# → confirmed，Q# → resolved）
//   c  纠正（archive/correct，必须写 reason——纠正台账要能追溯）
//   a  搁置（archive/abandon，同样必须写 reason："不追了"也要留痕）
//
// 服务端对"哪些类型能 v/a"有纪律（只作用于 H#/Q#），所以按键不做本地判断：
// 发出去，让服务端回可读错误——前端猜类型规则迟早会和服务端漂。
//
// 未做：`archive/op`（举证/挂链需要 refs/anchor 多字段），它本质是 agent 的
// 写入通道，人侧用上面三个动作就够。

import (
	"context"
	"fmt"
	"strings"
	"time"

	tea "github.com/charmbracelet/bubbletea"

	"github.com/lielingai/zhishi/tui/internal/client"
)

func (o *archiveOverlay) handleOps(m *Model, msg tea.KeyMsg) tea.Cmd {
	sel, ok := o.selectedEntity()
	if !ok {
		return nil
	}
	switch msg.String() {
	case "v":
		o.note = "提交中…"
		return archiveOpCmd(m.Ctx, m.Admin, m.SessionID, "resolve", sel.Key, "")
	case "c":
		id := sel.Key
		m.PushOverlay(newPromptOverlay("纠正档案条目", "错在哪、为什么（必填）",
			func(m *Model, reason string) tea.Cmd {
				if strings.TrimSpace(reason) == "" {
					return noticeCmd("纠正必须写原因")
				}
				return archiveOpCmd(m.Ctx, m.Admin, m.SessionID, "correct", id, reason)
			}))
		return nil
	case "a":
		id := sel.Key
		m.PushOverlay(newPromptOverlay("搁置档案条目", "为什么不追了（必填）",
			func(m *Model, reason string) tea.Cmd {
				if strings.TrimSpace(reason) == "" {
					return noticeCmd("搁置必须留原因")
				}
				return archiveOpCmd(m.Ctx, m.Admin, m.SessionID, "abandon", id, reason)
			}))
		return nil
	}
	return nil
}

// selectedEntity 返回扁平化后当前选中的实体行。
func (o *archiveOverlay) selectedEntity() (row, bool) {
	flat := o.flatRows()
	if o.sel < 0 || o.sel >= len(flat) {
		return row{}, false
	}
	return flat[o.sel], true
}

// flatRows 按分组顺序拼成一条候选列表（光标在它上面移动）。
func (o *archiveOverlay) flatRows() []row {
	var out []row
	for _, g := range o.groups {
		out = append(out, g.rows...)
	}
	return out
}

// ── 命令 ────────────────────────────────────────────────────────────────

type archiveOpDoneMsg struct {
	op  string
	id  string
	err error
}

func archiveOpCmd(ctx context.Context, admin adminAPI, sessionID, op, id, text string) tea.Cmd {
	return func() tea.Msg {
		if admin == nil {
			return archiveOpDoneMsg{op: op, id: id, err: fmt.Errorf("没有可用的管理面客户端")}
		}
		reqCtx, cancel := context.WithTimeout(ctx, 20*time.Second)
		defer cancel()
		var err error
		switch op {
		case "resolve":
			err = admin.ArchiveResolve(reqCtx, sessionID, id, text)
		case "correct":
			err = admin.ArchiveCorrect(reqCtx, sessionID, id, text)
		case "abandon":
			err = admin.ArchiveAbandon(reqCtx, sessionID, id, text)
		default:
			err = fmt.Errorf("未知档案操作 %q", op)
		}
		return archiveOpDoneMsg{op: op, id: id, err: err}
	}
}

// detail 打开选中实体的只读详情：面板行只有一行摘要，全文/链接/反证都在这里。
func (o *archiveOverlay) detail(m *Model) tea.Cmd {
	sel, ok := o.selectedEntity()
	if !ok {
		return nil
	}
	var ent *client.ArchiveEntity
	for i := range o.ents {
		if o.ents[i].ID == sel.Key {
			ent = &o.ents[i]
			break
		}
	}
	if ent == nil {
		return nil
	}
	detail := newDetailOverlay(ent.ID+" · "+kindLabel(ent.Kind), archiveEntityDetail(*ent))
	detail.hint = "v 证实/解决  c 纠正  a 搁置  Esc 关闭"
	id := ent.ID
	detail.onKey = func(m *Model, msg tea.KeyMsg) (tea.Cmd, bool) {
		switch msg.String() {
		case "v":
			m.PopOverlay()
			return archiveOpCmd(m.Ctx, m.Admin, m.SessionID, "resolve", id, ""), true
		case "c":
			m.PopOverlay()
			m.PushOverlay(newPromptOverlay("纠正档案条目", "错在哪、为什么（必填）",
				func(m *Model, reason string) tea.Cmd {
					if strings.TrimSpace(reason) == "" {
						return noticeCmd("纠正必须写原因")
					}
					return archiveOpCmd(m.Ctx, m.Admin, m.SessionID, "correct", id, reason)
				}))
			return nil, true
		case "a":
			m.PopOverlay()
			m.PushOverlay(newPromptOverlay("搁置档案条目", "为什么不追了（必填）",
				func(m *Model, reason string) tea.Cmd {
					if strings.TrimSpace(reason) == "" {
						return noticeCmd("搁置必须留原因")
					}
					return archiveOpCmd(m.Ctx, m.Admin, m.SessionID, "abandon", id, reason)
				}))
			return nil, true
		}
		return nil, false
	}
	m.PushOverlay(detail)
	return nil
}

func archiveEntityDetail(e client.ArchiveEntity) string {
	var b strings.Builder
	fmt.Fprintf(&b, "状态：%s", statusText(e.Status))
	if e.NeedsReview {
		b.WriteString("    待复核：是")
	}
	b.WriteString("\n\n")
	b.WriteString(strings.TrimSpace(e.Text))
	if b.Len() == 0 || strings.TrimSpace(e.Text) == "" {
		b.WriteString("（无正文）")
	}
	if len(e.Links) > 0 {
		b.WriteString("\n\n链接：" + strings.Join(e.Links, "  "))
	}
	if len(e.Against) > 0 {
		b.WriteString("\n反证：" + strings.Join(e.Against, "  "))
	}
	b.WriteString("\n\nEsc 关闭    v 证实/解决    c 纠正    a 搁置")
	return b.String()
}

// statusText 把服务端状态枚举转成中文（未知值原样显示，不吞信息）。
func statusText(s string) string {
	switch s {
	case "":
		return "—"
	case "proposed":
		return "待验证"
	case "confirmed":
		return "已证实"
	case "refuted":
		return "已推翻"
	case "resolved":
		return "已解决"
	case "abandoned":
		return "已搁置"
	case "active":
		return "进行中"
	case "needs-review", "needsReview":
		return "待复核"
	default:
		return s
	}
}
