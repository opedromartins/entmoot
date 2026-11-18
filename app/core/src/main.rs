use std::collections::HashMap;
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::time::Instant;

use anyhow::{bail, Context, Result};

use transcritor_core::asr::{Device, Parakeet};
use transcritor_core::protocol::{AudioFrame, Message};
use transcritor_core::db::Db;
use transcritor_core::recorder::DevSettings;
use transcritor_core::session::{AttributedUtterance, Caption, MeetingInfo, Session, Speaker};
use transcritor_core::store::{MeetingWriter, Segment};
use transcritor_core::{echo, models, server, SAMPLE_RATE};

const USAGE: &str = "usage:
  transcritor serve  [--bind 127.0.0.1] [--port 17865] [--token dev] [--model NAME] [--device cpu|gpu] [--no-cpu-fallback] [--dump] [--models DIR] [--data DIR]
  transcritor replay SESSION_DIR [--model NAME] [--device cpu|gpu] [--no-cpu-fallback] [--models DIR] [--text]
  transcritor meetings            [--data DIR]
  transcritor show ID [--captions] [--data DIR]
  transcritor search WORDS...     [--data DIR]
  transcritor import MEETING_DIR  [--data DIR]
  transcritor delete ID           [--data DIR]

serve     accept the browser extension and transcribe meetings live; --dump keeps
          each meeting's messages, audio and transcript in DIR/recordings
replay    run a session recorded by tools/spike-receiver through the same pipeline
meetings  list stored meetings
show      print a meeting's transcript, or the platform's captions
search    find words across all transcripts
import    load a meeting saved as JSON Lines by an earlier version";

fn main() -> Result<()> {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();
    let mut args: Vec<String> = std::env::args().skip(1).collect();
    let mut flag = |name: &str| -> Option<String> {
        let i = args.iter().position(|a| a == name)?;
        args.remove(i);
        (i < args.len()).then(|| args.remove(i))
    };
    let models_root = PathBuf::from(flag("--models").unwrap_or_else(|| "models".into()));
    let model = flag("--model").unwrap_or_else(|| models::DEFAULT_MODEL.into());
    let device: Device = flag("--device").map_or(Ok(Device::Cpu), |d| d.parse())?;
    let fetch =|name: &str| models::ensure(&models_root, name, &mut |_, _| true);
    let data_dir = PathBuf::from(flag("--data").unwrap_or_else(|| "data".into()));
    let port = flag("--port").map_or(Ok(17865), |p| p.parse()).context("--port")?;
    let bind = flag("--bind").unwrap_or_else(|| "127.0.0.1".into());
    let token = flag("--token").unwrap_or_else(|| "dev".into());
    let mut switch = |name: &str| {
        let before = args.len();
        args.retain(|a| a != name);
        args.len() != before
    };
    let (show_text, show_captions) = (switch("--text"), switch("--captions"));
    let cpu_fallback = !switch("--no-cpu-fallback");
    let dump = switch("--dump");
    let db_path = data_dir.join("entmoot.db");

    match args.iter().map(String::as_str).collect::<Vec<_>>()[..] {
        ["serve"] => {
            let model_dir = fetch(&model)?;
            // Fixed for the run: nobody is there to change it.
            let dev = tokio::sync::watch::channel(DevSettings { enabled: dump, ..DevSettings::default() }).1;
            let config = server::Config {
                bind,
                port,
                token,
                model_dir: Some(model_dir),
                device,
                cpu_fallback: std::sync::Arc::new(std::sync::atomic::AtomicBool::new(cpu_fallback)),
                db_path,
                diagnostics_dir: Some(data_dir.join("diagnostics")),
                recordings_dir: Some(data_dir.join("recordings")),
                dev,
            };
            tokio::runtime::Runtime::new()?.block_on(server::serve(config, std::sync::Arc::new(|_| {}), tokio::sync::mpsc::unbounded_channel().1))
        }
        ["replay", dir] => replay(Path::new(dir), &fetch(&model)?, device, cpu_fallback, show_text),
        ["meetings"] => {
            for m in Db::open(&db_path)?.meetings()? {
                let minutes = m.ended_ms.map_or(0, |e| e.saturating_sub(m.started_ms) / 60_000);
                println!("{:>4}  {:>3} min  {:>4} trechos  {}  {}", m.id, minutes, m.segments, m.code, m.title);
            }
            Ok(())
        }
        ["show", id] => {
            let (db, id) = (Db::open(&db_path)?, id.parse()?);
            let start = db.meeting_start(id)?.context("no such meeting")?;
            if show_captions {
                for c in db.captions(id)? {
                    println!("[{}] {}: {}", clock(c.first_ms, start), c.speaker.as_deref().unwrap_or(&c.device_id), c.text);
                }
            } else {
                for s in db.transcript(id)? {
                    println!("[{}] {}: {}", clock(s.start_ms, start), s.speaker, s.text);
                }
            }
            Ok(())
        }
        ["search", ref words @ ..] if !words.is_empty() => {
            let db = Db::open(&db_path)?;
            for s in db.search(&words.join(" "))? {
                let start = db.meeting_start(s.meeting_id)?.unwrap_or(s.start_ms);
                println!("#{} [{}] {}: {}", s.meeting_id, clock(s.start_ms, start), s.speaker, s.text);
            }
            Ok(())
        }
        ["delete", id] => {
            let removed = Db::open(&db_path)?.delete_meeting(id.parse()?)?;
            println!("{}", if removed { "deleted" } else { "no such meeting" });
            Ok(())
        }
        ["import", dir] => import(Path::new(dir), &mut Db::open(&db_path)?),
        _ => bail!(USAGE),
    }
}

