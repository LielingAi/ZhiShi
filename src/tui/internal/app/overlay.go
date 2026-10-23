package app

import (
	"fmt"
	"strings"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
)

// Overlay 是覆盖层栈里的一层。
//
// 三类覆盖层（提示空壳 / 命令面板 / 四个数据面板）共用同一份契约：
//   - Handle 只决定"想做什么"并返回 Cmd，自己不执行 IO（IO 仍然只在 update）；
//   - Render 只读自己的状态，不产生副作用；
//   - 栈顶那一层独占按键（键路由第 1 段），Esc 逐层退，栈空后按键回输入框。
type Overlay interface {
	Title() string
	Handle(m *Model, msg tea.KeyMsg) tea.Cmd
	Render(m Model, width, height int) string
	// Summary 是给探针与日志的诊断快照（条数/首条/状态），不参与渲染。
	Summary() Summary
}

// Summary 是覆盖层的诊断快照。
type Summary struct {
	Kind  string // notice / palette / env / line / task / archive
	Title string
	State string // idle / loading / ready / failed
	Err   string
	Count int
	First string
}

// loadState 是异步数据的状态机：一次性请求，三态收敛。
type loadState int

const (
	loadIdle    loadState = iota // 还没发请求
	loadRunning                  // 在途 → 画「加载中…」
	loadReady                    // 有数据（可能为空列表）
	loadFailed                   // 请求失败 → 画错误行，不退出
)

func (s loadState) String() string {
	switch s {
	case loadRunning:
		return "loading"
	case loadReady:
		return "ready"
	case loadFailed:
		return "failed"
	default:
		return "idle"
	}
}

// row 是列表覆盖层里的一行。
//
// 它是 UI 层的中性结构：client 的 DTO 在命令里就被折算成 row，覆盖层不认识
// 传输层类型——这样四个面板的渲染与选中逻辑可以完全共用。
type row struct {
	Key string // 主键（环境 id / 会话 id / 任务 id / 实体 id）
	// Ref 是次要键：会话行同时有 meta id 与 loopSessionId，切线用前者、
	// 拉 wire 用后者——一个字段塞不下两个 id，也不该让调用方去猜。
	Ref   string
	Title string
	Desc  string
	Flag  string // 右侧标记（状态 / 类型 / 当前项）
	Dim   bool   // 弱化显示（已归档、已解决等）
}

// list 是"列表 + 光标"的公共状态，四个数据覆盖层共用。
type list struct {
	state loadState
	err   string // 加载失败信息
	note  string // 动作反馈（选中/切换失败等，不改变列表状态）
	rows  []row
	sel   int
	// emptyHint 是空列表面板的解释文案（"空"本身不回答"为什么空"）。
	emptyHint string
}

// loadState 暴露加载状态（测试断言 r 刷新是否真的触发）。
func (l *list) loadState() loadState { return l.state }

func (l *list) move(delta int) {
	if len(l.rows) == 0 {
		return
	}
	l.sel += delta
	l.clamp()
}

func (l *list) clamp() {
	if l.sel >= len(l.rows) {
		l.sel = len(l.rows) - 1
	}
	if l.sel < 0 {
		l.sel = 0
	}
}

func (l *list) setRows(rows []row) {
	l.rows = rows
	l.state = loadReady
	l.err = ""
	l.note = ""
	l.clamp()
}

func (l *list) fail(err error) {
	l.state = loadFailed
	l.err = err.Error()
	l.rows = nil
	l.sel = 0
}

func (l *list) selected() (row, bool) {
	if l.sel < 0 || l.sel >= len(l.rows) {
		return row{}, false
	}
	return l.rows[l.sel], true
}

// first 返回首条标题（探针摘要用）。
func (l *list) first() string {
	if len(l.rows) == 0 {
		return ""
	}
	return l.rows[0].Title
}

// renderList 画列表区（含加载中 / 空 / 错误三态），返回若干行。
//
// 行窗口跟着选中项滚动：选中项永远在可见范围内，不需要第二个滚动位置。
func renderList(l list, width, maxRows int) []string {
	if maxRows < 1 {
		maxRows = 1
	}
	switch l.state {
	case loadIdle, loadRunning:
		return []string{dimStyle.Render("  加载中…")}
	case loadFailed:
		return wrapLines("! "+l.err, width, errStyle)
	}
	if len(l.rows) == 0 {
		hint := "（空）"
		if l.emptyHint != "" {
			hint = l.emptyHint
		}
		return wrapLines("  "+hint, width, dimStyle)
	}

	from := 0
	if l.sel >= maxRows {
		from = l.sel - maxRows + 1
	}
	out := make([]string, 0, maxRows)
	for i := from; i < len(l.rows) && i < from+maxRows; i++ {
		r := l.rows[i]
		marker := "  "
		title := r.Title
		if i == l.sel {
			marker = "▸ "
			title = selStyle.Render(r.Title)
		} else if r.Dim {
			title = dimStyle.Render(r.Title)
		}
		line := marker + padRight(title, r.Title, 22)
		if r.Desc != "" {
			line += dimStyle.Render(r.Desc)
		}
		if r.Flag != "" {
			// 标记靠右让列表像表格；宽度不够时 truncateWidth 会自己截。
			line += "  " + flagStyle(r).Render(r.Flag)
		}
		out = append(out, truncateWidth(line, width))
	}
	return out
}

