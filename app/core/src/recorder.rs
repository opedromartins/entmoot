//! Developer mode: what the extension sends during a meeting, kept in a folder
//! in the format `replay` and tools/replay read:
//!
//! - `events.jsonl`: every text message, the raw data-channel frames included
//! - `stream-N.wav` and `audio-index.csv`: the audio of each track, and when each frame came
//! - `meeting.json`, `transcript.jsonl` and `captions.jsonl`: what the app made of it
//! - `speakers.json`: who was in the call, how much each one spoke and on which
//!   tracks, and where each track's audio is continuous
//!
//! One folder per meeting, made on the first write, so a page that opens and
//! never joins a call leaves nothing behind.

use std::collections::{BTreeMap, HashMap, VecDeque};
use std::fs::File;
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};

use anyhow::Result;
use serde::{Deserialize, Serialize};

use crate::db::{MeetingRow, SegmentRow};
use crate::protocol::{AudioFrame, MIC_STREAM};
use crate::session::{AttributedUtterance, Caption, MeetingInfo, Person};

/// What the user turned on in the developer settings. Read at each message,
/// so a change takes effect in the meeting going on.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct DevSettings {
    /// The developer mode itself. With it off, nothing below is done.
    pub enabled: bool,
    /// Keep every message from the extension, and ask it for all of them: the
    /// frames of every data channel, not only the first ones.
    pub dump_events: bool,
    /// Keep the audio of every track.
    pub dump_audio: bool,
    /// Keep what the app made of the meeting, next to what it came from.
    pub save_transcripts: bool,
}

impl Default for DevSettings {
    fn default() -> Self {
        Self { enabled: false, dump_events: true, dump_audio: true, save_transcripts: true }
    }
}

impl DevSettings {
    pub fn events(&self) -> bool {
        self.enabled && self.dump_events
    }
    pub fn audio(&self) -> bool {
        self.enabled && self.dump_audio
    }
    pub fn transcripts(&self) -> bool {
        self.enabled && self.save_transcripts
    }
}

/// How many audio frames of a track go to disk before the file's header is
/// brought up to date, so a recording cut short is still a valid WAV.
const WAV_FLUSH_EVERY: u32 = 100;
const RATE: u32 = 16_000;
/// A frame starting this close to where the previous one ended continues it;
/// the clock the frames are stamped with is not exact to the millisecond.
const CONTINUOUS_WITHIN_MS: u64 = 50;

/// Audio of one track that is continuous: its frames follow one another with
/// no time missing between them. `offset_samples` is where it starts in the
/// WAV, so a time in it is `offset_samples + (t_ms - from_ms) * 16`.
#[derive(Debug, Clone, Serialize)]
pub struct Run {
    pub from_ms: u64,
    pub to_ms: u64,
    pub offset_samples: u64,
    pub samples: u64,
}

struct Track {
    wav: hound::WavWriter<BufWriter<File>>,
    since_flush: u32,
    written: u64,
    runs: Vec<Run>,
}

/// A frame whose loudest sample is this low is silence (about -84 dBFS).
const SILENT_PEAK: u16 = 2;
/// Frames of silence kept before and after sound: enough for the segmenter's
/// lead-in (2 frames) and for the 600 ms of silence that ends a sentence.
const SILENCE_KEPT: u32 = 7;

/// Silence seen on a track, waiting to know whether sound follows.
#[derive(Default)]
struct Quiet {
    /// The latest silent frames, kept to go before the next sound.
    pending: VecDeque<AudioFrame>,
    /// How many more silent frames go out, after a sound.
    tail: u32,
}

/// What one speaker was heard doing, from the utterances cut so far.
#[derive(Default)]
struct Heard {
    utterances: u32,
    ms: u64,
    streams: BTreeMap<u8, u64>,
}

/// One meeting's folder. Nothing touches the disk before the first write.
pub struct Recorder {
    dir: PathBuf,
    made: bool,
    events: Option<BufWriter<File>>,
    index: Option<BufWriter<File>>,
    tracks: HashMap<u8, Track>,
    quiet: HashMap<u8, Quiet>,
    heard: HashMap<String, Heard>,
}

/// A folder for a meeting that starts now: the date and time, like the older
/// receiver's, with a number after it when two start in the same second.
pub fn new_folder(root: &Path) -> PathBuf {
    let name = chrono::Local::now().format("%Y%m%d-%H%M%S").to_string();
    let mut dir = root.join(&name);
    let mut n = 1;
    while dir.exists() {
        n += 1;
        dir = root.join(format!("{name}-{n}"));
    }
    dir
}

