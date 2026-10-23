package style

import "testing"

func TestResolveThemes(t *testing.T) {
	cases := map[string]string{
		"":                 "#89b4fa", // 缺省 catppuccin
		"catppuccin":       "#89b4fa",
		"Catppuccin-Mocha": "#89b4fa",
		"gruvbox":          "#83a598",
		"gruvbox_dark":     "#83a598",
		"rose-pine":        "#9ccfd8",
		"Rose Pine":        "#9ccfd8", // 空格不识别 → 回落缺省
		"rose_pine":        "#9ccfd8",
		"nonsense-theme":   "#89b4fa",
	}
	for in, want := range cases {
		if got := resolve(in).Accent; got != want {
			t.Fatalf("resolve(%q).Accent = %s，期望 %s", in, got, want)
		}
	}
}

func TestPaletteFieldsNonEmpty(t *testing.T) {
	for _, name := range Names() {
		p := resolve(name)
		for field, v := range map[string]string{
			"Bg": p.Bg, "Accent": p.Accent, "User": p.User, "Tool": p.Tool,
			"OK": p.OK, "Fail": p.Fail, "Warn": p.Warn, "Notice": p.Notice,
			"Text": p.Text, "Dim": p.Dim, "Faint": p.Faint,
		} {
			if v == "" {
				t.Fatalf("%s 主题缺字段 %s", name, field)
			}
		}
	}
}
