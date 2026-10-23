package app

// 「让人选择」的两类请求：决策（decision）与越界审批（boundary ask）。
//
// 与 GUI 的决策卡同源：
//   - 决策：SSE chat:decision-request {decisionId, question, options[]}，
//     应答 POST /chat/decision/respond {decisionId, choice, note?}
//   - 越界：SSE chat:boundary-ask {askId, kind, objects[], options?}，
//     应答 POST /chat/boundary/respond {askId, approve, note?}
//
// TUI 不重新解释语义：选项原文照抄，第一个选项 = 批准/主选项。
// Esc 收起不作答（pending 仍留在服务端），状态行显示待答数，Alt+d 重开。

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	tea "github.com/charmbracelet/bubbletea"

	"github.com/lielingai/zhishi/tui/internal/protocol"
)

// choiceRequest 是一条待答请求。
type choiceRequest struct {
	id       string
	boundary bool
	title    string   // 决策的 question / 越界的 kind
	detail   []string // 对象清单、工具描述
	toolName string
	options  []string
	sel      int
	// custom 是"选项给不出想要的答案"时的自由输入通道（仅决策）。
	custom bool
	input  string
}

// defaultBoundaryOptions 是越界请求没给 options 时的兜底：批准 / 拒绝。
var defaultBoundaryOptions = []string{"批准", "拒绝"}

// keyFor 返回选项的热键（1..9，之后 a、b、c…）。
func keyFor(i int) string {
	if i < 9 {
		return fmt.Sprintf("%d", i+1)
	}
	return string(rune('a' + (i - 9)))
}

// findChoice 按 id 找待答请求。
func (m Model) findChoice(id string) *choiceRequest {
	for _, c := range m.Choices {
		if c.id == id {
			return c
		}
	}
	return nil
}

// upsertChoice 登记（重连重放会重复推送，按 id 幂等）。
func (m *Model) upsertChoice(c *choiceRequest) {
	if c == nil || c.id == "" {
		return
	}
	if old := m.findChoice(c.id); old != nil {
		// 重放时保留本地选择位置与输入草稿。
		old.title, old.detail, old.options = c.title, c.detail, c.options
		old.toolName, old.boundary = c.toolName, c.boundary
		return
	}
	m.Choices = append(m.Choices, c)
}

func (m *Model) removeChoice(id string) {
	out := m.Choices[:0]
	for _, c := range m.Choices {
		if c.id != id {
			out = append(out, c)
		}
	}
	m.Choices = out
}

// choiceOverlayOpen 判断面板栈里是否已经有待答面板。
func (m Model) choiceOverlayOpen() bool {
	for _, ov := range m.Overlays {
		if _, ok := ov.(*choiceOverlay); ok {
			return true
		}
	}
	return false
}

// autoOpenChoice：有待答且没有面板在显示时，弹出第一个。
func (m *Model) autoOpenChoice() {
	if len(m.Choices) == 0 || m.choiceOverlayOpen() {
		return
	}
	// 其它覆盖层开着时不抢焦点（用户可能正在看环境面板）。
	if _, busy := m.TopOverlay(); busy {
		return
	}
	m.PushOverlay(newChoiceOverlay(m.Choices[0].id))
}

// ── 覆盖层 ──────────────────────────────────────────────────────────────

type choiceOverlay struct{ id string }

func newChoiceOverlay(id string) *choiceOverlay { return &choiceOverlay{id: id} }

func (o *choiceOverlay) Title() string { return "待选择" }

func (o *choiceOverlay) Handle(m *Model, msg tea.KeyMsg) tea.Cmd {
	c := m.findChoice(o.id)
	if c == nil {
		m.PopOverlay()
		return nil
	}
	if c.custom {
		switch msg.String() {
		case "enter":
			if strings.TrimSpace(c.input) == "" {
				return nil
			}
			return m.respondChoice(c, strings.TrimSpace(c.input))
		case "backspace":
			if r := []rune(c.input); len(r) > 0 {
				c.input = string(r[:len(r)-1])
			}
			return nil
		case "esc", "ctrl+c":
			c.custom = false
			return nil
		}
		if msg.Type == tea.KeyRunes && !msg.Alt {
			c.input += string(msg.Runes)
		}
		return nil
	}

	switch msg.String() {
	case "up", "ctrl+p":
		c.sel--
	case "down", "ctrl+n":
		c.sel++
	case "enter":
		if len(c.options) > 0 {
			return m.respondChoice(c, c.options[c.sel])
		}
		return nil
	case "c":
		if !c.boundary {
			c.custom = true
		}
	default:
		if msg.Type == tea.KeyRunes && !msg.Alt {
			if idx := hotkeyIndex(string(msg.Runes), len(c.options)); idx >= 0 {
				c.sel = idx
				return m.respondChoice(c, c.options[idx])
			}
		}
	}
	if c.sel < 0 {
		c.sel = 0
	}
	if c.sel >= len(c.options) {
		c.sel = len(c.options) - 1
	}
	if c.sel < 0 {
		c.sel = 0
	}
	return nil
}

