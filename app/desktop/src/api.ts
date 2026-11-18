import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

export interface Status {
  stage: 'starting' | 'downloading_model' | 'loading_model' | 'ready' | 'error';
  error: string | null;
  extension_connected: boolean;
  live_meeting: number | null;
  /** The model being downloaded, loaded or used. */
  model: string;
  /** Whether this run keeps only the platform's captions. */
  mode: Mode;
  /** Where the loaded model runs; null while it is not loaded: before a meeting page opens, and again some minutes after the last meeting. */
  device: Device | null;
  /**
   * What went wrong with the GPU chosen in the settings. With the stage
   * "error", the model did not load; with the device still the GPU, an
   * utterance was lost; otherwise the model runs on the CPU instead.
   */
  gpu_error: string | null;
  /** The GPU worked when the model loaded and failed later. */
  gpu_failed_in_use: boolean;
  /** How fast the model ran a trial on the device in use; null until it has loaded. */
  speed_trial: Speed | null;
  /** The latest utterance transcribed. */
  speed_last: Speed | null;
  /** Every utterance transcribed on the device in use. */
  speed_total: Speed;
  /** Bytes present and total while the model downloads. */
  download: [number, number] | null;
  /** The model is moving to another device or another model: nothing is transcribed meanwhile, the captions go on. */
  switching: boolean;
  /** Why the last move failed; the model stayed where it was. */
  switch_error: string | null;
}

export type Device = 'cpu' | 'gpu';

/** How long a stretch of audio was and how long it took to transcribe. */
export interface Speed {
  audio_ms: number;
  took_ms: number;
}

/** What the graphics card is doing for the app. */
export interface GpuStats {
  name: string;
  /** Bytes of video memory the app holds. */
  memory_used: number;
  /** The card's own memory, in bytes; small or zero for one that shares the computer's. */
  memory_total: number;
  /** How busy the app kept the card since the previous reading, 0 to 100; null on the first. */
  usage: number | null;
}

/** What the app's process occupies. */
export interface Resources {
  /** Bytes of the computer's memory; null where it cannot be read. */
  memory_used: number | null;
  /** Null unless the model runs on the graphics card. */
  gpu: GpuStats | null;
}

export interface ModelInfo {
  name: string;
  size_bytes: number;
  /** False for models that only run on the CPU. */
  gpu: boolean;
  downloaded: boolean;
  /** The web page its files come from. */
  page: string;
}

export interface Meeting {
  id: number;
  platform: string;
  code: string;
  title: string;
  started_ms: number;
  ended_ms: number | null;
  segments: number;
}

export interface Segment {
  id: number;
  meeting_id: number;
  start_ms: number;
  end_ms: number;
  /** The audio track it was heard on: 0 is the microphone. */
  stream: number;
  speaker: string;
  speaker_key: string;
  text: string;
}

export interface Caption {
  device_id: string;
  speaker: string | null;
  first_ms: number;
  last_ms: number;
  text: string;
}

/** Where the text of a meeting comes from: a model on this computer, or only the platform's own captions. */
export type Mode = 'local' | 'captions';

/** A graphics card the computer has. */
export interface GpuInfo {
  name: string;
  /** NVIDIA, AMD, Intel... */
  vendor: string;
  /** The card's own memory, in bytes; small or zero for one that shares the computer's. */
  vram: number;
  /** Computer memory the card may borrow, in bytes. */
  shared_memory: number;
  driver: string | null;
  integrated: boolean;
}

/** What the first-run setup finds out about the computer, and what it suggests. */
export interface HardwareReport {
  /** The one with most memory first; empty when none was found. */
  gpus: GpuInfo[];
  cpu_threads: number;
  /** Bytes of the computer's memory. */
  ram_total: number | null;
  recommended_device: Device;
  recommended_model: string;
  /** One line saying why. */
  reason: string;
}

