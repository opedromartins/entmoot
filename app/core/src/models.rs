//! Speech models the app can run, downloaded on first use.

use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};

pub struct ModelSpec {
    /// Name used on the command line and as the folder under the models root.
    pub name: &'static str,
    /// False for quantized models: 8-bit operators run on the CPU only.
    pub gpu: bool,
    /// Hugging Face `repo/resolve/revision`, pinned so the files cannot change.
    source: &'static str,
    /// File name and exact size in bytes.
    files: &'static [(&'static str, u64)],
}

pub const MODELS: &[ModelSpec] = &[
    // Parakeet TDT 0.6B v3 fine-tuned for Brazilian Portuguese (CC-BY-4.0).
    // Full precision only: about 2.5 GB on disk and in memory.
    ModelSpec {
        name: "parakeet-v3-ptbr",
        gpu: true,
        source: "alefiury/parakeet-tdt-0.6b-v3-ptBR-TAGARELA-onnx/resolve/47586335c0b00ba273205f0ed3ef5a2cd651c143",
        files: &[
            ("encoder-model.onnx", 41_842_954),
            ("encoder-model.onnx.data", 2_435_420_160),
            ("decoder_joint-model.onnx", 72_520_893),
            ("nemo128.onnx", 139_764),
            ("vocab.txt", 93_939),
        ],
    },
    // The multilingual original at full precision.
    ModelSpec {
        name: "parakeet-v3",
        gpu: true,
        source: "istupakov/parakeet-tdt-0.6b-v3-onnx/resolve/8f23f0c03c8761650bdb5b40aaf3e40d2c15f1ce",
        files: &[
            ("encoder-model.onnx", 41_770_866),
            ("encoder-model.onnx.data", 2_435_420_160),
            ("decoder_joint-model.onnx", 72_520_893),
            ("nemo128.onnx", 139_764),
            ("vocab.txt", 93_939),
        ],
    },
    // The multilingual original, 8-bit quantized: 670 MB, fastest on CPU.
    ModelSpec {
        name: "parakeet-v3-int8",
        gpu: false,
        source: "istupakov/parakeet-tdt-0.6b-v3-onnx/resolve/main",
        files: &[
            ("encoder-model.int8.onnx", 652_183_999),
            ("decoder_joint-model.int8.onnx", 18_202_004),
            ("nemo128.onnx", 139_764),
            ("vocab.txt", 93_939),
        ],
    },
];

pub const DEFAULT_MODEL: &str = MODELS[0].name;

pub fn find(name: &str) -> Option<&'static ModelSpec> {
    MODELS.iter().find(|m| m.name == name)
}

impl ModelSpec {
    pub fn size_bytes(&self) -> u64 {
        self.files.iter().map(|&(_, size)| size).sum()
    }

    /// The web page listing the files that are downloaded.
    pub fn page(&self) -> String {
        format!("https://huggingface.co/{}", self.source.replacen("/resolve/", "/tree/", 1))
    }

    /// Whether every file is already complete under `root`.
    pub fn is_downloaded(&self, root: &Path) -> bool {
        self.files.iter().all(|&(file, size)| present(&root.join(self.name).join(file), size))
    }
}

fn present(path: &Path, size: u64) -> bool {
    fs::metadata(path).is_ok_and(|m| m.len() == size)
}

/// Returns the folder of model `name` under `root`, downloading what is missing.
///
/// `progress` is called with the bytes present so far and the model's total
/// size, only while something is being downloaded; returning false stops it.
pub fn ensure(root: &Path, name: &str, progress: &mut dyn FnMut(u64, u64) -> bool) -> Result<PathBuf> {
    let Some(spec) = find(name) else {
        let known: Vec<_> = MODELS.iter().map(|m| m.name).collect();
        bail!("unknown model {name:?}; available: {}", known.join(", "));
    };
    let dir = root.join(spec.name);
    fs::create_dir_all(&dir)?;
    let total = spec.size_bytes();
    let mut done: u64 = spec.files.iter().filter(|&&(file, size)| present(&dir.join(file), size)).map(|&(_, size)| size).sum();
    for &(file, size) in spec.files {
        let path = dir.join(file);
        if present(&path, size) {
            continue;
        }
        log::info!("downloading {file} ({} MB)", size / 1_000_000);
        let partial = dir.join(format!("{file}.part"));
        let url = format!("https://huggingface.co/{}/{file}", spec.source);
        let mut body = ureq::get(&url).call().with_context(|| format!("fetching {url}"))?.into_reader();
        let mut out = fs::File::create(&partial)?;
        let mut buf = vec![0u8; 1 << 20];
        let mut written = 0u64;
        loop {
            if !progress(done + written, total) {
                drop(out);
                fs::remove_file(&partial).ok();
                bail!("download of {name} cancelled");
            }
            let n = body.read(&mut buf).with_context(|| format!("downloading {file}"))?;
            if n == 0 {
                break;
            }
            out.write_all(&buf[..n])?;
            written += n as u64;
        }
        drop(out);
        if written != size {
            bail!("{file}: expected {size} bytes, got {written}");
        }
        fs::rename(&partial, &path)?;
        done += size;
    }
    Ok(dir)
}
