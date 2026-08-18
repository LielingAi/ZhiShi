fn main() {
    // Windows manifest（comctl32 v6）的单一来源策略：
    //
    // 背景坑（2026-08-06 实战）：
    // 1. tauri_build 默认把内建 manifest 编进 resource.lib，只随 **app 主二进制**
    //    链接——`cargo test --lib` 的测试二进制拿不到 → TaskDialogIndirect
    //    （tauri-plugin-dialog/rfd 依赖 comctl32 v6）解析到 System32 的 v5.8 →
    //    测试进程启动即 0xC0000139 STATUS_ENTRYPOINT_NOT_FOUND。
    // 2. 直接补 `cargo:rustc-link-arg=/MANIFESTINPUT:...` 会同时作用于主二进制，
    //    与 resource.lib 里的 manifest 撞车 → CVT1100 资源重复 / LNK1123。
    //    （`rustc-link-arg-tests` 看着对症，但本 crate 没有显式 [[test]] 目标，
    //    cargo 直接报错拒绝。）
    //
    // 解法：tauri 侧用 new_without_app_manifest() 让 resource.lib 不带 MANIFEST，
    // 全目标（bin + test）统一由链接参数嵌入 app.manifest——内容与 tauri 内建
    // 同义（都只有 comctl32 v6 依赖），行为零变化。
    #[cfg(target_os = "windows")]
    let attributes = tauri_build::Attributes::new()
        .windows_attributes(tauri_build::WindowsAttributes::new_without_app_manifest());
    #[cfg(not(target_os = "windows"))]
    let attributes = tauri_build::Attributes::new();

    tauri_build::try_build(attributes).expect("tauri_build failed");

    #[cfg(target_os = "windows")]
    {
        println!("cargo:rerun-if-changed=app.manifest");
        println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
        println!("cargo:rustc-link-arg=/MANIFESTINPUT:app.manifest");
    }
}
