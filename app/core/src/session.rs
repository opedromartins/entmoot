//! State of one meeting: roster, who is audible where, open utterances and
//! the platform's own captions. Synchronous and free of I/O, so the server and
//! the replay tool drive it the same way.

use std::borrow::Cow;
use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};

use crate::attribution::SpeakerTimeline;
use crate::protocol::{AudioFrame, Message, MIC_STREAM};
use crate::vad::{Segmenter, Utterance};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Speaker {
    /// The local user, heard through the microphone, by the name the meeting
    /// gives them once it is known.
    Me {
        #[serde(default)]
        name: Option<String>,
    },
    Participant { device_id: String, name: Option<String> },
    Unknown,
}

impl Speaker {
    /// Identity within the meeting, for grouping: `me`, the device, or `unknown`.
    pub fn key(&self) -> String {
        match self {
            Speaker::Me { .. } => "me".into(),
            Speaker::Participant { device_id, .. } => device_id.clone(),
            Speaker::Unknown => "unknown".into(),
        }
    }

    pub fn label(&self) -> Cow<'_, str> {
        match self {
            Speaker::Me { name: Some(name) } => name.into(),
            Speaker::Me { name: None } => "Você".into(),
            Speaker::Participant { name: Some(name), .. } => name.into(),
            // Meet's device ids look like `spaces/<meeting>/devices/<number>`.
            // A Teams id is a person's, and too long to tell anyone apart by.
            Speaker::Participant { device_id, .. } => match device_id.rsplit_once('/') {
                Some((_, number)) => format!("Participante {number}").into(),
                None => "Participante".into(),
            },
            Speaker::Unknown => "Desconhecido".into(),
        }
    }
}

/// Something the session learned that concerns what is already stored.
#[derive(Debug, Clone, PartialEq)]
pub enum Update {
    Meeting(MeetingInfo),
    /// A participant's name, possibly after some of their speech was stored.
    Named { device_id: String, name: String },
    /// The local user's name in the meeting.
    Me { name: String },
    /// A caption line appeared or was revised.
    Caption(LiveCaption),
}

/// A caption line as it stands now, to show while the meeting goes on.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct LiveCaption {
    /// The same for every revision of a line.
    pub key: String,
    pub device_id: String,
    pub speaker: Option<String>,
    pub first_ms: u64,
    pub last_ms: u64,
    pub text: String,
}

#[derive(Debug)]
pub struct AttributedUtterance {
    pub utterance: Utterance,
    pub speaker: Speaker,
    /// Other sources audible on the stream while it lasted (their speaker
    /// keys), which is how to tell speech that may hold another voice from
    /// speech that is one person's alone. Always empty for the microphone.
    pub others: Vec<String>,
}

/// Someone in the call, as far as the extension has said.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Person {
    pub device_id: String,
    pub name: Option<String>,
    /// The local user's own device.
    pub own: bool,
    /// The audio sources the platform gave this device.
    pub csrc: Vec<u32>,
}

/// One caption line from the meeting platform, in its latest revision.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Caption {
    pub device_id: String,
    pub speaker: Option<String>,
    pub first_ms: u64,
    pub last_ms: u64,
    pub text: String,
    pub lang: Option<String>,
}

#[derive(Debug, Default, Clone, PartialEq, Serialize, Deserialize)]
pub struct MeetingInfo {
    pub platform: String,
    pub code: String,
    pub title: String,
}

#[derive(Default)]
pub struct Session {
    pub meeting: MeetingInfo,
    participants: HashMap<String, String>,
    /// The device the local user is in the call with.
    own_device: Option<String>,
    /// Audio CSRC -> device. Entries outlive `source_removed`: utterances are
    /// attributed after the fact, possibly after the person left.
    sources: HashMap<u32, String>,
    /// Sources the platform reports as muted right now.
    muted: HashSet<u32>,
    updates: Vec<Update>,
    timeline: SpeakerTimeline,
    /// What was heard from sources while they were muted.
    muted_timeline: SpeakerTimeline,
    segmenters: HashMap<u8, Segmenter>,
    /// Source the open utterance on each remote stream belongs to.
    open_source: HashMap<u8, u32>,
    captions: HashMap<(String, u64), Caption>,
    caption_order: Vec<(String, u64)>,
    ended: bool,
}

