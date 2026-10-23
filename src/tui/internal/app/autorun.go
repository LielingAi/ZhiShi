package app

// auto-run（自动循环攻击链）观察面。
//
// GUI 有一整个观察卡（阶段 / 轮次 / 预算进度条 / 最近结论 / 终止），TUI 之前
// 四个 `auto-run:*` 事件一个都不认识——跑起来完全无感。这里做最小闭环：
//
//   - 事件维护本地状态（不轮询，SSE 已经把所有推进都广播了）
//   - 状态行显示 `⛁ 阶段 · 轮次 N`，回答"它还在跑吗、跑到哪了"
//   - Alt+w 打开面板：目标/环境/预算进度 + `x` 终止 + `r` 从服务端刷新
//
// 启动（goal/budget/criteria 表单）不在这一版：多字段输入在 TUI 里体验很差，
// 先用 CLI/`/` 命令启动，TUI 负责观察与终止。

import (
	"context"
	"fmt"
	"strings"
	"time"

	tea "github.com/charmbracelet/bubbletea"

	"github.com/lielingai/zhishi/tui/internal/client"
	"github.com/lielingai/zhishi/tui/internal/protocol"
	"github.com/lielingai/zhishi/tui/internal/store"
)

// applyAutoRunEvent 折四个 auto-run 事件。
func (m *Model) applyAutoRunEvent(ev protocol.Event) {
	if ev.AutoRunID == "" {
		return
	}
	switch ev.Kind {
	case protocol.KindAutoRunStarted:
		m.AutoRun = &client.AutoRunInfo{
			ID: ev.AutoRunID, Name: ev.Name, EnvKey: ev.EnvKey,
			Goal: ev.Goal, Status: "running",
		}
		m.AutoRun.Budget.Kind = ev.BudgetKind
		m.AutoRun.Budget.Limit = float64(ev.BudgetLimit)
		m.addNotice(store.KindNotice, "auto-run", "自动循环已启动："+displayName(ev.Name, ev.AutoRunID))

	case protocol.KindAutoRunPhase:
		if m.AutoRun == nil || m.AutoRun.ID != ev.AutoRunID {
			m.AutoRun = &client.AutoRunInfo{ID: ev.AutoRunID, Status: "running"}
		}
		m.AutoRun.Phase = ev.Phase
		m.LastNotice = fmt.Sprintf("auto-run 阶段：%s（%s）", ev.Phase, ev.PrevPhase)

	case protocol.KindAutoRunTurn:
		if m.AutoRun == nil || m.AutoRun.ID != ev.AutoRunID {
			m.AutoRun = &client.AutoRunInfo{ID: ev.AutoRunID, Status: "running"}
		}
		m.AutoRun.Turns = ev.Turn
		m.AutoRun.Phase = ev.Phase
		if ev.Status != "" {
			m.AutoRun.Status = ev.Status
		}
		m.AutoRun.Budget.Kind = ev.BudgetKind
		m.AutoRun.Budget.Limit = float64(ev.BudgetLimit)
		m.AutoRun.Budget.Spent = float64(ev.BudgetSpent)

	case protocol.KindAutoRunCompleted:
		name := "auto-run"
		if m.AutoRun != nil && m.AutoRun.ID == ev.AutoRunID {
			name = displayName(m.AutoRun.Name, m.AutoRun.ID)
			m.AutoRun.Status = ev.Outcome
			if ev.Reason != "" {
				m.AutoRun.PauseReason = ev.Reason
			}
		}
		m.LastNotice = strings.TrimSpace(fmt.Sprintf("%s 结束：%s %s", name, ev.Outcome, ev.Reason))
		m.addNotice(store.KindNotice, "auto-run", m.LastNotice)
	}
}

func displayName(name, id string) string {
	if strings.TrimSpace(name) != "" {
		return name
	}
	return id
}

// AutoRunActive 表示有 run 在跑（状态行只在这种情况下显示）。
func (m Model) AutoRunActive() bool {
	return m.AutoRun != nil && m.AutoRun.Status == "running"
}

// ── 覆盖层（Alt+w）─────────────────────────────────────────────────────

type autoRunOverlay struct {
	note string
	// records 是"没有活动 run 时"的历史记录（r 刷新拉取）。
	records []client.AutoRunInfo
	err     string
}

func newAutoRunOverlay() *autoRunOverlay { return &autoRunOverlay{} }

func (o *autoRunOverlay) Title() string { return "自动循环" }

