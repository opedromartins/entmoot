//! Cuts one audio stream into utterances by energy.
//!
//! Meeting audio arrives already noise-suppressed, so speech stands well clear
//! of the floor; an adaptive energy gate is enough to find where people stop.

use std::collections::VecDeque;

use crate::SAMPLE_RATE;

const MIN_THRESHOLD: f32 = 0.006;
const NOISE_FACTOR: f32 = 3.0;
const NOISE_RISE: f32 = 1.005;
/// Silence that ends an utterance.
const HANGOVER_MS: u64 = 600;
const MIN_SPEECH_MS: u64 = 300;
const MAX_UTTERANCE_MS: u64 = 25_000;
/// Audio kept from before speech was detected, so first syllables survive.
const PRE_ROLL_FRAMES: usize = 2;
/// A jump in timestamps larger than this means audio is missing.
const GAP_MS: u64 = 250;

#[derive(Debug)]
pub struct Utterance {
    pub stream: u8,
    pub start_ms: u64,
    pub end_ms: u64,
    pub samples: Vec<i16>,
}

struct Open {
    start_ms: u64,
    samples: Vec<i16>,
    speech_ms: u64,
    silence_ms: u64,
}

pub struct Segmenter {
    stream: u8,
    noise: f32,
    pre_roll: VecDeque<(u64, Vec<i16>)>,
    open: Option<Open>,
    last_end_ms: Option<u64>,
}

fn duration_ms(samples: usize) -> u64 {
    samples as u64 * 1000 / SAMPLE_RATE as u64
}

fn rms(frame: &[i16]) -> f32 {
    if frame.is_empty() {
        return 0.0;
    }
    let sum: f64 = frame.iter().map(|&s| (s as f64) * (s as f64)).sum();
    ((sum / frame.len() as f64).sqrt() / 32768.0) as f32
}

impl Segmenter {
    pub fn new(stream: u8) -> Self {
        Self { stream, noise: 0.002, pre_roll: VecDeque::new(), open: None, last_end_ms: None }
    }

    pub fn is_open(&self) -> bool {
        self.open.is_some()
    }

    /// Feeds one frame stamped with the time of its first sample.
    pub fn feed(&mut self, t_ms: u64, frame: &[i16]) -> Option<Utterance> {
        let mut finished = None;
        if self.last_end_ms.is_some_and(|end| t_ms > end + GAP_MS) {
            finished = self.close();
            self.pre_roll.clear();
        }
        let frame_ms = duration_ms(frame.len());
        self.last_end_ms = Some(t_ms + frame_ms);

        let level = rms(frame);
        let speech = level > MIN_THRESHOLD.max(self.noise * NOISE_FACTOR);
        // The floor follows the quietest recent level: it drops at once and
        // creeps up slowly, so steady noise is learned within seconds while
        // speech, which always has pauses, never becomes the floor.
        self.noise = level.min(self.noise * NOISE_RISE).max(1e-4);

        match &mut self.open {
            None if speech => {
                let start_ms = self.pre_roll.front().map_or(t_ms, |(t, _)| *t);
                let mut samples: Vec<i16> = self.pre_roll.drain(..).flat_map(|(_, s)| s).collect();
                samples.extend_from_slice(frame);
                self.open = Some(Open { start_ms, samples, speech_ms: frame_ms, silence_ms: 0 });
            }
            None => {
                self.pre_roll.push_back((t_ms, frame.to_vec()));
                if self.pre_roll.len() > PRE_ROLL_FRAMES {
                    self.pre_roll.pop_front();
                }
            }
            Some(open) => {
                open.samples.extend_from_slice(frame);
                if speech {
                    open.speech_ms += frame_ms;
                    open.silence_ms = 0;
                } else {
                    open.silence_ms += frame_ms;
                }
                if open.silence_ms >= HANGOVER_MS || duration_ms(open.samples.len()) >= MAX_UTTERANCE_MS {
                    // A gap and a natural end cannot both happen on one frame:
                    // a gap closes the utterance before this frame is added.
                    finished = self.close();
                }
            }
        }
        finished
    }

    /// Ends the utterance in progress, if it holds enough speech to keep.
    pub fn close(&mut self) -> Option<Utterance> {
        let open = self.open.take()?;
        if open.speech_ms < MIN_SPEECH_MS {
            return None;
        }
        let end_ms = open.start_ms + duration_ms(open.samples.len());
        Some(Utterance { stream: self.stream, start_ms: open.start_ms, end_ms, samples: open.samples })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const FRAME: usize = 1600; // 100 ms

    fn tone(amplitude: i16) -> Vec<i16> {
        (0..FRAME).map(|i| if i % 2 == 0 { amplitude } else { -amplitude }).collect()
    }

    fn run(seg: &mut Segmenter, start_ms: u64, frames: &[i16]) -> Vec<Utterance> {
        frames
            .iter()
            .enumerate()
            .filter_map(|(i, &a)| seg.feed(start_ms + i as u64 * 100, &tone(a)))
            .collect()
    }

    #[test]
    fn cuts_at_silence_and_keeps_pre_roll() {
        let mut seg = Segmenter::new(1);
        let mut frames = vec![0; 5];
        frames.extend([8000; 10]);
        frames.extend([0; 7]);
        let out = run(&mut seg, 10_000, &frames);
        assert_eq!(out.len(), 1);
        // Speech starts at 10.5 s; two pre-roll frames pull the start to 10.3 s.
        assert_eq!(out[0].start_ms, 10_300);
        // 2 pre-roll + 10 speech + 6 hangover frames.
        assert_eq!(out[0].end_ms, 10_300 + 1800);
        assert_eq!(out[0].samples.len(), 18 * FRAME);
    }

    #[test]
    fn drops_blips() {
        let mut seg = Segmenter::new(1);
        let mut frames = vec![0; 3];
        frames.extend([8000; 2]);
        frames.extend([0; 8]);
        assert!(run(&mut seg, 0, &frames).is_empty());
    }

    #[test]
    fn a_gap_in_time_ends_the_utterance() {
        let mut seg = Segmenter::new(1);
        assert!(run(&mut seg, 0, &[8000; 5]).is_empty());
        let out = run(&mut seg, 5_000, &[8000; 5]);
        assert_eq!(out.len(), 1);
        assert_eq!((out[0].start_ms, out[0].end_ms), (0, 500));
        assert!(seg.is_open());
    }

    #[test]
    fn long_speech_is_cut_at_the_limit() {
        let mut seg = Segmenter::new(1);
        let out = run(&mut seg, 0, &vec![8000; 300]);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].end_ms - out[0].start_ms, MAX_UTTERANCE_MS);
    }

    #[test]
    fn adapts_to_a_noisy_floor() {
        let mut seg = Segmenter::new(0);
        // Steady noise above the fixed minimum passes as speech only until the
        // floor catches up; after that, only real speech opens an utterance.
        let mut frames = vec![300; 150];
        frames.extend([8000; 10]);
        frames.extend([300; 7]);
        let out = run(&mut seg, 0, &frames);
        assert!(out.len() <= 2);
        let last = out.last().unwrap();
        assert!(last.start_ms >= 14_000 && last.end_ms - last.start_ms < 2_500);
    }
}
