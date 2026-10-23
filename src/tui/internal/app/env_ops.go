package app

// 环境写操作（2.1 P2）：停止 / 删除 / 重命名 / 配方清单。
//
// 之前 TUI 只能 list + select，跟 GUI 差了整个生命周期。这里补的是"日常会用到、
// 且 CLI 对位也麻烦"的四条：
//
//   d  停止（environment/down）——可逆，单次确认
//   x  删除（environment/rm）——不可逆，**两次确认**（3 秒内再按一次）
//   n  重命名（environment/rename）——弹输入框，空串=清除别名
//   l  配方清单（environment/recipes）——只读，回答"能起什么"
//
// 新增/认领（environment/add、adopt）需要多字段表单，留给 CLI。

import (
	"context"
	"fmt"
	"strings"
	"time"

	tea "github.com/charmbracelet/bubbletea"

	"github.com/lielingai/zhishi/tui/internal/client"
)

// envWriteKeys 挂在环境面板上（Alt+e 之后按）。
func (o *envOverlay) handleWriteKeys(m *Model, msg tea.KeyMsg) tea.Cmd {
	switch msg.String() {
	case "d":
		r, ok := o.selected()
		if !ok || o.state != loadReady {
			return nil
		}
		o.note = "停止中…"
		return envOpCmd(m.Ctx, m.Admin, "down", r.Key, "")

	case "x":
		r, ok := o.selected()
		if !ok || o.state != loadReady {
			return nil
		}
		if o.pendingRemove == r.Key && time.Since(o.pendingRemoveAt) < 3*time.Second {
			o.pendingRemove = ""
			o.note = "删除中…"
			return envOpCmd(m.Ctx, m.Admin, "rm", r.Key, "")
		}
		o.pendingRemove = r.Key
		o.pendingRemoveAt = time.Now()
		o.note = "再按一次 x 确认删除（不可逆，3 秒内有效）"

	case "n":
		r, ok := o.selected()
		if !ok || o.state != loadReady {
			return nil
		}
		id := r.Key
		p := newPromptOverlay("重命名环境", "新名称（留空 = 清除别名）", func(m *Model, value string) tea.Cmd {
			return envOpCmd(m.Ctx, m.Admin, "rename", id, strings.TrimSpace(value))
		})
		m.PushOverlay(p)
		return nil

	case "l":
		ov := newRecipesOverlay()
		m.PushOverlay(ov)
		return ov.reload(m)
	}
	return nil
}

// ── 通用输入框覆盖层 ────────────────────────────────────────────────────

type promptOverlay struct {
	title    string
	label    string
	value    string
	onSubmit func(*Model, string) tea.Cmd
}

func newPromptOverlay(title, label string, onSubmit func(*Model, string) tea.Cmd) *promptOverlay {
	return &promptOverlay{title: title, label: label, onSubmit: onSubmit}
}

func (o *promptOverlay) Title() string { return o.title }

func (o *promptOverlay) Handle(m *Model, msg tea.KeyMsg) tea.Cmd {
	switch msg.String() {
	case "enter":
		value := o.value
		m.PopOverlay()
		if o.onSubmit != nil {
			return o.onSubmit(m, value)
		}
		return nil
	case "backspace":
		if r := []rune(o.value); len(r) > 0 {
			o.value = string(r[:len(r)-1])
		}
		return nil
	}
	if msg.Type == tea.KeyRunes && !msg.Alt {
		o.value += string(msg.Runes)
	}
	return nil
}

func (o *promptOverlay) Render(m Model, width, height int) string {
	lines := []string{headerStyle.Render(o.title)}
	if o.label != "" {
		lines = append(lines, dimStyle.Render(o.label))
	}
	lines = append(lines, "", "› "+o.value+"▏", "", footerHint("Enter 确认  Esc 取消", ""))
	return strings.Join(lines, "\n")
}

func (o *promptOverlay) Summary() Summary {
	return Summary{Kind: "prompt", Title: o.title, State: "ready"}
}

// ── 配方清单（只读）─────────────────────────────────────────────────────

type recipesOverlay struct {
	state loadState
	err   string
	rows  []client.EnvRecipe
}

func newRecipesOverlay() *recipesOverlay { return &recipesOverlay{} }

func (o *recipesOverlay) Title() string { return "环境配方" }

func (o *recipesOverlay) reload(m *Model) tea.Cmd {
	o.state = loadRunning
	o.err = ""
	if m.Admin == nil {
		o.state = loadFailed
		o.err = "没有可用的管理面客户端"
		return nil
	}
	return loadRecipesCmd(m.Ctx, m.Admin)
}

func (o *recipesOverlay) Handle(m *Model, msg tea.KeyMsg) tea.Cmd {
	if msg.String() == "r" {
		return o.reload(m)
	}
	return nil
}

func (o *recipesOverlay) Render(m Model, width, height int) string {
	lines := []string{headerStyle.Render("环境配方")}
	switch o.state {
	case loadIdle, loadRunning:
		lines = append(lines, dimStyle.Render("  加载中…"))
	case loadFailed:
		lines = append(lines, errStyle.Render("! "+truncateWidth(o.err, width-2)))
	default:
		maxRows := listOverlayRows(height) - 2
		for i, r := range o.rows {
			if i >= maxRows {
				lines = append(lines, dimStyle.Render(fmt.Sprintf("  …（共 %d 个）", len(o.rows))))
				break
			}
			name := r.Name
			if name == "" {
				name = r.ID
			}
			lines = append(lines, "  "+valueStyle.Render(truncateWidth(name, 24))+"  "+
				dimStyle.Render(truncateWidth(r.Description, width-30)))
		}
	}
	lines = append(lines, "", footerHint("r 刷新  Esc 关闭（启动用 /env up <recipe>）", ""))
	return strings.Join(lines, "\n")
}

func (o *recipesOverlay) Summary() Summary {
	return Summary{Kind: "recipes", Title: "环境配方", State: o.state.String(), Err: o.err, Count: len(o.rows)}
}

// ── 命令 ────────────────────────────────────────────────────────────────

type envOpDoneMsg struct {
	op  string
	id  string
	err error
}

func envOpCmd(ctx context.Context, admin adminAPI, op, id, name string) tea.Cmd {
	return func() tea.Msg {
		if admin == nil {
			return envOpDoneMsg{op: op, id: id, err: fmt.Errorf("没有可用的管理面客户端")}
		}
		reqCtx, cancel := context.WithTimeout(ctx, 60*time.Second)
		defer cancel()
		var err error
		switch op {
		case "down":
			err = admin.EnvDown(reqCtx, id)
		case "rm":
			err = admin.EnvRm(reqCtx, id)
		case "rename":
			err = admin.EnvRename(reqCtx, id, name)
		}
		return envOpDoneMsg{op: op, id: id, err: err}
	}
}

type recipesLoadedMsg struct {
	rows []client.EnvRecipe
	err  error
}

func loadRecipesCmd(ctx context.Context, admin adminAPI) tea.Cmd {
	return func() tea.Msg {
		if admin == nil {
			return recipesLoadedMsg{err: errNoAdmin}
		}
		reqCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
		defer cancel()
		rows, err := admin.EnvRecipes(reqCtx)
		return recipesLoadedMsg{rows: rows, err: err}
	}
}
