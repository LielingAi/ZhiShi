fn main() {
    #[cfg(windows)]
    {
        let _ = embed_resource::compile("assets/zhishi-updater.rc", embed_resource::NONE);
    }
}
