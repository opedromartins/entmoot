mod parakeet_model;

use std::path::{Path, PathBuf};
use std::str::FromStr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Instant;

use anyhow::{anyhow, bail, Context, Result};
use serde::{Deserialize, Serialize};

use parakeet_model::{ParakeetModel, TimestampedResult};

use crate::SAMPLE_RATE;

/// Where the model's heavy part (the encoder) runs.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Device {
    #[default]
    Cpu,
    /// Any DirectX 12 graphics card, through DirectML. Windows only.
    Gpu,
}

impl FromStr for Device {
    type Err = anyhow::Error;

    fn from_str(s: &str) -> Result<Self> {
        match s {
            "cpu" => Ok(Self::Cpu),
            "gpu" => Ok(Self::Gpu),
            _ => bail!("unknown device {s:?}; available: cpu, gpu"),
        }
    }
}

/// How long a stretch of audio was and how long it took to transcribe.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
pub struct Speed {
    pub audio_ms: u64,
    pub took_ms: u64,
}

#[derive(Debug)]
pub struct Transcript {
    pub text: String,
    /// Sub-word tokens and the time, in seconds from the start of the audio,
    /// at which each was emitted.
    pub tokens: Vec<String>,
    pub token_times: Vec<f32>,
    pub speed: Speed,
}

/// Seconds of silence transcribed after loading, to time the model.
const TRIAL_SECONDS: usize = 5;

/// The GPU was asked for, could not be used, and the CPU was not allowed in
/// its place. Holds why the GPU could not be used.
#[derive(Debug, thiserror::Error)]
#[error("the GPU could not be used: {0}")]
pub struct GpuUnavailable(pub String);

pub struct Parakeet {
    /// Only unset inside `switch`, or after it failed to bring back
    /// the model it had dropped.
    model: Option<ParakeetModel>,
    model_dir: PathBuf,
    device: Device,
    /// Whether the CPU takes over when the GPU fails. Read at each
    /// transcription, so it can change while the model stays loaded.
    cpu_fallback: Arc<AtomicBool>,
    gpu_error: Option<String>,
    trial: Speed,
}

impl Parakeet {
    /// Loads the model in `model_dir` on `device`. With `cpu_fallback`, a GPU
    /// that cannot be used is not an error: the model runs on the CPU and
    /// `gpu_error` says why. Without it, the error is a `GpuUnavailable`.
    pub fn load(model_dir: &Path, device: Device, cpu_fallback: bool) -> Result<Self> {
        let mut gpu_error = None;
        let flag = Arc::new(AtomicBool::new(cpu_fallback));
        if device == Device::Gpu {
            match Self::load_on(model_dir, Device::Gpu) {
                Ok((model, trial)) => return Ok(Self { model: Some(model), model_dir: model_dir.into(), device, cpu_fallback: flag, gpu_error, trial }),
                Err(e) if !cpu_fallback => return Err(GpuUnavailable(format!("{e:#}")).into()),
                Err(e) => {
                    log::warn!("GPU unavailable, using the CPU: {e:#}");
                    gpu_error = Some(format!("{e:#}"));
                }
            }
        }
        let (model, trial) = Self::load_on(model_dir, Device::Cpu).with_context(|| format!("loading Parakeet from {}", model_dir.display()))?;
        Ok(Self { model: Some(model), model_dir: model_dir.into(), device: Device::Cpu, cpu_fallback: flag, gpu_error, trial })
    }

    /// Moves to the model in `model_dir` (the same one, to change only the
    /// device) on `device`, as asked by the user. The old model is freed
    /// first, so two never take memory at once; in exchange nothing is
    /// transcribed until the new one has loaded. If it cannot load (the GPU
    /// is unavailable and the CPU may not take over, say), the model goes
    /// back to where it was and the error says why.
    pub fn switch(&mut self, model_dir: &Path, device: Device) -> Result<()> {
        let flag = self.cpu_fallback.clone();
        let before = self.device;
        self.model = None;
        match Self::load(model_dir, device, flag.load(Ordering::Relaxed)) {
            Ok(mut loaded) => {
                loaded.share_cpu_fallback(flag);
                *self = loaded;
                Ok(())
            }
            Err(e) => {
                let (model, trial) = Self::load_on(&self.model_dir, before).map_err(|back| anyhow!("{e:#}; and the previous model could not be restored: {back:#}"))?;
                (self.model, self.trial) = (Some(model), trial);
                Err(e)
            }
        }
    }

