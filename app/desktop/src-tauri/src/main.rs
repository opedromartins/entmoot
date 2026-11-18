// No console window behind the app in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::Context;
use serde::{Deserialize, Serialize};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, State, WindowEvent};
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_dialog::DialogExt;

use transcritor_core::asr::{Device, Speed};
use transcritor_core::db::{Db, MeetingRow, SegmentRow};
use transcritor_core::gpu::{self, GpuMonitor, GpuStats, Hardware};
use transcritor_core::recorder::DevSettings;
use transcritor_core::server::{self, Event, Switch};
use transcritor_core::session::Caption;
use transcritor_core::{export, memory, models};

const PORT: u16 = 17865;
// Pairing with a per-install token comes with the extension's options page.
const TOKEN: &str = "dev";
/// Passed by Windows when it starts the app at login; the window stays in the tray.
const AUTOSTART_ARG: &str = "--autostart";

/// What the window needs to know about the engine at any moment.
#[derive(Debug, Clone, Default, Serialize)]
struct Status {
    /// starting | downloading_model | loading_model | ready | error.
    /// "ready" without a device (and not keeping only the captions) is the
    /// model waiting on disk for a meeting page to open.
    stage: String,
    error: Option<String>,
    extension_connected: bool,
    live_meeting: Option<i64>,
    /// The model being downloaded, loaded or used.
    model: String,
    /// Whether this run keeps only the platform's captions.
    mode: Mode,
    /// Where the loaded model runs; unset until it has loaded.
    device: Option<Device>,
    /// What went wrong with the GPU chosen in the settings. With the stage
    /// "error", the model did not load; with the device still the GPU, an
    /// utterance was lost; otherwise the model runs on the CPU instead.
    gpu_error: Option<String>,
    /// The GPU worked when the model loaded and failed later.
    gpu_failed_in_use: bool,
    /// How fast the model ran a trial on the device in use.
    speed_trial: Option<Speed>,
    /// The latest utterance transcribed.
    speed_last: Option<Speed>,
    /// Every utterance transcribed on the device in use.
    speed_total: Speed,
    /// Bytes present and total while the model downloads.
    download: Option<(u64, u64)>,
    /// The model is moving to another device: nothing is transcribed
    /// meanwhile, while the captions go on.
    switching: bool,
    /// Why the last move failed; the model stayed where it was.
    switch_error: Option<String>,
}

/// Where the text of a meeting comes from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum Mode {
    /// Transcribed here, by a model that runs on this computer.
    #[default]
    Local,
    /// Only the captions the meeting platform itself shows; no model.
    Captions,
}

/// What the user chose; kept in settings.json next to the database.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
struct Prefs {
    /// The first-run setup was finished. The engine waits for it, so nothing
    /// is downloaded before the user has chosen.
    setup_done: bool,
    mode: Mode,
    minimize_to_tray: bool,
    close_to_tray: bool,
    device: Device,
    /// Whether the CPU takes over when the GPU cannot be used or fails in use.
    cpu_fallback: bool,
    model: String,
    /// The developer mode, which the user turns on from inside the app. It
    /// reaches the engine as it is, with no restart.
    dev: DevSettings,
}

impl Default for Prefs {
    fn default() -> Self {
        Self {
            setup_done: false,
            mode: Mode::Local,
            minimize_to_tray: false,
            close_to_tray: false,
            device: Device::Cpu,
            cpu_fallback: true,
            model: models::DEFAULT_MODEL.into(),
            dev: DevSettings::default(),
        }
    }
}

/// Reads settings.json. An install from before the setup existed (a file
/// without `setup_done`) has chosen already and is not asked again.
fn load_prefs(path: &std::path::Path) -> Prefs {
    let Some(json) = std::fs::read(path).ok() else { return Prefs::default() };
    let mut prefs: Prefs = serde_json::from_slice(&json).unwrap_or_default();
    let had_setup = serde_json::from_slice::<serde_json::Value>(&json).is_ok_and(|v| v.get("setup_done").is_some());
    if !had_setup && !json.is_empty() {
        prefs.setup_done = true;
    }
    prefs
}

