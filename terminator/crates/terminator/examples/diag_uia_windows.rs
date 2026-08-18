use terminator::platforms;
use terminator::AutomationError;

// Enumerate UIA top-level windows/panes and print name/control type/pid/process name.
#[tokio::main]
async fn main() -> Result<(), AutomationError> {
    tracing_subscriber::fmt::Subscriber::builder()
        .with_max_level(tracing::Level::WARN)
        .init();

    let engine = platforms::create_engine(true, false)?;
    let root = engine.get_root_element();
    let children = root.children()?;
    println!("top-level windows/panes: {}", children.len());
    for el in &children {
        let name = el.name().unwrap_or_default();
        let role = el.role();
        let pid = el.process_id().unwrap_or(0);
        if name.is_empty() && role != "Window" { continue; }
        println!("  [{}] pid={} name={:?}", role, pid, name);
    }
    Ok(())
}
