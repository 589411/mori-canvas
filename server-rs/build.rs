fn main() {
    // The client is embedded into the binary at COMPILE time (include_dir! in lib.rs).
    // Without this, rebuilding only the frontend (vite build) leaves cargo thinking
    // nothing changed — the server keeps serving the OLD embedded assets.
    println!("cargo:rerun-if-changed=../client/dist");
    // Same for prompts (prompts.rs EMBEDDED; the on-disk prompts/ dir overrides at
    // runtime, but a standalone binary deploy serves the embedded copies).
    println!("cargo:rerun-if-changed=../prompts");
}
