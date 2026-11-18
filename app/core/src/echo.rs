//! Detects microphone segments that are the remote party's voice coming back
//! through the user's speakers.
//!
//! Decided on the transcribed text: an echo says the same words as a remote
//! segment at the same moment. Short replies ("sim", "é isso") are never
//! judged, because people do say the same short thing at the same time.

/// How far apart, in time, the two segments may be and still be compared.
pub const WINDOW_MS: u64 = 1500;
const MIN_WORDS: usize = 3;
const MIN_SHARED_WORDS: f32 = 0.6;
/// Shortest run of identical text that counts as the same sentence.
const MIN_COMMON_RUN: usize = 12;

fn normalize(text: &str) -> String {
    let kept: String = text
        .to_lowercase()
        .chars()
        .map(|c| if c.is_alphanumeric() { c } else { ' ' })
        .collect();
    kept.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn longest_common_run(a: &[char], b: &[char]) -> usize {
    let mut best = 0;
    let mut prev = vec![0usize; b.len() + 1];
    for &ca in a {
        let mut row = vec![0usize; b.len() + 1];
        for (j, &cb) in b.iter().enumerate() {
            if ca == cb {
                row[j + 1] = prev[j] + 1;
                best = best.max(row[j + 1]);
            }
        }
        prev = row;
    }
    best
}

/// True when `mic` repeats what `remote` (the text of the remote segments
/// around the same time) says.
pub fn is_echo(mic: &str, remote: &str) -> bool {
    let (mic, remote) = (normalize(mic), normalize(remote));
    let words: Vec<&str> = mic.split(' ').filter(|w| !w.is_empty()).collect();
    if words.len() < MIN_WORDS {
        return false;
    }
    let remote_words: Vec<&str> = remote.split(' ').collect();
    let shared = words.iter().filter(|w| remote_words.contains(w)).count();
    if (shared as f32) < MIN_SHARED_WORDS * words.len() as f32 {
        return false;
    }
    let (a, b): (Vec<char>, Vec<char>) = (mic.chars().collect(), remote.chars().collect());
    longest_common_run(&a, &b) >= MIN_COMMON_RUN.min(a.len())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn repeated_sentence_is_echo() {
        assert!(is_echo("então a gente fecha na sexta", "Então, a gente fecha na sexta-feira, pode ser?"));
        // Recognition differs slightly between the two paths.
        assert!(is_echo("eu acho que da pra entregar amanha cedo", "Eu acho que dá pra entregar amanhã cedo."));
    }

    #[test]
    fn different_speech_at_the_same_time_is_not_echo() {
        assert!(!is_echo("eu discordo disso completamente", "a gente fecha na sexta, pode ser?"));
        // Same common words, different sentence.
        assert!(!is_echo("eu acho que a gente não vai", "a gente acha que eu vou sim"));
    }

    #[test]
    fn short_replies_are_never_judged() {
        assert!(!is_echo("pode ser", "na sexta, pode ser?"));
        assert!(!is_echo("", "qualquer coisa"));
    }
}
