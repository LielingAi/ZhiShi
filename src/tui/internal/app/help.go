package app

// F1 帮助面板。
//
// 为什么按"想做什么"分组而不是按键名字典序排：新手的问题是**不知道有什么**，
// 不是记不住某个键。旧版是一张 20 行的键表，看完仍然不知道"任务从哪看"。
// 现在按意图分段（看东西 / 发消息 / 会话操作 / 读内容 / 鼠标），每段第一行
// 直接回答"我想 X，按什么"。

import (
	"strings"

	tea "github.com/charmbracelet/bubbletea"
)

type helpOverlay struct{}

func (o *helpOverlay) Title() string { return "帮助" }

func (o *helpOverlay) Handle(m *Model, msg tea.KeyMsg) tea.Cmd {
	// 任何键都关（Esc 由路由统一处理，这里兜住其余键，避免落在输入框里）。
	m.PopOverlay()
	return nil
}

func (o *helpOverlay) Summary() Summary {
	n := 0
	for _, s := range helpSections {
		n += len(s.rows)
	}
	return Summary{Kind: "help", Title: "帮助", State: "ready", Count: n}
}

type helpSection struct {
	title string
	rows  [][2]string
}

var helpSections = []helpSection{
	{
		title: "想知道有什么（面板）",
		rows: [][2]string{
			{"Alt+t", "任务中心：Enter 看详情（描述/工作区/历史/文档）；c 续命、x 终止"},
			{"Alt+a", "研究档案：假设 / 结论 / 证据 / 未决问题；Enter 看详情，v/c/a 改判定"},
			{"Alt+e", "环境：切换、attach、停止、删除、重命名、配方"},
			{"Alt+l", "研究线（历史会话）：切线、归档、重命名、删除"},
			{"Alt+w", "自动循环：阶段 / 轮次 / 预算，新建或终止"},
			{"Alt+d", "待你决定的请求（决策 / 越界审批）；Esc 收起后在这里重开"},
		},
	},
	{
		title: "想找东西",
		rows: [][2]string{
			{"Ctrl+F", "搜索：本会话消息 → Tab 扩到记忆 / 专家 / 情报"},
			{"Ctrl+K", "动作中心：先列当前块的可用动作，再搜索全局动作与命令模板（可直接执行）"},
			{"F1", "本帮助"},
		},
	},
	{
		title: "发消息",
		rows: [][2]string{
			{"Enter", "发送（运行中则作为纠偏注入，进 Alt+q 的队列）"},
			{"Alt+Enter", "换行（Windows 下 Ctrl+J 与 Enter 同码，用这个）"},
			{"/", "CLI 子命令候选：/model list、/env list、/help …"},
			{"@", "工作区文件补全；命中的文件会作为结构化引用随消息发送"},
			{"Alt+i / Alt+u", "附加图片（输入或粘贴路径，≤8MB）/ 移除最后一张"},
			{"Alt+q", "查看/撤销排队与纠偏消息"},
		},
	},
	{
		title: "改会话",
		rows: [][2]string{
			{"Alt+x", "重置 / 回退到选中消息 / 分叉 / 切模型 / 权限模式 / 导出报告"},
			{"Alt+s", "attach 选中环境的远端终端"},
			{"Alt+h", "历史回看（只读 wire 回放）"},
		},
	},
	{
		title: "读内容",
		rows: [][2]string{
			{"Alt+j / Alt+k", "移动块光标（移出视口自动滚动）"},
			{"Alt+r", "折叠/展开工具输出与思考（正文超过 3 行才折）"},
			{"Alt+y", "复制当前块正文（OSC52）"},
			{"Alt+o", "外部程序打开当前块正文"},
			{"Alt+f", "只看失败块"},
			{"↑ / ↓", "滚动一行（多行输入时改为移动光标）"},
			{"PgUp / PgDn", "翻页；Alt+g 回底"},
		},
	},
	{
		title: "鼠标与退出",
		rows: [][2]string{
			{"F2 / Alt+m", "交还 / 接管鼠标（默认接管：滚轮+点块头；交还后终端可拖选）"},
			{"Ctrl+C", "跑着中断；空转连按两次退出"},
		},
	},
}

func (o *helpOverlay) Render(m Model, width, height int) string {
	keyW := 0
	for _, s := range helpSections {
		for _, r := range s.rows {
			if n := len([]rune(r[0])); n > keyW {
				keyW = n
			}
		}
	}
	lines := []string{headerStyle.Render("帮助") + dimStyle.Render("  按「想做什么」分组")}
	for _, s := range helpSections {
		lines = append(lines, "", headerStyle.Render(s.title))
		for _, r := range s.rows {
			key := r[0] + strings.Repeat(" ", keyW-len([]rune(r[0])))
			lines = append(lines, "  "+dimStyle.Render(key)+"  "+truncateWidth(r[1], width-keyW-2))
		}
	}
	lines = append(lines, "", footerHint("任意键关闭", ""))
	return strings.Join(lines, "\n")
}
