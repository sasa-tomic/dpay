//! In-crate UniFFI bindings generator.
//!
//! Delegates to the pinned uniffi's CLI so the codegen version always matches the runtime
//! scaffolding compiled into `dpay_ffi`. Invoked by `verify.sh`, e.g.:
//!   cargo run --features cli --bin uniffi-bindgen -- \
//!       generate --library <path/to/libdpay_ffi.so> --language python --out-dir <dir> --no-format
fn main() {
    uniffi::uniffi_bindgen_main()
}
