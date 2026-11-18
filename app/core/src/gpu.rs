//! What the graphics card is doing for this process, so the user can see
//! that the model really runs on it. Windows only; elsewhere there is nothing
//! to report.

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct GpuStats {
    /// The card's name, as Windows shows it.
    pub name: String,
    /// Video memory this process holds on the card, in bytes.
    pub memory_used: u64,
    /// The card's own memory, in bytes; small or zero for one that shares the
    /// computer's memory.
    pub memory_total: u64,
    /// How busy this process kept the card since the previous sample, 0 to
    /// 100. Unset on the first sample and after a long pause between samples.
    pub usage: Option<f32>,
}

/// A graphics card the computer has, for the first-run setup.
#[derive(Debug, Clone, Serialize)]
pub struct GpuInfo {
    /// The card's name, as Windows shows it.
    pub name: String,
    /// NVIDIA, AMD, Intel... from the PCI vendor id.
    pub vendor: String,
    /// The card's own memory, in bytes; zero or small for one that shares
    /// the computer's memory (most integrated graphics).
    pub vram: u64,
    /// Computer memory the card may borrow, in bytes.
    pub shared_memory: u64,
    /// Driver version as Windows shows it, like "32.0.15.6094".
    pub driver: Option<String>,
    /// Has no memory of its own to speak of.
    pub integrated: bool,
}

/// The computer, as far as the model's speed depends on it.
#[derive(Debug, Clone, Serialize)]
pub struct Hardware {
    /// Every hardware graphics card, the one with most memory first.
    pub gpus: Vec<GpuInfo>,
    /// Logical processors.
    pub cpu_threads: usize,
    /// The computer's memory, in bytes.
    pub ram_total: Option<u64>,
}

/// Looks for the graphics cards and the memory the computer has.
pub fn hardware() -> Hardware {
    Hardware {
        gpus: gpus(),
        cpu_threads: std::thread::available_parallelism().map_or(1, |n| n.get()),
        ram_total: ram_total(),
    }
}

#[cfg(windows)]
fn gpus() -> Vec<GpuInfo> {
    sys::gpus()
}

#[cfg(not(windows))]
fn gpus() -> Vec<GpuInfo> {
    Vec::new()
}

#[cfg(windows)]
fn ram_total() -> Option<u64> {
    sys::ram_total()
}

#[cfg(not(windows))]
fn ram_total() -> Option<u64> {
    None
}

/// Samples the card this process uses. Keep one and call `sample` every
/// second or two: usage is measured between one call and the next.
#[derive(Default)]
pub struct GpuMonitor {
    #[cfg(windows)]
    usage: Option<sys::Usage>,
}

impl GpuMonitor {
    #[cfg(windows)]
    pub fn sample(&mut self) -> Option<GpuStats> {
        let (name, memory_used, memory_total) = sys::adapter()?;
        let usage = match &mut self.usage {
            Some(usage) => usage.sample(),
            None => {
                self.usage = sys::Usage::open();
                None
            }
        };
        Some(GpuStats { name, memory_used, memory_total, usage })
    }

    #[cfg(not(windows))]
    pub fn sample(&mut self) -> Option<GpuStats> {
        None
    }
}

#[cfg(windows)]
mod sys {
    use std::collections::HashMap;
    use std::time::{Duration, Instant};

