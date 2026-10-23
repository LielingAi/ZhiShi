package app

// 会话操作面板（Alt+x）：重置 / 回退 / 分叉 / 切模型。
//
// 这三件事在 CLI 里没有对位交互（reset 干脆没有命令），GUI 里又藏在菜单和
// 状态栏里——TUI 收进一个面板，动作都是 sidecar 已有端点：
//   POST /chat/reset          （清上下文，旧 jsonl 保留）
//   POST /chat/rewind         {userMessageId}（截断到该用户消息之前）
//   POST /sessions/fork       {messageId}（从该消息分叉，当前线原地换血）
//   POST /chat/model          {providerId, model}（会话内切模型）
//
// 回退/分叉要求选中块是**权威消息**（wire 的 msg:<id>）：本地回显块没有服务端
// id，拿它去调用只会 404。所以这两个动作在不可用时置灰说明原因，而不是静默失败。

import (
	"context"
	"fmt"
	"strings"
	"time"

	tea "github.com/charmbracelet/bubbletea"

	"github.com/lielingai/zhishi/tui/internal/client"
	"github.com/lielingai/zhishi/tui/internal/store"
)

type sessionAction int

const (
	sessionReset sessionAction = iota
	sessionRewind
	sessionFork
	sessionModel
	sessionPermission
	sessionReport
)

type sessionItem struct {
	label  string
	action sessionAction
	// hint 是选中时的说明（不可用时给出原因）。
	hint    string
	enabled bool
}

type sessionOverlay struct {
	items []sessionItem
	sel   int
	note  string
}

func newSessionOverlay(m *Model) *sessionOverlay {
	o := &sessionOverlay{}
	o.items = []sessionItem{
		{label: "重置当前会话", action: sessionReset, enabled: true,
			hint: "清空上下文，旧记录保留可审计"},
		{label: "回退到选中消息之前", action: sessionRewind,
			hint: "选中块必须是用户消息（wire 消息）"},
		{label: "从选中消息分叉", action: sessionFork,
			hint: "选中块必须是助手消息（wire 消息）"},
		{label: "切换模型", action: sessionModel, enabled: true,
			hint: "只影响当前会话，不改全局默认"},
		{label: "权限模式：" + m.PermissionMode, action: sessionPermission, enabled: true,
			hint: "auto = 越界要审批；fullAgency = 后台全自主（高危）"},
		{label: "导出研究报告", action: sessionReport, enabled: m.Workspace != "",
			hint: "写回工作区 output/，需先在越界面板批准"},
	}
	if m.Workspace == "" {
		o.items[len(o.items)-1].hint = "workspace 未知（未收到 chat:init 的 agentDir）"
	}
	id, kind := selectedWireMessage(*m)
	if id != "" && kind == store.KindUser {
		o.items[1].enabled = true
	} else {
		o.items[1].hint = "当前块不是用户消息（或不是历史重放块）"
	}
	if id != "" && kind == store.KindAssistant {
		o.items[2].enabled = true
	} else {
		o.items[2].hint = "当前块不是助手消息（或不是历史重放块）"
	}
	return o
}

// selectedWireMessage 取选中块的权威消息 id（msg:<n> → n）。
func selectedWireMessage(m Model) (string, store.Kind) {
	b, ok := m.targetBlock()
	if !ok {
		return "", store.KindNotice
	}
	if id, ok := strings.CutPrefix(b.ID, "msg:"); ok {
		return id, b.Kind
	}
	return "", b.Kind
}

func (o *sessionOverlay) Title() string { return "会话" }

