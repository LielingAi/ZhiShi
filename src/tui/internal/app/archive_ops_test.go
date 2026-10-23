package app

import (
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"

	"github.com/lielingai/zhishi/tui/internal/client"
)

func archiveOverlayWith(m Model, groups ...archiveGroup) Model {
	ov := newArchiveOverlay()
	ov.apply(groups, nil, nil)
	m.PushOverlay(ov)
	return m
}

func TestArchiveCursorAndResolve(t *testing.T) {
	m := archiveOverlayWith(testModel(),
		archiveGroup{kind: "hypothesis", rows: []row{{Key: "H#1", Desc: "扫描器可用"}}},
		archiveGroup{kind: "question", rows: []row{{Key: "Q#1", Desc: "22 为何超时"}}},
	)
	m.Admin = &fakeAdmin{}
	m, _ = m.Update(tea.KeyMsg{Type: tea.KeyDown})
	ov, _ := lastOverlayOf[*archiveOverlay](&m)
	if ov.sel != 1 {
		t.Fatalf("↓ 应移到第二条，实际 %d", ov.sel)
	}
	m, cmd := m.Update(runes("v"))
	if cmd == nil {
		t.Fatal("v 应发 resolve")
	}
	if msg := cmd().(archiveOpDoneMsg); msg.id != "Q#1" || msg.op != "resolve" {
		t.Fatalf("resolve 目标不对：%+v", msg)
	}
}

func TestArchiveCorrectRequiresReason(t *testing.T) {
	m := archiveOverlayWith(testModel(),
		archiveGroup{kind: "finding", rows: []row{{Key: "C#1", Desc: "结论"}}},
	)
	m.Admin = &fakeAdmin{}
	m, _ = m.Update(runes("c"))
	ov, ok := m.TopOverlay()
	if !ok {
		t.Fatal("c 应弹输入框")
	}
	if _, isPrompt := ov.(*promptOverlay); !isPrompt {
		t.Fatalf("栈顶应是输入框，实际 %T", ov)
	}
	// 空原因 → 只提示，不发命令
	m, cmd := m.Update(tea.KeyMsg{Type: tea.KeyEnter})
	if cmd == nil {
		t.Fatal("应返回提示命令")
	}
	if msg := cmd(); msg == nil || !strings.Contains(typeName(msg), "notice") {
		t.Fatalf("空原因应只提示，实际 %T", msg)
	}
}

func TestArchiveAbandonWithReason(t *testing.T) {
	m := archiveOverlayWith(testModel(),
		archiveGroup{kind: "hypothesis", rows: []row{{Key: "H#2", Desc: "假设"}}},
	)
	m.Admin = &fakeAdmin{}
	m, _ = m.Update(runes("a"))
	for _, r := range "线索不足" {
		m, _ = m.Update(runes(string(r)))
	}
	m, cmd := m.Update(tea.KeyMsg{Type: tea.KeyEnter})
	if cmd == nil {
		t.Fatal("应发出搁置命令")
	}
	if msg := cmd().(archiveOpDoneMsg); msg.op != "abandon" || !strings.Contains(msg.id, "H#2") {
		t.Fatalf("搁置参数不对：%+v", msg)
	}
}

// Enter 打开详情：面板行只有一行摘要，全文/链接/反证要在详情里看到。
func TestArchiveDetailShowsFullText(t *testing.T) {
	m := testModel()
	m.Admin = &fakeAdmin{}
	m.PushOverlay(newArchiveOverlay())
	ov, _ := lastOverlayOf[*archiveOverlay](&m)
	ov.apply([]archiveGroup{
		{kind: "hypothesis", rows: []row{{Key: "H#1", Desc: "短摘要"}}},
	}, nil, []client.ArchiveEntity{{
		ID: "H#1", Kind: "hypothesis", Status: "proposed",
		Text:  "完整假设正文：扫描器在 133 上可用，因为 22 端口开放",
		Links: []string{"V#2"}, Against: []string{"C#3"}, NeedsReview: true,
	}})

	m, _ = m.Update(tea.KeyMsg{Type: tea.KeyEnter})
	out := m.View()
	for _, want := range []string{"完整假设正文", "待验证", "待复核", "V#2", "C#3", "Esc 关闭"} {
		if !strings.Contains(out, want) {
			t.Fatalf("详情应包含 %q：\n%s", want, out)
		}
	}
}

// 详情层的 v/c/a 必须真的可用——上一版只写了提示、没接线。
func TestArchiveDetailActions(t *testing.T) {
	openDetail := func(t *testing.T) Model {
		t.Helper()
		m := testModel()
		m.Admin = &fakeAdmin{}
		m.SessionID = "line-1"
		m.PushOverlay(newArchiveOverlay())
		ov, _ := lastOverlayOf[*archiveOverlay](&m)
		ov.apply([]archiveGroup{{kind: "hypothesis", rows: []row{{Key: "H#1", Desc: "x"}}}}, nil,
			[]client.ArchiveEntity{{ID: "H#1", Kind: "hypothesis", Status: "proposed", Text: "正文"}})
		m, _ = m.Update(tea.KeyMsg{Type: tea.KeyEnter})
		if _, ok := lastOverlayOf[*detailOverlay](&m); !ok {
			t.Fatal("前置条件：详情层没打开")
		}
		return m
	}

	// v → 直接发 resolve，详情关闭
	m := openDetail(t)
	m, cmd := m.Update(runes("v"))
	if cmd == nil {
		t.Fatal("详情层 v 应发 resolve")
	}
	if msg := cmd().(archiveOpDoneMsg); msg.op != "resolve" || msg.id != "H#1" {
		t.Fatalf("resolve 参数不对：%+v", msg)
	}
	if _, ok := lastOverlayOf[*detailOverlay](&m); ok {
		t.Fatal("动作后详情应关闭")
	}

	// c → 弹纠错输入框（详情让位）
	m = openDetail(t)
	m, _ = m.Update(runes("c"))
	top, ok := m.TopOverlay()
	if !ok {
		t.Fatal("c 应弹输入框")
	}
	if _, isPrompt := top.(*promptOverlay); !isPrompt {
		t.Fatalf("栈顶应是输入框，实际 %T", top)
	}
}
