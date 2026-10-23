package app

// 搜索面板（Ctrl+F）：先搜当前会话，再按 Tab 扩到三套知识库。
//
// 设计取舍：
//   - 一个输入框 + 一个 scope chip（本地 → 记忆 → 专家 → 情报），Tab 循环。
//     不做多输入框/多页签——搜索的瓶颈是"想到查什么"，不是切换成本。
//   - 本地搜索**边打边搜**（纯内存，几十块字符串包含），远程检索**回车才发**
//     （SQLite/FTS 与网络都不该跟着每个字符跑）。
//   - 本地命中回车 = 跳过去（关面板 + 光标定位 + 滚到可见）；远程命中回车 =
//     展开正文（搜索结果是"线索"，读全文才是目的）。

import (
	"context"
	"fmt"
	"strings"
	"time"

	tea "github.com/charmbracelet/bubbletea"
)

type searchScope int

const (
	scopeLocal searchScope = iota
	scopeMemory
	scopeExpert
	scopeIntel
)

func (s searchScope) String() string {
	switch s {
	case scopeMemory:
		return "记忆"
	case scopeExpert:
		return "专家"
	case scopeIntel:
		return "情报"
	default:
		return "本会话"
	}
}

// searchHit 是统一的结果行。
type searchHit struct {
	title string
	desc  string
	// blockID 非空 = 本地块，回车跳转。
	blockID string
	// body 非空 = 远程结果正文，回车展开。
	body string
}

type searchOverlay struct {
	scope   searchScope
	query   string
	hits    []searchHit
	sel     int
	note    string
	loading bool
}

func newSearchOverlay() *searchOverlay { return &searchOverlay{} }

func (o *searchOverlay) Title() string { return "搜索" }

func (o *searchOverlay) Handle(m *Model, msg tea.KeyMsg) tea.Cmd {
	switch msg.String() {
	case "tab":
		o.scope = searchScope((int(o.scope) + 1) % 4)
		o.hits = nil
		o.sel = 0
		o.note = ""
		if o.scope == scopeLocal {
			o.runLocal(m)
		}
		return nil
	case "backspace":
		if r := []rune(o.query); len(r) > 0 {
			o.query = string(r[:len(r)-1])
		}
		o.sel = 0
		if o.scope == scopeLocal {
			o.runLocal(m)
		}
		return nil
	case "up", "ctrl+p":
		o.sel--
	case "down", "ctrl+n":
		o.sel++
	case "enter":
		return o.submit(m)
	}
	if msg.Type == tea.KeyRunes && !msg.Alt {
		o.query += string(msg.Runes)
		if o.scope == scopeLocal {
			o.runLocal(m)
		}
	}
	if o.sel < 0 {
		o.sel = 0
	}
	if o.sel >= len(o.hits) {
		o.sel = len(o.hits) - 1
	}
	if o.sel < 0 {
		o.sel = 0
	}
	return nil
}

// runLocal 在当前块表里做子串匹配（标题 + 正文），最多 50 条。
func (o *searchOverlay) runLocal(m *Model) {
	o.hits = nil
	q := strings.ToLower(strings.TrimSpace(o.query))
	if q == "" {
		return
	}
	for _, b := range m.Store.List() {
		if len(o.hits) >= 50 {
			break
		}
		if strings.Contains(strings.ToLower(b.Body), q) || strings.Contains(strings.ToLower(b.Title), q) {
			desc := strings.ReplaceAll(b.Body, "\n", " ")
			o.hits = append(o.hits, searchHit{
				title:   blockLabel(b),
				desc:    truncateWidth(desc, 80),
				blockID: b.ID,
			})
		}
	}
	o.note = fmt.Sprintf("%d 条命中", len(o.hits))
}

func (o *searchOverlay) submit(m *Model) tea.Cmd {
	q := strings.TrimSpace(o.query)
	if q == "" {
		return nil
	}
	if o.scope == scopeLocal {
		if len(o.hits) == 0 {
			return nil
		}
		hit := o.hits[o.sel]
		m.PopOverlay()
		m.jumpToBlock(hit.blockID)
		return nil
	}
	// 远程命中：展开正文
	if len(o.hits) > 0 {
		hit := o.hits[o.sel]
		m.PopOverlay()
		m.PushOverlay(newNoticeOverlay(hit.title, hit.body))
		return nil
	}
	o.loading = true
	o.note = "检索中…"
	return searchRemoteCmd(m.Ctx, m.Admin, o.scope, q)
}

