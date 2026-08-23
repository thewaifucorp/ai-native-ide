#[tauri::command]
fn foundation_status() -> &'static str {
    "Tauri host ready; governed foundation slice lives in ide-domain"
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![foundation_status])
        .run(tauri::generate_context!())
        .expect("failed to run AI-Native IDE desktop host");
}
