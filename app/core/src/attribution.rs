//! Who was audible on each remote stream, and when.
//!
//! The browser reports, about ten times a second, which RTP contributing
//! sources (CSRC) each audio receiver heard and how loud. A source stays
//! listed for seconds after it goes quiet, so a report only counts when its
//! packet timestamp moved since the previous one.

use std::collections::{HashMap, VecDeque};

/// Below this the source is transmitting silence.
const MIN_LEVEL: f32 = 0.001;
const KEEP_MS: u64 = 120_000;
/// How far back `current` looks for the latest audible source.
const CURRENT_WINDOW_MS: u64 = 400;

#[derive(Default)]
pub struct SpeakerTimeline {
    samples: HashMap<u8, VecDeque<(u64, u32, f32)>>,
    last_packet: HashMap<(u8, u32), f64>,
}

impl SpeakerTimeline {
    pub fn push(&mut self, stream: u8, t_ms: u64, csrc: u32, level: Option<f32>, packet_ts: Option<f64>) {
        if let Some(ts) = packet_ts {
            let last = self.last_packet.insert((stream, csrc), ts);
            if last.is_some_and(|l| ts <= l) {
                return; // nothing new from this source
            }
        }
        let level = level.unwrap_or(0.0);
        if level < MIN_LEVEL {
            return;
        }
        let q = self.samples.entry(stream).or_default();
        q.push_back((t_ms, csrc, level));
        while q.front().is_some_and(|(t, _, _)| t + KEEP_MS < t_ms) {
            q.pop_front();
        }
    }

    /// Sources heard on `stream` within [start_ms, end_ms], loudest total first.
    pub fn ranked(&self, stream: u8, start_ms: u64, end_ms: u64) -> Vec<u32> {
        let mut totals: HashMap<u32, f32> = HashMap::new();
        for &(t, csrc, level) in self.samples.get(&stream).into_iter().flatten() {
            if t >= start_ms && t <= end_ms {
                *totals.entry(csrc).or_default() += level;
            }
        }
        let mut ranked: Vec<_> = totals.into_iter().collect();
        ranked.sort_by(|a, b| b.1.total_cmp(&a.1).then(a.0.cmp(&b.0)));
        ranked.into_iter().map(|(csrc, _)| csrc).collect()
    }

    /// Sources in the latest report of `stream` just before `t_ms`: more than
    /// one when voices overlap on it, as on a stream that mixes everyone.
    pub fn together(&self, stream: u8, t_ms: u64) -> Vec<u32> {
        let mut at = None;
        let mut seen = Vec::new();
        for &(t, csrc, _) in self.samples.get(&stream).into_iter().flatten().rev() {
            if t > t_ms {
                continue;
            }
            if t + CURRENT_WINDOW_MS < t_ms || at.is_some_and(|at| at != t) {
                break;
            }
            at = Some(t);
            seen.push(csrc);
        }
        seen
    }

    /// Sources audible on `stream` just before `t_ms`, most recent first.
    pub fn current(&self, stream: u8, t_ms: u64) -> Vec<u32> {
        let mut seen = Vec::new();
        for &(t, csrc, _) in self.samples.get(&stream).into_iter().flatten().rev() {
            if t + CURRENT_WINDOW_MS < t_ms {
                break;
            }
            if t <= t_ms && !seen.contains(&csrc) {
                seen.push(csrc);
            }
        }
        seen
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ranks_by_total_level_inside_the_window() {
        let mut tl = SpeakerTimeline::default();
        for i in 0..10u64 {
            tl.push(1, 1000 + i * 100, 111, Some(0.2), Some(i as f64));
        }
        for i in 0..3u64 {
            tl.push(1, 1000 + i * 100, 222, Some(0.3), Some(i as f64));
        }
        tl.push(1, 5000, 333, Some(0.9), Some(0.0));
        tl.push(2, 1200, 444, Some(0.9), Some(0.0));
        assert_eq!(tl.ranked(1, 1000, 2000), vec![111, 222]);
        assert_eq!(tl.ranked(1, 1000, 1100), vec![222, 111]);
        assert!(tl.ranked(3, 0, 9999).is_empty());
    }

    #[test]
    fn ignores_stale_and_silent_reports() {
        let mut tl = SpeakerTimeline::default();
        tl.push(1, 1000, 111, Some(0.5), Some(10.0));
        // Same packet timestamp: the source stopped sending, level is stale.
        tl.push(1, 1100, 111, Some(0.5), Some(10.0));
        tl.push(1, 1200, 111, Some(0.5), Some(10.0));
        // New packets, but silence.
        tl.push(1, 1300, 111, Some(0.0001), Some(11.0));
        tl.push(1, 1400, 111, None, Some(12.0));
        assert_eq!(tl.samples[&1].len(), 1);
    }

    #[test]
    fn together_are_the_sources_of_the_latest_report() {
        let mut tl = SpeakerTimeline::default();
        tl.push(1, 1000, 111, Some(0.5), Some(1.0));
        tl.push(1, 1100, 111, Some(0.5), Some(2.0));
        tl.push(1, 1100, 222, Some(0.5), Some(1.0));
        tl.push(1, 1200, 222, Some(0.5), Some(2.0));
        assert_eq!(tl.together(1, 1050), vec![111]);
        assert_eq!(tl.together(1, 1150), vec![222, 111]);
        assert_eq!(tl.together(1, 1250), vec![222]);
        assert!(tl.together(1, 2000).is_empty());
    }

    #[test]
    fn current_reports_the_latest_audible_source() {
        let mut tl = SpeakerTimeline::default();
        tl.push(1, 1000, 111, Some(0.5), Some(1.0));
        tl.push(1, 2000, 222, Some(0.5), Some(1.0));
        assert_eq!(tl.current(1, 1100), vec![111]);
        assert_eq!(tl.current(1, 2100), vec![222]);
        assert!(tl.current(1, 3000).is_empty());
    }
}