func (o *searchOverlay) Render(m Model, width, height int) string {
	lines := []string{headerStyle.Render("搜索") + "  " + selStyle.Render("["+o.scope.String()+"]") + dimStyle.Render("  Tab 切换范围")}
	lines = append(lines, "› "+o.query+"▏")
	if o.note != "" {
		lines = append(lines, dimStyle.Render(o.note))
	}
	maxRows := listOverlayRows(height) - 4
	if maxRows < 1 {
		maxRows = 1
	}
	start := 0
	if o.sel >= maxRows {
		start = o.sel - maxRows + 1
	}
	for i := start; i < len(o.hits) && i < start+maxRows; i++ {
		h := o.hits[i]
		mark := "  "
		style := valueStyle
		if i == o.sel {
			mark = "▸ "
			style = selStyle
		}
		lines = append(lines, mark+style.Render(truncateWidth(h.title, width-8))+
			dimStyle.Render("  "+truncateWidth(h.desc, width-16)))
	}
	hint := "↑↓ 选择  Enter 跳转  Tab 换范围  Esc 关闭"
	if o.scope != scopeLocal {
		hint = "Enter 检索/展开  Tab 换范围  Esc 关闭"
	}
	lines = append(lines, "", footerHint(hint, ""))
	return strings.Join(lines, "\n")
}

func (o *searchOverlay) Summary() Summary {
	return Summary{Kind: "search", Title: "搜索", State: "ready", Count: len(o.hits), First: o.scope.String()}
}

// jumpToBlock 把光标移到指定块并滚到可见。
func (m *Model) jumpToBlock(id string) {
	if i := m.indexOfVisible(id); i >= 0 {
		m.Cursor = i
		m.CursorTouched = true
		m.ensureCursorVisible()
	}
}

// ── 远程检索 ────────────────────────────────────────────────────────────

type searchResultMsg struct {
	scope searchScope
	hits  []searchHit
	err   error
}

func searchRemoteCmd(ctx context.Context, admin adminAPI, scope searchScope, q string) tea.Cmd {
	return func() tea.Msg {
		if admin == nil {
			return searchResultMsg{scope: scope, err: fmt.Errorf("没有可用的管理面客户端")}
		}
		reqCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
		defer cancel()
		switch scope {
		case scopeMemory:
			hits, err := admin.SearchMemory(reqCtx, q)
			if err != nil {
				return searchResultMsg{scope: scope, err: err}
			}
			out := make([]searchHit, 0, len(hits))
			for _, h := range hits {
				out = append(out, searchHit{
					title: h.Kind,
					desc:  truncateWidth(strings.ReplaceAll(h.Content, "\n", " "), 80),
					body:  fmt.Sprintf("%s\n\n来源：%s\nid：%s", h.Content, h.Source, h.ID),
				})
			}
			return searchResultMsg{scope: scope, hits: out}
		case scopeExpert:
			hits, err := admin.SearchExpert(reqCtx, q)
			if err != nil {
				return searchResultMsg{scope: scope, err: err}
			}
			out := make([]searchHit, 0, len(hits))
			for _, h := range hits {
				out = append(out, searchHit{
					title: fmt.Sprintf("E#%d %s", h.ID, h.Title),
					desc:  truncateWidth(strings.ReplaceAll(h.Content, "\n", " "), 80),
					body:  fmt.Sprintf("%s\n\n类型：%s  域：%s\nid：E#%d", h.Content, h.Kind, h.Domain, h.ID),
				})
			}
			return searchResultMsg{scope: scope, hits: out}
		case scopeIntel:
			text, n, err := admin.SearchIntel(reqCtx, q)
			if err != nil {
				return searchResultMsg{scope: scope, err: err}
			}
			return searchResultMsg{scope: scope, hits: []searchHit{{
				title: fmt.Sprintf("情报命中 %d 条", n),
				desc:  "回车展开",
				body:  text,
			}}}
		}
		return searchResultMsg{scope: scope}
	}
}