/** The developer mode, turned on from inside the app. The three below only count while `enabled`. */
export interface DevSettings {
  enabled: boolean;
  /** Keep every message from the extension, and ask it for every data-channel frame it sees. */
  dump_events: boolean;
  /** Keep the audio of every track. */
  dump_audio: boolean;
  /** Keep what the app made of the meeting, next to the dump. */
  save_transcripts: boolean;
}

export interface Settings {
  /** False until the first-run setup is finished. */
  setup_done: boolean;
  mode: Mode;
  autostart: boolean;
  minimize_to_tray: boolean;
  close_to_tray: boolean;
  device: Device;
  /** Whether the CPU takes over when the GPU cannot be used or fails in use. */
  cpu_fallback: boolean;
  model: string;
  dev: DevSettings;
}

export type EngineEvent =
  | { type: 'segment' } & Segment
  | { type: 'echo'; segment_id: number }
  /** A caption line of the meeting going on, new or revised; `key` is the line's. */
  | ({ type: 'caption'; key: string } & Caption)
  | { type: 'meeting_started'; meeting_id: number }
  | { type: 'meeting_updated'; meeting_id: number }
  | { type: 'meeting_saved'; meeting_id: number }
  /** The meeting ended with nothing said and is gone. */
  | { type: 'meeting_discarded'; meeting_id: number }
  | { type: 'waiting' | 'loading_model' | 'load_failed' | 'listening'| 'listening_captions_only' | 'gpu_failed' | 'switching' | 'switched' | 'switch_failed' | 'transcribed' | 'extension_connected' | 'extension_disconnected' };

export const api = {
  status: () => invoke<Status>('status'),
  meetings: () => invoke<Meeting[]>('meetings'),
  transcript: (meetingId: number) => invoke<Segment[]>('transcript', { meetingId }),
  captions: (meetingId: number) => invoke<Caption[]>('captions', { meetingId }),
  search: (query: string) => invoke<Segment[]>('search', { query }),
  deleteMeeting: (meetingId: number) => invoke<void>('delete_meeting', { meetingId }),
  /** Removes every meeting but the one happening now; resolves to how many went. */
  deleteAllMeetings: () => invoke<number>('delete_all_meetings'),
  /** Opens, in the browser, the page a model is downloaded from. */
  openModelPage: (name: string) => invoke<void>('open_model_page', { name }),
  /** Asks where to save the meeting as Markdown; resolves to the file, or null when the user gave up. */
  exportMeeting: (meetingId: number, captions: boolean) => invoke<string | null>('export_meeting', { meetingId, captions }),
  /** Asks where to save a zip with every meeting; null when the user gave up, no file when no meeting has text. */
  exportAll: () => invoke<{ file: string | null; meetings: number } | null>('export_all'),
  settings: () => invoke<Settings>('settings'),
  /** `allowLive` confirms moving the model during a meeting, which leaves it without transcription for a few seconds. */
  setSettings: (settings: Settings, allowLive = false) => invoke<void>('set_settings', { settings, allowLive }),
  models: () => invoke<ModelInfo[]>('model_list'),
  /** Looks for the graphics card and the memory; takes a moment. */
  hardware: () => invoke<HardwareReport>('hardware'),
  /** Loads the model again, to give the GPU another chance after it failed. */
  restartEngine: () => invoke<void>('restart_engine'),
  /** Opens, in the file explorer, the folder the developer mode keeps its meetings in; resolves to its path. */
  openRecordings: () => invoke<string>('open_recordings'),
  /** The card's usage is measured between one call and the next. */
  resources: () => invoke<Resources>('resources'),
  onStatus: (fn: (s: Status) => void): Promise<UnlistenFn> => listen<Status>('status', (e) => fn(e.payload)),
  onEngine: (fn: (e: EngineEvent) => void): Promise<UnlistenFn> => listen<EngineEvent>('engine', (e) => fn(e.payload)),
};
