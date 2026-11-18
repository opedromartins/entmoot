//! SQLite storage for meetings, their transcript and the platform's captions.

use std::path::Path;

use anyhow::{Context, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

use crate::session::{Caption, MeetingInfo, Speaker};
use crate::store::Segment;

/// One entry per schema version; applied in order to reach the latest.
const MIGRATIONS: &[&str] = &["
    CREATE TABLE meetings (
        id         INTEGER PRIMARY KEY,
        platform   TEXT NOT NULL DEFAULT '',
        code       TEXT NOT NULL DEFAULT '',
        title      TEXT NOT NULL DEFAULT '',
        started_ms INTEGER NOT NULL,
        ended_ms   INTEGER
    );
    CREATE TABLE segments (
        id           INTEGER PRIMARY KEY,
        meeting_id   INTEGER NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
        start_ms     INTEGER NOT NULL,
        end_ms       INTEGER NOT NULL,
        stream       INTEGER NOT NULL,
        speaker_type TEXT NOT NULL,   -- me | participant | unknown
        device_id    TEXT,
        speaker_name TEXT,
        text         TEXT NOT NULL,
        -- 1 when the microphone picked up a remote voice from the speakers.
        echo         INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX segments_by_meeting ON segments(meeting_id, start_ms);
    CREATE TABLE captions (
        id           INTEGER PRIMARY KEY,
        meeting_id   INTEGER NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
        device_id    TEXT NOT NULL,
        speaker_name TEXT,
        first_ms     INTEGER NOT NULL,
        last_ms      INTEGER NOT NULL,
        text         TEXT NOT NULL,
        lang         TEXT
    );
    CREATE INDEX captions_by_meeting ON captions(meeting_id, first_ms);
    CREATE VIRTUAL TABLE segments_fts USING fts5(
        text, content='segments', content_rowid='id', tokenize='unicode61 remove_diacritics 2'
    );
    CREATE TRIGGER segments_ai AFTER INSERT ON segments BEGIN
        INSERT INTO segments_fts(rowid, text) VALUES (new.id, new.text);
    END;
    CREATE TRIGGER segments_ad AFTER DELETE ON segments BEGIN
        INSERT INTO segments_fts(segments_fts, rowid, text) VALUES ('delete', old.id, old.text);
    END;
"];

#[derive(Debug, Serialize)]
pub struct MeetingRow {
    pub id: i64,
    pub platform: String,
    pub code: String,
    pub title: String,
    pub started_ms: u64,
    pub ended_ms: Option<u64>,
    pub segments: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct SegmentRow {
    pub id: i64,
    pub meeting_id: i64,
    pub start_ms: u64,
    pub end_ms: u64,
    /// The audio track it was heard on: 0 is the microphone, the others are
    /// the remote tracks, as in `stream-N.wav`.
    pub stream: u8,
    /// Display name.
    pub speaker: String,
    /// Stable identity of the speaker within the meeting, for grouping.
    pub speaker_key: String,
    pub text: String,
    pub echo: bool,
}

impl SegmentRow {
    pub fn new(id: i64, meeting_id: i64, s: &Segment, echo: bool) -> Self {
        Self { id, meeting_id, start_ms: s.start_ms, end_ms: s.end_ms, stream: s.stream, speaker: s.speaker.label().to_string(), speaker_key: s.speaker.key(), text: s.text.clone(), echo }
    }
}

pub struct Db {
    conn: Connection,
}

fn speaker_columns(speaker: &Speaker) -> (&'static str, Option<&str>, Option<&str>) {
    match speaker {
        Speaker::Me { name } => ("me", None, name.as_deref()),
        Speaker::Participant { device_id, name } => ("participant", Some(device_id), name.as_deref()),
        Speaker::Unknown => ("unknown", None, None),
    }
}

const SEGMENT_COLUMNS: &str = "id, meeting_id, start_ms, end_ms, stream, speaker_type, device_id, speaker_name, text, echo";

fn segment_row(row: &rusqlite::Row) -> rusqlite::Result<SegmentRow> {
    let kind: String = row.get(5)?;
    let speaker = match kind.as_str() {
        "me" => Speaker::Me { name: row.get(7)? },
        "participant" => Speaker::Participant { device_id: row.get::<_, Option<String>>(6)?.unwrap_or_default(), name: row.get(7)? },
        _ => Speaker::Unknown,
    };
    let segment = Segment { start_ms: row.get(2)?, end_ms: row.get(3)?, stream: row.get(4)?, speaker, text: row.get(8)? };
    Ok(SegmentRow::new(row.get(0)?, row.get(1)?, &segment, row.get(9)?))
}

fn replace_captions(tx: &rusqlite::Transaction, id: i64, captions: &[Caption]) -> Result<()> {
    tx.execute("DELETE FROM captions WHERE meeting_id = ?1", params![id])?;
    let mut insert = tx.prepare(
        "INSERT INTO captions (meeting_id, device_id, speaker_name, first_ms, last_ms, text, lang)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
    )?;
    for c in captions {
        insert.execute(params![id, c.device_id, c.speaker, c.first_ms, c.last_ms, c.text, c.lang])?;
    }
    Ok(())
}

impl Db {
    pub fn open(path: &Path) -> Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        Self::init(Connection::open(path).with_context(|| format!("opening {}", path.display()))?)
    }

    pub fn in_memory() -> Result<Self> {
        Self::init(Connection::open_in_memory()?)
    }

    fn init(mut conn: Connection) -> Result<Self> {
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "foreign_keys", true)?;
        let version: usize = conn.pragma_query_value(None, "user_version", |r| r.get(0))?;
        for (i, sql) in MIGRATIONS.iter().enumerate().skip(version) {
            let tx = conn.transaction()?;
            tx.execute_batch(sql)?;
            tx.pragma_update(None, "user_version", i + 1)?;
            tx.commit()?;
        }
        Ok(Self { conn })
    }

    pub fn begin_meeting(&self, started_ms: u64) -> Result<i64> {
        self.conn.execute("INSERT INTO meetings (started_ms) VALUES (?1)", params![started_ms])?;
        Ok(self.conn.last_insert_rowid())
    }

    pub fn add_segment(&self, meeting_id: i64, s: &Segment, echo: bool) -> Result<i64> {
        let (kind, device, name) = speaker_columns(&s.speaker);
        self.conn.execute(
            "INSERT INTO segments (meeting_id, start_ms, end_ms, stream, speaker_type, device_id, speaker_name, text, echo)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![meeting_id, s.start_ms, s.end_ms, s.stream, kind, device, name, s.text, echo],
        )?;
        Ok(self.conn.last_insert_rowid())
    }

    /// Removes a meeting with its transcript and captions.
    pub fn delete_meeting(&self, id: i64) -> Result<bool> {
        Ok(self.conn.execute("DELETE FROM meetings WHERE id = ?1", params![id])? > 0)
    }

    /// Removes every meeting except `keep` (the one happening now). Returns how many went.
    pub fn delete_all_meetings(&self, keep: Option<i64>) -> Result<usize> {
        Ok(self.conn.execute("DELETE FROM meetings WHERE id IS NOT ?1", params![keep])?)
    }

    pub fn mark_echo(&self, segment_id: i64) -> Result<()> {
        self.conn.execute("UPDATE segments SET echo = 1 WHERE id = ?1", params![segment_id])?;
        Ok(())
    }

    /// Records what the meeting is, as soon as it is known.
    pub fn set_meeting_info(&self, id: i64, info: &MeetingInfo) -> Result<()> {
        self.conn.execute(
            "UPDATE meetings SET platform = ?2, code = ?3, title = ?4 WHERE id = ?1",
            params![id, info.platform, info.code, info.title],
        )?;
        Ok(())
    }

    /// Names a participant in what was stored before the name was known.
    /// Returns how many segments changed.
    pub fn name_speaker(&self, meeting_id: i64, device_id: &str, name: &str) -> Result<usize> {
        Ok(self.conn.execute(
            "UPDATE segments SET speaker_name = ?3 WHERE meeting_id = ?1 AND device_id = ?2 AND speaker_name IS NOT ?3",
            params![meeting_id, device_id, name],
        )?)
    }

    /// Names the local user in what was stored before the name was known.
    /// Returns how many segments changed.
    pub fn name_me(&self, meeting_id: i64, name: &str) -> Result<usize> {
        Ok(self.conn.execute(
            "UPDATE segments SET speaker_name = ?2 WHERE meeting_id = ?1 AND speaker_type = 'me' AND speaker_name IS NOT ?2",
            params![meeting_id, name],
        )?)
    }

    /// Records how the meeting ended and replaces its captions.
    pub fn finish_meeting(&mut self, id: i64, info: &MeetingInfo, ended_ms: u64, captions: &[Caption]) -> Result<()> {
        let tx = self.conn.transaction()?;
        tx.execute(
            "UPDATE meetings SET platform = ?2, code = ?3, title = ?4, ended_ms = ?5 WHERE id = ?1",
            params![id, info.platform, info.code, info.title, ended_ms],
        )?;
        replace_captions(&tx, id, captions)?;
        tx.commit()?;
        Ok(())
    }

    /// A meeting that had ended goes on: its call was joined again.
    pub fn reopen_meeting(&self, id: i64) -> Result<()> {
        self.conn.execute("UPDATE meetings SET ended_ms = NULL WHERE id = ?1", params![id])?;
        Ok(())
    }

    /// Replaces the captions of a meeting still going on, so they survive
    /// the app closing before it ends.
    pub fn set_captions(&mut self, id: i64, captions: &[Caption]) -> Result<()> {
        let tx = self.conn.transaction()?;
        replace_captions(&tx, id, captions)?;
        tx.commit()?;
        Ok(())
    }

    /// Newest first.
    pub fn meetings(&self) -> Result<Vec<MeetingRow>> {
        let mut stmt = self.conn.prepare(
            "SELECT m.id, m.platform, m.code, m.title, m.started_ms, m.ended_ms,
                    (SELECT count(*) FROM segments s WHERE s.meeting_id = m.id AND s.echo = 0)
             FROM meetings m ORDER BY m.started_ms DESC",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(MeetingRow {
                id: r.get(0)?,
                platform: r.get(1)?,
                code: r.get(2)?,
                title: r.get(3)?,
                started_ms: r.get(4)?,
                ended_ms: r.get(5)?,
                segments: r.get(6)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    pub fn meeting_start(&self, id: i64) -> Result<Option<u64>> {
        Ok(self.conn.query_row("SELECT started_ms FROM meetings WHERE id = ?1", params![id], |r| r.get(0)).optional()?)
    }

    /// The transcript in spoken order, without echoes.
    pub fn transcript(&self, meeting_id: i64) -> Result<Vec<SegmentRow>> {
        let sql = format!("SELECT {SEGMENT_COLUMNS} FROM segments WHERE meeting_id = ?1 AND echo = 0 ORDER BY start_ms, id");
        let mut stmt = self.conn.prepare(&sql)?;
        let rows = stmt.query_map(params![meeting_id], segment_row)?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    pub fn captions(&self, meeting_id: i64) -> Result<Vec<Caption>> {
        let mut stmt = self.conn.prepare(
            "SELECT device_id, speaker_name, first_ms, last_ms, text, lang FROM captions WHERE meeting_id = ?1 ORDER BY first_ms, id",
        )?;
        let rows = stmt.query_map(params![meeting_id], |r| {
            Ok(Caption { device_id: r.get(0)?, speaker: r.get(1)?, first_ms: r.get(2)?, last_ms: r.get(3)?, text: r.get(4)?, lang: r.get(5)? })
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// Full-text search over every transcript; every word typed must begin a
    /// word of the text ("requis" finds "requisição").
    pub fn search(&self, query: &str) -> Result<Vec<SegmentRow>> {
        // Quoting each word keeps user input from being read as FTS syntax;
        // the star after it makes it a prefix.
        let terms: Vec<String> = query
            .split_whitespace()
            .filter(|w| w.chars().any(char::is_alphanumeric))
            .map(|w| format!("\"{}\"*", w.replace('"', "\"\"")))
            .collect();
        if terms.is_empty() {
            return Ok(Vec::new());
        }
        let sql = format!(
            "SELECT {SEGMENT_COLUMNS} FROM segments
             WHERE echo = 0 AND id IN (SELECT rowid FROM segments_fts WHERE segments_fts MATCH ?1)
             ORDER BY meeting_id DESC, start_ms"
        );
        let mut stmt = self.conn.prepare(&sql)?;
        let rows = stmt.query_map(params![terms.join(" ")], segment_row)?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seg(start_ms: u64, speaker: Speaker, text: &str) -> Segment {
        Segment { start_ms, end_ms: start_ms + 1000, stream: 1, speaker, text: text.into() }
    }

    fn ana() -> Speaker {
        Speaker::Participant { device_id: "spaces/x/devices/1".into(), name: Some("Ana".into()) }
    }

    #[test]
    fn stores_and_reads_a_meeting() {
        let mut db = Db::in_memory().unwrap();
        let id = db.begin_meeting(1000).unwrap();
        db.add_segment(id, &seg(2000, ana(), "Bom dia, pessoal."), false).unwrap();
        db.add_segment(id, &seg(1500, Speaker::Me { name: None }, "Olá."), false).unwrap();
        let echo = db.add_segment(id, &seg(2100, Speaker::Me { name: None }, "bom dia pessoal"), false).unwrap();
        db.mark_echo(echo).unwrap();
        let info = MeetingInfo { platform: "meet".into(), code: "abc".into(), title: "Semanal".into() };
        let caption = Caption { device_id: "spaces/x/devices/1".into(), speaker: Some("Ana".into()), first_ms: 2000, last_ms: 2900, text: "Bom dia pessoal".into(), lang: Some("pt-BR".into()) };
        db.finish_meeting(id, &info, 9000, &[caption]).unwrap();

        let meetings = db.meetings().unwrap();
        assert_eq!((meetings[0].title.as_str(), meetings[0].segments, meetings[0].ended_ms), ("Semanal", 2, Some(9000)));
        let transcript = db.transcript(id).unwrap();
        let lines: Vec<_> = transcript.iter().map(|s| (s.speaker.as_str(), s.text.as_str())).collect();
        assert_eq!(lines, vec![("Você", "Olá."), ("Ana", "Bom dia, pessoal.")]);
        assert_eq!(db.captions(id).unwrap().len(), 1);

        // The name reaches what the microphone already said, echoes included.
        assert_eq!(db.name_me(id, "CAIO LIMA").unwrap(), 2);
        assert_eq!(db.name_me(id, "CAIO LIMA").unwrap(), 0);
        db.add_segment(id, &seg(3000, Speaker::Me { name: Some("CAIO LIMA".into()) }, "Sim."), false).unwrap();
        let mine: Vec<_> = db.transcript(id).unwrap().into_iter().filter(|s| s.speaker_key == "me").map(|s| s.speaker).collect();
        assert_eq!(mine, vec!["CAIO LIMA", "CAIO LIMA"]);
        db.set_captions(id, &[]).unwrap();
        assert!(db.captions(id).unwrap().is_empty());

        assert!(db.delete_meeting(id).unwrap());
        assert!(!db.delete_meeting(id).unwrap());
        assert!(db.meetings().unwrap().is_empty());
        assert!(db.search("pessoal").unwrap().is_empty());
        assert!(db.captions(id).unwrap().is_empty());
    }

    #[test]
    fn search_ignores_accents_case_and_fts_syntax() {
        let db = Db::in_memory().unwrap();
        let id = db.begin_meeting(0).unwrap();
        db.add_segment(id, &seg(0, ana(), "A migração do banco fica para amanhã."), false).unwrap();
        db.add_segment(id, &seg(1000, Speaker::Me { name: None }, "Combinado."), false).unwrap();
        assert_eq!(db.search("MIGRACAO amanha").unwrap().len(), 1);
        assert!(db.search("migração ontem").unwrap().is_empty());
        assert!(db.search("\"banco AND (").unwrap().len() <= 1); // must not error
        assert!(db.search("   ").unwrap().is_empty());
    }

    #[test]
    fn search_finds_the_start_of_a_word() {
        let db = Db::in_memory().unwrap();
        let id = db.begin_meeting(0).unwrap();
        db.add_segment(id, &seg(0, ana(), "A requisição falhou de novo."), false).unwrap();
        assert_eq!(db.search("requis").unwrap().len(), 1);
        assert_eq!(db.search("REQUISICA fal").unwrap().len(), 1);
        assert!(db.search("quisição").unwrap().is_empty());
        assert!(db.search("( -").unwrap().is_empty());
    }

    #[test]
    fn deletes_every_meeting_but_the_live_one() {
        let db = Db::in_memory().unwrap();
        let (a, b, live) = (db.begin_meeting(0).unwrap(), db.begin_meeting(1).unwrap(), db.begin_meeting(2).unwrap());
        for id in [a, b, live] {
            db.add_segment(id, &seg(0, ana(), "Bom dia."), false).unwrap();
        }
        assert_eq!(db.delete_all_meetings(Some(live)).unwrap(), 2);
        assert_eq!(db.meetings().unwrap().len(), 1);
        assert_eq!(db.search("dia").unwrap().len(), 1);
        assert_eq!(db.delete_all_meetings(None).unwrap(), 1);
        assert!(db.search("dia").unwrap().is_empty());
    }

    #[test]
    fn reopening_keeps_data_and_does_not_rerun_migrations() {
        let dir = std::env::temp_dir().join(format!("entmoot-test-{}", std::process::id()));
        let path = dir.join("t.db");
        let id = {
            let db = Db::open(&path).unwrap();
            let id = db.begin_meeting(5).unwrap();
            db.add_segment(id, &seg(10, Speaker::Unknown, "teste"), false).unwrap();
            id
        };
        let db = Db::open(&path).unwrap();
        assert_eq!(db.transcript(id).unwrap()[0].speaker, "Desconhecido");
        std::fs::remove_dir_all(dir).ok();
    }
}