func (o *autoRunOverlay) Handle(m *Model, msg tea.KeyMsg) tea.Cmd {
	switch msg.String() {
	case "n":
		m.PushOverlay(newAutoRunForm(m))
		return nil
	case "r":
		return loadAutoRunCmd(m.Ctx, m.Admin, m.AutoRun)
	case "x":
		if m.AutoRun == nil || m.AutoRun.ID == "" {
			return nil
		}
		if !m.AutoRunActive() {
			o.note = "这条已经结束了"
			return nil
		}
		o.note = "终止中…"
		return autoRunStopCmd(m.Ctx, m.Admin, m.AutoRun.ID)
	}
	return nil
}

func (o *autoRunOverlay) Render(m Model, width, height int) string {
	lines := []string{headerStyle.Render("自动循环")}
	if o.err != "" {
		lines = append(lines, errStyle.Render("! "+truncateWidth(o.err, width-2)))
	}
	if o.note != "" {
		lines = append(lines, noticeStyle.Render("· "+o.note))
	}
	if r := m.AutoRun; r != nil {
		lines = append(lines,
			dimStyle.Render("名称  ")+valueStyle.Render(truncateWidth(displayName(r.Name, r.ID), width-8)),
			dimStyle.Render("环境  ")+valueStyle.Render(truncateWidth(r.EnvKey, width-8)),
			dimStyle.Render("目标  ")+truncateWidth(r.Goal, width-8),
			dimStyle.Render("状态  ")+valueStyle.Render(r.Status)+
				dimStyle.Render(fmt.Sprintf("   阶段 %s   轮次 %d", phaseOrDash(r.Phase), r.Turns)),
			dimStyle.Render("预算  ")+valueStyle.Render(budgetText(r.Budget.Kind, r.Budget.Limit, r.Budget.Spent)),
		)
		if r.PauseReason != "" {
			lines = append(lines, dimStyle.Render("原因  ")+truncateWidth(r.PauseReason, width-8))
		}
	} else {
		lines = append(lines, dimStyle.Render("当前没有自动循环在跑"))
		if len(o.records) > 0 {
			lines = append(lines, "", dimStyle.Render("最近记录："))
			for i, r := range o.records {
				if i >= 5 {
					break
				}
				lines = append(lines, "  "+truncateWidth(displayName(r.Name, r.ID), width-24)+
					"  "+dimStyle.Render(r.Status))
			}
		}
	}
	lines = append(lines, "", footerHint("n 新建  r 刷新  x 终止  Esc 关闭", ""))
	return strings.Join(lines, "\n")
}

func (o *autoRunOverlay) Summary() Summary {
	return Summary{Kind: "auto-run", Title: "自动循环", State: "ready"}
}

func phaseOrDash(p string) string {
	if p == "" {
		return "—"
	}
	return p
}

// budgetText 拼预算进度：turns 60/100 · tokens 12k/50k · time 3m/30m。
func budgetText(kind string, limit, spent float64) string {
	if kind == "" || limit <= 0 {
		return "—"
	}
	switch kind {
	case "turns":
		return fmt.Sprintf("%.0f/%.0f 轮", spent, limit)
	case "tokens":
		return fmt.Sprintf("%s/%s", fmtTokens(int(spent)), fmtTokens(int(limit)))
	case "time":
		return fmt.Sprintf("%s/%s", (time.Duration(spent) * time.Second).Truncate(time.Second),
			(time.Duration(limit) * time.Second).Truncate(time.Second))
	default:
		return fmt.Sprintf("%.0f/%.0f", spent, limit)
	}
}

// ── 命令 ────────────────────────────────────────────────────────────────

type autoRunRefreshedMsg struct {
	record  *client.AutoRunInfo
	records []client.AutoRunInfo
	err     error
}

func loadAutoRunCmd(ctx context.Context, admin adminAPI, current *client.AutoRunInfo) tea.Cmd {
	return func() tea.Msg {
		if admin == nil {
			return autoRunRefreshedMsg{err: errNoAdmin}
		}
		reqCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
		defer cancel()
		if current != nil && current.ID != "" {
			rec, err := admin.AutoRunShow(reqCtx, current.ID)
			if err != nil {
				return autoRunRefreshedMsg{err: err}
			}
			return autoRunRefreshedMsg{record: &rec}
		}
		records, err := admin.AutoRunList(reqCtx, "")
		return autoRunRefreshedMsg{records: records, err: err}
	}
}

type autoRunStopDoneMsg struct {
	id  string
	err error
}

func autoRunStopCmd(ctx context.Context, admin adminAPI, id string) tea.Cmd {
	return func() tea.Msg {
		if admin == nil {
			return autoRunStopDoneMsg{id: id, err: errNoAdmin}
		}
		reqCtx, cancel := context.WithTimeout(ctx, 20*time.Second)
		defer cancel()
		return autoRunStopDoneMsg{id: id, err: admin.AutoRunStop(reqCtx, id)}
	}
}