/// What the first-run setup shows about the computer, and what it suggests.
#[derive(Debug, Serialize)]
struct HardwareReport {
    #[serde(flatten)]
    hardware: Hardware,
    recommended_device: Device,
    recommended_model: &'static str,
    /// One line saying why.
    reason: String,
}

/// A model needs about this much video memory on the card: the full-precision
/// encoder is 2.5 GB, plus room to work.
const GPU_MIN_VRAM: u64 = 3 << 30;

fn gib(bytes: u64) -> String {
    format!("{:.1}", bytes as f64 / (1u64 << 30) as f64).replace('.', ",")
}

fn recommend(hardware: Hardware) -> HardwareReport {
    let card = hardware.gpus.iter().find(|g| !g.integrated && g.vram >= GPU_MIN_VRAM);
    let little_ram = hardware.ram_total.is_some_and(|r| r < 8 << 30);
    let (device, model, reason) = match card {
        Some(g) => (Device::Gpu, models::DEFAULT_MODEL, format!("A {} tem {} GB de memória de vídeo, o bastante para o modelo completo.", g.name, gib(g.vram))),
        None if little_ram => (Device::Cpu, "parakeet-v3-int8", "Sem placa de vídeo dedicada e com pouca memória RAM, o modelo compacto é o mais seguro.".into()),
        None if hardware.gpus.is_empty() => (Device::Cpu, models::DEFAULT_MODEL, "Nenhuma placa de vídeo foi encontrada; o processador faz o trabalho.".into()),
        None => (Device::Cpu, models::DEFAULT_MODEL, "A placa de vídeo encontrada não tem memória própria suficiente; o processador faz o trabalho.".into()),
    };
    HardwareReport { hardware, recommended_device: device, recommended_model: model, reason }
}

/// What the app's process occupies, for the settings screen.
#[derive(Debug, Serialize)]
struct Resources {
    /// Bytes of the computer's memory.
    memory_used: Option<u64>,
    /// Unset unless the model runs on the graphics card.
    gpu: Option<GpuStats>,
}

/// A model the settings screen offers.
#[derive(Debug, Serialize)]
struct ModelInfo {
    name: &'static str,
    size_bytes: u64,
    /// False for models that only run on the CPU.
    gpu: bool,
    downloaded: bool,
    /// The web page its files come from.
    page: String,
}

/// What the settings screen edits. Starting with Windows is a registry entry,
/// not a line in settings.json, so it is always read from the system.
#[derive(Debug, Serialize, Deserialize)]
struct Settings {
    autostart: bool,
    #[serde(flatten)]
    prefs: Prefs,
}

struct AppState {
    db: Mutex<Db>,
    status: Mutex<Status>,
    prefs: Mutex<Prefs>,
    prefs_path: PathBuf,
    models_dir: PathBuf,
    /// Set when the model or device changed; the engine restarts with them.
    restart_engine: AtomicBool,
    /// Shared with the engine, which reads it as it transcribes: turning the
    /// CPU fallback on or off does not reload the model.
    cpu_fallback: Arc<AtomicBool>,
    /// Asks the serving engine to move the model; unset while it is not serving.
    switch_tx: Mutex<Option<tokio::sync::mpsc::UnboundedSender<Switch>>>,
    gpu: Mutex<GpuMonitor>,
    /// The developer settings the serving engine reads as messages arrive.
    dev_tx: tokio::sync::watch::Sender<DevSettings>,
    recordings_dir: PathBuf,
}

type CommandResult<T> = Result<T, String>;

fn err(e: impl std::fmt::Display) -> String {
    format!("{e:#}")
}

#[tauri::command]
fn status(state: State<AppState>) -> Status {
    state.status.lock().unwrap().clone()
}

#[tauri::command]
fn meetings(state: State<AppState>) -> CommandResult<Vec<MeetingRow>> {
    state.db.lock().unwrap().meetings().map_err(err)
}

#[tauri::command]
fn transcript(state: State<AppState>, meeting_id: i64) -> CommandResult<Vec<SegmentRow>> {
    state.db.lock().unwrap().transcript(meeting_id).map_err(err)
}

#[tauri::command]
fn captions(state: State<AppState>, meeting_id: i64) -> CommandResult<Vec<Caption>> {
    state.db.lock().unwrap().captions(meeting_id).map_err(err)
}

