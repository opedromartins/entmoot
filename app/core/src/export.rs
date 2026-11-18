//! A meeting written out as a Markdown file, for reading outside the app.

use chrono::{DateTime, Local, TimeZone};

use crate::db::{MeetingRow, SegmentRow};
use crate::session::Caption;

/// One stretch of speech, from the transcript or from the platform's captions.
pub struct Line<'a> {
    /// Stable identity of the speaker within the meeting.
    pub speaker_key: &'a str,
    pub speaker: &'a str,
    pub start_ms: u64,
    pub text: &'a str,
}

impl<'a> From<&'a SegmentRow> for Line<'a> {
    fn from(s: &'a SegmentRow) -> Self {
        Self { speaker_key: &s.speaker_key, speaker: &s.speaker, start_ms: s.start_ms, text: &s.text }
    }
}

impl<'a> From<&'a Caption> for Line<'a> {
    fn from(c: &'a Caption) -> Self {
        Self { speaker_key: &c.device_id, speaker: c.speaker.as_deref().unwrap_or("Participante"), start_ms: c.first_ms, text: &c.text }
    }
}

/// The meeting's name as the app shows it.
pub fn meeting_name(m: &MeetingRow) -> &str {
    // Meet's tab is called "Meet: <name>". A Teams title comes already cut,
    // and may well begin with "Meeting".
    let title = match m.title.strip_prefix("Meet") {
        Some(rest) if m.platform != "teams" => rest.strip_prefix(':').unwrap_or(rest),
        _ => m.title.as_str(),
    }
    .trim();
    if !title.is_empty() && title != m.code {
        title
    } else if !m.code.is_empty() {
        &m.code
    } else {
        "Reunião"
    }
}

fn local(ms: u64) -> DateTime<Local> {
    Local.timestamp_millis_opt(ms as i64).earliest().unwrap_or_default()
}

/// Time since the meeting started, as m:ss.
fn clock(ms: u64, start_ms: u64) -> String {
    let s = ms.saturating_sub(start_ms) / 1000;
    format!("{}:{:02}", s / 60, s % 60)
}

/// The file to save a meeting as: when it started, then its name. Starting
/// with the date keeps a folder of them in order.
pub fn file_name(m: &MeetingRow) -> String {
    // Characters Windows refuses in file names.
    let name: String = meeting_name(m).chars().map(|c| if c.is_control() || r#"<>:"/\|?*"#.contains(c) { ' ' } else { c }).collect();
    let name: String = name.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(80).collect();
    format!("{} {}.md", local(m.started_ms).format("%Y-%m-%d %Hh%M"), name.trim_end_matches(['.', ' ']))
}

/// The meeting as Markdown: a heading, when and who, then each turn of speech
/// under the speaker's name. Consecutive lines by one speaker form one turn.
pub fn markdown(m: &MeetingRow, lines: &[Line]) -> String {
    let mut out = format!("# {}\n\n", meeting_name(m));

    out += &local(m.started_ms).format("%d/%m/%Y %H:%M").to_string();
    if let Some(ended_ms) = m.ended_ms {
        out += &format!(" · {} min", ((ended_ms.saturating_sub(m.started_ms) + 30_000) / 60_000).max(1));
    }
    out.push('\n');

    // Each person once, by the latest name they have.
    let mut people: Vec<(&str, &str)> = Vec::new();
    for l in lines {
        match people.iter_mut().find(|(key, _)| *key == l.speaker_key) {
            Some(person) => person.1 = l.speaker,
            None => people.push((l.speaker_key, l.speaker)),
        }
    }
    if !people.is_empty() {
        let names: Vec<&str> = people.iter().map(|(_, name)| *name).collect();
        out += &format!("\nParticipantes: {}\n", names.join(", "));
    }

    let mut last: Option<&str> = None;
    for l in lines {
        if last == Some(l.speaker_key) {
            out.push(' ');
        } else {
            if last.is_some() {
                out.push('\n');
            }
            // Two trailing spaces: a line break that keeps name and speech in one paragraph.
            out += &format!("\n**{}** ({})  \n", l.speaker, clock(l.start_ms, m.started_ms));
            last = Some(l.speaker_key);
        }
        out += l.text.trim();
    }
    if last.is_some() {
        out.push('\n');
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn meeting(title: &str, code: &str) -> MeetingRow {
        MeetingRow { id: 1, platform: "meet".into(), code: code.into(), title: title.into(), started_ms: 1_000_000, ended_ms: Some(1_000_000 + 125_000), segments: 0 }
    }

    fn line<'a>(key: &'a str, speaker: &'a str, start_ms: u64, text: &'a str) -> Line<'a> {
        Line { speaker_key: key, speaker, start_ms, text }
    }

    #[test]
    fn names_the_meeting_like_the_app() {
        assert_eq!(meeting_name(&meeting("Meet: Semanal", "abc")), "Semanal");
        assert_eq!(meeting_name(&meeting("Meet abc", "abc")), "abc");
        let teams = MeetingRow { platform: "teams".into(), ..meeting("Meeting with Ana", "123") };
        assert_eq!(meeting_name(&teams), "Meeting with Ana");
        assert_eq!(meeting_name(&meeting("", "")), "Reunião");
    }

    #[test]
    fn file_name_is_valid_on_windows() {
        let name = file_name(&meeting("Meet: Plano 1/2: \"custos\"?  ...", "abc"));
        assert!(name.ends_with(" Plano 1 2 custos.md"), "{name}");
        assert!(!name.contains(['<', '>', ':', '"', '/', '\\', '|', '?', '*']), "{name}");
    }

    #[test]
    fn groups_consecutive_lines_into_turns() {
        let lines = [
            line("d1", "Participante 1", 1_000_000, "Bom dia."),
            line("d1", "Ana", 1_004_000, " Vamos começar? "),
            line("me", "Você", 1_065_000, "Vamos."),
        ];
        let text = markdown(&meeting("Meet: Semanal", "abc"), &lines);
        assert!(text.starts_with("# Semanal\n\n"), "{text}");
        assert!(text.contains(" · 2 min\n"), "{text}");
        assert!(text.contains("\nParticipantes: Ana, Você\n"), "{text}");
        assert!(text.ends_with("\n\n**Participante 1** (0:00)  \nBom dia. Vamos começar?\n\n**Você** (1:05)  \nVamos.\n"), "{text}");
    }

    #[test]
    fn a_meeting_without_speech_is_just_its_heading() {
        let text = markdown(&meeting("", "abc"), &[]);
        assert!(text.starts_with("# abc\n\n") && !text.contains("Participantes"), "{text}");
    }
}
