//! UTF-8 BOM (U+FEFF) tolerance for JSON file readers.
//!
//! Background — issue #170 #6: Windows editors (Notepad, some PowerShell
//! redirects, certain "Save As UTF-8" toolchains) prepend a U+FEFF BOM to
//! UTF-8 files. `serde_json::from_str` does NOT tolerate the BOM and fails
//! with `expected value at line 1 column 1`. When the user manually edited
//! `~/.zhishi/config.json` with such a tool, ZhiShi would log the parse
//! error and fall back to the `.bak` backup — an opaque failure mode that
//! looked like data loss. ZhiShi itself never writes BOM (`serde_json::to_string_pretty`
//! produces clean UTF-8), so the fix is read-side: strip BOM before parsing.
//!
//! Use this helper at every JSON-reader site whose **source file** might be
//! externally edited (`config.json`, `cron_tasks.json`, `sessions.json`) — the
//! rule is keyed on the data source, not the consumer. The search indexer and
//! IM memory-update task also read `sessions.json` directly and so must
//! `strip_bom()` too. Pure app-internal files (Tantivy index segments,
//! ephemeral caches) don't need it.

/// Strip a leading UTF-8 BOM (U+FEFF) from a string slice. Returns the input
/// unchanged when no BOM is present (zero allocations either way).
pub fn strip_bom(content: &str) -> &str {
    content.strip_prefix('\u{FEFF}').unwrap_or(content)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_leading_bom() {
        assert_eq!(strip_bom("\u{FEFF}{\"a\":1}"), "{\"a\":1}");
    }

    #[test]
    fn passes_through_when_no_bom() {
        assert_eq!(strip_bom("{\"a\":1}"), "{\"a\":1}");
    }

    #[test]
    fn does_not_strip_bom_in_middle() {
        // Only a leading BOM is stripped — a U+FEFF inside a JSON string
        // value would be a legitimate (if unusual) character.
        assert_eq!(strip_bom("{\"a\":\"\u{FEFF}\"}"), "{\"a\":\"\u{FEFF}\"}");
    }

    #[test]
    fn empty_string() {
        assert_eq!(strip_bom(""), "");
    }
}