impl Session {
    /// True once after the extension reports that the page left the meeting.
    pub fn take_ended(&mut self) -> bool {
        std::mem::take(&mut self.ended)
    }

    /// What changed since the last call, for whoever stores the meeting.
    pub fn take_updates(&mut self) -> Vec<Update> {
        std::mem::take(&mut self.updates)
    }

    pub fn handle_message(&mut self, msg: Message) {
        match msg {
            Message::Meeting { platform, code, title } => {
                // The title is only known a few seconds in; keep the best one.
                let info = MeetingInfo { platform, code, title };
                if info.title.len() >= self.meeting.title.len() && info != self.meeting {
                    self.meeting = info.clone();
                    self.updates.push(Update::Meeting(info));
                }
            }
            Message::MeetingEnd {} => self.ended = true,
            Message::Participant { device_id, name, own } => {
                // Only some mentions of the device say it is the user's own.
                let found = own && self.own_device.as_deref() != Some(&device_id);
                if found {
                    self.own_device = Some(device_id.clone());
                }
                let renamed = self.participants.get(&device_id) != Some(&name);
                if (found || renamed) && self.own_device.as_deref() == Some(&device_id) {
                    self.updates.push(Update::Me { name: name.clone() });
                }
                if renamed {
                    self.participants.insert(device_id.clone(), name.clone());
                    self.updates.push(Update::Named { device_id, name });
                }
            }
            Message::Source { device_id, csrc, media, muted } => {
                if media == "audio" {
                    self.sources.insert(csrc, device_id);
                    match muted {
                        Some(true) => self.muted.insert(csrc),
                        Some(false) => self.muted.remove(&csrc),
                        None => false,
                    };
                }
            }
            Message::Speakers { t, streams } => {
                for s in streams {
                    for src in s.csrc {
                        let timeline = if self.muted.contains(&src.id) { &mut self.muted_timeline } else { &mut self.timeline };
                        timeline.push(s.stream, t as u64, src.id, src.level, src.ts);
                    }
                }
            }
            Message::Caption { t, device_id, message_id, text, lang } => {
                let key = (device_id.clone(), message_id.unwrap_or(0));
                let t = t as u64;
                if !self.captions.contains_key(&key) {
                    self.caption_order.push(key.clone());
                }
                let c = self.captions.entry(key.clone()).or_insert_with(|| Caption { device_id, speaker: None, first_ms: t, last_ms: t, text: String::new(), lang });
                c.last_ms = t;
                c.text = text;
                self.updates.push(Update::Caption(LiveCaption {
                    key: format!("{}/{}", key.0, key.1),
                    device_id: c.device_id.clone(),
                    speaker: self.participants.get(&c.device_id).cloned(),
                    first_ms: c.first_ms,
                    last_ms: c.last_ms,
                    text: c.text.clone(),
                }));
            }
            Message::Hello { .. } | Message::SourceRemoved { .. } | Message::Other => {}
        }
    }

    /// Feeds one audio frame; returns the utterances it completed.
    pub fn handle_audio(&mut self, frame: AudioFrame) -> Vec<AttributedUtterance> {
        let mut done = Vec::new();
        let stream = frame.stream;
        let seg = self.segmenters.entry(stream).or_insert_with(|| Segmenter::new(stream));

        // A remote stream is reused for whoever is loudest. When the person on
        // it changes mid-utterance, cut so each piece gets its own speaker.
        // Not while the one who was speaking still is: on a stream with
        // voices mixed, two people talking at once would cut it at every turn.
        if stream != MIC_STREAM {
            let now = self.timeline.current(stream, frame.t_ms).into_iter().find(|c| self.sources.contains_key(c));
            let together = self.timeline.together(stream, frame.t_ms);
            match (now, self.open_source.get(&stream).copied()) {
                (Some(now), Some(open)) if now != open && seg.is_open() && !together.contains(&open) => {
                    done.extend(seg.close());
                    self.open_source.insert(stream, now);
                }
                (Some(now), None) => {
                    self.open_source.insert(stream, now);
                }
                _ => {}
            }
        }

        done.extend(seg.feed(frame.t_ms, &frame.samples));
        if !seg.is_open() {
            self.open_source.remove(&stream);
        }
        done.into_iter().filter_map(|u| self.attribute(u)).collect()
    }

