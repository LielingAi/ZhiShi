package app

// 输入 `/` 时的命令候选（斜杠菜单）。
//
// 与命令面板（Ctrl+K）共用同一份模板：这里只是「手指不用离开输入框」的
// 快捷通道。模板只影响**发现**，执行永远是 CLI 子进程（slash.go）——
// 删光模板也不会少一条能力。

import (
	"strings"

	"github.com/charmbracelet/lipgloss"
)

// slashMenuMaxRows 是候选浮层最多占几行。再多会把 stream 挤没。
const slashMenuMaxRows = 8

// commandTemplates 是给人看的命令模板（Ctrl+K 与 `/` 菜单共用）。
//
// 不追求穷举 CLI 的每个子命令：常用路径给到手，其余照打就是——模板不是
// 能力边界（见文件头注释）。
func commandTemplates() []PaletteItem {
	return []PaletteItem{
		{Name: "/model list", Desc: "provider / 默认模型", Insert: "/model list"},
		{Name: "/model set-key ", Desc: "写 provider key（<id> <key>）", Insert: "/model set-key "},
		{Name: "/model verify ", Desc: "验证 provider 是否可用", Insert: "/model verify "},
		{Name: "/model set-default ", Desc: "切默认模型", Insert: "/model set-default "},
		{Name: "/model add ", Desc: "加自定义 provider", Insert: "/model add "},
		{Name: "/env list", Desc: "环境清单（id / kind / target）", Insert: "/env list"},
		{Name: "/env add ", Desc: "新增环境（--kind ssh|vm|docker …）", Insert: "/env add "},
		{Name: "/env probe ", Desc: "重推环境能力", Insert: "/env probe "},
		{Name: "/task list", Desc: "任务清单", Insert: "/task list"},
		{Name: "/task get ", Desc: "任务详情", Insert: "/task get "},
		{Name: "/memory search ", Desc: "检索长期记忆", Insert: "/memory search "},
		{Name: "/expert list", Desc: "专家知识库", Insert: "/expert list"},
		{Name: "/expert search ", Desc: "专家库检索", Insert: "/expert search "},
		{Name: "/domain list", Desc: "域包清单", Insert: "/domain list"},
		{Name: "/intel status", Desc: "情报索引状态", Insert: "/intel status"},
		{Name: "/research log ", Desc: "记录研究信号", Insert: "/research log "},
		{Name: "/agent list", Desc: "子代理清单", Insert: "/agent list"},
		{Name: "/auth list", Desc: "团队 token 清单", Insert: "/auth list"},
		{Name: "/line list", Desc: "会话线清单", Insert: "/line list"},
		{Name: "/config get", Desc: "当前配置", Insert: "/config get"},
		{Name: "/status", Desc: "引擎状态", Insert: "/status"},
		{Name: "/version", Desc: "版本", Insert: "/version"},
		{Name: "/reload", Desc: "热重载配置", Insert: "/reload"},
		{Name: "/help", Desc: "CLI 总帮助", Insert: "/help"},
	}
}

// slashMenu 是输入框上方的候选列表。空 items = 不显示。
type slashMenu struct {
	items []PaletteItem
	sel   int
}

// buildSlashMenu 按当前输入算候选；返回 nil 表示不该显示。
//
// 只在「第一个词还没打完」时出现（没有空白）：一旦开始打参数，候选只会挡住
// 输入，反而碍事。
func buildSlashMenu(input string) *slashMenu {
	s := strings.TrimLeft(input, " \t")
	if !strings.HasPrefix(s, "/") {
		return nil
	}
	rest := s[1:]
	if rest == "" {
		items := commandTemplates()
		return &slashMenu{items: items}
	}
	if strings.ContainsAny(rest, " \t\n") {
		return nil
	}
	query := strings.ToLower(rest)
	var items []PaletteItem
	for _, it := range commandTemplates() {
		cmd := strings.TrimSpace(it.Insert)
		if strings.HasPrefix(strings.ToLower(strings.TrimPrefix(cmd, "/")), query) {
			items = append(items, it)
		}
	}
	if len(items) == 0 {
		return nil
	}
	return &slashMenu{items: items}
}

func (m *slashMenu) move(delta int) {
	if m == nil || len(m.items) == 0 {
		return
	}
	m.sel += delta
	if m.sel < 0 {
		m.sel = len(m.items) - 1
	}
	if m.sel >= len(m.items) {
		m.sel = 0
	}
}

func (m *slashMenu) selected() (PaletteItem, bool) {
	if m == nil || len(m.items) == 0 {
		return PaletteItem{}, false
	}
	sel := m.sel
	if sel < 0 || sel >= len(m.items) {
		sel = 0
	}
	return m.items[sel], true
}

// acceptSlashMenu 把选中模板填进输入框（不执行）。填完通常已经有空格，
// 候选自然消失；单命令（/status）补一个尾部空格，让下一次 Enter 就是执行。
func (m *Model) acceptSlashMenu() {
	it, ok := m.Menu.selected()
	if !ok {
		m.Menu = nil
		return
	}
	text := it.Insert
	if !strings.HasSuffix(text, " ") {
		text += " " // 补一个空格：候选收起，接着就能打参数
	}
	m.Input.Reset()
	m.Input.InsertString(text)
	m.Menu = buildSlashMenu(m.Input.Value())
	m.layout()
}

// MenuRows 是浮层要占的行数（0 = 不显示）。
func (m Model) MenuRows() int {
	if m.Menu == nil || len(m.Menu.items) == 0 {
		return 0
	}
	n := len(m.Menu.items)
	if n > slashMenuMaxRows {
		n = slashMenuMaxRows
	}
	return n
}

// viewSlashMenu 画候选。窗口只显示 sel 附近的 8 行，长列表不会溢出。
func (m Model) viewSlashMenu() string {
	rows := m.MenuRows()
	if rows == 0 {
		return ""
	}
	items := m.Menu.items
	start := 0
	if m.Menu.sel >= rows {
		start = m.Menu.sel - rows + 1
	}
	end := start + rows
	if end > len(items) {
		end = len(items)
	}
	// 名字列对齐：模板名长短不一（`/model list` vs `/model set-default `），
	// 不对齐时右侧说明会参差，扫读成本高。
	width := 0
	for i := start; i < end; i++ {
		if n := len(strings.TrimRight(items[i].Name, " ")); n > width {
			width = n
		}
	}
	lines := make([]string, 0, rows)
	for i := start; i < end; i++ {
		it := items[i]
		mark := "  "
		nameStyle := lipgloss.NewStyle()
		if i == m.Menu.sel {
			mark = "▸ "
			nameStyle = selStyle
		}
		name := strings.TrimRight(it.Name, " ")
		pad := strings.Repeat(" ", width-len(name))
		lines = append(lines, "  "+mark+nameStyle.Render(name)+pad+"  "+dimStyle.Render(it.Desc))
	}
	return strings.Join(lines, "\n")
}
