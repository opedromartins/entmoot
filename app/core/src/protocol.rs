//! Wire format between the browser extension and the app.
//!
//! Text frames are JSON objects tagged by `kind`. Binary frames are audio:
//! `stream:u8 | seq:u32 LE | t_ms:u64 LE | PCM s16le 16 kHz mono`.
//! Stream 0 is the user's microphone; the others are remote tracks.

use serde::Deserialize;

pub const MIC_STREAM: u8 = 0;
const AUDIO_HEADER: usize = 13;

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Message {
    Hello {
        token: String,
    },
    Meeting {
        platform: String,
        code: String,
        #[serde(default)]
        title: String,
    },
    MeetingEnd {},
    Speakers {
        t: f64,
        streams: Vec<StreamSpeakers>,
    },
    Participant {
        #[serde(rename = "deviceId")]
        device_id: String,
        name: String,
        /// The device this very browser joined the call with.
        #[serde(default, rename = "self")]
        own: bool,
    },
    Source {
        #[serde(rename = "deviceId")]
        device_id: String,
        csrc: u32,
        media: String,
        /// The platform's own mute state for the source, when it says.
        #[serde(default)]
        muted: Option<bool>,
    },
    SourceRemoved {
        csrc: u32,
    },
    Caption {
        t: f64,
        #[serde(rename = "deviceId")]
        device_id: String,
        #[serde(rename = "messageId")]
        message_id: Option<u64>,
        text: String,
        lang: Option<String>,
    },
    /// Diagnostics and raw frames the app has no use for.
    #[serde(other)]
    Other,
}

#[derive(Debug, Deserialize)]
pub struct StreamSpeakers {
    pub stream: u8,
    #[serde(default)]
    pub csrc: Vec<RtpSource>,
}

#[derive(Debug, Deserialize)]
pub struct RtpSource {
    pub id: u32,
    pub level: Option<f32>,
    /// When the browser last received a packet from this source.
    pub ts: Option<f64>,
}

#[derive(Debug, Clone)]
pub struct AudioFrame {
    pub stream: u8,
    pub seq: u32,
    pub t_ms: u64,
    pub samples: Vec<i16>,
}

impl AudioFrame {
    /// Returns None for frames too short to carry any audio.
    pub fn parse(bytes: &[u8]) -> Option<Self> {
        if bytes.len() < AUDIO_HEADER + 2 {
            return None;
        }
        let samples = bytes[AUDIO_HEADER..]
            .chunks_exact(2)
            .map(|b| i16::from_le_bytes([b[0], b[1]]))
            .collect();
        Some(Self {
            stream: bytes[0],
            seq: u32::from_le_bytes(bytes[1..5].try_into().ok()?),
            t_ms: u64::from_le_bytes(bytes[5..13].try_into().ok()?),
            samples,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_audio_frame() {
        let mut b = vec![3u8];
        b.extend(7u32.to_le_bytes());
        b.extend(1_700_000_000_123u64.to_le_bytes());
        b.extend((-2i16).to_le_bytes());
        b.extend(5i16.to_le_bytes());
        let f = AudioFrame::parse(&b).unwrap();
        assert_eq!((f.stream, f.seq, f.t_ms), (3, 7, 1_700_000_000_123));
        assert_eq!(f.samples, vec![-2, 5]);
        assert!(AudioFrame::parse(&b[..13]).is_none());
    }

    #[test]
    fn parses_messages_and_ignores_unknown_kinds() {
        let m: Message = serde_json::from_str(
            r#"{"kind":"source","deviceId":"spaces/x/devices/1","csrc":3726115263,"media":"audio","muted":false,"t":1,"tab":2}"#,
        )
        .unwrap();
        assert!(matches!(m, Message::Source { csrc: 3726115263, .. }));
        let m: Message = serde_json::from_str(r#"{"kind":"raw","label":"dcrpc","b64":""}"#).unwrap();
        assert!(matches!(m, Message::Other));
        let m: Message = serde_json::from_str(
            r#"{"kind":"speakers","t":5.5,"streams":[{"stream":1,"csrc":[{"id":42,"ts":1.0}],"ssrc":[]}]}"#,
        )
        .unwrap();
        assert!(matches!(m, Message::Speakers { .. }));
        let m: Message = serde_json::from_str(r#"{"kind":"participant","deviceId":"spaces/x/devices/1","name":"Ana","self":true}"#).unwrap();
        assert!(matches!(m, Message::Participant { own: true, .. }));
        let m: Message = serde_json::from_str(r#"{"kind":"participant","deviceId":"spaces/x/devices/1","name":"Ana"}"#).unwrap();
        assert!(matches!(m, Message::Participant { own: false, .. }));
    }
}
