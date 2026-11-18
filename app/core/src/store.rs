//! A transcribed segment, and a JSON Lines writer used when replaying recordings.

use std::fs::{self, File};
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};

use anyhow::Result;
use serde::{Deserialize, Serialize};

use crate::session::{Caption, MeetingInfo, Speaker};

#[derive(Debug, Serialize, Deserialize)]
pub struct Segment {
    pub start_ms: u64,
    pub end_ms: u64,
    pub stream: u8,
    pub speaker: Speaker,
    pub text: String,
}

pub struct MeetingWriter {
    dir: PathBuf,
    transcript: BufWriter<File>,
}

impl MeetingWriter {
    pub fn create(dir: &Path) -> Result<Self> {
        fs::create_dir_all(dir)?;
        let transcript = BufWriter::new(File::create(dir.join("transcript.jsonl"))?);
        Ok(Self { dir: dir.to_path_buf(), transcript })
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    /// Appends one segment and flushes, so a crash loses nothing already said.
    pub fn segment(&mut self, segment: &Segment) -> Result<()> {
        serde_json::to_writer(&mut self.transcript, segment)?;
        self.transcript.write_all(b"\n")?;
        self.transcript.flush()?;
        Ok(())
    }

    pub fn finish(&mut self, meeting: &MeetingInfo, captions: &[Caption]) -> Result<()> {
        let mut out = BufWriter::new(File::create(self.dir.join("captions.jsonl"))?);
        for c in captions {
            serde_json::to_writer(&mut out, c)?;
            out.write_all(b"\n")?;
        }
        out.flush()?;
        fs::write(self.dir.join("meeting.json"), serde_json::to_vec_pretty(meeting)?)?;
        Ok(())
    }
}