func (o *sessionOverlay) Handle(m *Model, msg tea.KeyMsg) tea.Cmd {
	switch msg.String() {
	case "up", "ctrl+p":
		o.sel--
	case "down", "ctrl+n":
		o.sel++
	case "enter":
		it := o.items[o.sel]
		if !it.enabled {
			o.note = it.hint
			return nil
		}
		switch it.action {
		case sessionReset:
			m.PopOverlay()
			return sessionOpCmd(m.Ctx, m.sessionClient(), "reset", "")
		case sessionRewind:
			id, _ := selectedWireMessage(*m)
			m.PopOverlay()
			return sessionOpCmd(m.Ctx, m.sessionClient(), "rewind", id)
		case sessionFork:
			id, _ := selectedWireMessage(*m)
			m.PopOverlay()
			return sessionOpCmd(m.Ctx, m.sessionClient(), "fork", id)
		case sessionModel:
			m.PopOverlay()
			mo := newModelOverlay()
			m.PushOverlay(mo)
			return mo.reload(m)
		case sessionReport:
			m.PopOverlay()
			// 导出可能要几分钟（等人批越界 + 证据回收 + 叙述），不提示的话
			// 用户会以为按了没反应。
			m.LastNotice = "正在导出报告…（越界批准后继续，最长约 7 分钟）"
			return reportExportCmd(m.Ctx, m.Admin, m.Workspace)
		case sessionPermission:
			if m.PermissionMode == "fullAgency" {
				m.PermissionMode = "auto"
			} else {
				m.PermissionMode = "fullAgency"
			}
			o.items[o.sel].label = "权限模式：" + m.PermissionMode
			o.note = "下一条消息起生效：" + m.PermissionMode
		}
	}
	if o.sel < 0 {
		o.sel = 0
	}
	if o.sel >= len(o.items) {
		o.sel = len(o.items) - 1
	}
	return nil
}

func (o *sessionOverlay) Render(m Model, width, height int) string {
	lines := []string{headerStyle.Render("会话操作")}
	if o.note != "" {
		lines = append(lines, noticeStyle.Render("· "+o.note))
	}
	for i, it := range o.items {
		mark := "  "
		style := valueStyle
		if i == o.sel {
			mark = "▸ "
			style = selStyle
		}
		label := it.label
		if !it.enabled {
			label += "（不可用）"
		}
		lines = append(lines, mark+style.Render(truncateWidth(label, width-4)))
	}
	if o.sel >= 0 && o.sel < len(o.items) {
		lines = append(lines, "", dimStyle.Render("  "+truncateWidth(o.items[o.sel].hint, width-4)))
	}
	lines = append(lines, "", footerHint("↑↓ 选择  Enter 执行  Esc 关闭", ""))
	return strings.Join(lines, "\n")
}

func (o *sessionOverlay) Summary() Summary {
	return Summary{Kind: "session", Title: "会话", State: "ready", Count: len(o.items)}
}

// ── 模型选择器 ──────────────────────────────────────────────────────────

type modelOverlay struct{ list }

func newModelOverlay() *modelOverlay {
	return &modelOverlay{list: list{emptyHint: "（没有可用模型）先用 /model set-key <provider> <key> 配一个"}}
}

func (o *modelOverlay) Title() string { return "切换模型" }

func (o *modelOverlay) reload(m *Model) tea.Cmd {
	o.state = loadRunning
	o.err = ""
	if m.Admin == nil {
		o.state = loadFailed
		o.err = "没有可用的管理面客户端"
		return nil
	}
	return loadModelsCmd(m.Ctx, m.Admin)
}

func (o *modelOverlay) Handle(m *Model, msg tea.KeyMsg) tea.Cmd {
	switch msg.String() {
	case "up", "ctrl+p":
		o.move(-1)
	case "down", "ctrl+n":
		o.move(1)
	case "r":
		return o.reload(m)
	case "enter":
		r, ok := o.selected()
		if !ok || o.state != loadReady {
			return nil
		}
		provider, model := splitModelKey(r.Key)
		m.PopOverlay()
		return modelSwitchCmd(m.Ctx, m.sessionClient(), provider, model)
	}
	return nil
}

func (o *modelOverlay) Render(m Model, width, height int) string {
	return listBody("切换模型", o.list, width, listOverlayRows(height),
		"↑↓ 选择  Enter 切换  r 刷新  Esc 关闭")
}