impl Recorder {
    pub fn new(dir: PathBuf) -> Self {
        Self { dir, made: false, events: None, index: None, tracks: HashMap::new(), quiet: HashMap::new(), heard: HashMap::new() }
    }

    /// Counts an utterance toward who it was attributed to.
    pub fn heard(&mut self, a: &AttributedUtterance) {
        let heard = self.heard.entry(a.speaker.key()).or_default();
        let ms = a.utterance.end_ms.saturating_sub(a.utterance.start_ms);
        heard.utterances += 1;
        heard.ms += ms;
        *heard.streams.entry(a.utterance.stream).or_default() += ms;
    }

    /// Who was in the call and how it went, written again as it changes.
    pub fn save_speakers(&mut self, meeting: &MeetingInfo, people: &[Person]) -> Result<()> {
        let mut speakers: BTreeMap<String, SpeakerEntry> = BTreeMap::new();
        for person in people {
            // The local user is one speaker whatever device the platform calls it.
            let key = if person.own { "me".to_string() } else { person.device_id.clone() };
            speakers.insert(key.clone(), SpeakerEntry { speaker_key: key, name: person.name.clone(), is_me: person.own, device_id: Some(person.device_id.clone()), csrc: person.csrc.clone(), ..SpeakerEntry::default() });
        }
        for (key, heard) in &self.heard {
            let entry = speakers.entry(key.clone()).or_insert_with(|| SpeakerEntry { speaker_key: key.clone(), is_me: key == "me", ..SpeakerEntry::default() });
            entry.utterances = heard.utterances;
            entry.ms = heard.ms;
            entry.streams = heard.streams.iter().map(|(&stream, &ms)| StreamTime { stream, ms }).collect();
        }
        let mut streams: Vec<StreamEntry> = self
            .tracks
            .iter()
            .map(|(&stream, track)| StreamEntry { stream, kind: if stream == MIC_STREAM { "mic" } else { "remote" }, file: format!("stream-{stream}.wav"), runs: track.runs.clone() })
            .collect();
        streams.sort_by_key(|s| s.stream);
        let file = SpeakersFile { meeting: meeting.clone(), speakers: speakers.into_values().collect(), streams };
        self.make()?;
        Ok(std::fs::write(self.dir.join("speakers.json"), serde_json::to_vec_pretty(&file)?)?)
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    fn make(&mut self) -> Result<()> {
        if !self.made {
            std::fs::create_dir_all(&self.dir)?;
            self.made = true;
        }
        Ok(())
    }

    /// One message as the extension sent it. The frequent kinds wait for the
    /// next rare one to be flushed.
    pub fn event(&mut self, text: &str) -> Result<()> {
        if self.events.is_none() {
            self.make()?;
            self.events = Some(BufWriter::new(File::create(self.dir.join("events.jsonl"))?));
        }
        let Some(file) = self.events.as_mut() else { return Ok(()) };
        writeln!(file, "{text}")?;
        if !(text.starts_with(r#"{"kind":"speakers""#) || text.starts_with(r#"{"kind":"raw""#)) {
            file.flush()?;
        }
        Ok(())
    }

    /// Keeps a frame of audio, unless it is part of a long silence. The
    /// microphone never stops sending (while muted it sends zeros, on purpose:
    /// the transcription needs the silence to close a sentence), and a file of
    /// an hour of it would be most of the call's size for nothing. Silence
    /// stays for a little before and after each sound, so what is kept is what
    /// the transcription was given, and the rest shows up as a gap in the
    /// index and in `speakers.json`, as it does on the remote tracks.
    pub fn audio(&mut self, frame: &AudioFrame) -> Result<()> {
        let quiet = self.quiet.entry(frame.stream).or_default();
        let silent = frame.samples.iter().all(|s| s.unsigned_abs() <= SILENT_PEAK);
        let mut lead = Vec::new();
        let keep = if !silent {
            quiet.tail = SILENCE_KEPT;
            lead.extend(quiet.pending.drain(..));
            true
        } else if quiet.tail > 0 {
            quiet.tail -= 1;
            true
        } else {
            quiet.pending.push_back(frame.clone());
            if quiet.pending.len() > SILENCE_KEPT as usize {
                quiet.pending.pop_front();
            }
            false
        };
        for earlier in &lead {
            self.write(earlier)?;
        }
        if keep {
            self.write(frame)?;
        }
        Ok(())
    }

    fn write(&mut self, frame: &AudioFrame) -> Result<()> {
        if self.index.is_none() {
            self.make()?;
            let mut index = BufWriter::new(File::create(self.dir.join("audio-index.csv"))?);
            writeln!(index, "stream,seq,t_ms,samples")?;
            self.index = Some(index);
        }
        if !self.tracks.contains_key(&frame.stream) {
            let spec = hound::WavSpec { channels: 1, sample_rate: RATE, bits_per_sample: 16, sample_format: hound::SampleFormat::Int };
            let wav = hound::WavWriter::create(self.dir.join(format!("stream-{}.wav", frame.stream)), spec)?;
            self.tracks.insert(frame.stream, Track { wav, since_flush: 0, written: 0, runs: Vec::new() });
        }
        if let Some(index) = self.index.as_mut() {
            writeln!(index, "{},{},{},{}", frame.stream, frame.seq, frame.t_ms, frame.samples.len())?;
        }
        if let Some(track) = self.tracks.get_mut(&frame.stream) {
            for sample in &frame.samples {
                track.wav.write_sample(*sample)?;
            }
            let samples = frame.samples.len() as u64;
            let to_ms = frame.t_ms + samples * 1000 / u64::from(RATE);
            match track.runs.last_mut() {
                Some(run) if frame.t_ms.abs_diff(run.to_ms) <= CONTINUOUS_WITHIN_MS => {
                    run.to_ms = to_ms;
                    run.samples += samples;
                }
                _ => track.runs.push(Run { from_ms: frame.t_ms, to_ms, offset_samples: track.written, samples }),
            }
            track.written += samples;
            track.since_flush += 1;
            if track.since_flush >= WAV_FLUSH_EVERY {
                track.since_flush = 0;
                track.wav.flush()?;
                if let Some(index) = self.index.as_mut() {
                    index.flush()?;
                }
            }
        }
        Ok(())
    }

    /// Closes the files; what was written stays valid. Also done on drop.
    pub fn finish(&mut self) {
        if let Some(mut events) = self.events.take() {
            events.flush().ok();
        }
        if let Some(mut index) = self.index.take() {
            index.flush().ok();
        }
        for (_, track) in self.tracks.drain() {
            track.wav.finalize().ok();
        }
    }
}

impl Drop for Recorder {
    fn drop(&mut self) {
        self.finish();
    }
}

fn lines<T: Serialize>(path: &Path, rows: &[T]) -> Result<()> {
    let mut file = BufWriter::new(File::create(path)?);
    for row in rows {
        serde_json::to_writer(&mut file, row)?;
        writeln!(file)?;
    }
    Ok(file.flush()?)
}

/// What the app kept of a meeting goes next to the folder's raw files, as it
/// happens: each segment is added when it is transcribed, the captions and
/// the meeting's details are written again when they change. At the end the
/// three are written once more from the database, which has the names that
/// came late and no echoes.
pub fn save_meeting(dir: &Path, meeting: &MeetingRow) -> Result<()> {
    std::fs::create_dir_all(dir)?;
    Ok(std::fs::write(dir.join("meeting.json"), serde_json::to_vec_pretty(meeting)?)?)
}

/// A line of `transcript.jsonl`: the stored segment, and who else was audible
/// on its track while it lasted (speaker keys). Unset where that is not known:
/// speech from before the call was joined again.
#[derive(Serialize)]
struct DumpSegment<'a> {
    #[serde(flatten)]
    row: &'a SegmentRow,
    others: Option<&'a [String]>,
}

pub fn append_segment(dir: &Path, segment: &SegmentRow, others: &[String]) -> Result<()> {
    std::fs::create_dir_all(dir)?;
    let mut file = std::fs::OpenOptions::new().create(true).append(true).open(dir.join("transcript.jsonl"))?;
    // One write, so a line is never left half there.
    let mut line = serde_json::to_vec(&DumpSegment { row: segment, others: Some(others) })?;
    line.push(b'\n');
    Ok(file.write_all(&line)?)
}

#[derive(Default, Serialize)]
struct StreamTime {
    stream: u8,
    ms: u64,
}

#[derive(Default, Serialize)]
struct SpeakerEntry {
    /// What `transcript.jsonl` calls them: `me`, a device, or `unknown`.
    speaker_key: String,
    /// The name the platform gave, when it did.
    name: Option<String>,
    is_me: bool,
    device_id: Option<String>,
    csrc: Vec<u32>,
    /// Utterances attributed to them, and how long they last altogether
    /// (with the margins the audio is cut with), whether or not the model
    /// found words in them.
    utterances: u32,
    ms: u64,
    /// The same, track by track.
    streams: Vec<StreamTime>,
}

#[derive(Serialize)]
struct StreamEntry {
    stream: u8,
    kind: &'static str,
    file: String,
    runs: Vec<Run>,
}

#[derive(Serialize)]
struct SpeakersFile {
    meeting: MeetingInfo,
    speakers: Vec<SpeakerEntry>,
    streams: Vec<StreamEntry>,
}

/// The captions are revised in place as people speak, so the file is made again.
pub fn save_captions(dir: &Path, captions: &[Caption]) -> Result<()> {
    std::fs::create_dir_all(dir)?;
    lines(&dir.join("captions.jsonl"), captions)
}

/// `others` is what was known when each segment was made, by segment id.
pub fn save_transcript(dir: &Path, meeting: &MeetingRow, segments: &[SegmentRow], others: &HashMap<i64, Vec<String>>, captions: &[Caption]) -> Result<()> {
    save_meeting(dir, meeting)?;
    let rows: Vec<DumpSegment> = segments.iter().map(|row| DumpSegment { row, others: others.get(&row.id).map(Vec::as_slice) }).collect();
    lines(&dir.join("transcript.jsonl"), &rows)?;
    save_captions(dir, captions)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(stream: u8, seq: u32, samples: Vec<i16>) -> AudioFrame {
        AudioFrame { stream, seq, t_ms: 1_000 + u64::from(seq) * 100, samples }
    }

    /// A 100 ms frame of sound.
    fn frame_at(stream: u8, seq: u32, t_ms: u64) -> AudioFrame {
        AudioFrame { stream, seq, t_ms, samples: vec![100; 1600] }
    }

    fn silence_at(stream: u8, seq: u32, t_ms: u64) -> AudioFrame {
        AudioFrame { stream, seq, t_ms, samples: vec![0; 1600] }
    }

    #[test]
    fn long_silence_is_left_out_and_shows_as_a_gap() {
        let root = std::env::temp_dir().join(format!("entmoot-rec-{}-quiet", std::process::id()));
        std::fs::remove_dir_all(&root).ok();
        let mut recorder = Recorder::new(new_folder(&root));
        // Frames 0-19 silent, 20-22 sound, 23-42 silent, 43-44 sound.
        for i in 0..45u32 {
            let t = 10_000 + u64::from(i) * 100;
            let sound = (20..23).contains(&i) || i >= 43;
            recorder.audio(&if sound { frame_at(0, i, t) } else { silence_at(0, i, t) }).unwrap();
        }
        let people: [Person; 0] = [];
        recorder.save_speakers(&MeetingInfo { platform: "meet".into(), ..MeetingInfo::default() }, &people).unwrap();
        let dir = recorder.dir().to_path_buf();
        drop(recorder);

        // The 7 silent frames before and after each sound are kept.
        let file: serde_json::Value = serde_json::from_slice(&std::fs::read(dir.join("speakers.json")).unwrap()).unwrap();
        let runs = file["streams"][0]["runs"].as_array().unwrap();
        assert_eq!(runs.iter().map(|r| (r["from_ms"].as_u64().unwrap(), r["samples"].as_u64().unwrap())).collect::<Vec<_>>(), [(11_300, 17 * 1600), (13_600, 9 * 1600)]);
        let wav = hound::WavReader::open(dir.join("stream-0.wav")).unwrap();
        assert_eq!(wav.len(), 26 * 1600);
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn nothing_is_made_until_something_is_written() {
        let root = std::env::temp_dir().join(format!("entmoot-rec-{}-lazy", std::process::id()));
        std::fs::remove_dir_all(&root).ok();
        let recorder = Recorder::new(new_folder(&root));
        assert!(!recorder.dir().exists());
        drop(recorder);
        assert!(!root.exists());
    }

    #[test]
    fn keeps_messages_and_audio_in_the_format_replay_reads() {
        let root = std::env::temp_dir().join(format!("entmoot-rec-{}-keep", std::process::id()));
        std::fs::remove_dir_all(&root).ok();
        let mut recorder = Recorder::new(new_folder(&root));
        recorder.event(r#"{"kind":"meeting","platform":"meet","code":"abc"}"#).unwrap();
        recorder.audio(&frame(0, 0, vec![1, 2, 3])).unwrap();
        recorder.audio(&frame(2, 0, vec![4])).unwrap();
        recorder.audio(&frame(0, 1, vec![5, 6])).unwrap();
        let dir = recorder.dir().to_path_buf();
        drop(recorder);

        assert_eq!(std::fs::read_to_string(dir.join("events.jsonl")).unwrap().lines().count(), 1);
        let index = std::fs::read_to_string(dir.join("audio-index.csv")).unwrap();
        assert_eq!(index.lines().collect::<Vec<_>>(), ["stream,seq,t_ms,samples", "0,0,1000,3", "2,0,1000,1", "0,1,1100,2"]);
        let samples: Vec<i16> = hound::WavReader::open(dir.join("stream-0.wav")).unwrap().samples::<i16>().map(Result::unwrap).collect();
        assert_eq!(samples, [1, 2, 3, 5, 6]);
        assert!(dir.join("stream-2.wav").exists());
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn speakers_tell_where_the_audio_is_continuous_and_who_spoke() {
        use crate::session::{AttributedUtterance, Speaker};
        use crate::vad::Utterance;

        let root = std::env::temp_dir().join(format!("entmoot-rec-{}-speakers", std::process::id()));
        std::fs::remove_dir_all(&root).ok();
        let mut recorder = Recorder::new(new_folder(&root));
        // 100 ms frames: three in a row, then a jump of a second, then two more.
        for (seq, t_ms) in [(0, 1_000), (1, 1_100), (2, 1_203), (3, 2_300), (4, 2_400)] {
            recorder.audio(&frame_at(2, seq, t_ms)).unwrap();
        }
        recorder.audio(&frame_at(0, 0, 1_000)).unwrap();
        let ana = Speaker::Participant { device_id: "spaces/x/devices/1".into(), name: Some("Ana".into()) };
        recorder.heard(&AttributedUtterance { utterance: Utterance { stream: 2, start_ms: 1_000, end_ms: 1_300, samples: vec![] }, speaker: ana, others: vec![] });
        let people = [
            Person { device_id: "spaces/x/devices/1".into(), name: Some("Ana".into()), own: false, csrc: vec![111] },
            Person { device_id: "spaces/x/devices/3".into(), name: Some("Caio".into()), own: true, csrc: vec![] },
        ];
        recorder.save_speakers(&MeetingInfo { platform: "meet".into(), code: "abc".into(), title: "Semanal".into() }, &people).unwrap();
        let dir = recorder.dir().to_path_buf();
        drop(recorder);

        let file: serde_json::Value = serde_json::from_slice(&std::fs::read(dir.join("speakers.json")).unwrap()).unwrap();
        let streams = file["streams"].as_array().unwrap();
        assert_eq!(streams.iter().map(|s| (s["stream"].as_u64().unwrap(), s["kind"].as_str().unwrap())).collect::<Vec<_>>(), [(0, "mic"), (2, "remote")]);
        // Jitter of a few milliseconds does not break a run; a missing second does.
        let runs = streams[1]["runs"].as_array().unwrap();
        assert_eq!(runs.len(), 2);
        assert_eq!((runs[0]["from_ms"].as_u64(), runs[0]["to_ms"].as_u64(), runs[0]["offset_samples"].as_u64(), runs[0]["samples"].as_u64()), (Some(1_000), Some(1_303), Some(0), Some(4_800)));
        assert_eq!((runs[1]["from_ms"].as_u64(), runs[1]["offset_samples"].as_u64()), (Some(2_300), Some(4_800)));

        let speakers = file["speakers"].as_array().unwrap();
        let by_key = |key: &str| speakers.iter().find(|s| s["speaker_key"] == key).unwrap();
        assert_eq!(by_key("spaces/x/devices/1")["ms"], 300);
        assert_eq!(by_key("spaces/x/devices/1")["streams"][0]["stream"], 2);
        // The local user is `me` whatever the device, and may not have spoken.
        assert_eq!((by_key("me")["name"].as_str(), by_key("me")["is_me"].as_bool(), by_key("me")["ms"].as_u64()), (Some("Caio"), Some(true), Some(0)));
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn a_second_meeting_in_the_same_second_gets_its_own_folder() {
        let root = std::env::temp_dir().join(format!("entmoot-rec-{}-twice", std::process::id()));
        std::fs::remove_dir_all(&root).ok();
        let mut first = Recorder::new(new_folder(&root));
        first.event("{}").unwrap();
        let second = new_folder(&root);
        assert_ne!(first.dir(), second);
        std::fs::remove_dir_all(&root).ok();
    }
}