#[tauri::command]
fn search(state: State<AppState>, query: String) -> CommandResult<Vec<SegmentRow>> {
    state.db.lock().unwrap().search(&query).map_err(err)
}

#[tauri::command]
fn delete_meeting(state: State<AppState>, meeting_id: i64) -> CommandResult<()> {
    if state.status.lock().unwrap().live_meeting == Some(meeting_id) {
        return Err("A reunião ainda está acontecendo.".into());
    }
    state.db.lock().unwrap().delete_meeting(meeting_id).map(|_| ()).map_err(err)
}

/// Removes every meeting but the one happening now. Returns how many went.
#[tauri::command]
fn delete_all_meetings(state: State<AppState>) -> CommandResult<usize> {
    let live = state.status.lock().unwrap().live_meeting;
    state.db.lock().unwrap().delete_all_meetings(live).map_err(err)
}

/// Opens, in the browser, the page a model is downloaded from.
#[tauri::command]
fn open_model_page(name: String) -> CommandResult<()> {
    let model = models::find(&name).ok_or("Modelo desconhecido.")?;
    std::process::Command::new("rundll32").args(["url.dll,FileProtocolHandler", &model.page()]).spawn().map(|_| ()).map_err(err)
}

/// The meeting as Markdown, from the transcript or from the platform's
/// captions; nothing when that source has no text.
fn meeting_markdown(db: &Db, meeting: &MeetingRow, captions: bool) -> anyhow::Result<Option<String>> {
    let (segments, caption_rows);
    let lines: Vec<export::Line> = if captions {
        caption_rows = db.captions(meeting.id)?;
        caption_rows.iter().map(Into::into).collect()
    } else {
        segments = db.transcript(meeting.id)?;
        segments.iter().map(Into::into).collect()
    };
    Ok((!lines.is_empty()).then(|| export::markdown(meeting, &lines)))
}

fn file_dialog(app: &AppHandle, title: &str) -> tauri_plugin_dialog::FileDialogBuilder<tauri::Wry> {
    let dialog = app.dialog().file().set_title(title);
    match app.get_webview_window("main") {
        Some(window) => dialog.set_parent(&window),
        None => dialog,
    }
}

/// Asks where to save the meeting and writes it there. Returns the file, or
/// nothing when the user gave up. Async so the dialog does not block the window.
#[tauri::command]
async fn export_meeting(app: AppHandle, state: State<'_, AppState>, meeting_id: i64, captions: bool) -> CommandResult<Option<String>> {
    let (name, text) = {
        let db = state.db.lock().unwrap();
        let meeting = db.meetings().map_err(err)?.into_iter().find(|m| m.id == meeting_id).ok_or("Reunião não encontrada.")?;
        let text = meeting_markdown(&db, &meeting, captions).map_err(err)?.ok_or("Não há texto para exportar.")?;
        (export::file_name(&meeting), text)
    };
    let chosen = file_dialog(&app, "Exportar reunião").set_file_name(&name).add_filter("Markdown", &["md"]).blocking_save_file();
    let Some(path) = chosen else { return Ok(None) };
    let path = path.into_path().map_err(err)?;
    std::fs::write(&path, text).map_err(err)?;
    Ok(Some(path.display().to_string()))
}

#[derive(Debug, Serialize)]
struct ExportedAll {
    /// The zip written; unset when no meeting has text.
    file: Option<String>,
    meetings: usize,
}

/// Every meeting that has text as a zip of Markdown files, one each: the
/// transcript, or the platform's captions when nothing was transcribed.
/// Returns the zip and how many meetings it holds.
fn meetings_zip(db: &Db) -> anyhow::Result<(Vec<u8>, usize)> {
    let mut zip = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    let mut names = std::collections::HashSet::new();
    for meeting in db.meetings()? {
        let text = match meeting_markdown(db, &meeting, false)? {
            Some(text) => Some(text),
            None => meeting_markdown(db, &meeting, true)?,
        };
        let Some(text) = text else { continue };
        // Two meetings with one name that started in the same minute.
        let mut name = export::file_name(&meeting);
        if names.contains(&name) {
            name = format!("{} ({}).md", name.trim_end_matches(".md"), meeting.id);
        }
        zip.start_file(name.as_str(), zip::write::SimpleFileOptions::default())?;
        zip.write_all(text.as_bytes())?;
        names.insert(name);
    }
    Ok((zip.finish()?.into_inner(), names.len()))
}