    use windows::core::{w, Interface, PCWSTR};
    use windows::Win32::Graphics::Dxgi::{
        CreateDXGIFactory1, IDXGIAdapter3, IDXGIDevice, IDXGIFactory1, DXGI_ADAPTER_FLAG_SOFTWARE, DXGI_MEMORY_SEGMENT_GROUP_LOCAL,
        DXGI_QUERY_VIDEO_MEMORY_INFO,
    };
    use windows::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};

    use super::GpuInfo;
    use windows::Win32::System::Performance::{
        PdhAddEnglishCounterW, PdhCloseQuery, PdhCollectQueryData, PdhGetFormattedCounterArrayW, PdhOpenQueryW, PDH_FMT_COUNTERVALUE_ITEM_W, PDH_FMT_DOUBLE,
        PDH_HCOUNTER, PDH_HQUERY, PDH_MORE_DATA,
    };

    /// Samples further apart than this say little about "now".
    const STALE: Duration = Duration::from_secs(10);

    /// Below this a card is treated as sharing the computer's memory.
    const INTEGRATED_BELOW: u64 = 512 << 20;

    fn vendor(id: u32) -> String {
        match id {
            0x10DE => "NVIDIA",
            0x1002 | 0x1022 => "AMD",
            0x8086 => "Intel",
            0x5143 => "Qualcomm",
            _ => "Desconhecido",
        }
        .into()
    }

    /// "32.0.15.6094" from the 64-bit version Windows keeps for a driver.
    fn driver_version(v: i64) -> String {
        let v = v as u64;
        format!("{}.{}.{}.{}", v >> 48, (v >> 32) & 0xFFFF, (v >> 16) & 0xFFFF, v & 0xFFFF)
    }

    /// Every hardware adapter, the one with most dedicated memory first.
    pub fn gpus() -> Vec<GpuInfo> {
        let mut found = Vec::new();
        unsafe {
            let Ok(factory) = CreateDXGIFactory1::<IDXGIFactory1>() else { return found };
            for i in 0.. {
                let Ok(adapter) = factory.EnumAdapters1(i) else { break };
                let Ok(desc) = adapter.GetDesc1() else { continue };
                if desc.Flags & DXGI_ADAPTER_FLAG_SOFTWARE.0 as u32 != 0 {
                    continue;
                }
                let driver = adapter.CheckInterfaceSupport(&IDXGIDevice::IID).ok().map(driver_version);
                let vram = desc.DedicatedVideoMemory as u64;
                found.push(GpuInfo {
                    name: String::from_utf16_lossy(&desc.Description).trim_end_matches('\0').trim().to_string(),
                    vendor: vendor(desc.VendorId),
                    vram,
                    shared_memory: desc.SharedSystemMemory as u64,
                    driver,
                    integrated: vram < INTEGRATED_BELOW,
                });
            }
        }
        found.sort_by_key(|g| std::cmp::Reverse(g.vram));
        found
    }

    pub fn ram_total() -> Option<u64> {
        let mut status = MEMORYSTATUSEX { dwLength: std::mem::size_of::<MEMORYSTATUSEX>() as u32, ..Default::default() };
        unsafe { GlobalMemoryStatusEx(&mut status).ok()? };
        Some(status.ullTotalPhys)
    }

    /// Name, memory this process holds and total memory of the card this
    /// process uses the most; the first one when it uses none.
    pub fn adapter() -> Option<(String, u64, u64)> {
        let mut best: Option<(String, u64, u64)> = None;
        unsafe {
            let factory: IDXGIFactory1 = CreateDXGIFactory1().ok()?;
            for i in 0.. {
                let Ok(adapter) = factory.EnumAdapters1(i) else { break };
                let Ok(desc) = adapter.GetDesc1() else { continue };
                if desc.Flags & DXGI_ADAPTER_FLAG_SOFTWARE.0 as u32 != 0 {
                    continue;
                }
                let Ok(adapter) = adapter.cast::<IDXGIAdapter3>() else { continue };
                let mut memory = DXGI_QUERY_VIDEO_MEMORY_INFO::default();
                if adapter.QueryVideoMemoryInfo(0, DXGI_MEMORY_SEGMENT_GROUP_LOCAL, &mut memory).is_err() {
                    continue;
                }
                if best.as_ref().is_none_or(|(_, used, _)| memory.CurrentUsage > *used) {
                    let name = String::from_utf16_lossy(&desc.Description);
                    best = Some((name.trim_end_matches('\0').trim().to_string(), memory.CurrentUsage, desc.DedicatedVideoMemory as u64));
                }
            }
        }
        best
    }

    /// The performance counters Task Manager reads for its GPU column.
    pub struct Usage {
        query: PDH_HQUERY,
        counter: PDH_HCOUNTER,
        /// How the counters of this process begin.
        prefix: String,
        sampled: Instant,
    }

    // The handles are not tied to the thread that opened them.
    unsafe impl Send for Usage {}

    impl Usage {
        pub fn open() -> Option<Self> {
            unsafe {
                let mut query = PDH_HQUERY::default();
                if PdhOpenQueryW(PCWSTR::null(), 0, &mut query) != 0 {
                    return None;
                }
                let mut counter = PDH_HCOUNTER::default();
                // One instance per process, card and engine (3D, copy, video...).
                if PdhAddEnglishCounterW(query, w!("\\GPU Engine(*)\\Utilization Percentage"), 0, &mut counter) != 0 {
                    PdhCloseQuery(query);
                    return None;
                }
                // A rate needs two samples; this is the first.
                PdhCollectQueryData(query);
                Some(Self { query, counter, prefix: format!("pid_{}_", std::process::id()), sampled: Instant::now() })
            }
        }

        pub fn sample(&mut self) -> Option<f32> {
            let stale = self.sampled.elapsed() > STALE;
            self.sampled = Instant::now();
            unsafe {
                if PdhCollectQueryData(self.query) != 0 || stale {
                    return None;
                }
                let (mut size, mut count) = (0u32, 0u32);
                if PdhGetFormattedCounterArrayW(self.counter, PDH_FMT_DOUBLE, &mut size, &mut count, None) != PDH_MORE_DATA {
                    return None;
                }
                // The items come first and their names after, in one buffer
                // that must be aligned for the items.
                let mut buffer = vec![0u64; (size as usize).div_ceil(8)];
                let items = buffer.as_mut_ptr().cast::<PDH_FMT_COUNTERVALUE_ITEM_W>();
                if PdhGetFormattedCounterArrayW(self.counter, PDH_FMT_DOUBLE, &mut size, &mut count, Some(items)) != 0 {
                    return None;
                }
                // Engines of one kind add up; the busiest kind is the usage,
                // as in Task Manager.
                let mut by_engine: HashMap<String, f64> = HashMap::new();
                for item in std::slice::from_raw_parts(items, count as usize) {
                    let Ok(name) = item.szName.to_string() else { continue };
                    if !name.starts_with(&self.prefix) {
                        continue;
                    }
                    let engine = name.rsplit("engtype_").next().unwrap_or_default().to_string();
                    *by_engine.entry(engine).or_default() += item.FmtValue.Anonymous.doubleValue;
                }
                Some(by_engine.into_values().fold(0.0, f64::max).min(100.0) as f32)
            }
        }
    }

    impl Drop for Usage {
        fn drop(&mut self) {
            unsafe {
                PdhCloseQuery(self.query);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn finds_the_computer() {
        let hw = super::hardware();
        println!("{hw:#?}");
        assert!(hw.cpu_threads >= 1);
        #[cfg(windows)]
        assert!(hw.ram_total.is_some_and(|r| r > 0));
        // Sorted: the card with most memory first.
        assert!(hw.gpus.windows(2).all(|w| w[0].vram >= w[1].vram));
    }
}