// wrapLines 按宽度折行并整体着色（错误行会很长）。
func wrapLines(text string, width int, style lipgloss.Style) []string {
	if width < 8 {
		width = 8
	}
	var out []string
	for _, chunk := range strings.Split(text, "\n") {
		for _, part := range splitByWidth(chunk, width-2) {
			out = append(out, style.Render("  "+part))
		}
	}
	return out
}

// splitByWidth 按显示宽度切串（错误信息可能带换行或长 URL）。
func splitByWidth(s string, width int) []string {
	if width < 4 {
		width = 4
	}
	var out []string
	var b strings.Builder
	w := 0
	for _, r := range s {
		rw := lipgloss.Width(string(r))
		if w+rw > width {
			out = append(out, b.String())
			b.Reset()
			w = 0
		}
		b.WriteRune(r)
		w += rw
	}
	out = append(out, b.String())
	return out
}

func flagStyle(r row) lipgloss.Style {
	if r.Dim {
		return dimStyle
	}
	return valueStyle
}

// ── 提示空壳 ────────────────────────────────────────────────────────────

// noticeOverlay 是纯展示的空壳（尚未接线的入口）。
//
// 它把除 Esc 之外的按键全部吃掉——覆盖层打开时的按键不该漏到输入框。
type noticeOverlay struct {
	title string
	body  string
}

func newNoticeOverlay(title, body string) *noticeOverlay {
	return &noticeOverlay{title: title, body: body}
}

func (o *noticeOverlay) Title() string { return o.title }

func (o *noticeOverlay) Handle(*Model, tea.KeyMsg) tea.Cmd { return nil }

func (o *noticeOverlay) Render(m Model, width, height int) string {
	body := lipgloss.NewStyle().Width(width).Render(o.body + "\n\n" + dimStyle.Render("Esc 关闭"))
	return lipgloss.JoinVertical(lipgloss.Left, headerStyle.Render(o.title), body)
}

func (o *noticeOverlay) Summary() Summary {
	return Summary{Kind: "notice", Title: o.title, State: "ready"}
}

// ── 栈工具 ──────────────────────────────────────────────────────────────

// lastOverlayOf 从栈顶往下找第一个指定类型。
//
// 数据回包必须写回**它自己那一层**（用户可能在加载途中又开了别的层），
// 所以不能直接打栈顶。
func lastOverlayOf[T Overlay](m *Model) (T, bool) {
	var zero T
	for i := len(m.Overlays) - 1; i >= 0; i-- {
		if o, ok := m.Overlays[i].(T); ok {
			return o, true
		}
	}
	return zero, false
}

// footerHint 是覆盖层底部的键提示（统一形态：末行固定一行灰字）。
func footerHint(parts ...string) string {
	return dimStyle.Render(strings.Join(parts, "  "))
}

func countLabel(n, total int) string {
	if total == 0 {
		return "0/0"
	}
	return fmt.Sprintf("%d/%d", n, total)
}

// ── 可滚动只读详情（档案实体 / 长文本）─────────────────────────────────

// detailOverlay 是带滚动的只读详情。
//
// 为什么不复用 noticeOverlay：那个不裁切也不滚动，正文比盒子长时会被静默截掉——
// "看不到详情"里至少有一半是这么来的。这里显式给窗口 + 位置提示。
type detailOverlay struct {
	title string
	body  string
	off   int
	// hint 是底注里的动作提示（不同详情可用键不同）。
	hint string
	// onKey 是"详情层自己的动作键"（如档案的 v/c/a）。返回 handled=false
	// 表示不认这个键，交回滚动逻辑/路由。
	onKey func(m *Model, msg tea.KeyMsg) (tea.Cmd, bool)
}

func newDetailOverlay(title, body string) *detailOverlay {
	return &detailOverlay{title: title, body: body, hint: "Esc 关闭"}
}

func (o *detailOverlay) Title() string { return o.title }

func (o *detailOverlay) Handle(m *Model, msg tea.KeyMsg) tea.Cmd {
	lines := wrapLines(o.body, m.contentWidth()-6, lipgloss.NewStyle())
	maxOff := len(lines) - (listOverlayRows(m.Height) - 2)
	if maxOff < 0 {
		maxOff = 0
	}
	if o.onKey != nil {
		if cmd, handled := o.onKey(m, msg); handled {
			return cmd
		}
	}
	switch msg.String() {
	case "up", "ctrl+p", "pgup":
		o.off -= pageScroll * 2
	case "down", "ctrl+n", "pgdown":
		o.off += pageScroll * 2
	case "home":
		o.off = 0
	case "end":
		o.off = maxOff
	}
	if o.off < 0 {
		o.off = 0
	}
	if o.off > maxOff {
		o.off = maxOff
	}
	return nil
}

func (o *detailOverlay) Render(m Model, width, height int) string {
	lines := wrapLines(o.body, width, lipgloss.NewStyle())
	maxRows := listOverlayRows(height) - 1
	if maxRows < 1 {
		maxRows = 1
	}
	end := o.off + maxRows
	if end > len(lines) {
		end = len(lines)
	}
	start := o.off
	if start > end {
		start = end
	}
	out := append([]string{headerStyle.Render(o.title)}, lines[start:end]...)
	out = append(out, "", footerHint(fmt.Sprintf("↑↓ 滚动  %d/%d", end, len(lines)), o.hint))
	return strings.Join(out, "\n")
}

func (o *detailOverlay) Summary() Summary {
	return Summary{Kind: "detail", Title: o.title, State: "ready"}
}
