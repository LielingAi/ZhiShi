package store

import (
	"testing"
	"time"
)

func TestUpsertKeepsInsertOrder(t *testing.T) {
	var s Store
	s.Upsert(Block{ID: "b", Version: 1})
	s.Upsert(Block{ID: "a", Version: 1})
	s.Upsert(Block{ID: "c", Version: 1})

	got := s.List()
	want := []string{"b", "a", "c"}
	if len(got) != len(want) {
		t.Fatalf("块数 %d，期望 %d", len(got), len(want))
	}
	for i, id := range want {
		if got[i].ID != id {
			t.Fatalf("第 %d 块是 %q，期望 %q（顺序必须按插入序，不能是 map 序）", i, got[i].ID, id)
		}
	}
}

func TestUpsertRejectsStaleVersion(t *testing.T) {
	var s Store
	s.Upsert(Block{ID: "x", Version: 2, Body: "new"})

	if ok := s.Upsert(Block{ID: "x", Version: 1, Body: "old"}); ok {
		t.Fatal("低版本重放不该覆盖高版本内容（重连重放会把 live 累积冲掉）")
	}
	b, _ := s.Get("x")
	if b.Body != "new" {
		t.Fatalf("正文被旧版本覆盖：%q", b.Body)
	}
	if n := s.Len(); n != 1 {
		t.Fatalf("同一 ID 应只有一块，实际 %d", n)
	}

	if ok := s.Upsert(Block{ID: "x", Version: 3, Body: "newer"}); !ok {
		t.Fatal("更高版本应当被接受")
	}
	b, _ = s.Get("x")
	if b.Body != "newer" {
		t.Fatalf("高版本未生效：%q", b.Body)
	}
}

func TestUpsertKeepsExpandedAcrossReplay(t *testing.T) {
	var s Store
	s.Upsert(Block{ID: "x", Version: 1})
	s.Mutate("x", func(b *Block) bool { b.Expanded = true; return true })

	// 重放一侧不知道用户是否展开了，默认是 false——不能把用户状态抹掉。
	s.Upsert(Block{ID: "x", Version: 2, Expanded: false})
	b, _ := s.Get("x")
	if !b.Expanded {
		t.Fatal("重放把用户的展开态抹掉了")
	}
}

func TestMutateBumpsVersionOnlyWhenContentChanges(t *testing.T) {
	var s Store
	s.Upsert(Block{ID: "x", Version: 1})

	s.Mutate("x", func(b *Block) bool { return false })
	if b, _ := s.Get("x"); b.Version != 1 {
		t.Fatalf("没变化也递增了版本（会打穿渲染缓存）：version=%d", b.Version)
	}

	s.Mutate("x", func(b *Block) bool { b.Body = "hi"; return true })
	if b, _ := s.Get("x"); b.Version != 2 {
		t.Fatalf("内容变了版本没动：version=%d", b.Version)
	}
}

func TestMutateMissingBlockIsNoop(t *testing.T) {
	var s Store
	if s.Mutate("ghost", func(b *Block) bool { return true }) {
		t.Fatal("改不存在的块应返回 false")
	}
	if s.Len() != 0 {
		t.Fatal("Mutate 不该凭空造块")
	}
}

func TestFilterFailed(t *testing.T) {
	var s Store
	s.Upsert(Block{ID: "ok", Kind: KindTool})
	s.Upsert(Block{ID: "bad", Kind: KindTool, Failed: true})
	s.Upsert(Block{ID: "err", Kind: KindError})

	got := s.FilterFailed()
	if len(got) != 2 {
		t.Fatalf("只看失败应命中 2 块，实际 %d", len(got))
	}
	for _, b := range got {
		if !b.Failed && b.Kind != KindError {
			t.Fatalf("过滤漏了非失败块 %q", b.ID)
		}
	}
}

func TestAtBounds(t *testing.T) {
	var s Store
	s.Upsert(Block{ID: "x", Version: 1, Kind: KindTool, Title: "Bash", Duration: time.Second})
	if _, ok := s.At(-1); ok {
		t.Fatal("负下标应返回 false")
	}
	if _, ok := s.At(1); ok {
		t.Fatal("越界下标应返回 false")
	}
	b, ok := s.At(0)
	if !ok || b.Title != "Bash" {
		t.Fatalf("At(0) 取错块：%+v", b)
	}
}
