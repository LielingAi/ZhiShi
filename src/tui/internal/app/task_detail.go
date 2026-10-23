package app

// 任务详情（Alt+t → Enter）：列表行只有名字/状态，详情回答"这个任务到底要
// 干什么、跑过没有、谁改的状态、文档在哪"。
//
// task/get 只下发文档**路径**（内容在盘上），所以详情里列路径，正文用
// `/task get <id>` 或直接开文件看——不在 TUI 里读工作区文件，边界清楚。

import (
	"context"
	"fmt"
	"strings"
	"time"

	tea "github.com/charmbracelet/bubbletea"

	"github.com/lielingai/zhishi/tui/internal/client"
)

type taskDetailMsg struct {
	detail client.TaskDetail
	err    error
}

func taskDetailCmd(ctx context.Context, admin adminAPI, id string) tea.Cmd {
	return func() tea.Msg {
		if admin == nil {
			return taskDetailMsg{err: fmt.Errorf("没有可用的管理面客户端")}
		}
		reqCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
		defer cancel()
		detail, err := admin.TaskGet(reqCtx, id)
		return taskDetailMsg{detail: detail, err: err}
	}
}

// taskDetailBody 把 TaskDetail 拼成可滚动文本。
func taskDetailBody(d client.TaskDetail) string {
	var b strings.Builder
	fmt.Fprintf(&b, "状态：%s    执行者：%s    模式：%s\n", emptyDash(d.Status), emptyDash(d.Executor), emptyDash(d.ExecutionMode))
	if d.Name != "" {
		fmt.Fprintf(&b, "名称：%s\n", d.Name)
	}
	if d.Description != "" {
		fmt.Fprintf(&b, "\n%s\n", strings.TrimSpace(d.Description))
	}
	if d.WorkspacePath != "" {
		fmt.Fprintf(&b, "\n工作区：%s\n", d.WorkspacePath)
	}
	if d.Model != "" || d.ProviderID != "" {
		fmt.Fprintf(&b, "模型：%s%s\n", d.ProviderID, dotJoin(d.ProviderID, d.Model))
	}
	if d.CronExpression != "" {
		fmt.Fprintf(&b, "Cron：%s\n", d.CronExpression)
	}
	if len(d.Tags) > 0 {
		fmt.Fprintf(&b, "标签：%s\n", strings.Join(d.Tags, "  "))
	}
	if len(d.SessionIDs) > 0 {
		fmt.Fprintf(&b, "会话线：%s\n", strings.Join(d.SessionIDs, "  "))
	}
	fmt.Fprintf(&b, "\n创建：%s\n更新：%s\n", tsText(d.CreatedAt), tsText(d.UpdatedAt))
	if d.LastExecutedAt > 0 {
		fmt.Fprintf(&b, "上次执行：%s\n", tsText(d.LastExecutedAt))
	}
	if len(d.StatusHistory) > 0 {
		b.WriteString("\n状态历史（最近 8 条）：\n")
		h := d.StatusHistory
		start := 0
		if len(h) > 8 {
			start = len(h) - 8
		}
		for _, t := range h[start:] {
			line := fmt.Sprintf("  %s → %s", tsText(t.At), emptyDash(t.To))
			if t.Actor != "" || t.Source != "" {
				line += fmt.Sprintf("  %s/%s", emptyDash(t.Actor), emptyDash(t.Source))
			}
			if t.Message != "" {
				line += "  " + t.Message
			}
			b.WriteString(line + "\n")
		}
	}
	if d.Docs.TaskMD != "" {
		b.WriteString("\n文档：\n  " + d.Docs.TaskMD + "\n")
		if d.Docs.VerifyMD != "" {
			b.WriteString("  " + d.Docs.VerifyMD + "\n")
		}
		if d.Docs.ProgressMD != "" {
			b.WriteString("  " + d.Docs.ProgressMD + "\n")
		}
		if d.Docs.AlignmentMD != "" {
			b.WriteString("  " + d.Docs.AlignmentMD + "\n")
		}
	}
	return strings.TrimRight(b.String(), "\n")
}

func emptyDash(s string) string {
	if strings.TrimSpace(s) == "" {
		return "—"
	}
	return s
}

// dotJoin 把 provider/model 拼起来（任一为空则不加分隔符）。
func dotJoin(provider, model string) string {
	if provider != "" && model != "" {
		return "/" + model
	}
	return model
}

func tsText(ms int64) string {
	if ms <= 0 {
		return "—"
	}
	return time.UnixMilli(ms).Format("2006-01-02 15:04")
}