    /// Closes every open utterance, at the end of the meeting.
    pub fn finish(&mut self) -> Vec<AttributedUtterance> {
        let open: Vec<Utterance> = self.segmenters.values_mut().filter_map(Segmenter::close).collect();
        let mut done: Vec<_> = open.into_iter().filter_map(|u| self.attribute(u)).collect();
        done.sort_by_key(|a| a.utterance.start_ms);
        done
    }

    /// Names who spoke. None when the audio came only from muted sources:
    /// that is not transcribed.
    fn attribute(&self, utterance: Utterance) -> Option<AttributedUtterance> {
        let mut others = Vec::new();
        let speaker = if utterance.stream == MIC_STREAM {
            Speaker::Me { name: self.own_device.as_ref().and_then(|device| self.participants.get(device)).cloned() }
        } else {
            let (stream, start, end) = (utterance.stream, utterance.start_ms, utterance.end_ms);
            let heard = self.timeline.ranked(stream, start, end);
            if heard.is_empty() && !self.muted_timeline.ranked(stream, start, end).is_empty() {
                return None;
            }
            let chosen = heard.iter().find_map(|csrc| self.sources.get(csrc));
            if let Some(chosen) = chosen {
                for csrc in &heard {
                    // A source the roster does not know is someone too.
                    let who = self.sources.get(csrc).map_or("unknown", String::as_str);
                    if who != chosen && !others.iter().any(|o| o == who) {
                        others.push(who.to_string());
                    }
                }
            }
            chosen.map_or(Speaker::Unknown, |device_id| Speaker::Participant {
                device_id: device_id.clone(),
                name: self.participants.get(device_id).cloned(),
            })
        };
        Some(AttributedUtterance { utterance, speaker, others })
    }

    /// Everyone the extension has told about, the local user included.
    pub fn people(&self) -> Vec<Person> {
        let mut devices: Vec<&String> = self.participants.keys().chain(self.sources.values()).collect();
        devices.sort();
        devices.dedup();
        devices
            .into_iter()
            .map(|device| {
                let mut csrc: Vec<u32> = self.sources.iter().filter(|(_, d)| *d == device).map(|(c, _)| *c).collect();
                csrc.sort_unstable();
                Person { device_id: device.clone(), name: self.participants.get(device).cloned(), own: self.own_device.as_ref() == Some(device), csrc }
            })
            .collect()
    }