    /// Makes `flag` the setting that says whether the CPU takes over, so
    /// whoever holds it can change that without reloading the model.
    pub fn share_cpu_fallback(&mut self, flag: Arc<AtomicBool>) {
        self.cpu_fallback = flag;
    }

    /// The model on that device, with how fast it ran a trial.
    fn load_on(model_dir: &Path, device: Device) -> Result<(ParakeetModel, Speed)> {
        let gpu = device == Device::Gpu;
        if gpu && !model_dir.join("encoder-model.onnx").exists() {
            bail!("this model is quantized to 8 bits, which only the CPU runs");
        }
        let mut model = ParakeetModel::new(model_dir, !gpu, gpu).map_err(|e| anyhow!(e))?;
        // Some failures (an operator the card lacks, not enough memory) only
        // show on the first run. It also pays the start-up cost here instead
        // of on the first words of a meeting.
        model.transcribe_samples(vec![0.0; SAMPLE_RATE as usize]).map_err(|e| anyhow!(e)).context("trial run")?;
        let (_, trial) = run(&mut model, vec![0.0; TRIAL_SECONDS * SAMPLE_RATE as usize]).context("timed trial run")?;
        Ok((model, trial))
    }

    /// The folder of the model in use.
    pub fn model_dir(&self) -> &Path {
        &self.model_dir
    }

    /// Where the model runs now: the CPU when the GPU could not be used, or
    /// stopped working since.
    pub fn device(&self) -> Device {
        self.device
    }

    /// Whether the CPU takes over when the GPU fails.
    pub fn cpu_fallback(&self) -> bool {
        self.cpu_fallback.load(Ordering::Relaxed)
    }

    /// Why the GPU was asked for and is not in use.
    pub fn gpu_error(&self) -> Option<&str> {
        self.gpu_error.as_deref()
    }

    /// How fast the device in use transcribed silence, once warmed up.
    pub fn trial(&self) -> Speed {
        self.trial
    }

    /// When the GPU fails (the driver restarted, the card ran out of memory)
    /// and the CPU may take over, the model moves there for good and the
    /// same audio is transcribed there, so nothing said is lost.
    pub fn transcribe(&mut self, samples: &[i16]) -> Result<Transcript> {
        let floats: Vec<f32> = samples.iter().map(|&s| s as f32 / 32768.0).collect();
        let again = (self.device == Device::Gpu && self.cpu_fallback()).then(|| floats.clone());
        let Some(model) = self.model.as_mut() else { bail!("no model is loaded") };
        let (r, speed) = match (run(model, floats), again) {
            (Ok(done), _) => done,
            (Err(e), Some(floats)) => {
                log::warn!("transcribing on the GPU failed, trying the CPU: {e:#}");
                // The GPU model stays until the CPU proves the audio was not
                // what failed.
                let (mut model, trial) = Self::load_on(&self.model_dir, Device::Cpu).context("moving the model to the CPU")?;
                let done = run(&mut model, floats)?;
                log::warn!("the model now runs on the CPU");
                (self.model, self.device, self.trial) = (Some(model), Device::Cpu, trial);
                self.gpu_error = Some(format!("{e:#}"));
                done
            }
            (Err(e), None) => return Err(e),
        };
        Ok(Transcript { text: r.text.trim().to_string(), tokens: r.tokens, token_times: r.timestamps, speed })
    }
}

fn run(model: &mut ParakeetModel, samples: Vec<f32>) -> Result<(TimestampedResult, Speed)> {
    let audio_ms = samples.len() as u64 * 1000 / SAMPLE_RATE as u64;
    let started = Instant::now();
    let result = model.transcribe_samples(samples)?;
    Ok((result, Speed { audio_ms, took_ms: started.elapsed().as_millis() as u64 }))
}
