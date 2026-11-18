//! WebSocket endpoint the browser extension connects to.
//!
//! Loopback by default, only extension origins, and the first message must carry the
//! pairing token: any web page can open a socket to localhost.

use std::collections::HashMap;
use std::fs::File;
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use anyhow::{bail, Result};
use futures_util::{SinkExt, StreamExt};
use serde::Serialize;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::watch;
use tokio_tungstenite::tungstenite::handshake::server::{ErrorResponse, Request, Response};
use tokio_tungstenite::tungstenite::http::StatusCode;
use tokio_tungstenite::tungstenite::Message as WsMessage;

use crate::asr::{Device, GpuUnavailable, Parakeet, Speed};
use crate::protocol::{AudioFrame, Message};
use crate::session::{AttributedUtterance, Caption, LiveCaption, MeetingInfo, Session, Speaker, Update};
use crate::db::{Db, SegmentRow};
use crate::echo;
use crate::recorder::{self, DevSettings, Recorder};
use crate::store::Segment;

const EXTENSION_ORIGINS: &[&str] = &["moz-extension://", "chrome-extension://"];

pub struct Config {
    /// Loopback unless the app runs in a container that publishes the port.
    pub bind: String,
    pub port: u16,
    pub token: String,
    /// The model to transcribe with; it loads when the extension first
    /// connects. Without one only the platform's captions are kept: no model
    /// loads and the audio is not even listened to.
    pub model_dir: Option<PathBuf>,
    /// Where to run the model.
    pub device: Device,
    /// Whether the CPU takes over when the GPU cannot be used or fails in use.
    /// Read when the model loads and at each utterance, so changing it while
    /// serving takes effect without reloading the model.
    pub cpu_fallback: Arc<AtomicBool>,
    pub db_path: PathBuf,
    /// Where to keep, for the latest connections, everything the extension
    /// sent except the audio: what tells why a name or a mute went wrong.
    pub diagnostics_dir: Option<PathBuf>,
    /// Where the developer mode keeps a folder per meeting; without it the
    /// mode does nothing.
    pub recordings_dir: Option<PathBuf>,
    /// The developer settings, read as messages arrive: a change reaches the
    /// meeting going on, and the extension is told when it has to send more.
    pub dev: watch::Receiver<DevSettings>,
}

const DIAGNOSTICS_KEPT: usize = 5;
/// How often the captions of the meeting going on are written to the database.
const CAPTIONS_EVERY: Duration = Duration::from_secs(5);
/// How long the model stays loaded with no meeting going on. Long enough to
/// rejoin a call, or to go from one meeting to the next, without loading again.
const UNLOAD_AFTER: Duration = Duration::from_secs(5 * 60);
/// A call joined again this soon after it ended is the same meeting: the page
/// was reloaded, the tab closed by accident, the connection to the call lost.
const REJOIN_WITHIN: Duration = Duration::from_secs(5 * 60);

/// Opens the log of a new connection and drops the oldest ones.
fn diagnostics_log(dir: &Path) -> Result<BufWriter<File>> {
    std::fs::create_dir_all(dir)?;
    let mut logs: Vec<PathBuf> = std::fs::read_dir(dir)?.filter_map(|e| Some(e.ok()?.path())).filter(|p| p.extension().is_some_and(|x| x == "jsonl")).collect();
    logs.sort();
    for old in logs.iter().rev().skip(DIAGNOSTICS_KEPT - 1) {
        std::fs::remove_file(old).ok();
    }
    // Zero-padded, so names sort by time.
    Ok(BufWriter::new(File::create(dir.join(format!("{:015}.jsonl", now_ms())))?))
}