func (o *choiceOverlay) Render(m Model, width, height int) string {
	c := m.findChoice(o.id)
	if c == nil {
		return "（这条请求已失效）"
	}
	kind := "决策"
	if c.boundary {
		kind = "越界审批"
	}
	lines := []string{headerStyle.Render(kind)}
	if c.title != "" {
		lines = append(lines, truncateWidth(c.title, width))
	}
	for _, d := range c.detail {
		if strings.TrimSpace(d) == "" {
			continue
		}
		lines = append(lines, dimStyle.Render("· "+truncateWidth(d, width-2)))
	}
	if c.toolName != "" {
		lines = append(lines, dimStyle.Render("工具："+c.toolName))
	}
	lines = append(lines, "")
	for i, opt := range c.options {
		mark := "  "
		style := valueStyle
		if i == c.sel {
			mark = "▸ "
			style = selStyle
		}
		lines = append(lines, fmt.Sprintf("%s%s %s", mark,
			dimStyle.Render("["+keyFor(i)+"]"), style.Render(truncateWidth(opt, width-8))))
	}
	if !c.boundary {
		if c.custom {
			lines = append(lines, "", noticeStyle.Render("自定义应答：")+c.input+"▏")
		} else {
			lines = append(lines, dimStyle.Render("c = 自定义应答"))
		}
	}
	hint := "↑↓ 选择  Enter 提交  Esc 收起（Alt+d 重开）"
	if c.custom {
		hint = "输入后 Enter 提交  Esc 退回选项"
	}
	lines = append(lines, "", footerHint(hint, ""))
	return strings.Join(lines, "\n")
}

func (o *choiceOverlay) Summary() Summary {
	return Summary{Kind: "choice", Title: "待选择", State: "ready", Count: 1, First: o.id}
}

// hotkeyIndex 把按键映射成选项下标；不匹配返回 -1。
func hotkeyIndex(key string, n int) int {
	if len(key) != 1 {
		return -1
	}
	ch := key[0]
	switch {
	case ch >= '1' && ch <= '9':
		i := int(ch - '1')
		if i < n {
			return i
		}
	case ch >= 'a' && ch <= 'z':
		i := int(ch-'a') + 9
		if i < n {
			return i
		}
	}
	return -1
}

// ── 应答 ────────────────────────────────────────────────────────────────

type choiceRespondedMsg struct {
	id  string
	err error
}

// respondChoice 提交应答。approve 语义只由"第几个选项"决定：越界的第一个
// 选项就是批准（服务端给的 options 顺序即语义顺序）。
func (m *Model) respondChoice(c *choiceRequest, picked string) tea.Cmd {
	payload := map[string]any{}
	if c.boundary {
		approve := c.sel == 0
		if len(c.options) > 0 && picked != "" {
			for i, opt := range c.options {
				if opt == picked {
					approve = i == 0
					break
				}
			}
		}
		payload["askId"] = c.id
		payload["approve"] = approve
	} else {
		payload["decisionId"] = c.id
		payload["choice"] = picked
	}
	raw, _ := json.Marshal(payload)
	client := m.Client
	return func() tea.Msg {
		if client == nil {
			return choiceRespondedMsg{id: c.id, err: fmt.Errorf("没有可用的 sidecar 连接")}
		}
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		var err error
		if c.boundary {
			err = client.RespondBoundary(ctx, raw)
		} else {
			err = client.RespondDecision(ctx, raw)
		}
		return choiceRespondedMsg{id: c.id, err: err}
	}
}

// applyChoiceEvent 折「待答 / 已答 / 过期」三类事件。
func (m *Model) applyChoiceEvent(ev protocol.Event) {
	switch ev.Kind {
	case protocol.KindDecision:
		m.upsertChoice(&choiceRequest{
			id:       ev.RequestID,
			title:    ev.Question,
			options:  ev.Options,
			toolName: "",
		})
	case protocol.KindBoundaryAsk:
		opts := ev.Options
		if len(opts) == 0 {
			opts = defaultBoundaryOptions
		}
		detail := append([]string{}, ev.Objects...)
		if ev.ToolDescription != "" {
			detail = append(detail, ev.ToolDescription)
		}
		m.upsertChoice(&choiceRequest{
			id:       ev.RequestID,
			boundary: true,
			title:    ev.BoundaryKind,
			detail:   detail,
			toolName: ev.ToolName,
			options:  opts,
		})
	case protocol.KindDecisionDone, protocol.KindBoundaryExpired:
		m.removeChoice(ev.RequestID)
		if top, ok := m.TopOverlay(); ok {
			if o, isChoice := top.(*choiceOverlay); isChoice && o.id == ev.RequestID {
				m.PopOverlay()
			}
		}
	}
}
