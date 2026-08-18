use terminator::{platforms, AutomationError, Selector};
use std::time::Duration;

// Dump notepad's menu bar items to see what the "文件" menu actually looks like.
#[tokio::main]
async fn main() -> Result<(), AutomationError> {
    tracing_subscriber::fmt::Subscriber::builder()
        .with_max_level(tracing::Level::WARN)
        .init();

    let engine = platforms::create_engine(true, false)?;

    // Find the notepad window by process
    let apps = engine.get_applications()?;
    let notepad = apps
        .iter()
        .find(|a| a.process_name().map(|n| n.to_lowercase().contains("notepad")).unwrap_or(false))
        .ok_or(AutomationError::ElementNotFound("no notepad process".into()))?;
    println!("[diag] found notepad window");

    // Get all descendants and print control_type + name for menu-ish items
    let tree = engine.find_elements(&Selector::Role { role: "MenuItem".to_string(), name: None }, Some(notepad), None, Some(10))?;
    println!("[diag] MenuItem count: {}", tree.len());
    for el in tree.iter().take(20) {
        let name = el.name().unwrap_or_default();
        let role = el.role();
        println!("  [{}] {}", role, name);
    }

    // Also try the exact selector the replay uses
    match engine.find_element(&Selector::Role {
        role: "MenuItem".to_string(),
        name: Some("文件".to_string()),
    }, Some(notepad), None) {
        Ok(_) => println!("[diag] selector 'role:MenuItem && name:文件' => FOUND"),
        Err(e) => println!("[diag] selector 'role:MenuItem && name:文件' => NOT FOUND: {e}"),
    }

    let _ = Duration::from_millis(0);
    Ok(())
}
