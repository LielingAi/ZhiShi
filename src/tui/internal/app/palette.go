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
	PaletteAttach
	PaletteSearch
	PaletteAutoRun
	PaletteChoices
	PaletteHistory
	PaletteHelp
)

// PaletteItem 是一条面板条目。
type PaletteItem struct {
	Name   string
	Desc   string
	Insert string        // 非空 = 把这条命令模板填进输入框（不直接执行）
	Action PaletteAction // Insert 为空时执行
}

// paletteItems 是动作 + 命令模板。
//
// 2.2：Ctrl+K 从「命令模板列表」升级成**动作中心**——先列能直接执行的动作
// （发现靠这里），命令模板留在后面给需要参数的操作（Insert 只填不执行）。
// 斜杠命令的**执行**仍不在这里：`/xxx` 一律交给 CLI 子进程（slash.go），
// 这里只是入口索引，不是第二份命令表。
func paletteItems() []PaletteItem {
	return append([]PaletteItem{
		{Name: "会话操作", Desc: "重置 / 回退 / 分叉 / 切模型 / 权限 / 导出报告（Alt+x）", Action: PaletteSessionActions},
		{Name: "attach 到环境", Desc: "进选中环境的远端终端；Ctrl-] 两次退出（Alt+s）", Action: PaletteAttach},
		{Name: "打开环境面板", Desc: "切换 / 启动 / 停止 / 删除环境（Alt+e）", Action: PaletteOpenEnv},
		{Name: "打开任务面板", Desc: "计划任务清单与详情（Alt+t）", Action: PaletteOpenTask},
		{Name: "打开研究档案", Desc: "假设 / 证据 / 结论 / 未决问题（Alt+a）", Action: PaletteOpenArchive},
		{Name: "打开研究线", Desc: "历史会话：切线 / 归档 / 重命名 / 删除（Alt+l）", Action: PaletteOpenLine},
		{Name: "打开自动循环", Desc: "阶段 / 轮次 / 预算，新建或终止（Alt+w）", Action: PaletteAutoRun},
		{Name: "打开待答请求", Desc: "决策 / 越界审批（Alt+d）", Action: PaletteChoices},
		{Name: "搜索", Desc: "本会话 → 记忆 / 专家 / 情报（Ctrl+F）", Action: PaletteSearch},
		{Name: "打开历史回看", Desc: "当前线的历史消息（Alt+h）", Action: PaletteHistory},
		{Name: "键位帮助", Desc: "所有快捷键与面板说明（F1）", Action: PaletteHelp},
		{Name: "跳到最后一块", Desc: "回到底部并跟随输出", Action: PaletteJumpBottom},
		{Name: "只看失败", Desc: "切换失败块过滤", Action: PaletteToggleFailed},
		{Name: "重连", Desc: "重新订阅 /chat/stream", Action: PaletteReconnect},
		{Name: "复制会话摘要", Desc: "把最近若干块拼成摘要复制（桩）", Action: PaletteCopySummary},
	}, commandTemplates()...)
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
		// 描述用子串匹配（输入 attach / 环境 / 任务都能命中动作），
		// 名称仍用子序列——名称短，容忍拼写；描述长，子序列噪声太大。
		name := strings.ToLower(it.Name)
		desc := strings.ToLower(it.Desc)
		if fuzzyMatch(q, name) || fuzzyMatch(q, strings.TrimPrefix(name, "/")) || strings.Contains(desc, q) {
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

// paletteOverlay 是动作中心：输入过滤 + 列表 + Enter 执行。
//
// Sel 是**过滤后**列表的下标——查询一变就要收敛，否则 Enter 会执行一个
// 用户根本没看到的条目。
type paletteOverlay struct {
	query string
	sel   int
}

func newPaletteOverlay() *paletteOverlay { return &paletteOverlay{} }

func (o *paletteOverlay) Title() string { return "动作中心" }

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
	case PaletteAttach:
		// 与 Alt+s 同一目标规则：面板光标优先，否则当前锚定环境。
		target := m.SelectedEnvID
		if target == "" {
			target = m.EnvironmentID
		}
		return attachCmd(m.Ctx, m.Client, target)
	case PaletteSearch:
		m.PushOverlay(newSearchOverlay())
		return nil
	case PaletteAutoRun:
		ov := newAutoRunOverlay()
		m.PushOverlay(ov)
		return loadAutoRunCmd(m.Ctx, m.Admin, m.AutoRun)
	case PaletteChoices:
		if len(m.Choices) == 0 {
			m.LastNotice = "当前没有待答的选择"
			return nil
		}
		m.PushOverlay(newChoiceOverlay(m.Choices[0].id))
		return nil
	case PaletteHistory:
		return m.openHistoryOverlay()
	case PaletteHelp:
		m.PushOverlay(&helpOverlay{})
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
		input = "› " + dimStyle.Render("搜索动作或命令…（如 attach / 环境 / 报告）") + "▏"
	}
	lines := []string{headerStyle.Render("动作中心"), input, ""}
	lines = append(lines, renderList(l, width, listOverlayRows(height)-3)...)
	lines = append(lines, footerHint("↑↓ 选择  Enter 执行  Esc 关闭", countLabel(l.sel+1, len(l.rows))))
	return strings.Join(lines, "\n")
}

func (o *paletteOverlay) Summary() Summary {
	items := filterPalette(o.query)
	s := Summary{Kind: "palette", Title: "动作中心", State: "ready", Count: len(items)}
	if len(items) > 0 {
		s.First = items[0].Name
	}
	return s
}