/// Time since the meeting started, as m:ss.
fn clock(ms: u64, start_ms: u64) -> String {
    let s = ms.saturating_sub(start_ms) / 1000;
    format!("{}:{:02}", s / 60, s % 60)
}

fn import(dir: &Path, db: &mut Db) -> Result<()> {
    let lines = |name: &str| -> Result<Vec<String>> {
        Ok(BufReader::new(File::open(dir.join(name)).context(name.to_string())?).lines().collect::<Result<_, _>>()?)
    };
    let segments: Vec<Segment> = lines("transcript.jsonl")?.iter().map(|l| serde_json::from_str(l)).collect::<Result<_, _>>()?;
    let captions: Vec<Caption> = lines("captions.jsonl")?.iter().map(|l| serde_json::from_str(l)).collect::<Result<_, _>>()?;
    let info: MeetingInfo = serde_json::from_reader(File::open(dir.join("meeting.json"))?)?;
    let start = segments.iter().map(|s| s.start_ms).min().context("empty transcript")?;
    let end = segments.iter().map(|s| s.end_ms).max().unwrap_or(start);

    let id = db.begin_meeting(start)?;
    for s in &segments {
        // Same check the live server makes, with the whole meeting at hand.
        let echo = matches!(s.speaker, Speaker::Me { .. }) && {
            let remote: Vec<&str> = segments
                .iter()
                .filter(|r| !matches!(r.speaker, Speaker::Me { .. }) && r.start_ms < s.end_ms + echo::WINDOW_MS && r.end_ms + echo::WINDOW_MS > s.start_ms)
                .map(|r| r.text.as_str())
                .collect();
            echo::is_echo(&s.text, &remote.join(" "))
        };
        db.add_segment(id, s, echo)?;
    }
    db.finish_meeting(id, &info, end, &captions)?;
    println!("imported as meeting {id}: {} segments, {} captions", segments.len(), captions.len());
    Ok(())
}

enum Item {
    Message(Message),
    Audio(AudioFrame),
}

/// Loads a recorded session as one time-ordered stream of what the extension sent.
fn load(dir: &Path) -> Result<Vec<(u64, Item)>> {
    let mut items = Vec::new();

    // decoded.jsonl holds roster and caption events for recordings made before
    // the extension decoded them itself.
    for name in ["events.jsonl", "decoded.jsonl"] {
        let Ok(file) = File::open(dir.join(name)) else { continue };
        for line in BufReader::new(file).lines() {
            let line = line?;
            let value: serde_json::Value = serde_json::from_str(&line)?;
            let t = value.get("t").and_then(|t| t.as_f64()).unwrap_or(0.0) as u64;
            if let Ok(msg) = serde_json::from_value(value) {
                items.push((t, Item::Message(msg)));
            }
        }
    }

    let mut wavs: HashMap<u8, hound::WavReader<BufReader<File>>> = HashMap::new();
    let index = File::open(dir.join("audio-index.csv")).context("audio-index.csv")?;
    for line in BufReader::new(index).lines().skip(1) {
        let line = line?;
        let cols: Vec<&str> = line.split(',').collect();
        let [stream, seq, t_ms, count] = cols[..] else { bail!("bad index line: {line}") };
        let (stream, count): (u8, usize) = (stream.parse()?, count.parse()?);
        if count == 0 {
            continue;
        }
        if !wavs.contains_key(&stream) {
            wavs.insert(stream, hound::WavReader::open(dir.join(format!("stream-{stream}.wav")))?);
        }
        let samples = wavs.get_mut(&stream).unwrap().samples::<i16>().take(count).collect::<Result<Vec<_>, _>>()?;
        let t_ms: u64 = t_ms.parse()?;
        items.push((t_ms, Item::Audio(AudioFrame { stream, seq: seq.parse()?, t_ms, samples })));
    }

    items.sort_by_key(|(t, _)| *t);
    Ok(items)
}

