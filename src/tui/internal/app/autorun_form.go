package app

// auto-run 启动表单（Alt+w → n）。
//
// 服务端契约（validateAutoRunStart）要求四样：name / goal / envKey /
// 至少一条 criteria，外加 budget{kind,limit}。TUI 用一个 6 行的紧凑表单：
//
//   ↑↓ 换字段   ←→ 切预算类型   Enter 启动   Esc 取消
//
// criteria 用 `;` 分隔（单行输入里最省事且不歧义）；envKey 预填当前环境，
// 空着也能提交——服务端会回"环境未登记"，比前端猜一份环境表可靠。

import (
	"context"
	"fmt"
	"strconv"
	"strings"
	"time"

	tea "github.com/charmbracelet/bubbletea"
)

var budgetKinds = []string{"turns", "tokens", "time"}

type autoRunForm struct {
	fields  []string // name, goal, envKey, limit, criteria
	focus   int
	budget  int // budgetKinds 下标
	note    string
	sending bool
}

func newAutoRunForm(m *Model) *autoRunForm {
	env := ""
	if m != nil {
		env = m.EnvironmentID
	}
	return &autoRunForm{fields: []string{"", "", env, "50", ""}}
}

func (o *autoRunForm) Title() string { return "启动自动循环" }

func (o *autoRunForm) Handle(m *Model, msg tea.KeyMsg) tea.Cmd {
	switch msg.String() {
	case "up", "shift+tab":
		o.focus--
		if o.focus < 0 {
			o.focus = len(o.fields) - 1
		}
		return nil
	case "down", "tab":
		o.focus = (o.focus + 1) % len(o.fields)
		return nil
	case "left":
		o.budget = (o.budget + len(budgetKinds) - 1) % len(budgetKinds)
		return nil
	case "right":
		o.budget = (o.budget + 1) % len(budgetKinds)
		return nil
	case "backspace":
		f := o.fields[o.focus]
		if r := []rune(f); len(r) > 0 {
			o.fields[o.focus] = string(r[:len(r)-1])
		}
		return nil
	case "enter":
		return o.submit(m)
	}
	if msg.Type == tea.KeyRunes && !msg.Alt && o.focus < len(o.fields) {
		o.fields[o.focus] += string(msg.Runes)
	}
	return nil
}

func (o *autoRunForm) submit(m *Model) tea.Cmd {
	name := strings.TrimSpace(o.fields[0])
	goal := strings.TrimSpace(o.fields[1])
	envKey := strings.TrimSpace(o.fields[2])
	limit, err := strconv.ParseFloat(strings.TrimSpace(o.fields[3]), 64)
	criteria := splitCriteria(o.fields[4])

	switch {
	case name == "":
		o.note = "任务名必填"
		return nil
	case goal == "":
		o.note = "目标必填"
		return nil
	case err != nil || limit <= 0:
		o.note = "预算上限必须是 > 0 的数字"
		return nil
	case len(criteria) == 0:
		o.note = "验收条件至少 1 条（用 ; 分隔）"
		return nil
	}
	o.sending = true
	o.note = "启动中…"
	m.PopOverlay()
	return autoRunStartCmd(m.Ctx, m.Admin, name, goal, envKey, budgetKinds[o.budget], limit, criteria)
}

// splitCriteria 按 ; 或 ； 切分（中英文分号都认），去空。
func splitCriteria(raw string) []string {
	parts := strings.FieldsFunc(raw, func(r rune) bool { return r == ';' || r == '；' })
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		if t := strings.TrimSpace(p); t != "" {
			out = append(out, t)
		}
	}
	return out
}

func (o *autoRunForm) Render(m Model, width, height int) string {
	labels := []string{"任务名", "目标", "环境", "预算上限", "验收条件"}
	lines := []string{headerStyle.Render("启动自动循环")}
	if o.note != "" {
		lines = append(lines, noticeStyle.Render("· "+o.note))
	}
	for i, label := range labels {
		mark := "  "
		style := valueStyle
		if i == o.focus {
			mark = "▸ "
			style = selStyle
		}
		value := o.fields[i]
		if value == "" && i == len(labels)-1 {
			value = dimStyle.Render("用 ; 分隔多条")
		}
		line := mark + dimStyle.Render(padRight(label, label, 10)) + style.Render(truncateWidth(value, width-14))
		if i == 3 {
			line += "  " + dimStyle.Render("["+budgetKinds[o.budget]+"  ←→]")
		}
		lines = append(lines, line)
	}
	lines = append(lines, "", footerHint("↑↓ 换字段  ←→ 切预算  Enter 启动  Esc 取消", ""))
	return strings.Join(lines, "\n")
}

func (o *autoRunForm) Summary() Summary {
	return Summary{Kind: "auto-run-form", Title: "启动自动循环", State: "ready"}
}

type autoRunStartDoneMsg struct {
	id  string
	err error
}

func autoRunStartCmd(ctx context.Context, admin adminAPI, name, goal, envKey, kind string, limit float64, criteria []string) tea.Cmd {
	return func() tea.Msg {
		if admin == nil {
			return autoRunStartDoneMsg{err: fmt.Errorf("没有可用的管理面客户端")}
		}
		reqCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
		defer cancel()
		id, err := admin.AutoRunStart(reqCtx, name, goal, envKey, kind, limit, criteria)
		return autoRunStartDoneMsg{id: id, err: err}
	}
}
