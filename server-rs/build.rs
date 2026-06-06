fn main() {
    // 前端是 include_dir! 在「編譯時」嵌進 binary 的(lib.rs 的 CLIENT_ASSETS)。
    // 沒有這行的話,只改前端、重跑 vite build 後,cargo 會以為 Rust 沒變而跳過重編,
    // server 就繼續出「舊的」前端 —— 這裡告訴 cargo:client/dist 變了就要重編。
    println!("cargo:rerun-if-changed=../client/dist");
    // prompts 同理(prompts.rs 的 EMBEDDED;執行時磁碟上的 prompts/ 會覆蓋,
    // 但單一 binary 部署吃的是嵌入版)
    println!("cargo:rerun-if-changed=../prompts");
}
