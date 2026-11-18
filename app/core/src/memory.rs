//! How much of the computer's memory this process occupies; with the model
//! on the CPU, nearly all of it is the model. Windows only.

/// Bytes of physical memory this process holds now.
#[cfg(windows)]
pub fn process_memory() -> Option<u64> {
    use windows::Win32::System::ProcessStatus::{GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS};
    use windows::Win32::System::Threading::GetCurrentProcess;

    let mut counters = PROCESS_MEMORY_COUNTERS::default();
    let size = std::mem::size_of::<PROCESS_MEMORY_COUNTERS>() as u32;
    // The working set, not the private bytes: the model's weights may be
    // mapped from the file instead of allocated.
    unsafe { GetProcessMemoryInfo(GetCurrentProcess(), &mut counters, size).ok()? };
    Some(counters.WorkingSetSize as u64)
}

#[cfg(not(windows))]
pub fn process_memory() -> Option<u64> {
    None
}