/// What the server tells whoever is showing the meeting.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Event {
    /// Serving with the model on disk: not loaded yet, or unloaded after
    /// `UNLOAD_AFTER` with no meeting. It loads when the extension connects,
    /// which is when a meeting page opens, or when a call begins on a page
    /// already open. Meanwhile the app does not hold the model's memory.
    Waiting { port: u16 },
    /// The extension connected and the model is loading. What is said
    /// meanwhile waits and is transcribed once it has loaded.
    LoadingModel,
    /// The model did not load: only the captions are kept until serving
    /// starts again. `gpu_error` is set when the GPU could not be used and
    /// the CPU may not take over.
    LoadFailed { error: String, gpu_error: Option<String> },
    /// Serving without a model: only the platform's captions are kept.
    ListeningCaptionsOnly { port: u16 },
    /// The model loaded. `device` is where it really runs; `gpu_error` is set
    /// when the GPU was asked for and could not be used. `trial` is how fast
    /// that device transcribed a stretch of silence.
    Listening { port: u16, device: Device, gpu_error: Option<String>, trial: Speed },
    /// The GPU failed in use. With `trial`, the model moved to the CPU, where
    /// a trial ran at that speed, and nothing was lost. Without it, the CPU
    /// may not take over: the model stays on the GPU and the utterance was
    /// not transcribed.
    GpuFailed { error: String, trial: Option<Speed> },
    /// The model was asked to move to another device or to another model.
    /// Nothing is transcribed until `Switched` or `SwitchFailed`; captions
    /// are not affected.
    Switching,
    /// The model loaded as asked, on `device` (the CPU, if the GPU could not
    /// be used and the CPU may take over; `gpu_error` says why). `model` is
    /// the name of its folder.
    Switched { model: String, device: Device, gpu_error: Option<String>, trial: Speed },
    /// The model could not move and is back where it was, `model` on `device`.
    SwitchFailed { error: String, model: String, device: Device, trial: Speed },
    /// An utterance was transcribed, this fast.
    Transcribed { speed: Speed },
    ExtensionConnected,
    ExtensionDisconnected,
    MeetingStarted { meeting_id: i64 },
    /// The meeting's title or the names in its stored transcript changed.
    MeetingUpdated { meeting_id: i64 },
    Segment(SegmentRow),
    /// A segment already shown turned out to be an echo.
    Echo { segment_id: i64 },
    /// A line of the platform's captions, new or revised. Not stored until
    /// the meeting ends, and not tied to a meeting id: the meeting's row may
    /// not exist yet.
    Caption(LiveCaption),
    MeetingSaved { meeting_id: i64 },
    /// The meeting ended with nothing said in it and was not kept.
    MeetingDiscarded { meeting_id: i64 },
}

pub type Sink = Arc<dyn Fn(Event) + Send + Sync>;

/// Where to move the model to while serving.
#[derive(Debug, Clone)]
pub struct Switch {
    /// A model already on disk.
    pub model_dir: PathBuf,
    pub device: Device,
}

fn folder_name(dir: &Path) -> String {
    dir.file_name().map_or_else(String::new, |n| n.to_string_lossy().into_owned())
}

enum Job {
    /// Load the model, unless it is loaded. Sent when the extension
    /// connects; utterances that arrive meanwhile wait in the queue.
    Load,
    /// Move the model. Utterances that arrive meanwhile wait in the queue.
    Switch(Switch),
    /// `recording` is the folder the developer mode keeps this meeting in, if
    /// it is on; the worker adds the transcript when the meeting ends.
    Begin { started_ms: u64, recording: Option<PathBuf> },
    /// With the time it was learned.
    Update(Update, u64),
    Utterance(AttributedUtterance),
    /// All the captions so far, to store while the meeting goes on.
    Captions(Vec<Caption>),
    End { meeting: MeetingInfo, captions: Vec<Caption> },
}

/// `switches` carries where the model is asked to move to while serving; a
/// meeting going on is not interrupted, only left without transcription
/// until the model has loaded.
pub async fn serve(config: Config, sink: Sink, mut switches: tokio::sync::mpsc::UnboundedReceiver<Switch>) -> Result<()> {
    // The model is not loaded here: the worker loads it when the extension
    // first connects, so it takes no memory while no meeting page is open.
    let wanted = config.model_dir.clone().map(|model_dir| Switch { model_dir, device: config.device });
    let worker = spawn_worker(wanted, config.cpu_fallback.clone(), config.port, Db::open(&config.db_path)?, sink.clone(), config.dev.clone());
    let listener = TcpListener::bind((config.bind.as_str(), config.port)).await?;
    log::info!("listening on ws://{}:{}", config.bind, config.port);
    match config.model_dir {
        Some(_) => sink(Event::Waiting { port: config.port }),
        None => sink(Event::ListeningCaptionsOnly { port: config.port }),
    }
    // The connection is awaited inside the accept loop, so the requests to
    // move the model are forwarded by a branch of their own. Its sender goes
    // away with it, which lets the worker end when serving stops.
    let jobs = worker.jobs.clone();
    let forward = async move {
        while let Some(switch) = switches.recv().await {
            jobs.send(Job::Switch(switch)).ok();
        }
        std::future::pending::<()>().await
    };
    let accepting = async {
        loop {
            let (stream, _) = listener.accept().await?;
            // One meeting at a time; a second tab waits its turn.
            if let Err(e) = connection(stream, &config, &worker.jobs, &sink).await {
                log::warn!("connection ended: {e:#}");
            }
        }
    };
    tokio::select! {
        served = accepting => served,
        () = forward => Ok(()),
    }
}

