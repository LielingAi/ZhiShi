// Package style 是 TUI 的唯一配色来源。
//
// 为什么单独成包：样式分散在 render（块内容）和 app（外壳/状态行）两处，
// 各写一份调色板必然漂。这里只存颜色**键**，具体 lipgloss.Style 由使用方
// 构造，避免把布局依赖拖进来。
//
// 主题用 ZHISHI_THEME 选（catppuccin / gruvbox / rose-pine），缺省 catppuccin。
// 终端不支持真彩时 lipgloss 自动降级成无色——层级靠留白与字形，不靠颜色。
package style

import (
	"os"
	"strings"
)

// Palette 是一套主题的色键（十六进制）。
type Palette struct {
	Name   string
	Bg     string // 状态 chip 的文字色（深底）
	Accent string // 主色：品牌、助手块、输入框聚焦
	User   string // 用户消息
	Tool   string // 工具名
	OK     string // 成功
	Fail   string // 失败 / 错误
	Warn   string // 等待 / 中断
	Notice string // 提示
	Text   string // 正文强调值
	Dim    string // 次要信息
	Faint  string // 边框 / 分隔
}

var themes = map[string]Palette{
	"catppuccin": {
		Name: "catppuccin", Bg: "#1e1e2e", Accent: "#89b4fa", User: "#cba6f7",
		Tool: "#cdd6f4", OK: "#a6e3a1", Fail: "#f38ba8", Warn: "#f9e2af",
		Notice: "#89dceb", Text: "#cdd6f4", Dim: "#6c7086", Faint: "#45475a",
	},
	"gruvbox": {
		Name: "gruvbox", Bg: "#282828", Accent: "#83a598", User: "#d3869b",
		Tool: "#ebdbb2", OK: "#b8bb26", Fail: "#fb4934", Warn: "#fabd2f",
		Notice: "#8ec07c", Text: "#ebdbb2", Dim: "#928374", Faint: "#504945",
	},
	"rose-pine": {
		Name: "rose-pine", Bg: "#232136", Accent: "#9ccfd8", User: "#c4a7e7",
		Tool: "#e0def4", OK: "#9ccfd8", Fail: "#eb6f92", Warn: "#f6c177",
		Notice: "#ebbcba", Text: "#e0def4", Dim: "#6e6a86", Faint: "#393552",
	},
}

// Current 是本次进程生效的主题。
var Current = resolve(os.Getenv("ZHISHI_THEME"))

func resolve(name string) Palette {
	// 容忍手输差异：大小写、下划线、空格都按连字符处理。
	key := strings.ToLower(strings.TrimSpace(name))
	key = strings.NewReplacer("_", "-", " ", "-").Replace(key)
	switch key {
	case "catppuccin", "catppuccin-mocha", "mocha":
		return themes["catppuccin"]
	case "gruvbox", "gruvbox-dark":
		return themes["gruvbox"]
	case "rose-pine", "rosepine", "rose-pine-moon":
		return themes["rose-pine"]
	default:
		return themes["catppuccin"]
	}
}

// Names 返回可用主题（供文档/报错提示）。
func Names() []string { return []string{"catppuccin", "gruvbox", "rose-pine"} }