    /// Captions in the order their lines first appeared, with speaker names.
    pub fn captions(&self) -> Vec<Caption> {
        self.caption_order
            .iter()
            .filter_map(|key| self.captions.get(key))
            .map(|c| Caption { speaker: self.participants.get(&c.device_id).cloned(), ..c.clone() })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::{RtpSource, StreamSpeakers};

    const ANA: &str = "spaces/x/devices/1";
    const BIA: &str = "spaces/x/devices/2";

    fn frame(stream: u8, t_ms: u64, amplitude: i16) -> AudioFrame {
        let samples = (0..1600).map(|i| if i % 2 == 0 { amplitude } else { -amplitude }).collect();
        AudioFrame { stream, seq: 0, t_ms, samples }
    }

    fn speaking(session: &mut Session, stream: u8, t_ms: u64, csrc: u32) {
        session.handle_message(Message::Speakers {
            t: t_ms as f64,
            streams: vec![StreamSpeakers {
                stream,
                csrc: vec![RtpSource { id: csrc, level: Some(0.3), ts: Some(t_ms as f64) }],
            }],
        });
    }

    fn roster(session: &mut Session) {
        for (device, name, csrc) in [(ANA, "Ana", 111), (BIA, "Bia", 222)] {
            session.handle_message(Message::Participant { device_id: device.into(), name: name.into(), own: false });
            session.handle_message(Message::Source { device_id: device.into(), csrc, media: "audio".into(), muted: Some(false) });
        }
    }

    fn name(a: &AttributedUtterance) -> String {
        a.speaker.label().into_owned()
    }

    #[test]
    fn a_muted_source_is_not_heard() {
        let mut s = Session::default();
        roster(&mut s);
        s.handle_message(Message::Source { device_id: ANA.into(), csrc: 111, media: "audio".into(), muted: Some(true) });
        let mut out = Vec::new();
        for i in 0..10u64 {
            speaking(&mut s, 1, 1000 + i * 100, 111);
            out.extend(s.handle_audio(frame(1, 1000 + i * 100, 8000)));
        }
        out.extend(s.finish());
        assert!(out.is_empty());

        // Unmuted again, the same person is heard and named.
        s.handle_message(Message::Source { device_id: ANA.into(), csrc: 111, media: "audio".into(), muted: Some(false) });
        for i in 20..30u64 {
            speaking(&mut s, 1, 1000 + i * 100, 111);
            out.extend(s.handle_audio(frame(1, 1000 + i * 100, 8000)));
        }
        out.extend(s.finish());
        assert_eq!(out.iter().map(name).collect::<Vec<_>>(), vec!["Ana"]);
    }

    #[test]
    fn reports_names_and_titles_once_as_they_change() {
        let mut s = Session::default();
        roster(&mut s);
        assert_eq!(s.take_updates().len(), 2);
        roster(&mut s); // the extension repeats the roster when the app reconnects
        assert!(s.take_updates().is_empty());
        let meeting = |title: &str| Message::Meeting { platform: "meet".into(), code: "abc".into(), title: title.into() };
        s.handle_message(meeting("Meet"));
        s.handle_message(meeting("Meet: Planejamento"));
        s.handle_message(meeting("Meet"));
        let titles: Vec<_> = s.take_updates().into_iter().map(|u| match u {
            Update::Meeting(m) => m.title,
            other => panic!("{other:?}"),
        }).collect();
        assert_eq!(titles, vec!["Meet", "Meet: Planejamento"]);
        assert_eq!(Speaker::Participant { device_id: ANA.into(), name: None }.label(), "Participante 1");
        assert_eq!(Speaker::Participant { device_id: "8:orgid:0a1b".into(), name: None }.label(), "Participante");
    }

    #[test]
    fn attributes_remote_speech_by_source_and_mic_to_me() {
        let mut s = Session::default();
        roster(&mut s);
        let mut out = Vec::new();
        for i in 0..10u64 {
            speaking(&mut s, 1, 1000 + i * 100, 111);
            out.extend(s.handle_audio(frame(1, 1000 + i * 100, 8000)));
            out.extend(s.handle_audio(frame(0, 1000 + i * 100, 8000)));
        }
        for i in 10..17u64 {
            out.extend(s.handle_audio(frame(1, 1000 + i * 100, 0)));
            out.extend(s.handle_audio(frame(0, 1000 + i * 100, 0)));
        }
        let mut names: Vec<_> = out.iter().map(name).collect();
        names.sort();
        assert_eq!(names, vec!["Ana", "Você"]);
    }

    #[test]
    fn says_who_else_was_audible_while_someone_spoke() {
        let mut s = Session::default();
        roster(&mut s);
        let mut alone = Vec::new();
        for i in 0..10u64 {
            speaking(&mut s, 1, 1000 + i * 100, 111);
            alone.extend(s.handle_audio(frame(1, 1000 + i * 100, 8000)));
        }
        alone.extend(s.finish());
        assert_eq!(alone.len(), 1);
        assert!(alone[0].others.is_empty());

        // Bia talking over Ana, and Ana louder: it is Ana's, with Bia noted.
        let mut together = Vec::new();
        for i in 20..30u64 {
            let t = 1000 + i * 100;
            speaking(&mut s, 1, t, 111);
            speaking(&mut s, 1, t, 222);
            together.extend(s.handle_audio(frame(1, t, 8000)));
        }
        together.extend(s.finish());
        assert_eq!(together.len(), 1);
        assert_eq!(together[0].speaker.key(), ANA);
        assert_eq!(together[0].others, vec![BIA]);

        let people = s.people();
        assert_eq!(people.iter().map(|p| (p.device_id.as_str(), p.name.as_deref(), p.csrc.clone())).collect::<Vec<_>>(), [(ANA, Some("Ana"), vec![111]), (BIA, Some("Bia"), vec![222])]);
    }

    #[test]
    fn the_microphone_takes_the_name_of_the_own_device() {
        let mut s = Session::default();
        roster(&mut s);
        s.take_updates();
        let me = |name: &str, own: bool| Message::Participant { device_id: "spaces/x/devices/3".into(), name: name.into(), own };
        let speak = |s: &mut Session, from: u64| {
            let mut out = Vec::new();
            for i in from..from + 10 {
                out.extend(s.handle_audio(frame(0, 1000 + i * 100, 8000)));
            }
            out.extend(s.finish());
            out.iter().map(name).collect::<Vec<_>>()
        };
        let named = |s: &mut Session| s.take_updates().into_iter().filter_map(|u| match u {
            Update::Me { name } => Some(name),
            _ => None,
        }).collect::<Vec<_>>();
        assert_eq!(speak(&mut s, 0), vec!["Você"]);

        s.handle_message(me("CAIO LIMA", true));
        assert_eq!(named(&mut s), vec!["CAIO LIMA"]);
        // Later mentions of the same device do not say whose it is.
        s.handle_message(me("CAIO LIMA", false));
        assert!(named(&mut s).is_empty());
        s.handle_message(me("Caio", false));
        assert_eq!(named(&mut s), vec!["Caio"]);
        assert_eq!(speak(&mut s, 20), vec!["Caio"]);
    }

    #[test]
    fn cuts_when_the_stream_changes_speaker() {
        let mut s = Session::default();
        roster(&mut s);
        let mut out = Vec::new();
        // Ana then Bia back to back on the same stream, no pause between.
        for i in 0..20u64 {
            let t = 1000 + i * 100;
            speaking(&mut s, 1, t, if i < 10 { 111 } else { 222 });
            out.extend(s.handle_audio(frame(1, t, 8000)));
        }
        out.extend(s.finish());
        assert_eq!(out.iter().map(name).collect::<Vec<_>>(), vec!["Ana", "Bia"]);
        assert_eq!(out[0].utterance.end_ms, out[1].utterance.start_ms);
    }

    #[test]
    fn voices_mixed_on_one_stream_go_to_who_spoke_most() {
        let mut s = Session::default();
        roster(&mut s);
        let mut out = Vec::new();
        // Ana, then Bia over her, then Bia alone: no pause anywhere.
        for i in 0..30u64 {
            let t = 1000 + i * 100;
            // The browser lists the two in whichever order.
            let both = if i % 2 == 0 { [111, 222] } else { [222, 111] };
            for csrc in both {
                if (csrc == 111 && i < 20) || (csrc == 222 && i >= 12) {
                    speaking(&mut s, 1, t, csrc);
                }
            }
            out.extend(s.handle_audio(frame(1, t, 8000)));
        }
        out.extend(s.finish());
        assert_eq!(out.iter().map(name).collect::<Vec<_>>(), vec!["Ana", "Bia"]);
    }

    #[test]
    fn unknown_sources_are_not_guessed() {
        let mut s = Session::default();
        roster(&mut s);
        let mut out = Vec::new();
        for i in 0..10u64 {
            speaking(&mut s, 1, 1000 + i * 100, 42); // not in the roster
            out.extend(s.handle_audio(frame(1, 1000 + i * 100, 8000)));
        }
        out.extend(s.finish());
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].speaker, Speaker::Unknown);
    }

    #[test]
    fn captions_keep_the_latest_revision_in_first_seen_order() {
        let mut s = Session::default();
        roster(&mut s);
        let cap = |t: f64, device: &str, id: u64, text: &str| Message::Caption {
            t,
            device_id: device.into(),
            message_id: Some(id),
            text: text.into(),
            lang: Some("pt-BR".into()),
        };
        s.handle_message(cap(1000.0, ANA, 1, "bom"));
        s.handle_message(cap(1500.0, BIA, 1, "oi"));
        s.handle_message(cap(2000.0, ANA, 1, "Bom dia."));
        // Every revision is reported as it comes, under the key of its line.
        let live: Vec<_> = s.take_updates().into_iter().filter_map(|u| match u {
            Update::Caption(c) => Some((c.key, c.speaker, c.first_ms, c.text)),
            _ => None,
        }).collect();
        assert_eq!(live.len(), 3);
        assert_eq!(live[0].0, live[2].0);
        assert_eq!(live[2], (format!("{ANA}/1"), Some("Ana".into()), 1000, "Bom dia.".into()));
        let caps = s.captions();
        assert_eq!(caps.len(), 2);
        assert_eq!((caps[0].text.as_str(), caps[0].first_ms, caps[0].last_ms), ("Bom dia.", 1000, 2000));
        assert_eq!(caps[0].speaker.as_deref(), Some("Ana"));
        assert_eq!(caps[1].speaker.as_deref(), Some("Bia"));
    }
}
