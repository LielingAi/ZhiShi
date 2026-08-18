use terminator::{platforms, AutomationError, Selector};
use std::time::Duration;

// AppCraft spike: verify Terminator core library on Notepad.
// 1) open notepad, 2) type text via selector (role:Document),
// 3) invoke 文件 menu via UIA InvokePattern (no physical mouse).
#[tokio::main]
async fn main() -> Result<(), AutomationError> {
    tracing_subscriber::fmt::Subscriber::builder()
        .with_max_level(tracing::Level::WARN)
        .init();

    let engine = platforms::create_engine(true, false)?;

    // 1. open notepad
    let app = engine.open_application("notepad.exe")?;
    std::thread::sleep(Duration::from_millis(1500));
    println!("[spike] notepad opened");

    // 2. find the document area and type
    let doc = engine.find_element(&Selector::Role {
        role: "Document".to_string(),
        name: None,
    }, Some(&app), None)?;
    doc.type_text("AppCraft spike: hello Terminator", false)?;
    println!("[spike] typed text via role:Document");

    // 3. read back text to verify
    let value = doc.text(1).unwrap_or_default();
    println!("[spike] document content = {:?}", value);

    // 4. invoke 文件 menu (UIA InvokePattern — background-safe, no cursor)
    let file_menu = engine.find_element(&Selector::Role {
        role: "MenuItem".to_string(),
        name: Some("文件".to_string()),
    }, Some(&app), None)?;
    file_menu.invoke()?;
    println!("[spike] invoked 文件 menu via InvokePattern");

    std::thread::sleep(Duration::from_millis(600));

    // 5. press Escape to close the menu
    app.press_key("Escape")?;
    println!("[spike] done");

    Ok(())
}