/// Asks where to save a zip with every meeting and writes it there. Returns
/// nothing when the user gave up.
#[tauri::command]
async fn export_all(app: AppHandle, state: State<'_, AppState>) -> CommandResult<Option<ExportedAll>> {
    let (zip, meetings) = meetings_zip(&state.db.lock().unwrap()).map_err(err)?;
    if meetings == 0 {
        return Ok(Some(ExportedAll { file: None, meetings }));
    }
    let chosen = file_dialog(&app, "Exportar todas as reuniões").set_file_name("entmoot - reuniões.zip").add_filter("Arquivo zip", &["zip"]).blocking_save_file();
    let Some(path) = chosen else { return Ok(None) };
    let path = path.into_path().map_err(err)?;
    std::fs::write(&path, zip).map_err(err)?;
    Ok(Some(ExportedAll { file: Some(path.display().to_string()), meetings }))
}

#[tauri::command]
fn settings(app: AppHandle, state: State<AppState>) -> CommandResult<Settings> {
    Ok(Settings { autostart: app.autolaunch().is_enabled().map_err(err)?, prefs: state.prefs.lock().unwrap().clone() })
}

/// Looks for the graphics card and the rest of what the model's speed depends
/// on. Async so the window stays alive while Windows answers.
#[tauri::command]
async fn hardware() -> HardwareReport {
    recommend(gpu::hardware())
}

#[tauri::command]
fn model_list(state: State<AppState>) -> Vec<ModelInfo> {
    models::MODELS
        .iter()
        .map(|m| ModelInfo { name: m.name, size_bytes: m.size_bytes(), gpu: m.gpu, downloaded: m.is_downloaded(&state.models_dir), page: m.page() })
        .collect()
}

#[tauri::command]
fn set_settings(app: AppHandle, state: State<AppState>, settings: Settings, allow_live: Option<bool>) -> CommandResult<()> {
    if models::find(&settings.prefs.model).is_none() {
        return Err(format!("Modelo desconhecido: {}", settings.prefs.model));
    }
    let (failed, movable, live) = {
        let status = state.status.lock().unwrap();
        // A model that is loading moves once it has loaded: the request waits
        // in the same queue. One still on disk has nothing to move.
        let loaded = status.stage == "ready" && status.device.is_some();
        (status.stage == "error", loaded || status.stage == "loading_model", status.live_meeting.is_some())
    };
    let switch_tx = state.switch_tx.lock().unwrap().clone();
    let (engine_changed, switch) = {
        let current = state.prefs.lock().unwrap();
        // Before the setup is finished the engine has not started: it begins
        // with whatever the setup chose.
        if !current.setup_done {
            (false, None)
        } else {
            let mode_changed = current.mode != settings.prefs.mode;
            let local = settings.prefs.mode == Mode::Local;
            // With only the captions kept, the model and the device do not matter.
            let model_changed = local && current.model != settings.prefs.model;
            let device_changed = local && current.device != settings.prefs.device;
            // The engine reads the fallback setting when the model loads and
            // as it transcribes. Only one whose model failed to load has to
            // start again to use it.
            let fallback_needs_restart = local && current.cpu_fallback != settings.prefs.cpu_fallback && failed;
            // Another device, or another model that is already on disk, loads in
            // place without restarting the engine, so the extension stays
            // connected and the captions go on. One still to download restarts
            // it, and so does a change made before the model has loaded, which
            // costs nothing.
            let spec = models::find(&settings.prefs.model);
            let on_disk = spec.is_some_and(|m| m.is_downloaded(&state.models_dir));
            let switch = !mode_changed && (model_changed || device_changed) && movable && switch_tx.is_some() && (!model_changed || on_disk);
            let switch = switch.then(|| Switch { model_dir: state.models_dir.join(spec.map_or("", |m| m.name)), device: settings.prefs.device });
            (mode_changed || ((model_changed || device_changed) && switch.is_none()) || fallback_needs_restart, switch)
        }
    };
    // Restarting the engine would cut the meeting being transcribed.
    if engine_changed && live {
        return Err("Espere a reunião terminar para trocar o modo, o modelo ou onde ele roda. Um modelo ainda não baixado só pode ser escolhido depois.".into());
    }
    // Moving the model leaves the meeting without transcription meanwhile;
    // the window asks the user first.
    if switch.is_some() && live && allow_live != Some(true) {
        return Err("Trocar o modelo durante a reunião precisa de confirmação.".into());
    }
    let autolaunch = app.autolaunch();
    if settings.autostart != autolaunch.is_enabled().map_err(err)? {
        if settings.autostart { autolaunch.enable() } else { autolaunch.disable() }.map_err(err)?;
    }
    let json = serde_json::to_vec_pretty(&settings.prefs).map_err(err)?;
    std::fs::write(&state.prefs_path, json).map_err(err)?;
    state.cpu_fallback.store(settings.prefs.cpu_fallback, Ordering::Relaxed);
    state.dev_tx.send_replace(settings.prefs.dev);
    *state.prefs.lock().unwrap() = settings.prefs;
    if let (Some(switch), Some(tx)) = (switch, &switch_tx) {
        tx.send(switch).map_err(err)?;
    }
    if engine_changed {
        state.restart_engine.store(true, Ordering::SeqCst);
    }
    Ok(())
}