func (o *modelOverlay) Summary() Summary {
	return Summary{Kind: "model", Title: "切换模型", State: o.state.String(), Err: o.err,
		Count: len(o.rows), First: o.first()}
}

// splitModelKey 拆 "providerId\x00model" —— 用 NUL 而不是 ":"：模型名里可能带冒号。
func splitModelKey(key string) (string, string) {
	provider, model, _ := strings.Cut(key, "|")
	return provider, model
}

// ── 命令 ────────────────────────────────────────────────────────────────

type sessionOpDoneMsg struct {
	op  string
	err error
}

func sessionOpCmd(ctx context.Context, client sessionOps, op, id string) tea.Cmd {
	return func() tea.Msg {
		if client == nil {
			return sessionOpDoneMsg{op: op, err: fmt.Errorf("没有可用的 sidecar 连接")}
		}
		reqCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
		defer cancel()
		var err error
		switch op {
		case "reset":
			err = client.ResetChat(reqCtx)
		case "rewind":
			err = client.Rewind(reqCtx, id)
		case "fork":
			err = client.Fork(reqCtx, id)
		}
		return sessionOpDoneMsg{op: op, err: err}
	}
}

type modelSwitchDoneMsg struct {
	provider, model string
	err             error
}

func modelSwitchCmd(ctx context.Context, client sessionOps, provider, model string) tea.Cmd {
	return func() tea.Msg {
		if client == nil {
			return modelSwitchDoneMsg{provider: provider, model: model, err: fmt.Errorf("没有可用的 sidecar 连接")}
		}
		reqCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
		defer cancel()
		err := client.ChatModel(reqCtx, provider, model)
		return modelSwitchDoneMsg{provider: provider, model: model, err: err}
	}
}

// sessionClient 把"指向 nil 的 *client.Client"收敛成 nil 接口。
//
// 直接把 m.Client（类型 *Client、值为 nil）塞进接口会得到**非 nil 接口**，
// 命令里的 `client == nil` 守卫失效，随后在真实方法里解引用 panic。
func (m Model) sessionClient() sessionOps {
	if m.Client == nil {
		return nil
	}
	return m.Client
}

// sessionOps 是这两个命令需要的最小客户端面（Model.Client 与测试桩都满足）。
type sessionOps interface {
	ResetChat(ctx context.Context) error
	Rewind(ctx context.Context, userMessageID string) error
	Fork(ctx context.Context, messageID string) error
	ChatModel(ctx context.Context, providerID, model string) error
	CancelQueueItem(ctx context.Context, queueID string) error
}

func loadModelsCmd(ctx context.Context, admin adminAPI) tea.Cmd {
	return func() tea.Msg {
		reqCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
		defer cancel()
		opts, err := admin.Models(reqCtx)
		return modelsLoadedMsg{options: opts, err: err}
	}
}

type modelsLoadedMsg struct {
	options []client.ModelOption
	err     error
}

// ── 报告导出 ────────────────────────────────────────────────────────────

type reportExportDoneMsg struct {
	info client.ReportExportInfo
	err  error
}

// reportExportCmd 导出研究报告。
//
// 超时给到 7 分钟：服务端会先发一条 host-write 越界审批等人批（5 分钟窗口），
// 批准后还要回收证据 + LLM 叙述（叙述自身 180s 上限）。给短了会把"人还没批"误报成失败。
func reportExportCmd(ctx context.Context, admin adminAPI, workspace string) tea.Cmd {
	return func() tea.Msg {
		if admin == nil {
			return reportExportDoneMsg{err: fmt.Errorf("没有可用的管理面客户端")}
		}
		if workspace == "" {
			return reportExportDoneMsg{err: fmt.Errorf("workspace 未知（未收到 chat:init 的 agentDir）")}
		}
		reqCtx, cancel := context.WithTimeout(ctx, 7*time.Minute)
		defer cancel()
		info, err := admin.ReportExport(reqCtx, workspace)
		return reportExportDoneMsg{info: info, err: err}
	}
}