fn replay(dir: &Path, model_dir: &Path, device: Device, cpu_fallback: bool, show_text: bool) -> Result<()> {
    let items = load(dir)?;
    let t0 = items.iter().find_map(|(t, i)| matches!(i, Item::Audio(_)).then_some(*t)).context("no audio")?;
    let loading = Instant::now();
    let mut asr = Parakeet::load(model_dir, device, cpu_fallback)?;
    let trial = asr.trial();
    println!(
        "model loaded on the {:?} in {:.1} s; trial: {:.1} s of audio in {:.2} s",
        asr.device(),
        loading.elapsed().as_secs_f64(),
        trial.audio_ms as f64 / 1000.0,
        trial.took_ms as f64 / 1000.0
    );
    if let Some(e) = asr.gpu_error() {
        println!("the GPU could not be used: {e}");
    }
    let mut writer = MeetingWriter::create(&dir.join("replay"))?;
    let mut session = Session::default();

    let mut segments: Vec<Segment> = Vec::new();
    let (mut audio_ms, mut asr_time) = (0u64, std::time::Duration::ZERO);
    let mut transcribe = |a: AttributedUtterance| -> Result<()> {
        let started = Instant::now();
        let text = asr.transcribe(&a.utterance.samples)?.text;
        asr_time += started.elapsed();
        audio_ms += a.utterance.samples.len() as u64 * 1000 / SAMPLE_RATE as u64;
        let u = &a.utterance;
        let at = |ms: u64| (ms.saturating_sub(t0)) as f64 / 1000.0;
        let shown = if show_text { text.as_str() } else { "" };
        println!("{:7.1}-{:7.1}  stream {}  {:<28} {:>3} chars  {shown}", at(u.start_ms), at(u.end_ms), u.stream, a.speaker.label(), text.chars().count());
        if !text.is_empty() {
            let segment = Segment { start_ms: u.start_ms, end_ms: u.end_ms, stream: u.stream, speaker: a.speaker, text };
            writer.segment(&segment)?;
            segments.push(segment);
        }
        Ok(())
    };

    for (_, item) in items {
        match item {
            Item::Message(m) => session.handle_message(m),
            Item::Audio(f) => session.handle_audio(f).into_iter().try_for_each(&mut transcribe)?,
        }
    }
    session.finish().into_iter().try_for_each(&mut transcribe)?;
    let captions = session.captions();
    writer.finish(&session.meeting, &captions)?;

    // The platform's captions name their speaker independently of our audio
    // path, so they check the attribution: a remote segment agrees when a
    // caption overlapping it in time came from the same device.
    let (mut checked, mut agree) = (0, 0);
    for s in &segments {
        let Speaker::Participant { device_id, .. } = &s.speaker else { continue };
        let overlapping: Vec<_> = captions
            .iter()
            .filter(|c| c.first_ms.saturating_sub(500) <= s.end_ms + 3000 && c.last_ms >= s.start_ms)
            .collect();
        if overlapping.is_empty() {
            continue;
        }
        checked += 1;
        agree += overlapping.iter().any(|c| &c.device_id == device_id) as u32;
    }
    let unknown = segments.iter().filter(|s| s.speaker == Speaker::Unknown).count();
    println!("\nsegments: {}  unknown speaker: {unknown}  captions: {}", segments.len(), captions.len());
    println!("remote segments overlapping a caption: {checked}, same speaker as the caption: {agree}");
    // The GPU may have failed along the way.
    println!(
        "transcribed {:.1} s of speech in {:.1} s ({:.1}x real time), ending on the {:?}",
        audio_ms as f64 / 1000.0,
        asr_time.as_secs_f64(),
        audio_ms as f64 / 1000.0 / asr_time.as_secs_f64().max(1e-9),
        asr.device()
    );
    println!("written to {}", dir.join("replay").display());
    Ok(())
}