/// Opens the folder the developer mode keeps its meetings in. Returns the path.
#[tauri::command]
fn open_recordings(state: State<AppState>) -> CommandResult<String> {
    std::fs::create_dir_all(&state.recordings_dir).map_err(err)?;
    std::process::Command::new("explorer").arg(&state.recordings_dir).spawn().map_err(err)?;
    Ok(state.recordings_dir.display().to_string())
}

/// Loads the model again, to give the GPU another chance after it failed.
#[tauri::command]
fn restart_engine(state: State<AppState>) -> CommandResult<()> {
    if state.status.lock().unwrap().live_meeting.is_some() {
        return Err("Espere a reunião terminar para carregar o modelo de novo.".into());
    }
    state.restart_engine.store(true, Ordering::SeqCst);
    Ok(())
}

/// The memory the app occupies and what the graphics card is doing for it;
/// the window asks every couple of seconds while it shows this. Async so
/// reading the system's counters does not block the window.
#[tauri::command]
async fn resources(state: State<'_, AppState>) -> CommandResult<Resources> {
    let on_gpu = state.status.lock().unwrap().device == Some(Device::Gpu);
    let gpu = if on_gpu { state.gpu.lock().unwrap().sample() } else { None };
    Ok(Resources { memory_used: memory::process_memory(), gpu })
}

/// Brings the window back from the tray or from behind other windows.
fn show_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        window.show().ok();
        window.unminimize().ok();
        window.set_focus().ok();
    }
}

