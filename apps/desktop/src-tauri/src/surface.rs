use tauri::{
    menu::{Menu, MenuItem, Submenu},
    App, AppHandle, Manager, WebviewUrl, WebviewWindowBuilder,
};

use crate::HostSurface;

pub fn open(app: &AppHandle, surface: HostSurface) -> tauri::Result<()> {
    if let Some(window) = app.get_webview_window(surface.label()) {
        window.set_focus()?;
        return Ok(());
    }

    WebviewWindowBuilder::new(
        app,
        surface.label(),
        WebviewUrl::App(surface.route().into()),
    )
    .title(surface.title())
    .inner_size(1120.0, 760.0)
    .min_inner_size(720.0, 480.0)
    .build()?;
    Ok(())
}

/// Shortcuts are owned by the native menu, so they work for every surface
/// without handing keyboard handling privileged behavior to the renderer.
pub fn install_menu(app: &App) -> tauri::Result<()> {
    let preview = MenuItem::with_id(
        app,
        "surface.preview",
        "Open Preview",
        true,
        Some("CmdOrCtrl+Shift+P"),
    )?;
    let terminal = MenuItem::with_id(
        app,
        "surface.terminal",
        "Open Terminal",
        true,
        Some("CmdOrCtrl+Shift+T"),
    )?;
    let raw_evidence = MenuItem::with_id(
        app,
        "surface.raw-evidence",
        "Open Raw Evidence",
        true,
        Some("CmdOrCtrl+Shift+E"),
    )?;
    let view = Submenu::with_items(app, "View", true, &[&preview, &terminal, &raw_evidence])?;
    app.set_menu(Menu::with_items(app, &[&view])?)?;
    app.on_menu_event(|app, event| {
        let surface = match event.id().as_ref() {
            "surface.preview" => Some(HostSurface::Preview),
            "surface.terminal" => Some(HostSurface::Terminal),
            "surface.raw-evidence" => Some(HostSurface::RawEvidence),
            _ => None,
        };
        if let Some(surface) = surface {
            if let Err(error) = open(app, surface) {
                eprintln!("could not open shortcut surface: {error}");
            }
        }
    });
    Ok(())
}
