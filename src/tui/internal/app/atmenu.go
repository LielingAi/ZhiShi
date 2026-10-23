package app

// `@` 补全：工作区文件。
//
// 与 GUI 的 @ chip 不同，TUI 这一版只做**文本补全**（把 `@apps/web/x.go` 插进
// 消息），不发结构化 refs——refs 协议面（`chat/send {refs}`）留给下一轮，先把
// "不用手打长路径"这个高频小需求解决掉。
//
// 数据来自 GET /api/workspace/files?agentDir=<本会话 agentDir>&depth=2：
// 只拉两层，够覆盖 src/** 与 app/**；更深路径靠继续打字过滤。

import (
	"context"
	"strings"
	"time"

	tea "github.com/charmbracelet/bubbletea"

	"github.com/lielingai/zhishi/tui/internal/client"
)

const atMenuMaxRows = 8

type atItem struct {
	path string
	dir  bool
}

type atMenu struct {
	items []atItem
	sel   int
	// start 是消息里 `@` 的位置：接受补全时从这里到尾替换。
	start int
}

// atToken 找消息末尾的 `@token`（token 里不能有空白）。
func atToken(input string) (query string, start int, ok bool) {
	i := strings.LastIndex(input, "@")
	if i < 0 {
		return "", 0, false
	}
	// `@` 必须位于开头或空白之后（避免邮箱地址 a@b 触发）。
	if i > 0 {
		prev := rune(input[i-1])
		if prev != ' ' && prev != '\t' && prev != '\n' {
			return "", 0, false
		}
	}
	rest := input[i+1:]
	if strings.ContainsAny(rest, " \t\n") {
		return "", 0, false
	}
	return rest, i, true
}

// buildAtMenu 按当前输入与文件表算候选（前缀匹配，忽略大小写）。
func buildAtMenu(input string, files []client.WorkspaceFile) *atMenu {
	query, start, ok := atToken(input)
	if !ok {
		return nil
	}
	q := strings.ToLower(query)
	var items []atItem
	for _, f := range files {
		p := f.Path
		if q == "" || strings.Contains(strings.ToLower(p), q) {
			items = append(items, atItem{path: p, dir: f.Type == "dir"})
			if len(items) >= 200 {
				break
			}
		}
	}
	if len(items) == 0 {
		return nil
	}
	return &atMenu{items: items, start: start}
}

func (m *atMenu) move(delta int) {
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

func (m *atMenu) selected() (atItem, bool) {
	if m == nil || len(m.items) == 0 {
		return atItem{}, false
	}
	if m.sel < 0 || m.sel >= len(m.items) {
		return m.items[0], true
	}
	return m.items[m.sel], true
}

// AtRows 是候选浮层占的行数（0 = 不显示）。
func (m Model) AtRows() int {
	if m.At == nil || len(m.At.items) == 0 {
		return 0
	}
	n := len(m.At.items)
	if n > atMenuMaxRows {
		n = atMenuMaxRows
	}
	return n
}

func (m Model) viewAtMenu() string {
	rows := m.AtRows()
	if rows == 0 {
		return ""
	}
	items := m.At.items
	start := 0
	if m.At.sel >= rows {
		start = m.At.sel - rows + 1
	}
	lines := make([]string, 0, rows)
	for i := start; i < len(items) && i < start+rows; i++ {
		it := items[i]
		mark := "  "
		style := valueStyle
		if i == m.At.sel {
			mark = "▸ "
			style = selStyle
		}
		suffix := ""
		if it.dir {
			suffix = "/"
		}
		lines = append(lines, "  "+mark+style.Render(truncateWidth(it.path, m.VisibleWidth()-6))+suffix)
	}
	return strings.Join(lines, "\n")
}

// applyAt 把选中项插进消息（保留前导 `@`）。
func (m *Model) applyAt() {
	it, ok := m.At.selected()
	if !ok {
		return
	}
	text := m.Input.Value()
	start := 0
	if m.At != nil {
		start = m.At.start
	}
	if start < 0 || start > len(text) {
		start = len(text)
	}
	m.Input.Reset()
	m.Input.InsertString(text[:start] + "@" + it.path + " ")
	m.At = nil
	m.layout()
}

// refreshAt 在每次输入后重算候选；文件表没拉过时返回加载命令。
func (m *Model) refreshAt() tea.Cmd {
	if _, _, ok := atToken(m.Input.Value()); !ok {
		m.At = nil
		return nil
	}
	m.At = buildAtMenu(m.Input.Value(), m.AtFiles)
	if m.AtLoaded || m.AtLoading {
		return nil
	}
	m.AtLoading = true
	return loadAtCmd(m.Ctx, m.Client, m.Workspace)
}

type atLoadedMsg struct {
	files []client.WorkspaceFile
	err   error
}

func loadAtCmd(ctx context.Context, c *client.Client, agentDir string) tea.Cmd {
	return func() tea.Msg {
		if c == nil {
			return atLoadedMsg{}
		}
		reqCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
		defer cancel()
		files, err := c.WorkspaceFiles(reqCtx, agentDir, 2)
		return atLoadedMsg{files: files, err: err}
	}
}

// extractRefs 把消息里的 `@token` 变成结构化引用。
//
//   - 与已知文件表精确匹配 → {type:'file', path}
//   - `@env:<id>` → {type:'env', id}
//
// 不匹配的 token 原样留在文本里（可能是邮箱、代码片段），不猜、不报错。
// 服务端 parseChatRefs 对非法条目只告警不阻断，所以这里宁可少发。
func (m Model) extractRefs(text string) []client.ChatRef {
	known := make(map[string]struct{}, len(m.AtFiles))
	for _, f := range m.AtFiles {
		known[f.Path] = struct{}{}
	}
	seen := make(map[string]struct{})
	var refs []client.ChatRef
	for _, field := range strings.Fields(text) {
		i := strings.Index(field, "@")
		if i < 0 {
			continue
		}
		// 中文标点常紧跟 token 且不带空格（"@id，别管"）：在第一个标点处截断，
		// 再按 ASCII 标点收尾。
		token := field[i+1:]
		if cut := strings.IndexAny(token, "，。；：！？、）】」”’"); cut >= 0 {
			token = token[:cut]
		}
		token = strings.Trim(token, ".,;:!?)]}\"'")
		if token == "" {
			continue
		}
		if id, ok := strings.CutPrefix(token, "env:"); ok && id != "" {
			key := "env:" + id
			if _, dup := seen[key]; dup {
				continue
			}
			seen[key] = struct{}{}
			refs = append(refs, client.ChatRef{Type: "env", ID: id})
			continue
		}
		if _, ok := known[token]; !ok {
			continue
		}
		if _, dup := seen[token]; dup {
			continue
		}
		seen[token] = struct{}{}
		refs = append(refs, client.ChatRef{Type: "file", Path: token})
	}
	return refs
}