fn build_tray(app: &tauri::App) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Abrir o entmoot", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Sair", true, None::<&str>)?;
    let mut tray = TrayIconBuilder::with_id("main")
        .tooltip("entmoot")
        .menu(&Menu::with_items(app, &[&open, &quit])?)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => show_main(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                show_main(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}

fn set_status(app: &AppHandle, change: impl FnOnce(&mut Status)) {
    let state = app.state::<AppState>();
    let mut status = state.status.lock().unwrap();
    change(&mut status);
    app.emit("status", status.clone()).ok();
}

/// Runs the engine with the chosen model and device, again each time they
/// change, until the app exits. A failure waits for the next change.
fn run_engine(app: AppHandle, data_dir: PathBuf) {
    let runtime = match tokio::runtime::Runtime::new() {
        Ok(runtime) => runtime,
        Err(e) => return set_status(&app, |s| (s.stage, s.error) = ("error".into(), Some(err(e)))),
    };
    let state = app.state::<AppState>();
    let restart = || state.restart_engine.load(Ordering::SeqCst);
    // The first-run setup decides what to download and where to run it.
    while !state.prefs.lock().unwrap().setup_done {
        std::thread::sleep(Duration::from_millis(200));
    }
    loop {
        state.restart_engine.store(false, Ordering::SeqCst);
        let prefs = state.prefs.lock().unwrap().clone();
        // A model that no longer exists in this version falls back to the default.
        let model = models::find(&prefs.model).map_or(models::DEFAULT_MODEL, |m| m.name);
        set_status(&app, |s| {
            *s = Status { stage: "starting".into(), model: model.into(), mode: prefs.mode, ..Default::default() };
        });
        if let Err(e) = engine_session(&app, &runtime, &data_dir, model, &prefs) {
            if !restart() {
                log::error!("{e:#}");
                set_status(&app, |s| (s.stage, s.error, s.download) = ("error".into(), Some(err(&e)), None));
            }
        }
        while !restart() {
            std::thread::sleep(Duration::from_millis(200));
        }
    }
}

/// Downloads the model if needed, then serves the extension until the
/// settings change (Ok) or something fails.
fn engine_session(app: &AppHandle, runtime: &tokio::runtime::Runtime, data_dir: &std::path::Path, model: &str, prefs: &Prefs) -> anyhow::Result<()> {
    let state = app.state::<AppState>();
    let restart = || state.restart_engine.load(Ordering::SeqCst);

    // Only the captions: nothing to download or load.
    let model_dir = if prefs.mode == Mode::Captions {
        None
    } else {
        let mut reported = 0;
        let dir = models::ensure(&state.models_dir, model, &mut |done, total| {
            // Often enough for a smooth bar, not once per megabyte read.
            if reported == 0 || done.saturating_sub(reported) >= total / 200 {
                reported = done.max(1);
                set_status(app, |s| (s.stage, s.download) = ("downloading_model".into(), Some((done, total))));
            }
            !restart()
        })?;
        set_status(app, |s| s.download = None);
        Some(dir)
    };

    let config = server::Config {
        bind: "127.0.0.1".into(),
        port: PORT,
        token: TOKEN.into(),
        model_dir,
        device: prefs.device,
        cpu_fallback: state.cpu_fallback.clone(),
        db_path: data_dir.join("entmoot.db"),
        diagnostics_dir: Some(data_dir.join("diagnostics")),
        recordings_dir: Some(state.recordings_dir.clone()),
        dev: state.dev_tx.subscribe(),
    };
    let sink_app = app.clone();
    let sink: server::Sink = Arc::new(move |event| {
        // Captions come many times a second and change no status.
        if matches!(event, Event::Caption(_)) {
            sink_app.emit("engine", event).ok();
            return;
        }
        // The model stayed where it was, so the choice in the settings goes back too.
        if let Event::SwitchFailed { model, device, .. } = &event {
            let state = sink_app.state::<AppState>();
            let mut prefs = state.prefs.lock().unwrap();
            if prefs.device != *device || prefs.model != *model {
                (prefs.device, prefs.model) = (*device, model.clone());
                if let Ok(json) = serde_json::to_vec_pretty(&*prefs) {
                    std::fs::write(&state.prefs_path, json).ok();
                }
            }
        }
        set_status(&sink_app, |s| match &event {
            Event::LoadingModel => s.stage = "loading_model".into(),
            Event::LoadFailed { error, gpu_error } => {
                s.stage = "error".into();
                // The GPU failed and the user chose not to use the CPU instead.
                s.error = Some(if gpu_error.is_some() { "Não foi possível usar a placa de vídeo".into() } else { error.clone() });
                s.gpu_error = gpu_error.clone();
            }
            Event::Waiting { .. } => {
                s.stage = "ready".into();
                // Also comes when the model is unloaded: what was known of
                // it says nothing about the next load.
                (s.device, s.gpu_error, s.gpu_failed_in_use) = (None, None, false);
                (s.speed_trial, s.speed_last, s.speed_total) = (None, None, Speed::default());
            }
            Event::ListeningCaptionsOnly { .. } => s.stage = "ready".into(),
            Event::Listening { device, gpu_error, trial, .. } => {
                s.stage = "ready".into();
                s.device = Some(*device);
                s.gpu_error = gpu_error.clone();
                s.speed_trial = Some(*trial);
            }
            Event::GpuFailed { error, trial } => {
                s.gpu_error = Some(error.clone());
                s.gpu_failed_in_use = true;
                // The model moved to the CPU, and what was measured on the
                // GPU says nothing about it.
                if trial.is_some() {
                    s.device = Some(Device::Cpu);
                    (s.speed_trial, s.speed_last, s.speed_total) = (*trial, None, Speed::default());
                }
            }
            Event::Transcribed { speed } => {
                s.speed_last = Some(*speed);
                s.speed_total.audio_ms += speed.audio_ms;
                s.speed_total.took_ms += speed.took_ms;
            }
            Event::Switching => (s.switching, s.switch_error) = (true, None),
            Event::Switched { model, device, gpu_error, trial } => {
                s.switching = false;
                s.model = model.clone();
                s.device = Some(*device);
                s.gpu_error = gpu_error.clone();
                s.gpu_failed_in_use = false;
                (s.speed_trial, s.speed_last, s.speed_total) = (Some(*trial), None, Speed::default());
            }
            Event::SwitchFailed { error, model, device, trial } => {
                s.switching = false;
                s.switch_error = Some(error.clone());
                s.model = model.clone();
                s.device = Some(*device);
                s.speed_trial = Some(*trial);
            }
            Event::ExtensionConnected => s.extension_connected = true,
            Event::ExtensionDisconnected => s.extension_connected = false,
            Event::MeetingStarted { meeting_id } => s.live_meeting = Some(*meeting_id),
            Event::MeetingSaved { .. } | Event::MeetingDiscarded { .. } => s.live_meeting = None,
            Event::Segment(_) | Event::Echo { .. } | Event::MeetingUpdated { .. } | Event::Caption(_) => {}
        });
        sink_app.emit("engine", event).ok();
    });
    let (switch_tx, switch_rx) = tokio::sync::mpsc::unbounded_channel();
    *state.switch_tx.lock().unwrap() = Some(switch_tx);
    let served = runtime.block_on(async {
        tokio::select! {
            served = server::serve(config, sink, switch_rx) => served.context("servidor"),
            _ = async { while !restart() { tokio::time::sleep(Duration::from_millis(200)).await } } => Ok(()),
        }
    });
    *state.switch_tx.lock().unwrap() = None;
    served
}

fn main() {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();
    tauri::Builder::default()
        // Must be the first plugin. A second launch (the engine's port is
        // already taken) just brings the running window forward.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_main(app)))
        // The name matches the Run registry value the uninstaller removes.
        .plugin(tauri_plugin_autostart::Builder::new().app_name("entmoot").arg(AUTOSTART_ARG).build())
        .plugin(tauri_plugin_dialog::init())
        .on_window_event(|window, event| {
            let Some(state) = window.try_state::<AppState>() else { return };
            let prefs = state.prefs.lock().unwrap().clone();
            match event {
                WindowEvent::CloseRequested { api, .. } if prefs.close_to_tray => {
                    api.prevent_close();
                    window.hide().ok();
                }
                // Minimizing arrives as a resize.
                WindowEvent::Resized(_) if prefs.minimize_to_tray && window.is_minimized().unwrap_or(false) => {
                    window.hide().ok();
                }
                _ => {}
            }
        })
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;
            let db = Db::open(&data_dir.join("entmoot.db"))?;
            let prefs_path = data_dir.join("settings.json");
            let prefs = load_prefs(&prefs_path);
            app.manage(AppState {
                db: Mutex::new(db),
                status: Mutex::new(Status { stage: "starting".into(), ..Default::default() }),
                cpu_fallback: Arc::new(AtomicBool::new(prefs.cpu_fallback)),
                dev_tx: tokio::sync::watch::channel(prefs.dev).0,
                recordings_dir: data_dir.join("recordings"),
                prefs: Mutex::new(prefs),
                prefs_path,
                models_dir: data_dir.join("models"),
                restart_engine: AtomicBool::new(false),
                switch_tx: Mutex::new(None),
                gpu: Mutex::default(),
            });

            build_tray(app)?;
            // The window is created hidden so a login start can stay in the tray.
            if !std::env::args().any(|arg| arg == AUTOSTART_ARG) {
                show_main(app.handle());
            }

            let handle = app.handle().clone();
            std::thread::spawn(move || run_engine(handle, data_dir));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![status, meetings, transcript, captions, search, delete_meeting, delete_all_meetings, open_model_page, export_meeting, export_all, settings, set_settings, hardware, model_list, restart_engine, resources, open_recordings])
        .run(tauri::generate_context!())
        .expect("failed to start entmoot");
}
