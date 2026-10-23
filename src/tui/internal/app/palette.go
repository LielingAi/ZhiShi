package app

import (
	"strings"

	tea "github.com/charmbracelet/bubbletea"
)

// PaletteAction 是面板里的**本地**动作（不发给 sidecar）。
// 斜杠命令走 Command 字段，作为一条 chat 消息发出——TUI 不解释它们，
// 解释权在 sidecar（前端不做业务逻辑）。
type PaletteAction int

const (
	PaletteNone PaletteAction = iota
	PaletteJumpBottom
	PaletteToggleFailed
	PaletteReconnect
	PaletteCopySummary
	PaletteOpenEnv
	PaletteOpenLine
	PaletteOpenTask
	PaletteOpenArchive
	PaletteSessionActions
)

// PaletteItem 是一条面板条目。
type PaletteItem struct {
	Name   string
	Desc   string
	Insert string        // 非空 = 把这条命令模板填进输入框（不直接执行）
	Action PaletteAction // Insert 为空时执行
}

// paletteItems 是命令模板 + 本地动作。
//
// 斜杠命令的**执行**不在这里：`/xxx` 一律交给 CLI 子进程（slash.go），所以
// 这里只是给人看的快捷模板，不是命令表——增删条目永远不会改变实际能力，
// 也不会和 src/cli 的真实命令集产生第二份真相。
func paletteItems() []PaletteItem {
	return append(commandTemplates(), []PaletteItem{
		{Name: "会话操作", Desc: "重置 / 回退 / 分叉 / 切模型（Alt+x）", Action: PaletteSessionActions},
		{Name: "打开环境面板", Desc: "切换环境（Alt+e）", Action: PaletteOpenEnv},
		{Name: "打开线面板", Desc: "切换会话线（Alt+l）", Action: PaletteOpenLine},
		{Name: "打开任务面板", Desc: "查看任务清单（Alt+t）", Action: PaletteOpenTask},
		{Name: "打开研究档案", Desc: "只读档案树（Alt+a）", Action: PaletteOpenArchive},
		{Name: "跳到最后一块", Desc: "回到底部并跟随输出", Action: PaletteJumpBottom},
		{Name: "只看失败", Desc: "切换失败块过滤", Action: PaletteToggleFailed},
		{Name: "重连", Desc: "重新订阅 /chat/stream", Action: PaletteReconnect},
		{Name: "复制会话摘要", Desc: "把最近若干块拼成摘要复制（桩）", Action: PaletteCopySummary},
	}...)
}

// filterPalette 按查询做模糊过滤，保持原始顺序。
//
// 只过滤不重排：输入一两个字符时按分数重排会让列表在手底下跳，选中项位置
// 不稳定比"不够聪明"更烦人。
func filterPalette(query string) []PaletteItem {
	all := paletteItems()
	q := strings.TrimSpace(strings.ToLower(query))
	if q == "" {
		return all
	}
	out := make([]PaletteItem, 0, len(all))
	for _, it := range all {
		// 斜杠命令允许"没打斜杠也能搜到"：输入 export 也命中 /export。
		if fuzzyMatch(q, strings.ToLower(it.Name)) || fuzzyMatch(q, strings.ToLower(strings.TrimPrefix(it.Name, "/"))) {
			out = append(out, it)
		}
	}
	return out
}

// fuzzyMatch 判断 query 的字符是否按序出现在 name 里（子序列匹配）。
//
// 不做打分/排序，只要布尔——列表规模是十几条，打分带来的排序抖动远比收益吵。
func fuzzyMatch(query, name string) bool {
	if query == "" {
		return true
	}
	qr := []rune(query)
	qi := 0
	for _, r := range name {
		if r == qr[qi] {
			qi++
			if qi == len(qr) {
				return true
			}
		}
	}
	return false
}

// ── 面板覆盖层 ──────────────────────────────────────────────────────────

// paletteOverlay 是命令面板：输入过滤 + 列表 + Enter 执行。
//
// Sel 是**过滤后**列表的下标——查询一变就要收敛，否则 Enter 会执行一个
// 用户根本没看到的条目。
type paletteOverlay struct {
	query string
	sel   int
}

func newPaletteOverlay() *paletteOverlay { return &paletteOverlay{} }

func (o *paletteOverlay) Title() string { return "命令面板" }

func (o *paletteOverlay) Handle(m *Model, msg tea.KeyMsg) tea.Cmd {
	switch msg.String() {
	case "up", "ctrl+p":
		o.sel--
	case "down", "ctrl+n":
		o.sel++
	case "backspace":
		o.query = trimLastRune(o.query)
		o.sel = 0
	case "enter":
		return o.run(m)
	default:
		if msg.Type == tea.KeyRunes && !msg.Alt {
			o.query += string(msg.Runes)
			o.sel = 0
		}
	}
	if n := len(filterPalette(o.query)); o.sel >= n {
		o.sel = n - 1
	}
	if o.sel < 0 {
		o.sel = 0
	}
	return nil
}

// run 执行选中项并关面板。
func (o *paletteOverlay) run(m *Model) tea.Cmd {
	items := filterPalette(o.query)
	if len(items) == 0 {
		return nil
	}
	sel := o.sel
	if sel >= len(items) {
		sel = len(items) - 1
	}
	it := items[sel]
	m.PopOverlay()

	if it.Insert != "" {
		// 只填模板、不执行：需要补参数的命令（set-key / env add）直接跑会报错。
		m.Input.Reset()
		m.Input.InsertString(it.Insert)
		m.Menu = nil // 用户已经选过了，别再弹候选
		m.layout()
		m.LastNotice = "已填入输入框，补完参数后 Enter 执行"
		return nil
	}
	switch it.Action {
	case PaletteSessionActions:
		m.PushOverlay(newSessionOverlay(m))
		return nil
	case PaletteOpenEnv:
		return m.openEnvOverlay()
	case PaletteOpenLine:
		return m.openLineOverlay()
	case PaletteOpenTask:
		return m.openTaskOverlay()
	case PaletteOpenArchive:
		return m.openArchiveOverlay()
	case PaletteJumpBottom:
		m.ScrollLines = 0
		m.LastNotice = "已回到底部"
	case PaletteToggleFailed:
		m.toggleFailedFilter()
	case PaletteReconnect:
		m.LastNotice = "正在重连…"
		return m.reconnect()
	case PaletteCopySummary:
		m.LastNotice = "复制会话摘要（M2a 桩）"
	}
	return nil
}

func (o *paletteOverlay) Render(m Model, width, height int) string {
	items := filterPalette(o.query)
	rows := make([]row, len(items))
	for i, it := range items {
		rows[i] = row{Key: it.Name, Title: it.Name, Desc: it.Desc}
	}
	l := list{state: loadReady, rows: rows, sel: o.sel}
	l.clamp()

	input := "› " + o.query + "▏"
	if o.query == "" {
		input = "› " + dimStyle.Render("输入以过滤…") + "▏"
	}
	lines := []string{headerStyle.Render("命令面板"), input, ""}
	lines = append(lines, renderList(l, width, listOverlayRows(height)-3)...)
	lines = append(lines, footerHint("↑↓ 选择  Enter 执行  Esc 关闭", countLabel(l.sel+1, len(l.rows))))
	return strings.Join(lines, "\n")
}

func (o *paletteOverlay) Summary() Summary {
	items := filterPalette(o.query)
	s := Summary{Kind: "palette", Title: "命令面板", State: "ready", Count: len(items)}
	if len(items) > 0 {
		s.First = items[0].Name
	}
	return s
}