fn check_origin(req: &Request, resp: Response) -> std::result::Result<Response, ErrorResponse> {
    let origin = req.headers().get("origin").and_then(|v| v.to_str().ok()).unwrap_or("");
    if EXTENSION_ORIGINS.iter().any(|p| origin.starts_with(p)) {
        return Ok(resp);
    }
    log::warn!("rejected origin {origin:?}");
    let mut refuse = ErrorResponse::new(Some("origin not allowed".into()));
    *refuse.status_mut() = StatusCode::FORBIDDEN;
    Err(refuse)
}

async fn connection(stream: TcpStream, config: &Config, jobs: &mpsc::Sender<Job>, sink: &Sink) -> Result<()> {
    let mut ws = tokio_tungstenite::accept_hdr_async(stream, check_origin).await?;

    let hello = match ws.next().await {
        Some(Ok(WsMessage::Text(text))) => match serde_json::from_str(&text) {
            Ok(Message::Hello { token }) if token == config.token => text,
            _ => bail!("first message was not a valid hello"),
        },
        _ => bail!("no hello"),
    };
    // Failing to log must not cost the meeting.
    let mut diagnostics = config.diagnostics_dir.as_deref().and_then(|dir| diagnostics_log(dir).map_err(|e| log::warn!("no diagnostics: {e:#}")).ok());
    let mut record = |text: &str| {
        if let Some(log) = &mut diagnostics {
            let written = writeln!(log, "{text}");
            // The frequent kinds ride along with the next rare one.
            if written.is_err() || !(text.starts_with(r#"{"kind":"speakers""#) || text.starts_with(r#"{"kind":"raw""#)) {
                log.flush().ok();
            }
        }
    };
    record(&hello.replace(&config.token, "…"));

    // Developer mode: a folder per meeting, and the extension asked for
    // everything it sees while the dump is on.
    let mut dev = config.dev.clone();
    let fresh = || config.recordings_dir.as_deref().map(|root| Recorder::new(recorder::new_folder(root)));
    let mut recorder = fresh();
    let mut asked = dev.borrow().events();
    if asked {
        ws.send(dev_message(true)).await.ok();
    }

    // A meeting page is open. Ahead of everything else from this connection,
    // so the call's first utterances wait behind the load.
    jobs.send(Job::Load).ok();
    jobs.send(Job::Begin { started_ms: now_ms(), recording: recorder.as_ref().map(|r| r.dir().to_path_buf()) }).ok();
    log::info!("extension connected");
    sink(Event::ExtensionConnected);

    let mut session = Session::default();
    let mut captions_changed = false;
    let mut captions_stored = Instant::now();
    let mut speakers_stored = Instant::now();
    loop {
        let msg = tokio::select! {
            msg = ws.next() => match msg {
                Some(msg) => msg,
                None => break,
            },
            // The sender going away ends this branch, not the connection.
            Ok(()) = dev.changed() => {
                let full = dev.borrow_and_update().events();
                if full != asked {
                    asked = full;
                    ws.send(dev_message(full)).await.ok();
                }
                continue;
            }
        };
        // A dropped connection still ends the meeting properly below.
        let Ok(msg) = msg else { break };
        let done = match msg {
            WsMessage::Binary(bytes) => {
                let frame = AudioFrame::parse(&bytes);
                if let (Some(frame), Some(rec)) = (&frame, recorder.as_mut()) {
                    if dev.borrow().audio() {
                        if let Err(e) = rec.audio(frame) {
                            log::warn!("developer mode: audio not kept: {e:#}");
                            recorder = None;
                        }
                    }
                }
                // Nothing transcribes the audio when only the captions are kept.
                match frame {
                    Some(frame) if config.model_dir.is_some() => session.handle_audio(frame),
                    _ => Vec::new(),
                }
            }
            WsMessage::Text(text) => {
                record(&text);
                if let Some(rec) = recorder.as_mut() {
                    if dev.borrow().events() {
                        if let Err(e) = rec.event(&text) {
                            log::warn!("developer mode: messages not kept: {e:#}");
                            recorder = None;
                        }
                    }
                }
                match serde_json::from_str(&text) {
                    Ok(m) => session.handle_message(m),
                    Err(e) => log::debug!("unreadable message: {e}"),
                }
                // The connection outlives the call: Teams' page stays open
                // after it, and a Meet tab that closes leaves the socket to
                // the next one. The next call is another meeting.
                if session.take_ended() {
                    for utterance in session.finish() {
                        recorder.as_mut().map(|r| r.heard(&utterance));
                        jobs.send(Job::Utterance(utterance)).ok();
                    }
                    save_speakers(&mut recorder, &dev, &session);
                    jobs.send(Job::End { meeting: session.meeting.clone(), captions: session.captions() }).ok();
                    // The next call is kept in a folder of its own. A page that
                    // leaves before any call (Meet's start page moving on to
                    // the room) is not the end of one: what came before the
                    // call stays with it.
                    if !session.meeting.platform.is_empty() {
                        recorder = fresh();
                    }
                    jobs.send(Job::Begin { started_ms: now_ms(), recording: recorder.as_ref().map(|r| r.dir().to_path_buf()) }).ok();
                    session = Session::default();
                    captions_changed = false;
                    continue;
                }
                Vec::new()
            }
            WsMessage::Close(_) => break,
            _ => Vec::new(),
        };
        for update in session.take_updates() {
            match update {
                // Straight to the screen: the worker may be busy transcribing.
                Update::Caption(caption) => {
                    sink(Event::Caption(caption));
                    captions_changed = true;
                }
                update => {
                    jobs.send(Job::Update(update, now_ms())).ok();
                }
            }
        }
        // Messages never stop coming during a call, so this needs no timer.
        if captions_changed && captions_stored.elapsed() >= CAPTIONS_EVERY {
            jobs.send(Job::Captions(session.captions())).ok();
            captions_changed = false;
            captions_stored = Instant::now();
        }
        for utterance in done {
            recorder.as_mut().map(|r| r.heard(&utterance));
            jobs.send(Job::Utterance(utterance)).ok();
        }
        if speakers_stored.elapsed() >= CAPTIONS_EVERY {
            save_speakers(&mut recorder, &dev, &session);
            speakers_stored = Instant::now();
        }
    }
    for utterance in session.finish() {
        recorder.as_mut().map(|r| r.heard(&utterance));
        jobs.send(Job::Utterance(utterance)).ok();
    }
    save_speakers(&mut recorder, &dev, &session);
    jobs.send(Job::End { meeting: session.meeting.clone(), captions: session.captions() }).ok();
    sink(Event::ExtensionDisconnected);
    Ok(())
}

/// Writes `speakers.json` into the meeting's folder, when the developer mode
/// keeps audio or transcripts and a call has been joined.
fn save_speakers(recorder: &mut Option<Recorder>, dev: &watch::Receiver<DevSettings>, session: &Session) {
    let wanted = {
        let dev = dev.borrow();
        dev.audio() || dev.transcripts()
    };
    if !wanted || session.meeting.platform.is_empty() {
        return;
    }
    if let Some(rec) = recorder.as_mut() {
        rec.save_speakers(&session.meeting, &session.people()).unwrap_or_else(|e| log::warn!("developer mode: speakers not kept: {e:#}"));
    }
}

/// Tells the extension whether to send every frame it sees, not only the
/// first ones of each data channel.
fn dev_message(full: bool) -> WsMessage {
    WsMessage::Text(format!(r#"{{"kind":"dev","full":{full}}}"#))
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64)
}

/// A stored segment the echo check may still need to look at.
struct Recent {
    id: i64,
    start_ms: u64,
    end_ms: u64,
    mic: bool,
    text: String,
}

/// The meeting being written. Its row is created when the extension says the
/// call was joined, so a tab that connects and leaves without a meeting stores
/// nothing; a call left with nothing said is removed again.
struct Open {
    /// When the extension connected; used only if the call was never announced.
    connected_ms: u64,
    /// Segments stored, echoes included.
    stored: usize,
    /// End of the latest segment, which is when the meeting ended.
    last_ms: u64,
    id: Option<i64>,
    /// What the meeting is, once the extension has said.
    info: Option<MeetingInfo>,
    recent: Vec<Recent>,
    /// Captions from before the call was left and joined again; the session
    /// only knows the ones since.
    earlier: Vec<Caption>,
    /// The developer mode's folder for this meeting.
    recording: Option<PathBuf>,
    /// Who else was audible while each segment was said, by segment id; only
    /// kept for the folder, and only for what this run of the meeting made.
    others: HashMap<i64, Vec<String>>,
}

/// A meeting that was saved, kept at hand in case its call is joined again.
struct Closed {
    at: Instant,
    id: i64,
    info: MeetingInfo,
    stored: usize,
    last_ms: u64,
    recent: Vec<Recent>,
    captions: Vec<Caption>,
}

impl Closed {
    /// The link is what tells one call from another; without it nothing does.
    fn is(&self, info: &MeetingInfo) -> bool {
        !info.code.is_empty() && info.code == self.info.code && info.platform == self.info.platform && self.at.elapsed() < REJOIN_WITHIN
    }
}

impl Open {
    /// The meeting's row, created on first use.
    fn id(&mut self, db: &Db, sink: &Sink, started_ms: u64) -> Result<i64> {
        if self.id.is_none() {
            let id = db.begin_meeting(started_ms)?;
            self.id = Some(id);
            if let Some(info) = &self.info {
                db.set_meeting_info(id, info)?;
            }
            sink(Event::MeetingStarted { meeting_id: id });
        }
        Ok(self.id.unwrap())
    }

    /// `dump` is where the developer mode keeps the transcript, when it does.
    fn add(&mut self, db: &Db, sink: &Sink, segment: Segment, dump: Option<&Path>, others: Vec<String>) -> Result<()> {
        let mic = matches!(segment.speaker, Speaker::Me { .. });
        let near = |r: &&Recent| r.mic != mic && r.start_ms < segment.end_ms + echo::WINDOW_MS && r.end_ms + echo::WINDOW_MS > segment.start_ms;

        // The echo and the voice it repeats finish transcribing in either
        // order, so each new segment is checked against the other side.
        let mut is_echo = false;
        if mic {
            let remote: Vec<&str> = self.recent.iter().filter(near).map(|r| r.text.as_str()).collect();
            is_echo = echo::is_echo(&segment.text, &remote.join(" "));
        } else {
            for r in self.recent.iter().filter(near) {
                if echo::is_echo(&r.text, &segment.text) {
                    db.mark_echo(r.id)?;
                    sink(Event::Echo { segment_id: r.id });
                }
            }
        }
        let meeting = self.id(db, sink, segment.start_ms)?;
        self.last_ms = self.last_ms.max(segment.end_ms);
        let id = db.add_segment(meeting, &segment, is_echo)?;
        self.stored += 1;
        if !is_echo {
            let row = SegmentRow::new(id, meeting, &segment, false);
            if let Some(dir) = dump {
                recorder::append_segment(dir, &row, &others).unwrap_or_else(|e| log::warn!("developer mode: segment not kept: {e:#}"));
                self.others.insert(id, others);
            }
            sink(Event::Segment(row));
        }
        self.recent.retain(|r| r.end_ms + 60_000 > segment.start_ms);
        self.recent.push(Recent { id, start_ms: segment.start_ms, end_ms: segment.end_ms, mic, text: segment.text });
        Ok(())
    }
}

/// The transcription thread. Dropping it (the server was stopped, say to load
/// another model) waits for the thread, so the model's memory is free before
/// the next one loads.
struct Worker {
    jobs: mpsc::Sender<Job>,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl Drop for Worker {
    fn drop(&mut self) {
        // The thread ends when its last sender goes away.
        let (closed, _) = mpsc::channel();
        drop(std::mem::replace(&mut self.jobs, closed));
        if let Some(thread) = self.thread.take() {
            thread.join().ok();
        }
    }
}

/// Loads the model and tells how it went.
fn load(target: &Switch, cpu_fallback: &Arc<AtomicBool>, port: u16, sink: &Sink) -> Option<Parakeet> {
    sink(Event::LoadingModel);
    match Parakeet::load(&target.model_dir, target.device, cpu_fallback.load(Ordering::Relaxed)) {
        Ok(mut loaded) => {
            loaded.share_cpu_fallback(cpu_fallback.clone());
            let (device, trial) = (loaded.device(), loaded.trial());
            log::info!("model running on the {device:?}: {} ms of audio in {} ms", trial.audio_ms, trial.took_ms);
            sink(Event::Listening { port, device, gpu_error: loaded.gpu_error().map(str::to_string), trial });
            Some(loaded)
        }
        Err(e) => {
            log::error!("the model did not load: {e:#}");
            let gpu_error = e.chain().find_map(|cause| cause.downcast_ref::<GpuUnavailable>()).map(|gpu| gpu.0.clone());
            sink(Event::LoadFailed { error: format!("{e:#}"), gpu_error });
            None
        }
    }
}

/// Transcription runs on its own thread so audio intake never waits on it.
/// `wanted` is the model to load when the extension connects; without it only
/// the captions are kept.
fn spawn_worker(mut wanted: Option<Switch>, cpu_fallback: Arc<AtomicBool>, port: u16, mut db: Db, sink: Sink, dev: watch::Receiver<DevSettings>) -> Worker {
    let (tx, rx) = mpsc::channel::<Job>();
    let thread = std::thread::spawn(move || {
        let mut asr: Option<Parakeet> = None;
        // What the loaded model was asked to be, to load it again after it
        // was unloaded: the GPU gets another chance if the CPU had taken over.
        let mut chosen: Option<Switch> = None;
        // Since when the model is loaded with no meeting going on.
        let mut idle_since: Option<Instant> = None;
        let mut open: Option<Open> = None;
        let mut closed: Option<Closed> = None;
        loop {
            let job = match idle_since {
                Some(since) => match rx.recv_timeout(UNLOAD_AFTER.saturating_sub(since.elapsed())) {
                    Ok(job) => job,
                    Err(mpsc::RecvTimeoutError::Timeout) => {
                        // Dropped here, which frees the model's memory.
                        asr = None;
                        wanted = chosen.take();
                        idle_since = None;
                        log::info!("no meeting for a while: model unloaded");
                        sink(Event::Waiting { port });
                        continue;
                    }
                    Err(mpsc::RecvTimeoutError::Disconnected) => break,
                },
                None => match rx.recv() {
                    Ok(job) => job,
                    Err(_) => break,
                },
            };
            // A meeting page opened, or a call began on one that was already
            // open after the model was unloaded. Taken, so a model that
            // failed is not tried again each time.
            if matches!(job, Job::Load | Job::Update(Update::Meeting(_), _) | Job::Utterance(_)) {
                if let Some(target) = wanted.take() {
                    asr = load(&target, &cpu_fallback, port, &sink);
                    chosen = asr.is_some().then_some(target);
                }
            }
            let result = (|| -> Result<()> {
                match (job, &mut open) {
                    (Job::Load, _) => {}
                    // Not loaded yet: what loads is what was asked for last.
                    (Job::Switch(switch), _) if wanted.is_some() => wanted = Some(switch),
                    // Nothing to move or to transcribe with: captions only,
                    // or the model did not load.
                    (Job::Switch(_), _) | (Job::Utterance(_), _) if asr.is_none() => {}
                    (Job::Switch(switch), _) => {
                        let Some(asr) = asr.as_mut() else { return Ok(()) };
                        sink(Event::Switching);
                        match asr.switch(&switch.model_dir, switch.device) {
                            Ok(()) => {
                                chosen = Some(switch);
                                log::info!("model {} now on the {:?}", folder_name(asr.model_dir()), asr.device());
                                sink(Event::Switched { model: folder_name(asr.model_dir()), device: asr.device(), gpu_error: asr.gpu_error().map(str::to_string), trial: asr.trial() });
                            }
                            Err(e) => {
                                log::warn!("could not move the model to {switch:?}: {e:#}");
                                sink(Event::SwitchFailed { error: format!("{e:#}"), model: folder_name(asr.model_dir()), device: asr.device(), trial: asr.trial() });
                            }
                        }
                    }
                    (Job::Begin { started_ms, recording }, _) => open = Some(Open { connected_ms: started_ms, stored: 0, last_ms: 0, id: None, info: None, recent: Vec::new(), earlier: Vec::new(), recording, others: HashMap::new() }),
                    // The extension says what the meeting is on joining the
                    // call: the meeting exists from then on, before any speech.
                    (Job::Update(Update::Meeting(info), at_ms), Some(meeting)) => {
                        // Back in the call just left: the meeting goes on
                        // where it stopped.
                        if meeting.id.is_none() && closed.as_ref().is_some_and(|c| c.is(&info)) {
                            if let Some(was) = closed.take() {
                                db.reopen_meeting(was.id)?;
                                log::info!("meeting {} joined again", was.id);
                                (meeting.id, meeting.stored, meeting.last_ms) = (Some(was.id), was.stored, was.last_ms);
                                (meeting.recent, meeting.earlier) = (was.recent, was.captions);
                                sink(Event::MeetingStarted { meeting_id: was.id });
                            }
                        }
                        let known = meeting.id.is_some();
                        meeting.info = Some(info.clone());
                        let id = meeting.id(&db, &sink, at_ms)?;
                        if known {
                            db.set_meeting_info(id, &info)?;
                            sink(Event::MeetingUpdated { meeting_id: id });
                        }
                        // What the meeting is, in the folder from the moment it is known.
                        if let Some(dir) = kept(&dev, meeting) {
                            dump_meeting(&db, id, &dir).unwrap_or_else(|e| log::warn!("developer mode: meeting not kept: {e:#}"));
                        }
                    }
                    (Job::Captions(captions), Some(meeting)) => {
                        if let Some(first) = captions.first() {
                            let id = meeting.id(&db, &sink, first.first_ms)?;
                            let all = [meeting.earlier.as_slice(), &captions].concat();
                            db.set_captions(id, &all)?;
                            if let Some(dir) = kept(&dev, meeting) {
                                recorder::save_captions(&dir, &all).unwrap_or_else(|e| log::warn!("developer mode: captions not kept: {e:#}"));
                            }
                        }
                    }
                    (Job::Update(Update::Named { device_id, name }, _), Some(meeting)) => {
                        if let Some(id) = meeting.id {
                            if db.name_speaker(id, &device_id, &name)? > 0 {
                                sink(Event::MeetingUpdated { meeting_id: id });
                            }
                        }
                    }
                    (Job::Update(Update::Me { name }, _), Some(meeting)) => {
                        if let Some(id) = meeting.id {
                            if db.name_me(id, &name)? > 0 {
                                sink(Event::MeetingUpdated { meeting_id: id });
                            }
                        }
                    }
                    (Job::Utterance(a), Some(meeting)) => {
                        let Some(asr) = asr.as_mut() else { return Ok(()) };
                        let on_gpu = asr.device() == Device::Gpu;
                        // With the CPU to fall back on, a failure here is not the GPU's.
                        let gpu_only = on_gpu && !asr.cpu_fallback();
                        let transcript = asr.transcribe(&a.utterance.samples).inspect_err(|e| {
                            if gpu_only {
                                sink(Event::GpuFailed { error: format!("{e:#}"), trial: None });
                            }
                        })?;
                        if on_gpu && asr.device() == Device::Cpu {
                            sink(Event::GpuFailed { error: asr.gpu_error().unwrap_or_default().to_string(), trial: Some(asr.trial()) });
                        }
                        sink(Event::Transcribed { speed: transcript.speed });
                        let text = transcript.text;
                        if !text.is_empty() {
                            println!("{}: {text}", a.speaker.label());
                            let dump = kept(&dev, meeting);
                            let others = a.others.clone();
                            meeting.add(&db, &sink, segment(a, text), dump.as_deref(), others)?;
                        }
                    }
                    (Job::End { meeting: info, captions }, Some(meeting)) => {
                        let captions = [std::mem::take(&mut meeting.earlier), captions].concat();
                        if meeting.stored == 0 && captions.is_empty() {
                            if let Some(id) = meeting.id {
                                db.delete_meeting(id)?;
                                log::info!("meeting {id} had nothing said; not kept");
                                sink(Event::MeetingDiscarded { meeting_id: id });
                            }
                        } else {
                            let id = meeting.id(&db, &sink, meeting.connected_ms)?;
                            let ended_ms = if meeting.last_ms > 0 { meeting.last_ms } else { now_ms() };
                            db.finish_meeting(id, &info, ended_ms, &captions)?;
                            log::info!("meeting {id} saved");
                            if let Some(dir) = kept(&dev, meeting) {
                                match dump_transcript(&db, id, &dir, &meeting.others) {
                                    Ok(()) => log::info!("developer mode: transcript kept in {}", dir.display()),
                                    Err(e) => log::warn!("developer mode: transcript not kept: {e:#}"),
                                }
                            }
                            sink(Event::MeetingSaved { meeting_id: id });
                            closed = Some(Closed { at: Instant::now(), id, info, stored: meeting.stored, last_ms: meeting.last_ms, recent: std::mem::take(&mut meeting.recent), captions });
                        }
                        open = None;
                    }
                    _ => {}
                }
                Ok(())
            })();
            if let Err(e) = result {
                log::error!("{e:#}");
            }
            // A meeting counts from when its row exists: the call was joined.
            let live = open.as_ref().is_some_and(|m| m.id.is_some());
            idle_since = if asr.is_none() || live { None } else { idle_since.or_else(|| Some(Instant::now())) };
        }
    });
    Worker { jobs: tx, thread: Some(thread) }
}

/// Where the developer mode keeps this meeting's transcript right now; unset
/// when it is off or the meeting has no folder.
fn kept(dev: &watch::Receiver<DevSettings>, meeting: &Open) -> Option<PathBuf> {
    meeting.recording.clone().filter(|_| dev.borrow().transcripts())
}

fn dump_meeting(db: &Db, id: i64, dir: &Path) -> Result<()> {
    match db.meetings()?.into_iter().find(|m| m.id == id) {
        Some(meeting) => recorder::save_meeting(dir, &meeting),
        None => Ok(()),
    }
}

/// The meeting as stored, written again at the end: the names that came late
/// are in it, and the echoes are out.
fn dump_transcript(db: &Db, id: i64, dir: &Path, others: &HashMap<i64, Vec<String>>) -> Result<()> {
    let Some(meeting) = db.meetings()?.into_iter().find(|m| m.id == id) else { return Ok(()) };
    recorder::save_transcript(dir, &meeting, &db.transcript(id)?, others, &db.captions(id)?)
}

fn segment(a: AttributedUtterance, text: String) -> Segment {
    Segment {
        start_ms: a.utterance.start_ms,
        end_ms: a.utterance.end_ms,
        stream: a.utterance.stream,
        speaker: a.speaker,
        text,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    fn caption(first_ms: u64, text: &str) -> Caption {
        Caption { device_id: "spaces/x/devices/1".into(), speaker: Some("Ana".into()), first_ms, last_ms: first_ms + 900, text: text.into(), lang: None }
    }

    /// Runs one call per entry on a worker without a model, each ending
    /// with one caption, and returns the ids of the meetings they started.
    fn calls(codes: &[&str]) -> (Vec<i64>, Db) {
        let path = std::env::temp_dir().join(format!("entmoot-test-{}-{}.db", std::process::id(), codes.join("-")));
        std::fs::remove_file(&path).ok();
        let started = Arc::new(Mutex::new(Vec::new()));
        let seen = started.clone();
        let sink: Sink = Arc::new(move |event| {
            if let Event::MeetingStarted { meeting_id } = event {
                seen.lock().unwrap().push(meeting_id);
            }
        });
        let worker = spawn_worker(None, Arc::new(AtomicBool::new(false)), 0, Db::open(&path).unwrap(), sink, watch::channel(DevSettings::default()).1);
        for (i, code) in codes.iter().enumerate() {
            let info = MeetingInfo { platform: "meet".into(), code: code.to_string(), title: "Semanal".into() };
            let at = 1000 * (i as u64 + 1);
            worker.jobs.send(Job::Begin { started_ms: at, recording: None }).unwrap();
            worker.jobs.send(Job::Update(Update::Meeting(info.clone()), at)).unwrap();
            worker.jobs.send(Job::End { meeting: info, captions: vec![caption(at, "Bom dia")] }).unwrap();
        }
        drop(worker);
        let ids = started.lock().unwrap().clone();
        let db = Db::open(&path).unwrap();
        std::fs::remove_file(&path).ok();
        (ids, db)
    }

    #[test]
    fn a_call_joined_again_is_the_same_meeting() {
        let (ids, db) = calls(&["abc-defg-hij", "abc-defg-hij"]);
        assert_eq!(ids[0], ids[1]);
        let meetings = db.meetings().unwrap();
        assert_eq!(meetings.len(), 1);
        assert!(meetings[0].ended_ms.is_some());
        // The captions from before leaving are kept with the ones after.
        assert_eq!(db.captions(ids[0]).unwrap().len(), 2);
    }

    #[test]
    fn the_developer_mode_keeps_the_transcript_beside_the_dump() {
        let tag = format!("entmoot-test-{}-dev", std::process::id());
        let (db_path, dir) = (std::env::temp_dir().join(format!("{tag}.db")), std::env::temp_dir().join(&tag));
        std::fs::remove_file(&db_path).ok();
        std::fs::remove_dir_all(&dir).ok();
        let info = MeetingInfo { platform: "meet".into(), code: "abc-defg-hij".into(), title: "Semanal".into() };
        for (enabled, kept) in [(true, true), (false, false)] {
            let (_dev, rx) = watch::channel(DevSettings { enabled, ..DevSettings::default() });
            let sink: Sink = Arc::new(|_| {});
            let worker = spawn_worker(None, Arc::new(AtomicBool::new(false)), 0, Db::open(&db_path).unwrap(), sink, rx);
            worker.jobs.send(Job::Begin { started_ms: 1000, recording: Some(dir.clone()) }).unwrap();
            worker.jobs.send(Job::Update(Update::Meeting(info.clone()), 1000)).unwrap();
            worker.jobs.send(Job::End { meeting: info.clone(), captions: vec![caption(1000, "Bom dia")] }).unwrap();
            drop(worker);
            assert_eq!(dir.join("transcript.jsonl").exists(), kept);
            if kept {
                assert!(dir.join("meeting.json").exists());
                assert_eq!(std::fs::read_to_string(dir.join("captions.jsonl")).unwrap().lines().count(), 1);
                std::fs::remove_dir_all(&dir).ok();
            }
        }
        std::fs::remove_file(&db_path).ok();
    }

    #[test]
    fn another_call_is_another_meeting() {
        let (ids, db) = calls(&["abc-defg-hij", "nop-qrst-uvw", ""]);
        assert_eq!(ids.len(), 3);
        assert_eq!(db.meetings().unwrap().len(), 3);
        // Without a link nothing says it is the same call.
        let (ids, _) = calls(&["", ""]);
        assert_ne!(ids[0], ids[1]);
    }
}
