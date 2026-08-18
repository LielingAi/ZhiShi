use terminator::{platforms, AutomationError, Selector};

// Search the WHOLE UIA tree for notepad-ish windows (top-level list missed it).
#[tokio::main]
async fn main() -> Result<(), AutomationError> {
    tracing_subscriber::fmt::Subscriber::builder()
        .with_max_level(tracing::Level::WARN)
        .init();

    let engine = platforms::create_engine(true, false)?;

    // 1) any Window with notepad-ish name anywhere in the tree
    for pat in ["无标题", "Notepad", "记事本", "AppCraft"] {
        let sel = Selector::Role { role: "Window".to_string(), name: Some(pat.to_string()) };
        match engine.find_element(&sel, None, None) {
            Ok(el) => {
                let pid = el.process_id().unwrap_or(0);
                println!("[diag] FOUND window matching {pat:?}: pid={pid} name={:?}", el.name().unwrap_or_default());
            }
            Err(_) => println!("[diag] no window matching {pat:?}"),
        }
    }

    // 2) what process name do the 16 notepad stubs resolve to? print PIDs from tasklist for reference
    println!("[diag] done");
    Ok(())
}
