package app

// 会话（研究线）写操作：归档 / 重命名 / 删除。
//
// 面板原本只能"切线"。这三条是整理历史时的日常动作：
//
//   a  归档 / 取消归档（PATCH /sessions/:id {archived}）
//   n  重命名（PATCH {title}）
//   x  删除（DELETE /sessions/:id，**两次确认**；连 transcript 一起删）
//
// 删除不可逆，和任务/环境保持同一套"再按一次 x"纪律。

import (
	"context"
	"fmt"
	"strings"
	"time"

	tea "github.com/charmbracelet/bubbletea"
)

func (o *lineOverlay) handleWriteKeys(m *Model, msg tea.KeyMsg) tea.Cmd {
	r, ok := o.selected()
	if !ok || o.state != loadReady {
		return nil
	}
	switch msg.String() {
	case "a":
		archived := strings.Contains(r.Flag, "已归档")
		o.note = "更新中…"
		if archived {
			return sessionPatchCmd(m.Ctx, m.Admin, r.Key, map[string]any{"archived": false})
		}
		return sessionPatchCmd(m.Ctx, m.Admin, r.Key, map[string]any{"archived": true})

	case "n":
		id := r.Key
		m.PushOverlay(newPromptOverlay("重命名会话", "新标题",
			func(m *Model, title string) tea.Cmd {
				title = strings.TrimSpace(title)
				if title == "" {
					return noticeCmd("标题不能为空")
				}
				return sessionPatchCmd(m.Ctx, m.Admin, id, map[string]any{"title": title})
			}))
		return nil

	case "x":
		if o.pendingDelete == r.Key && time.Since(o.pendingDeleteAt) < 3*time.Second {
			o.pendingDelete = ""
			o.note = "删除中…"
			return sessionDeleteCmd(m.Ctx, m.Admin, r.Key)
		}
		o.pendingDelete = r.Key
		o.pendingDeleteAt = time.Now()
		o.note = "再按一次 x 确认删除（连 transcript，3 秒内有效）"
	}
	return nil
}

type sessionWriteDoneMsg struct {
	op  string
	id  string
	err error
}

func sessionPatchCmd(ctx context.Context, admin adminAPI, id string, patch map[string]any) tea.Cmd {
	op := "archive"
	if _, isTitle := patch["title"]; isTitle {
		op = "rename"
	}
	return func() tea.Msg {
		if admin == nil {
			return sessionWriteDoneMsg{op: op, id: id, err: fmt.Errorf("没有可用的管理面客户端")}
		}
		reqCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
		defer cancel()
		return sessionWriteDoneMsg{op: op, id: id, err: admin.SessionPatch(reqCtx, id, patch)}
	}
}

func sessionDeleteCmd(ctx context.Context, admin adminAPI, id string) tea.Cmd {
	return func() tea.Msg {
		if admin == nil {
			return sessionWriteDoneMsg{op: "delete", id: id, err: fmt.Errorf("没有可用的管理面客户端")}
		}
		reqCtx, cancel := context.WithTimeout(ctx, 20*time.Second)
		defer cancel()
		return sessionWriteDoneMsg{op: "delete", id: id, err: admin.SessionDelete(reqCtx, id)}
	}
}
