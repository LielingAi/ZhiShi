// Package store 是 stream 区的数据表：按 ID 索引、保持插入顺序的 block 列表。
//
// 它替代"前端自己拼消息"的老做法——sidecar 的每个事件都归约到某个 block 上，
// 渲染层只认 Block，不再关心事件名。
package store

import (
	"time"
)

// Kind 是 block 的种类，决定渲染头与折叠策略。
type Kind int

const (
	KindUser Kind = iota
	KindAssistant
	KindTool
	KindThinking
	KindError
	KindNotice
)

// String 供日志与探针输出用。
func (k Kind) String() string {
	switch k {
	case KindUser:
		return "user"
	case KindAssistant:
		return "assistant"
	case KindTool:
		return "tool"
	case KindThinking:
		return "thinking"
	case KindError:
		return "error"
	default:
		return "notice"
	}
}

// Block 是 stream 区的一行/一段。
//
// 渲染缓存以 Version 为唯一脏标记：内容真的变了才 +1，否则缓存被无意义的
// 帧打穿（流式 turn 里每秒几十帧很常见）。
type Block struct {
	ID      string
	Kind    Kind
	Version int

	// 头部字段。工具块用 Title 存工具名，Duration 存自量耗时。
	//
	// 没有 ExitCode：sidecar 的 chat:tool-result-complete 只给
	// {toolUseId, content, isError}（packages/zhishi-loop-core/src/sse-adapter.ts），
	// wire 重放也只给 ok:bool——真实退出码根本不到前端。所以这里只有
	// Failed（ok/fail 二态），不伪装成 exit code。
	Title    string
	Duration time.Duration

	// 正文。Body 是累积后的纯文本（含换行）。
	Body string

	// Live 表示这块仍在流式产出（渲染时留光标）。
	Live bool
	// Expanded 表示展开（Alt+r 切换）。折叠态只显示前若干行。
	Expanded bool
	// Failed 表示终态失败（isError / wire 的 ok=false）。
	Failed bool
}

// Store 是 block 表。零值可用。
type Store struct {
	order []string
	byID  map[string]Block
}

// Len 返回块数。
func (s *Store) Len() int { return len(s.order) }

// Upsert 按 ID + Version 写入：同一 ID 只在传入 Version 更大时替换。
//
// Version 单调是重连对账的前提——/chat/stream 重连会重放整个冷历史，
// 没有版本号的话重放会把 live 累积的内容覆盖回去。
func (s *Store) Upsert(b Block) bool {
	if s.byID == nil {
		s.byID = make(map[string]Block)
	}
	if old, ok := s.byID[b.ID]; ok {
		if b.Version <= old.Version {
			return false
		}
		// 展开态是用户状态，重放不该把它抹掉。
		b.Expanded = b.Expanded || old.Expanded
		s.byID[b.ID] = b
		return true
	}
	s.order = append(s.order, b.ID)
	s.byID[b.ID] = b
	return true
}

// Mutate 原地改一个块，并在内容真的变化时递增 Version。
//
// 返回 false 表示块不存在。Version 的自增只发生在 fn 报告"变了"的时候，
// 所以 fn 里改了字段就要返回 true——这是渲染缓存的唯一脏来源。
func (s *Store) Mutate(id string, fn func(*Block) bool) bool {
	b, ok := s.byID[id]
	if !ok {
		return false
	}
	if !fn(&b) {
		s.byID[id] = b
		return true
	}
	b.Version++
	s.byID[id] = b
	return true
}

// Delete 移除一个块（保持其余块的插入顺序）。
//
// 用途：发送时先本地回显一条用户消息，重连/回放又送来同一条时把本地那条删掉，
// 免得同一条消息在屏幕上出现两次。
func (s *Store) Delete(id string) bool {
	if _, ok := s.byID[id]; !ok {
		return false
	}
	delete(s.byID, id)
	for i, x := range s.order {
		if x == id {
			s.order = append(s.order[:i], s.order[i+1:]...)
			break
		}
	}
	return true
}

// Get 取一个块。
func (s *Store) Get(id string) (Block, bool) {
	b, ok := s.byID[id]
	return b, ok
}

// At 取第 i 个块（按插入顺序）。
func (s *Store) At(i int) (Block, bool) {
	if i < 0 || i >= len(s.order) {
		return Block{}, false
	}
	b, ok := s.byID[s.order[i]]
	return b, ok
}

// List 返回按插入顺序的副本。渲染与统计都走它，避免把内部 map 泄出去。
func (s *Store) List() []Block {
	out := make([]Block, 0, len(s.order))
	for _, id := range s.order {
		out = append(out, s.byID[id])
	}
	return out
}

// FilterFailed 返回只看失败视图下的可见块（M0 是 Alt+f 的桩实现）。
func (s *Store) FilterFailed() []Block {
	out := make([]Block, 0, len(s.order))
	for _, id := range s.order {
		if b := s.byID[id]; b.Failed || b.Kind == KindError {
			out = append(out, b)
		}
	}
	return out
}

// Reset 清空（换线/重连冷启动时用）。
func (s *Store) Reset() {
	s.order = nil
	s.byID = nil
}
