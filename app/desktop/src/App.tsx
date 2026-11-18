import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { api, type Caption, type Device, type Meeting, type ModelInfo, type Resources, type Segment, type Settings, type Speed, type Status } from './api';
import logo from './assets/logo.svg';
import { comma, MODEL_TEXT, modelLabel, shortName, shownName, size } from './format';
import { Setup } from './Setup';

function duration(ms: number): string {
  const s = ms / 1000;
  if (s < 60) return `${comma(s, s < 1 ? 2 : 1)} s`;
  return `${Math.floor(s / 60)} min ${Math.round(s % 60)} s`;
}

/** "5,0 s de áudio em 0,33 s (15× mais rápido que a fala)". */
function speedText(speed: Speed): string {
  const text = `${duration(speed.audio_ms)} de áudio em ${duration(speed.took_ms)}`;
  if (speed.audio_ms === 0 || speed.took_ms === 0) return text;
  const times = speed.audio_ms / speed.took_ms;
  return times >= 1 ? `${text} (${comma(times, times < 10 ? 1 : 0)}× mais rápido que a fala)` : `${text} (mais lento que a fala)`;
}

function stageText(status: Status): string {
  switch (status.stage) {
    case 'starting':
      return 'Iniciando…';
    case 'downloading_model': {
      if (!status.download) return 'Baixando o modelo de fala…';
      const [done, total] = status.download;
      return `Baixando o modelo de fala: ${Math.floor((100 * done) / total)}% de ${size(total)}`;
    }
    case 'loading_model':
      return 'Carregando o modelo de fala…';
    case 'ready':
      if (status.mode === 'captions') return 'Pronto: guardando as legendas das reuniões';
      // The model stays on disk until a meeting page opens.
      return status.device ? 'Pronto para transcrever' : 'Pronto: o modelo carrega ao abrir uma reunião';
    case 'error':
      return status.error ?? 'Erro';
  }
}

/** What to tell the user when the GPU they chose let them down. */
interface GpuIssue {
  /** The error as the engine gave it. */
  detail: string;
  /** For the sidebar. */
  short: string;
  /** For the strip over the meeting. */
  notice: string;
  title: string;
  body: string;
}

/**
 * Nothing when the GPU works, was not chosen, or the model only runs on the
 * CPU anyway. Otherwise one of: the model did not load, or speech went
 * untranscribed (both only with the CPU fallback turned off), or the model
 * runs on the CPU instead.
 */
function findGpuIssue(status: Status, cpuOnlyModel: boolean): GpuIssue | null {
  const detail = status.gpu_error;
  if (!detail) return null;
  const noFallback = 'porque o uso do processador como reserva está desligado';
  if (status.stage === 'error') {
    return {
      detail,
      short: 'A placa de vídeo não pôde ser usada',
      notice: 'A placa de vídeo não pôde ser usada e nada está sendo transcrito.',
      title: 'Não foi possível usar a placa de vídeo',
      body: `O modelo não foi carregado e nada está sendo transcrito, ${noFallback}.`,
    };
  }
  if (status.stage !== 'ready') return null;
  if (status.device === 'gpu') {
    return {
      detail,
      short: 'A placa de vídeo falhou: há falas não transcritas',
      notice: 'A placa de vídeo falhou e pelo menos uma fala não foi transcrita.',
      title: 'A placa de vídeo falhou durante o uso',
      body: `Pelo menos uma fala não foi transcrita, ${noFallback}. As próximas falas continuam indo para a placa de vídeo.`,
    };
  }
  if (cpuOnlyModel) return null;
  if (status.gpu_failed_in_use) {
    return {
      detail,
      short: 'A placa de vídeo parou de funcionar',
      notice: 'A placa de vídeo parou de funcionar. A transcrição continua no processador, sem perder falas.',
      title: 'A placa de vídeo parou de funcionar durante o uso',
      body: 'O modelo passou para o processador e a transcrição continuou, sem perder falas.',
    };
  }
  return {
    detail,
    short: 'A placa de vídeo não pôde ser usada',
    notice: 'A placa de vídeo não pôde ser usada. A transcrição está rodando no processador.',
    title: 'Não foi possível usar a placa de vídeo',
    body: 'O modelo está rodando no processador. A transcrição funciona do mesmo jeito, só ocupa mais o processador durante as reuniões.',
  };
}

function clock(ms: number, startMs: number): string {
  const s = Math.max(0, Math.floor((ms - startMs) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Where the meeting took place, as the user knows it. */
function platformName(m: Meeting): string {
  return m.platform === 'teams' ? 'Teams' : 'Meet';
}

function meetingName(m: Meeting): string {
  // Meet's tab is called "Meet: <name>". A Teams title comes already cut, and may well begin with "Meeting".
  const title = (m.platform === 'teams' ? m.title : m.title.replace(/^Meet:?\s*/, '')).trim();
  return title && title !== m.code ? title : m.code || 'Reunião';
}

function minutes(m: Meeting): number | null {
  return m.ended_ms ? Math.max(1, Math.round((m.ended_ms - m.started_ms) / 60000)) : null;
}

function meetingWhen(m: Meeting): string {
  const day = new Date(m.started_ms).toLocaleString('pt-BR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
  const min = minutes(m);
  return min ? `${day} · ${min} min` : day;
}

/** Whole days between a moment and today, by the calendar. */
function daysAgo(ms: number): number {
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  return Math.round((day(new Date()) - day(new Date(ms))) / 86400000);
}

function dayGroup(ms: number): string {
  const ago = daysAgo(ms);
  if (ago <= 0) return 'Hoje';
  if (ago === 1) return 'Ontem';
  if (ago < 7) return 'Esta semana';
  const month = new Date(ms).toLocaleString('pt-BR', { month: 'long', year: 'numeric' });
  return month.charAt(0).toUpperCase() + month.slice(1);
}

/** The line under a meeting in the list; its group already says the day for today and yesterday. */
function listMeta(m: Meeting, live: boolean): string {
  const d = new Date(m.started_ms);
  const when =
    daysAgo(m.started_ms) <= 1
      ? d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
      : d.toLocaleDateString('pt-BR', { day: 'numeric', month: 'short' });
  const min = minutes(m);
  return live ? `${when} · em andamento` : min ? `${when} · ${min} min` : when;
}

/** Meetings, already newest first, split under day headings. */
function groupByDay(meetings: Meeting[]): { label: string; items: Meeting[] }[] {
  const groups: { label: string; items: Meeting[] }[] = [];
  for (const m of meetings) {
    const label = dayGroup(m.started_ms);
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.items.push(m);
    else groups.push({ label, items: [m] });
  }
  return groups;
}

/** Leaf-and-tree shapes. With the colors below, a person's icon is one of SHAPES × COLORS. */
const SHAPES: ReactNode[] = [
  <>
    <circle cx="12" cy="9.5" r="6.5" />
    <rect x="11" y="14" width="2" height="7" rx="1" />
  </>,
  <path d="M12 2.5c5 4.5 6 11 0 19-6-8-5-14.5 0-19z" />,
  <>
    <path d="M12 2.5l7 11H5z" />
    <path d="M12 12l5 9H7z" />
  </>,
  <>
    <circle cx="8" cy="10" r="4.5" />
    <circle cx="16" cy="10" r="4.5" />
    <circle cx="12" cy="6" r="4.5" />
  </>,
  <ellipse cx="12" cy="11" rx="5" ry="8.5" />,
  <path d="M12 2.5L21 12 12 21.5 3 12z" />,
  <>
    <circle cx="12" cy="8" r="5" />
    <circle cx="7" cy="14" r="4" />
    <circle cx="17" cy="14" r="4" />
  </>,
  <path d="M12 2.5l9 16H3z" />,
  <>
    <path d="M12 2.5l6 7h-3l4 6H5l4-6H6z" />
    <rect x="11" y="15" width="2" height="6" rx="1" />
  </>,
  <>
    <rect x="11.2" y="2.5" width="1.6" height="3.5" rx="0.8" />
    <path d="M5 10c0-3 3-5 7-5s7 2 7 5z" opacity="0.7" />
    <path d="M6 11h12c0 5-3 9-6 9s-6-4-6-9z" />
  </>,
  <>
    <rect x="11" y="11" width="2" height="10" rx="1" />
    <path d="M12 12C12 7 8 5 4 5c0 5 3 7 8 7z" />
    <path d="M12 10c0-4 3-6 8-6 0 5-3 7-8 6z" opacity="0.7" />
  </>,
  <>
    <circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" strokeWidth="2" />
    <circle cx="12" cy="12" r="4" />
  </>,
];

const COLORS = 12;

/** A stable hash of the full name, without case or accents. */
function hashName(name: string): number {
  let h = 2166136261;
  for (const ch of name.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim()) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  h ^= h >>> 15;
  h = Math.imul(h, 2246822519);
  h ^= h >>> 13;
  return h >>> 0;
}

/** The icon of a person: the same name always gets the same shape and color. */
function voice(name: string): { shape: number; color: number } {
  const h = hashName(name);
  return { shape: h % SHAPES.length, color: Math.floor(h / SHAPES.length) % COLORS };
}

function Mark(props: { shape: number }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="currentColor">
      {SHAPES[props.shape % SHAPES.length]}
    </svg>
  );
}

function Avatar(props: { name: string }) {
  const v = voice(props.name);
  return (
    <span className="avatar" style={{ '--speaker': `var(--s${v.color})` } as CSSProperties} aria-hidden="true">
      <Mark shape={v.shape} />
    </span>
  );
}

function fmtClock(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const p = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${p(m)}:${p(s % 60)}` : `${p(m)}:${p(s % 60)}`;
}

/** The people of a live meeting around a circle with the clock in the middle; the one speaking gets a halo. */
function Council(props: { people: { key: string; name: string }[]; speaking: string | null; clock: string; speakerName: string | null }) {
  const { people } = props;
  const n = people.length;
  const cx = 180;
  const cy = 124;
  const radius = 88;
  const nodeR = n > 10 ? 16 : 22;
  const scale = nodeR / 22;
  return (
    <svg className="council" viewBox="0 0 360 272" role="img" aria-label={`Assembleia da reunião: ${n} ${n === 1 ? 'voz' : 'vozes'}${props.speakerName ? `, ${props.speakerName} falando` : ''}`}>
      {[44, 33, 22].map((r) => (
        <circle key={r} cx={cx} cy={cy} r={r} fill="none" stroke="var(--line)" strokeWidth="1" />
      ))}
      {people.map((p, i) => {
        const angle = -Math.PI / 2 + (i * 2 * Math.PI) / n;
        const x = n === 1 ? cx : cx + radius * Math.cos(angle);
        const y = n === 1 ? cy - radius : cy + radius * Math.sin(angle);
        const v = voice(p.name);
        const on = props.speaking === p.key;
        const color = `var(--s${v.color})`;
        return (
          <g key={p.key} className={`node${on ? ' is-on' : ''}`} transform={`translate(${x.toFixed(1)} ${y.toFixed(1)})`}>
            <line className="spoke" x1={cx - x} y1={cy - y} x2="0" y2="0" />
            {on && <circle className="halo" r={nodeR + 8} fill={color} />}
            <circle className="node-bg" r={nodeR} stroke={color} />
            <g transform={`translate(${-12 * 0.9 * scale} ${-12 * 0.9 * scale}) scale(${0.9 * scale})`} style={{ color }} fill="currentColor">
              {SHAPES[v.shape]}
            </g>
            <text className="node-name" y={nodeR + 19}>{shortName(p.name).split(' ')[0]}</text>
          </g>
        );
      })}
      <text className="clk-l" x={cx} y={cy - 14}>ao vivo</text>
      <text className="clk" x={cx} y={cy + 7}>{props.clock}</text>
    </svg>
  );
}

/** Consecutive lines by the same speaker, shown as one block. */
interface Turn {
  key: string;
  speaker: string;
  speakerKey: string;
  startMs: number;
  lines: { id: string; text: string }[];
}

function toTurns(lines: { id: string; speaker: string; speakerKey: string; startMs: number; text: string }[]): Turn[] {
  const turns: Turn[] = [];
  for (const l of lines) {
    const last = turns[turns.length - 1];
    if (last && last.speakerKey === l.speakerKey) last.lines.push({ id: l.id, text: l.text });
    else turns.push({ key: l.id, speaker: l.speaker, speakerKey: l.speakerKey, startMs: l.startMs, lines: [{ id: l.id, text: l.text }] });
  }
  return turns;
}

// The row of overlapping avatars on the home card: as many as the card's width holds, then "+N".
function VoiceMarks(props: { voices: string[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  // Matches .marks in styles.css: 28px avatars overlapping by 8px, and room for the "+N".
  const FIRST = 28, STEP = 20, MORE = 34, MAX = 7;
  const total = props.voices.length;
  const fits = (n: number) => FIRST + STEP * (n - 1) + (n < total ? MORE : 0) <= width;
  let shown = Math.min(total, MAX);
  while (shown > 1 && !fits(shown)) shown--;
  return (
    <div className="marks" ref={ref}>
      {props.voices.slice(0, shown).map((name) => (
        <Avatar key={name} name={name} />
      ))}
      {total > shown && <span className="more">+{total - shown}</span>}
    </div>
  );
}

function Icon(props: { d: string; size?: number; children?: ReactNode }) {
  const s = props.size ?? 18;
  return (
    <svg aria-hidden="true" width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d={props.d} />
      {props.children}
    </svg>
  );
}

const ICON = {
  search: 'M20 20l-3.5-3.5',
  sliders: 'M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  menu: 'M4 7h16M4 12h16M4 17h16',
  download: 'M12 4v11M7 10.5l5 5 5-5M5 20h14',
  trash: 'M4 7h16M10 11v6M14 11v6M6 7l1 12a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-12M9 7V4h6v3',
  chevron: 'M9 6l6 6-6 6',
  panel: 'M9 4v16',
  home: 'M4 11l8-7 8 7v8a1 1 0 0 1-1 1h-4v-6h-6v6H5a1 1 0 0 1-1-1z',
  info: 'M12 11v6M12 7.5v.01',
  warning: 'M12 4.5l9 15H3zM12 10.5v4M12 17v.01',
};

function Logo(props: { className: string; alt?: string }) {
  return <img className={props.className} src={logo} alt={props.alt ?? ''} />;
}

/** Light, dark, or whatever Windows is using. Kept in this window's storage, like the folded sidebar. */
type Theme = 'system' | 'light' | 'dark';
const systemDark = window.matchMedia('(prefers-color-scheme: dark)');

function stored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function store(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // The choice then lasts only until the app closes.
  }
}

function storedTheme(): Theme {
  const t = stored('theme');
  return t === 'light' || t === 'dark' ? t : 'system';
}

function isDark(theme: Theme, system: boolean): boolean {
  return theme === 'system' ? system : theme === 'dark';
}

// Before the first paint, so the window never flashes the other theme.
document.documentElement.dataset.theme = isDark(storedTheme(), systemDark.matches) ? 'dark' : 'light';

function Bars(props: { count: number; label?: string }) {
  return (
    <span className="eq" role={props.label ? 'img' : undefined} aria-label={props.label} aria-hidden={props.label ? undefined : true}>
      {Array.from({ length: props.count }, (_, i) => (
        <i key={i} />
      ))}
    </span>
  );
}

/** The text in lowercase and without accents, with where in the text each character came from. */
function fold(text: string): { folded: string; at: number[] } {
  let folded = '';
  const at: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const plain = text[i].normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
    for (let j = 0; j < plain.length; j++) {
      folded += plain[j];
      at.push(i);
    }
  }
  return { folded, at };
}

const WORD_CHAR = /[\p{L}\p{N}]/u;

/** What was typed in a search, as the words to look for. */
function searchWords(query: string): string[] {
  return fold(query)
    .folded.split(/\s+/)
    .map((w) => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ''))
    .filter(Boolean);
}

/**
 * Where the searched words are in the text, in order. As in the search over
 * every meeting, each one must begin a word of the text ("requis" finds
 * "requisição"), whatever the case or accents; null unless all of them do.
 */
function findWords(text: string, words: string[]): [number, number][] | null {
  if (words.length === 0) return null;
  const { folded, at } = fold(text);
  const ranges: [number, number][] = [];
  for (const w of words) {
    let found = false;
    for (let i = folded.indexOf(w); i !== -1; i = folded.indexOf(w, i + 1)) {
      if (i > 0 && WORD_CHAR.test(folded[i - 1])) continue;
      found = true;
      ranges.push([at[i], at[i + w.length - 1] + 1]);
    }
    if (!found) return null;
  }
  return ranges.sort((a, b) => a[0] - b[0]);
}

/** The text with the searched words marked. */
function Highlight(props: { text: string; words: string[] }) {
  const ranges = findWords(props.text, props.words);
  if (!ranges) return <>{props.text}</>;
  const parts: ReactNode[] = [];
  let pos = 0;
  ranges.forEach(([start, end], i) => {
    if (end <= pos) return;
    const from = Math.max(start, pos);
    parts.push(props.text.slice(pos, from), <mark key={i}>{props.text.slice(from, end)}</mark>);
    pos = end;
  });
  parts.push(props.text.slice(pos));
  return <>{parts}</>;
}

function Toggle(props: { label: string; hint: string; checked: boolean; disabled?: boolean; onChange: (checked: boolean) => void }) {
  return (
    <label className={`setting is-switch${props.disabled ? ' is-disabled' : ''}`}>
      <span className="setting-text">
        <span className="setting-label">{props.label}</span>
        <span className="setting-hint">{props.hint}</span>
      </span>
      <input className="switch" type="checkbox" role="switch" checked={props.checked} disabled={props.disabled} onChange={(e) => props.onChange(e.target.checked)} />
    </label>
  );
}

function Choice(props: {
  group: string;
  label: string;
  hint: string;
  checked: boolean;
  disabled: boolean;
  onChoose: () => void;
  /** Goes right after the label. */
  info?: ReactNode;
  aside?: ReactNode;
}) {
  return (
    <label className={`setting${props.disabled ? ' is-disabled' : ''}`}>
      <input type="radio" name={props.group} checked={props.checked} disabled={props.disabled} onChange={props.onChoose} />
      <span className="setting-text">
        <span className="setting-label">
          {props.label}
          {props.info}
        </span>
        <span className="setting-hint">{props.hint}</span>
      </span>
      {props.aside && <span className="setting-aside">{props.aside}</span>}
    </label>
  );
}

/** Concentric rings, one per step of `of`, filled up to `value`: a tree's growth rings. */
function Rings(props: { value: number; of?: number; size?: number }) {
  const n = props.of ?? 6;
  const filled = Math.round(Math.min(1, Math.max(0, props.value)) * n);
  return (
    <svg className="rings" width={props.size ?? 40} height={props.size ?? 40} viewBox="0 0 40 40" aria-hidden="true">
      {Array.from({ length: n }, (_, i) => (
        <circle key={i} cx="20" cy="20" r={17 - i * (16 / n)} fill="none" stroke={i < filled ? 'var(--accent)' : 'var(--line-strong)'} strokeWidth={i < filled ? 1.6 : 1} />
      ))}
      <circle cx="20" cy="20" r="2" fill="var(--amber)" />
    </svg>
  );
}

function greeting(): string {
  const h = new Date().getHours();
  return h < 5 ? 'Boa madrugada' : h < 12 ? 'Bom dia' : h < 18 ? 'Boa tarde' : 'Boa noite';
}

/** The start screen: what is going on now, a few numbers, and the latest meetings. */
function Home(props: { meetings: Meeting[]; liveId: number | null; header: ReactNode; onOpen: (id: number) => void }) {
  const { meetings, liveId } = props;
  const stats = useMemo(() => {
    const now = new Date();
    const inMonth = (ms: number, offset: number) => {
      const d = new Date(ms);
      const ref = new Date(now.getFullYear(), now.getMonth() - offset, 1);
      return d.getFullYear() === ref.getFullYear() && d.getMonth() === ref.getMonth();
    };
    const thisMonth = meetings.filter((m) => inMonth(m.started_ms, 0)).length;
    const lastMonth = meetings.filter((m) => inMonth(m.started_ms, 1)).length;
    const done = meetings.filter((m) => m.ended_ms !== null);
    const totalMs = done.reduce((sum, m) => sum + (m.ended_ms! - m.started_ms), 0);
    const avgMin = done.length > 0 ? Math.round(totalMs / done.length / 60000) : 0;
    return { thisMonth, lastMonth, hours: totalMs / 3600000, avgMin, count: meetings.length };
  }, [meetings]);

  // Distinct people across every saved meeting, by full name (without case or accents).
  const [voices, setVoices] = useState<string[] | null>(null);
  const meetingIds = meetings.map((m) => m.id).join(',');
  useEffect(() => {
    let stale = false;
    Promise.all(meetings.map((m) => api.transcript(m.id).catch(() => [] as Segment[]))).then((all) => {
      if (stale) return;
      const byName = new Map<string, string>();
      for (const segs of all) {
        for (const s of segs) {
          const key = s.speaker.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
          if (key && !byName.has(key)) byName.set(key, s.speaker.trim());
        }
      }
      setVoices([...byName.values()]);
    });
    return () => {
      stale = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meetingIds]);

  const live = meetings.find((m) => m.id === liveId) ?? null;
  const recent = meetings.slice(0, 5);
  const month = new Date().toLocaleString('pt-BR', { month: 'long' });
  const diff = stats.thisMonth - stats.lastMonth;
  const compare =
    diff === 0
      ? 'Igual ao mês passado'
      : diff > 0
        ? `${diff} a mais que no mês passado`
        : `${-diff} a menos que no mês passado`;
  const date = new Date().toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' });

  return (
    <>
      <div className="topbar">{props.header}</div>
      <div className="scroll">
        <div className="home">
          <div className="home-head">
            <h1>{greeting()}</h1>
            <p>{date.charAt(0).toUpperCase() + date.slice(1)}</p>
          </div>
          <div className="bento">
            <section className="card hero">
              <svg className="hero-deco" viewBox="0 0 280 280" aria-hidden="true">
                {Array.from({ length: 9 }, (_, i) => (
                  <circle key={i} cx="140" cy="140" r={20 + i * 15} fill="none" stroke="var(--line)" strokeWidth="1" />
                ))}
                <circle cx="140" cy="140" r="95" fill="none" stroke="var(--accent)" strokeWidth="1.4" opacity="0.5" />
              </svg>
              {live ? (
                <>
                  <span className="eyebrow is-live">
                    <i className="pulse" />
                    Ao vivo agora
                  </span>
                  <h2>{meetingName(live)}</h2>
                  <p>Desde {new Date(live.started_ms).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })} · {live.segments} {live.segments === 1 ? 'fala transcrita' : 'falas transcritas'}</p>
                  <div className="hero-foot">
                    <button className="button is-primary" onClick={() => props.onOpen(live.id)}>
                      Abrir a reunião
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <span className="eyebrow">Nada em andamento</span>
                  <h2>Os Ents não têm pressa.</h2>
                  <p>Quando uma reunião começar, ela aparece aqui e começa a ser transcrita.</p>
                  <div className="hero-foot">
                    <button className="button" onClick={() => props.onOpen(recent[0].id)}>
                      Abrir a última reunião
                    </button>
                  </div>
                </>
              )}
            </section>
            <div className="card stat">
              <span className="k">Reuniões em {month}</span>
              <span className="v">{stats.thisMonth}</span>
              <span className="s">{compare}</span>
            </div>
            <div className="card stat">
              <span className="k">Horas transcritas</span>
              <span className="v">{comma(stats.hours, 1)} h</span>
              <span className="s">{stats.count} {stats.count === 1 ? 'reunião salva' : 'reuniões salvas'}</span>
              <Rings value={stats.hours / 40} />
            </div>
            <div className="card stat">
              <span className="k">Vozes distintas</span>
              <span className="v">{voices === null ? '…' : voices.length}</span>
              {voices !== null && voices.length > 0 && <VoiceMarks voices={voices} />}
            </div>
            <div className="card stat">
              <span className="k">Duração média</span>
              <span className="v">{stats.avgMin} min</span>
              <span className="s">Um anel a cada 10 min</span>
              <Rings value={stats.avgMin / 60} />
            </div>
          </div>
          <section className="card recent">
            <div className="recent-h">
              <h3>Recentes</h3>
            </div>
            {recent.map((m) => {
              const isLive = m.id === liveId;
              return (
                <button key={m.id} className="row" onClick={() => props.onOpen(m.id)}>
                  <Avatar name={meetingName(m)} />
                  <span className="grow">
                    <span className="t">{meetingName(m)}</span>
                    <span className="m">
                      {dayGroup(m.started_ms)}, {listMeta(m, isLive)} · {m.segments} {m.segments === 1 ? 'fala' : 'falas'}
                    </span>
                  </span>
                  <Icon d={ICON.chevron} size={16} />
                </button>
              );
            })}
          </section>
        </div>
      </div>
    </>
  );
}

/** What can be changed during a meeting: the model, the device, or both. */
type EngineChange = Partial<Pick<Settings, 'model' | 'device'>>;

export function App() {
  const [status, setStatus] = useState<Status>({
    stage: 'starting',
    error: null,
    extension_connected: false,
    live_meeting: null,
    model: '',
    mode: 'local',
    device: null,
    gpu_error: null,
    gpu_failed_in_use: false,
    speed_trial: null,
    speed_last: null,
    speed_total: { audio_ms: 0, took_ms: 0 },
    download: null,
    switching: false,
    switch_error: null,
  });
  const [resources, setResources] = useState<Resources | null>(null);
  // The GPU error whose notice over the meeting was closed.
  const [gpuNoticeClosed, setGpuNoticeClosed] = useState<string | null>(null);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  // The start screen shows until a meeting is opened.
  const [home, setHome] = useState(true);
  const [segments, setSegments] = useState<Segment[]>([]);
  const [captions, setCaptions] = useState<Caption[]>([]);
  // Captions of the meeting going on, as they come; stored only when it ends.
  const [liveCaptions, setLiveCaptions] = useState<(Caption & { key: string })[]>([]);
  const [source, setSource] = useState<'parakeet' | 'captions'>('parakeet');
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<Segment[] | null>(null);
  // Within the open meeting: what is being searched, and whose speech is hidden (by speaker key).
  const [find, setFind] = useState('');
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  // The summary card above the transcript can be folded away to give the text more room.
  const [bandFolded, setBandFolded] = useState(() => stored('band') === 'folded');
  const toggleBand = () =>
    setBandFolded((prev) => {
      store('band', prev ? 'open' : 'folded');
      return !prev;
    });
  const [error, setError] = useState<string | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  // In a narrow window the sidebar is a drawer.
  const [menuOpen, setMenuOpen] = useState(false);
  // The model or device the user picked during a meeting, waiting for their go-ahead.
  const [pendingChange, setPendingChange] = useState<EngineChange | null>(null);
  // A deletion waiting for the user to confirm it in the dialog.
  const [pendingDelete, setPendingDelete] = useState<{ title: string; body: string; action: string; run: () => void } | null>(null);
  // The dialog that offers the developer mode, opened by F12.
  const [askDev, setAskDev] = useState(false);
  // The settings were opened to show the developer section: scroll to it once it is on screen.
  const [openAtDev, setOpenAtDev] = useState(false);
  // Where the developer mode keeps its meetings, once the user asked to see the folder.
  const [recordingsAt, setRecordingsAt] = useState<string | null>(null);
  // In a wide one it can be folded away.
  const [collapsed, setCollapsed] = useState(() => stored('sidebar') === 'collapsed');
  const [theme, setTheme] = useState<Theme>(storedTheme);
  const [windowsDark, setWindowsDark] = useState(systemDark.matches);
  const dark = isDark(theme, windowsDark);

  useEffect(() => {
    const onChange = () => setWindowsDark(systemDark.matches);
    systemDark.addEventListener('change', onChange);
    return () => systemDark.removeEventListener('change', onChange);
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  }, [dark]);

  const chooseTheme = (t: Theme) => {
    setTheme(t);
    store('theme', t);
  };

  const showSidebar = (show: boolean) => {
    setMenuOpen(show);
    setCollapsed(!show);
    store('sidebar', show ? 'open' : 'collapsed');
  };

  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const scroller = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);

  const fail = useCallback((e: unknown) => setError(String(e)), []);
  const reloadMeetings = useCallback(() => api.meetings().then(setMeetings, fail), [fail]);

  useEffect(() => {
    api.status().then(setStatus, fail);
    api.settings().then(setSettings, fail);
    reloadMeetings();
    const offStatus = api.onStatus(setStatus);
    const offEngine = api.onEngine((e) => {
      if (e.type === 'segment') {
        if (e.meeting_id === selectedRef.current) setSegments((prev) => [...prev, e]);
        setMeetings((prev) => prev.map((m) => (m.id === e.meeting_id ? { ...m, segments: m.segments + 1 } : m)));
      } else if (e.type === 'echo') {
        setSegments((prev) => prev.filter((s) => s.id !== e.segment_id));
      } else if (e.type === 'caption') {
        // A line is revised in place, many times, as the person speaks.
        setLiveCaptions((prev) => {
          for (let i = prev.length - 1; i >= 0 && i >= prev.length - 20; i--) {
            if (prev[i].key === e.key) return prev.map((c, j) => (j === i ? e : c));
          }
          return [...prev, e];
        });
      } else if (e.type === 'extension_connected') {
        setLiveCaptions([]); // a new connection starts its captions over
      } else if (e.type === 'meeting_started') {
        reloadMeetings();
        setQuery('');
        setSelected(e.meeting_id); // follow the meeting as it happens
        setHome(false);
      } else if (e.type === 'meeting_updated') {
        // A title, or names for speech already on screen.
        reloadMeetings();
        if (e.meeting_id === selectedRef.current) api.transcript(e.meeting_id).then(setSegments, fail);
      } else if (e.type === 'meeting_saved') {
        reloadMeetings();
        if (e.meeting_id === selectedRef.current) api.captions(e.meeting_id).then(setCaptions, fail);
      } else if (e.type === 'switch_failed') {
        api.settings().then(setSettings, fail); // the choice went back to where the model is
      } else if (e.type === 'meeting_discarded') {
        reloadMeetings().then(() => {
          if (e.meeting_id === selectedRef.current) setSelected(null); // opens the newest one left
        });
      }
    });
    return () => {
      offStatus.then((off) => off());
      offEngine.then((off) => off());
    };
  }, [fail, reloadMeetings]);

  // Which models are on disk changes when a download ends.
  useEffect(() => {
    api.models().then(setModels, fail);
  }, [status.stage, fail]);

  // Open the newest meeting when nothing is selected yet.
  useEffect(() => {
    if (selected === null && meetings.length > 0) setSelected(meetings[0].id);
  }, [meetings, selected]);

  useEffect(() => {
    setFind('');
    setHidden(new Set());
    if (selected === null) return;
    let stale = false;
    stickToBottom.current = true;
    Promise.all([api.transcript(selected), api.captions(selected)]).then(([t, c]) => {
      if (stale) return;
      setSegments(t);
      setCaptions(c);
    }, fail);
    return () => {
      stale = true;
    };
  }, [selected, fail]);

  useEffect(() => {
    const q = query.trim();
    if (!q) return setHits(null);
    const timer = setTimeout(() => api.search(q).then(setHits, fail), 200);
    return () => clearTimeout(timer);
  }, [query, fail]);

  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [menuOpen]);

  useEffect(() => {
    if (!showSettings || pendingChange || pendingDelete || askDev) return; // with a confirmation open, Escape closes only that
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setShowSettings(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [showSettings, pendingChange, pendingDelete, askDev]);

  useEffect(() => {
    if (!pendingDelete) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPendingDelete(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pendingDelete]);

  // F12 is the way into the developer mode: it offers to turn it on, and once it is on it takes to its settings.
  useEffect(() => {
    if (!settings) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'F12') return;
      e.preventDefault();
      if (!settings.dev.enabled) setAskDev(true);
      else {
        setMenuOpen(false);
        setShowSettings(true);
        setOpenAtDev(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [settings]);

  useEffect(() => {
    if (!showSettings || !openAtDev) return;
    document.getElementById('dev-section')?.scrollIntoView({ block: 'start' });
    setOpenAtDev(false);
  }, [showSettings, openAtDev, settings?.dev.enabled]);

  useEffect(() => {
    if (!askDev) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setAskDev(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [askDev]);

  useEffect(() => {
    if (!pendingChange) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPendingChange(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pendingChange]);

  const meeting = meetings.find((m) => m.id === selected) ?? null;

  // Esc leaves the meeting (or the search results) for the start screen. Dialogs and the drawer take it first.
  useEffect(() => {
    if (showSettings || pendingChange || pendingDelete || askDev || menuOpen) return;
    if (home && !hits) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const el = document.activeElement;
      if ((el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) && el.value !== '') return; // Esc in a filled field is for that field
      if (hits) setQuery('');
      else setHome(true);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [showSettings, pendingChange, pendingDelete, askDev, menuOpen, home, hits]);

  const remove = (m: Meeting) =>
    setPendingDelete({
      title: `Excluir a reunião “${meetingName(m)}”?`,
      body: 'A reunião e a transcrição dela são removidas deste computador. Não dá para desfazer.',
      action: 'Excluir reunião',
      run: () => api.deleteMeeting(m.id).then(forget, fail),
    });

  // After the list is fresh, so the meeting opened next is one that still exists.
  const forget = () =>
    reloadMeetings().then(() => {
      setSelected(null);
      setHome(true);
      setSegments([]);
      setCaptions([]);
    });

  const removable = meetings.filter((m) => m.id !== status.live_meeting).length;

  const removeAll = () => {
    const one = removable === 1;
    setPendingDelete({
      title: one ? 'Apagar a reunião salva?' : `Apagar as ${removable} reuniões salvas?`,
      body: `${one ? 'A reunião e a transcrição dela são removidas' : 'As reuniões e as transcrições delas são removidas'} deste computador. Não dá para desfazer.${busy ? ' A reunião em andamento fica.' : ''}`,
      action: 'Apagar tudo',
      run: () =>
        api.deleteAllMeetings().then((gone) => {
          setExported(`${gone} ${gone === 1 ? 'reunião apagada' : 'reuniões apagadas'}.`);
          return forget();
        }, fail),
    });
  };

  const confirmDelete = () => {
    pendingDelete?.run();
    setPendingDelete(null);
  };

  // Set while a save dialog is open; the note says how "export all" or "delete all" went.
  const [exporting, setExporting] = useState(false);
  const [exported, setExported] = useState<string | null>(null);

  const exportMeeting = (m: Meeting) => {
    setExporting(true);
    api
      .exportMeeting(m.id, source === 'captions')
      .catch(fail)
      .finally(() => setExporting(false));
  };

  const exportAll = () => {
    setExporting(true);
    setExported(null);
    api
      .exportAll()
      .then((done) => {
        if (!done) return;
        setExported(
          done.file === null
            ? 'Nenhuma reunião tem texto para exportar.'
            : `${done.meetings} ${done.meetings === 1 ? 'reunião exportada' : 'reuniões exportadas'} para ${done.file}`,
        );
      }, fail)
      .finally(() => setExporting(false));
  };

  const live = meeting !== null && meeting.id === status.live_meeting;
  // The clock in the middle of the council runs while the meeting does.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!live) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [live]);
  // The engine restarts to change model or device, which would cut a meeting.
  const busy = status.live_meeting !== null;
  const chosenModel = models.find((m) => m.name === settings?.model);
  const gpuIssue = findGpuIssue(status, models.find((m) => m.name === status.model)?.gpu === false);
  const ready = status.stage === 'ready';
  const onGpu = ready && status.device === 'gpu';
  const gpuStats = onGpu ? resources?.gpu ?? null : null;

  // Speed of the meeting going on: the totals minus what was already there when it began.
  const meetingBase = useRef<{ id: number | null; base: Speed }>({ id: null, base: { audio_ms: 0, took_ms: 0 } });
  if (meetingBase.current.id !== status.live_meeting) {
    meetingBase.current = { id: status.live_meeting, base: status.speed_total };
  } else if (status.speed_total.audio_ms < meetingBase.current.base.audio_ms) {
    meetingBase.current.base = { audio_ms: 0, took_ms: 0 }; // the counters restarted (device switch)
  }
  const rtfx = (() => {
    if (!ready || status.live_meeting === null) return null;
    const audio = status.speed_total.audio_ms - meetingBase.current.base.audio_ms;
    const took = status.speed_total.took_ms - meetingBase.current.base.took_ms;
    if (audio <= 0 || took <= 0 || !status.speed_last || status.speed_last.took_ms === 0) return null;
    const fmt = (x: number) => `${comma(x, x < 10 ? 1 : 0)}×`;
    return { average: fmt(audio / took), instant: fmt(status.speed_last.audio_ms / status.speed_last.took_ms) };
  })();

  // Memory and the card's numbers, read while the settings show them.
  useEffect(() => {
    if (!showSettings || !ready) return;
    let stale = false;
    const read = () =>
      api.resources().then(
        (r) => stale || setResources(r),
        () => {}, // the rest of the screen does not depend on these
      );
    read();
    const timer = setInterval(read, 2000);
    return () => {
      stale = true;
      clearInterval(timer);
      setResources(null);
    };
  }, [showSettings, ready]);

  // Moving the model works during a meeting, at the price of a few seconds
  // without transcription (the captions keep coming), so the user confirms.
  const chooseEngine = (change: EngineChange) => {
    if (!settings || (Object.keys(change) as (keyof EngineChange)[]).every((k) => change[k] === settings[k])) return;
    // A model that only runs on the CPU takes the device along, whatever the
    // CPU fallback says; the dialog tells the user.
    const cpuOnly = change.model !== undefined && models.find((m) => m.name === change.model)?.gpu === false;
    if (cpuOnly && settings.device === 'gpu') change = { ...change, device: 'cpu' };
    if (busy || (cpuOnly && change.device === 'cpu')) setPendingChange(change); // the dialog asks first
    else changeSettings(change);
  };
  const chooseDevice = (device: Device) => chooseEngine({ device });

  const confirmChange = () => {
    if (pendingChange) changeSettings(pendingChange, true);
    setPendingChange(null);
  };

  const openSettings = () => {
    setMenuOpen(false);
    setShowSettings(true);
  };

  const changeDev = (change: Partial<Settings['dev']>) => {
    if (settings) changeSettings({ dev: { ...settings.dev, ...change } });
  };

  const turnOnDev = () => {
    changeDev({ enabled: true });
    setAskDev(false);
    setMenuOpen(false);
    setShowSettings(true);
    setOpenAtDev(true);
  };

  const showRecordings = () => api.openRecordings().then(setRecordingsAt, fail);

  const changeSettings = (change: Partial<Settings>, allowLive = false) => {
    if (!settings) return;
    const next = { ...settings, ...change };
    setSettings(next);
    api.setSettings(next, allowLive).catch((e) => {
      fail(e);
      api.settings().then(setSettings, fail); // show what is really in effect
    });
  };

  // With only the captions kept, there is no transcript to show.
  const captionsOnly = settings?.mode === 'captions';
  useEffect(() => {
    if (captionsOnly) setSource('captions');
  }, [captionsOnly]);

  const groups = useMemo(() => groupByDay(meetings), [meetings]);

  // During the meeting: the captions as they come, after whatever the
  // database already held from before this window was opened.
  const shownCaptions = useMemo(() => {
    if (!live) return captions;
    const since = liveCaptions.length > 0 ? liveCaptions[0].first_ms : Infinity;
    return [...captions.filter((c) => c.first_ms < since), ...liveCaptions];
  }, [live, captions, liveCaptions]);

  const turns = useMemo(() => {
    if (!meeting) return [];
    const lines =
      source === 'parakeet'
        ? segments.map((s) => ({ id: `s${s.id}`, speaker: s.speaker, speakerKey: s.speaker_key, startMs: s.start_ms, text: s.text }))
        : shownCaptions.map((c, i) => ({ id: `c${i}`, speaker: c.speaker ?? 'Participante', speakerKey: c.device_id, startMs: c.first_ms, text: c.text }));
    return toTurns(lines);
  }, [meeting, source, segments, shownCaptions]);

  // Who speaks in the text on screen, by the latest name each one has.
  const people = useMemo(() => {
    const byKey = new Map<string, string>();
    for (const t of turns) byKey.set(t.speakerKey, t.speaker);
    // Alphabetical, with the local user (the engine's key for the microphone) last.
    return [...byKey]
      .map(([key, name]) => ({ key, name }))
      .sort((a, b) => Number(a.key === 'me') - Number(b.key === 'me') || a.name.localeCompare(b.name, 'pt-BR'));
  }, [turns]);

  // The microphone's speech is the user's; in the platform's captions the user is one more device, known by the same name.
  const myName = useMemo(() => segments.find((s) => s.speaker_key === 'me' && s.speaker !== 'Você')?.speaker, [segments]);
  const label = (name: string, key: string) => shownName(name, key === 'me' || (myName !== undefined && name === myName));

  const toggleHidden = (key: string) =>
    setHidden((prev) => {
      const next = new Set(prev);
      if (!next.delete(key)) next.add(key);
      return next;
    });

  const findWordsTyped = useMemo(() => searchWords(find), [find]);
  const hitWords = useMemo(() => searchWords(query), [query]);

  // The turns on screen: without the people hidden and, in a search, only those with a line that matches.
  const { shownTurns, found } = useMemo(() => {
    let shown = turns.filter((t) => !hidden.has(t.speakerKey));
    let found = 0;
    if (findWordsTyped.length > 0) {
      shown = shown.filter((t) => {
        const matches = t.lines.filter((l) => findWords(l.text, findWordsTyped)).length;
        found += matches;
        return matches > 0;
      });
    }
    return { shownTurns: shown, found };
  }, [turns, hidden, findWordsTyped]);
  const finding = findWordsTyped.length > 0;

  useEffect(() => {
    const el = scroller.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [turns]);

  const onScroll = () => {
    const el = scroller.current;
    if (el) stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  const menuButton = (
    <button className="icon-button menu-button" aria-label="Mostrar a barra lateral" title="Mostrar a barra lateral" onClick={() => showSidebar(true)}>
      <Icon d={ICON.menu} size={20} />
    </button>
  );

  const download = status.stage === 'downloading_model' ? status.download : null;
  const hitMeetings = hits ? new Set(hits.map((h) => h.meeting_id)).size : 0;

  // The first run: choices come before anything is downloaded or loaded.
  if (settings === null && !error) return <div className="app-loading" aria-busy="true" data-tauri-drag-region />;
  if (settings && !settings.setup_done) {
    return (
      <Setup
        settings={settings}
        models={models}
        theme={theme}
        windowsDark={windowsDark}
        onTheme={chooseTheme}
        onFinish={(done) =>
          api.setSettings(done).then(() => {
            setSettings(done);
            return api.status().then(setStatus);
          })
        }
      />
    );
  }

  return (
    <div className={`app${collapsed ? ' is-collapsed' : ''}`}>
      {menuOpen && <button className="backdrop" aria-label="Fechar a lista de reuniões" onClick={() => setMenuOpen(false)} />}
      {/* The window has no title bar: it is dragged by the empty parts of the sidebar and by the strip over the content. */}
      <aside className={`sidebar${menuOpen ? ' is-open' : ''}`} data-tauri-drag-region>
        <div className="brand" data-tauri-drag-region>
          <button
            className="brand-home"
            aria-label="Início"
            title="Início"
            onClick={() => {
              setShowSettings(false);
              setMenuOpen(false);
              setQuery('');
              setHome(true);
            }}
          >
            <Logo className="brand-mark" />
            <span className="brand-name">entmoot</span>
          </button>
          <button className="icon-button" aria-label="Recolher a barra lateral" title="Recolher a barra lateral" onClick={() => showSidebar(false)}>
            <Icon d={ICON.panel}>
              <rect x="3" y="4" width="18" height="16" rx="3" />
            </Icon>
          </button>
        </div>
        <form
          className="search"
          role="search"
          onSubmit={(e) => {
            e.preventDefault();
            setMenuOpen(false);
          }}
        >
          <Icon d={ICON.search} size={16}>
            <circle cx="11" cy="11" r="7" />
          </Icon>
          <input
            type="search"
            placeholder="Buscar em todas as reuniões"
            value={query}
            onChange={(e) => {
              setShowSettings(false);
              setQuery(e.target.value);
            }}
            aria-label="Buscar em todas as reuniões"
          />
        </form>
        <button
          className={`settings-link${home && !hits && !showSettings ? ' is-selected' : ''}`}
          onClick={() => {
            setShowSettings(false);
            setMenuOpen(false);
            setQuery('');
            setHome(true);
          }}
        >
          <Icon d={ICON.home} />
          Início
        </button>
        <nav className="meetings" aria-label="Reuniões">
          {meetings.length === 0 && <p className="hint">Nenhuma reunião ainda. Os Ents não têm pressa.</p>}
          {groups.map((g) => (
            <div key={g.label} className="meeting-group">
              <div className="group-label">{g.label}</div>
              {g.items.map((m) => {
                const isLive = m.id === status.live_meeting;
                return (
                  <button
                    key={m.id}
                    className={`meeting${m.id === selected && !hits && !home ? ' is-selected' : ''}`}
                    onClick={() => {
                      setHome(false);
                      setShowSettings(false);
                      setMenuOpen(false);
                      setQuery('');
                      setSelected(m.id);
                    }}
                  >
                    <span className="meeting-name">
                      {isLive && <Bars count={3} label="Ao vivo" />}
                      <span>{meetingName(m)}</span>
                    </span>
                    <span className="meeting-meta">{listMeta(m, isLive)}</span>
                  </button>
                );
              })}
            </div>
          ))}
        </nav>
        <div className="sidebar-foot">
          <footer className={`status is-${status.stage}`}>
            <div className="status-main">
              <span className="dot" />
              {rtfx ? `RTFx médio ${rtfx.average} · agora ${rtfx.instant}` : stageText(status)}
            </div>
            {download && (
              <div
                className="progress"
                role="progressbar"
                aria-label="Download do modelo"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.floor((100 * download[0]) / download[1])}
              >
                <span style={{ width: `${(100 * download[0]) / download[1]}%` }} />
              </div>
            )}
            {status.stage === 'ready' && (
              <>
                {status.device && (
                  <div>
                    {modelLabel(status.model)} · {status.device === 'gpu' ? 'GPU' : 'CPU'}
                  </div>
                )}
                {gpuIssue && (
                  <button className="status-warning" onClick={openSettings}>
                    <Icon d={ICON.warning} size={14} />
                    <span>{gpuIssue.short}</span>
                  </button>
                )}
                {!status.extension_connected && (
                  <div className="status-ext">
                    <span className="ring" />
                    Aguardando a extensão
                  </div>
                )}
              </>
            )}
            {settings?.dev.enabled && (
              <button
                className="status-warning"
                onClick={() => {
                  openSettings();
                  setOpenAtDev(true);
                }}
              >
                <Icon d={ICON.warning} size={14} />
                <span>Modo de desenvolvedor ligado</span>
              </button>
            )}
          </footer>
          <button
            className={`settings-link${showSettings ? ' is-selected' : ''}`}
            onClick={openSettings}
          >
            <Icon d={ICON.sliders}>
              <circle cx="16" cy="6" r="2" />
              <circle cx="10" cy="12" r="2" />
              <circle cx="18" cy="18" r="2" />
            </Icon>
            Configurações
          </button>
        </div>
      </aside>

      <main className="content">
        <div className="drag-strip" data-tauri-drag-region />
        {error && (
          <div className="error" role="alert">
            {error} <button onClick={() => setError(null)}>Fechar</button>
          </div>
        )}
        {gpuIssue && !showSettings && gpuIssue.detail !== gpuNoticeClosed && (
          <div className="notice" role="status">
            <Icon d={ICON.warning} size={18} />
            <span>{gpuIssue.notice}</span>
            <button onClick={openSettings}>Ver detalhes</button>
            <button onClick={() => setGpuNoticeClosed(gpuIssue.detail)}>Fechar</button>
          </div>
        )}

        {hits ? (
          <>
            <header className="header">
              {menuButton}
              <div className="header-title">
                <h1>Busca</h1>
                <span className="header-meta">
                  {hits.length} {hits.length === 1 ? 'trecho' : 'trechos'} com “{query.trim()}”
                  {hitMeetings > 1 && ` em ${hitMeetings} reuniões`}
                </span>
              </div>
            </header>
            <div className="scroll">
              {hits.length === 0 && <p className="hint">Nada encontrado.</p>}
              {hits.map((h) => {
                const m = meetings.find((x) => x.id === h.meeting_id);
                return (
                  <button
                    key={h.id}
                    className="hit"
                    onClick={() => {
                      setQuery('');
                      setHome(false);
                      setSource('parakeet');
                      setSelected(h.meeting_id);
                    }}
                  >
                    <Avatar name={h.speaker} />
                    <span className="hit-body">
                      <span className="hit-head">
                        <span className="hit-speaker">{shownName(h.speaker, h.speaker_key === 'me')}</span>
                        <span className="hit-where">
                          {m ? `${meetingName(m)} · ${meetingWhen(m)} · ${clock(h.start_ms, m.started_ms)}` : `Reunião ${h.meeting_id}`}
                        </span>
                      </span>
                      <span className="hit-text">
                        <Highlight text={h.text} words={hitWords} />
                      </span>
                    </span>
                    <Icon d={ICON.chevron} size={16} />
                  </button>
                );
              })}
            </div>
          </>
        ) : home && meetings.length > 0 ? (
          <Home
            meetings={meetings}
            liveId={status.live_meeting}
            header={menuButton}
            onOpen={(id) => {
              setSelected(id);
              setHome(false);
            }}
          />
        ) : meeting ? (
          <>
            <div className="topbar">{menuButton}</div>
            <div className="meeting-view">
              <div className="meeting-top">
                <div className="m-head">
                  <div className="m-title">
                    <h1>{meetingName(meeting)}</h1>
                    <div className="meta">
                      {live && <span className="live-badge">Ao vivo</span>}
                      <span>{meetingWhen(meeting)}</span>
                      {people.length > 0 && (
                        <>
                          <span aria-hidden="true">·</span>
                          <span>
                            {people.length} {people.length === 1 ? 'pessoa' : 'pessoas'}
                          </span>
                        </>
                      )}
                    </div>
                  </div>
                  <div className="m-actions">
                    <button
                      className="button"
                      title={source === 'captions' ? `Exportar as legendas do ${platformName(meeting)}` : 'Exportar a transcrição'}
                      disabled={turns.length === 0 || exporting}
                      onClick={() => exportMeeting(meeting)}
                    >
                      <Icon d={ICON.download} size={16} />
                      Exportar
                    </button>
                    {!live && (
                      <button className="icon-button is-danger" aria-label="Excluir reunião" title="Excluir reunião" onClick={() => remove(meeting)}>
                        <Icon d={ICON.trash} />
                      </button>
                    )}
                  </div>
                </div>

                {people.length > 0 && !bandFolded && (
                  <section className="card band" id="meeting-band">
                    <div className="band-main">
                      {live ? (
                        <>
                          <Council
                            people={people}
                            speaking={turns.length > 0 ? turns[turns.length - 1].speakerKey : null}
                            speakerName={turns.length > 0 ? label(turns[turns.length - 1].speaker, turns[turns.length - 1].speakerKey) : null}
                            clock={fmtClock((now - meeting.started_ms) / 1000)}
                          />
                          {turns.length > 0 && (
                            <p className="speaking">
                              <b>{label(turns[turns.length - 1].speaker, turns[turns.length - 1].speakerKey)}</b> está falando agora
                            </p>
                          )}
                        </>
                      ) : (
                        <div className="summary">
                          <Rings value={(minutes(meeting) ?? 0) / 60} size={72} />
                          <div>
                            <div className="big">
                              {minutes(meeting) ?? 0}
                              <small>min</small>
                            </div>
                            <div className="sub">
                              {people.length} {people.length === 1 ? 'voz' : 'vozes'}
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                    <div className="band-side">
                      <h3>Quem falou</h3>
                      <p className="lead">Clique num nome para ocultar as falas dessa pessoa.</p>
                      <div className="chips">
                        {people.map((p) => {
                          const off = hidden.has(p.key);
                          return (
                            <button
                              key={p.key}
                              className="chip"
                              aria-pressed={!off}
                              title={off ? `Mostrar as falas de ${label(p.name, p.key)}` : `Ocultar as falas de ${label(p.name, p.key)}`}
                              onClick={() => toggleHidden(p.key)}
                            >
                              <Avatar name={p.name} />
                              {label(p.name, p.key)}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  </section>
                )}

                <div className="toolbar">
                  <div className="seg" role="tablist" aria-label="Fonte do texto">
                    <button role="tab" aria-selected={source === 'parakeet'} onClick={() => setSource('parakeet')}>
                      Parakeet
                    </button>
                    <button role="tab" aria-selected={source === 'captions'} onClick={() => setSource('captions')}>
                      Legendas do {platformName(meeting)}
                    </button>
                  </div>
                  <label className="find">
                    <Icon d={ICON.search} size={16}>
                      <circle cx="11" cy="11" r="7" />
                    </Icon>
                    <input type="search" placeholder="Buscar nesta reunião" value={find} onChange={(e) => setFind(e.target.value)} aria-label="Buscar nesta reunião" />
                  </label>
                  <span className="count" role="status">
                    {finding
                      ? `${found === 0 ? 'Nada encontrado' : `${found} ${found === 1 ? 'trecho' : 'trechos'}`} com “${find.trim()}”${hidden.size > 0 ? ', fora as pessoas ocultas' : ''}`
                      : `${people.length} ${people.length === 1 ? 'pessoa' : 'pessoas'} · ${turns.reduce((sum, t) => sum + t.lines.length, 0)} falas`}
                  </span>
                  {people.length > 0 && (
                    <button
                      className={`icon-button fold${bandFolded ? ' is-folded' : ''}`}
                      aria-expanded={!bandFolded}
                      aria-controls="meeting-band"
                      aria-label={bandFolded ? 'Mostrar o resumo' : 'Ocultar o resumo'}
                      title={bandFolded ? 'Mostrar o resumo e quem falou' : 'Ocultar o resumo para ver mais da transcrição'}
                      onClick={toggleBand}
                    >
                      <Icon d={ICON.chevron} size={16} />
                    </button>
                  )}
                </div>
              </div>

              <div className="transcript-scroll" ref={scroller} onScroll={onScroll}>
                <div className="transcript">
                  {!finding && turns.length > 0 && shownTurns.length === 0 && (
                    <p className="notice">Todas as pessoas estão ocultas. Clique num nome acima para mostrar as falas.</p>
                  )}
                  {turns.length === 0 && !(live && source === 'parakeet') && (
                    <p className="hint">
                      {source === 'captions'
                        ? live
                          ? `As legendas do ${platformName(meeting)} aparecem aqui conforme as pessoas falam.`
                          : `Esta reunião não tem legendas do ${platformName(meeting)}.`
                        : 'Sem fala transcrita.'}
                    </p>
                  )}
                  {shownTurns.map((t) => (
                    <article key={t.key} className="turn">
                      <Avatar name={t.speaker} />
                      <div className="turn-body">
                        <div className="turn-head">
                          <span className="turn-speaker">{label(t.speaker, t.speakerKey)}</span>
                          <span className="turn-time">{clock(t.startMs, meeting.started_ms)}</span>
                        </div>
                        <p className="turn-text">
                          {t.lines.map((l) => (
                            <span key={l.id}>
                              <Highlight text={l.text} words={findWordsTyped} />{' '}
                            </span>
                          ))}
                        </p>
                      </div>
                    </article>
                  ))}
                  {live && source === 'parakeet' && !finding && (
                    <div className="listening">
                      <Bars count={5} />
                      Ouvindo…
                    </div>
                  )}
                </div>
              </div>
            </div>
          </>
        ) : (
          <div className="empty">
            {menuButton}
            <div className="empty-inner">
              <div className="empty-hero">
                <Logo className="empty-mark" alt="Logo do entmoot: uma árvore cujos galhos viram ondas de som" />
                <h1>entmoot</h1>
                <p>As reuniões aparecem aqui assim que a extensão do Zen detectar uma chamada.</p>
                <p className="quip">Nenhuma reunião ainda. Os Ents não têm pressa.</p>
              </div>
              <ol className="steps">
                <li>
                  <span className="step-n">01</span>
                  <strong>Abra o Zen</strong>
                  <span>Com a extensão do entmoot ativa no navegador.</span>
                </li>
                <li>
                  <span className="step-n">02</span>
                  <strong>Entre numa reunião do Meet ou do Teams</strong>
                  <span>A reunião entra na lista ao lado no momento em que começa.</span>
                </li>
                <li>
                  <span className="step-n">03</span>
                  <strong>Acompanhe a transcrição</strong>
                  <span>O texto aparece enquanto as pessoas falam e fica salvo neste computador.</span>
                </li>
              </ol>
            </div>
          </div>
        )}
      </main>
      {showSettings && (
        <div className="dialog-backdrop" onClick={() => setShowSettings(false)}>
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby="settings-title" onClick={(e) => e.stopPropagation()}>
            <header className="modal-head">
              <h1 id="settings-title">Configurações</h1>
              <button className="icon-button" aria-label="Fechar" title="Fechar" onClick={() => setShowSettings(false)}>
                <Icon d="M6 6l12 12M18 6L6 18" />
              </button>
            </header>
            <div className="scroll">
              {settings && (
                <div className="settings">
                  <h2>Transcrição</h2>
                  <p className={`settings-state${gpuIssue ? ' is-warning' : ''}`}>
                    {ready && captionsOnly && status.mode === 'captions' ? (
                      <>
                        <Icon d={ICON.check} size={16} />
                        Só as legendas do Meet são guardadas. Nenhum modelo está carregado.
                      </>
                    ) : ready && status.device ? (
                      <>
                        <Icon d={gpuIssue ? ICON.warning : ICON.check} size={16} />
                        {`Em uso: ${modelLabel(status.model)}, ${status.device === 'gpu' ? 'na placa de vídeo' : 'no processador'}.`}
                      </>
                    ) : (
                      stageText(status)
                    )}
                  </p>
                  {status.switching && (
                    <p className="settings-note">Trocando o modelo. A transcrição está parada até terminar.</p>
                  )}
                  {status.switch_error && (
                    <div className="alert" role="alert">
                      <Icon d={ICON.warning} size={20} />
                      <div className="alert-body">
                        <strong>Não foi possível trocar o modelo</strong>
                        <p>O modelo voltou para onde estava.</p>
                        <details>
                          <summary>Detalhe técnico</summary>
                          <pre>{status.switch_error}</pre>
                        </details>
                      </div>
                    </div>
                  )}

                  <div>
                    <h3>Como transcrever</h3>
                    <div className="choice-grid">
                      <Choice
                        group="mode"
                        label="Neste computador"
                        hint="Um modelo de voz roda aqui e transcreve o áudio da reunião."
                        checked={settings.mode === 'local'}
                        disabled={status.switching || busy}
                        onChoose={() => changeSettings({ mode: 'local' })}
                      />
                      <Choice
                        group="mode"
                        label="Só as legendas"
                        hint="Sem modelo e sem download: guarda as legendas que a plataforma gera. Não se esqueça de ativar as legendas na reunião ou configurar a extensão para ativá-las automaticamente."
                        checked={settings.mode === 'captions'}
                        disabled={status.switching || busy}
                        onChoose={() => changeSettings({ mode: 'captions' })}
                      />
                    </div>
                    {busy && <p className="settings-note is-below">Espere a reunião terminar para trocar isso.</p>}
                  </div>

                  {!captionsOnly && (
                  <>
                  <div>
                    <h3>Onde rodar</h3>
                    <div className="choice-grid">
                      <Choice
                        group="device"
                        label="Processador (CPU)"
                        hint="Roda o modelo no processador."
                        checked={settings.device === 'cpu'}
                        disabled={status.switching}
                        onChoose={() => chooseDevice('cpu')}
                      />
                      <Choice
                        group="device"
                        label="Placa de vídeo (GPU)"
                        hint="Roda o modelo na placa de vídeo."
                        checked={settings.device === 'gpu'}
                        disabled={status.switching}
                        onChoose={() => chooseDevice('gpu')}
                      />
                    </div>
                    {settings.device === 'gpu' && (
                      <div className="card-list is-below">
                        <Toggle
                          label="Usar o processador se a placa de vídeo falhar"
                          hint={
                            settings.cpu_fallback
                              ? 'Se a placa não puder ser usada ou parar de funcionar, o modelo passa para o processador e a transcrição continua.'
                              : 'Se a placa não puder ser usada ou parar de funcionar, o entmoot avisa e as falas ficam sem transcrição até ela voltar.'
                          }
                          checked={settings.cpu_fallback}
                          onChange={(cpu_fallback) => changeSettings({ cpu_fallback })}
                        />
                      </div>
                    )}
                    {settings.device === 'gpu' && chosenModel && !chosenModel.gpu && (
                      <p className="settings-note is-below">O modelo escolhido só roda no processador.</p>
                    )}
                    {gpuIssue && (
                      <div className="alert" role="alert">
                        <Icon d={ICON.warning} size={20} />
                        <div className="alert-body">
                          <strong>{gpuIssue.title}</strong>
                          <p>{gpuIssue.body}</p>
                          <p>
                            O que costuma resolver: atualizar o driver da placa de vídeo e fechar programas que ocupam a memória dela, como jogos e
                            editores de vídeo. Depois, tente de novo.
                          </p>
                          <div className="alert-actions">
                            <button className="button" disabled={busy} onClick={() => api.restartEngine().catch(fail)}>
                              Tentar de novo
                            </button>
                            <button className="button" disabled={status.switching} onClick={() => chooseDevice('cpu')}>
                              Usar o processador
                            </button>
                          </div>
                          <details>
                            <summary>Detalhe técnico</summary>
                            <pre>{gpuIssue.detail}</pre>
                          </details>
                        </div>
                      </div>
                    )}
                  </div>

                  {ready && status.speed_trial && (
                    <div>
                      <h3>Desempenho</h3>
                      <dl className="stats">
                        <div>
                          <dt>Velocidade</dt>
                          <dd>
                            {status.speed_last && status.speed_total.audio_ms > 0 ? (
                              <>
                                <div>Última fala: {speedText(status.speed_last)}</div>
                                <div>
                                  {status.gpu_failed_in_use && !onGpu ? 'Todas desde que passou para o processador' : 'Todas desde que o modelo carregou'}:{' '}
                                  {speedText(status.speed_total)}
                                </div>
                              </>
                            ) : (
                              `${speedText(status.speed_trial)} (teste ao carregar o modelo)`
                            )}
                          </dd>
                        </div>
                        {resources?.memory_used != null && (
                          <div>
                            <dt>Memória RAM ocupada pelo entmoot</dt>
                            <dd>{size(resources.memory_used)}</dd>
                          </div>
                        )}
                        {gpuStats && (
                          <>
                            <div>
                              <dt>Placa de vídeo</dt>
                              <dd>{gpuStats.name}</dd>
                            </div>
                            <div>
                              <dt>Uso da placa pelo entmoot</dt>
                              <dd>{gpuStats.usage === null ? 'Medindo…' : `${Math.round(gpuStats.usage)}%`}</dd>
                            </div>
                            <div>
                              <dt>Memória de vídeo ocupada pelo entmoot</dt>
                              <dd>
                                {size(gpuStats.memory_used)}
                                {gpuStats.memory_total > gpuStats.memory_used && ` de ${size(gpuStats.memory_total)}`}
                              </dd>
                            </div>
                          </>
                        )}
                      </dl>
                      {gpuStats ? (
                        <p className="stats-note">O uso da placa só sobe enquanto uma fala está sendo transcrita; entre uma e outra fica perto de 0%.</p>
                      ) : (
                        resources?.memory_used != null && <p className="stats-note">Quase toda a memória ocupada é do modelo de fala.</p>
                      )}
                    </div>
                  )}

                  <div>
                    <h3>Modelo</h3>
                    <div className="card-list">
                      {models.map((m) => (
                        <Choice
                          key={m.name}
                          group="model"
                          label={modelLabel(m.name)}
                          hint={MODEL_TEXT[m.name]?.hint ?? ''}
                          checked={settings.model === m.name}
                          // During a meeting only a model already on disk can be chosen: a download has to wait.
                          disabled={status.switching || (busy && !m.downloaded)}
                          onChoose={() => chooseEngine({ model: m.name })}
                          info={
                            <button
                              type="button"
                              className="info"
                              aria-label={`Abrir a página de onde o modelo ${m.downloaded ? 'foi' : 'vai ser'} baixado`}
                              title={`${m.downloaded ? 'Baixado de' : 'Vai ser baixado de'} ${m.page.replace('https://', '')}\nClique para abrir no navegador.`}
                              onClick={(e) => {
                                e.preventDefault(); // not a click on the choice around it
                                api.openModelPage(m.name).catch(fail);
                              }}
                            >
                              <Icon d={ICON.info} size={16}>
                                <circle cx="12" cy="12" r="9" />
                              </Icon>
                            </button>
                          }
                          aside={
                            <>
                              <span>{size(m.size_bytes)}</span>
                              {m.downloaded ? <span className="badge">Baixado</span> : <span>{busy ? 'Só depois da reunião' : 'Baixa ao escolher'}</span>}
                            </>
                          }
                        />
                      ))}
                    </div>
                  </div>
                  </>
                  )}

                  <h2>Aparência</h2>
                  <div className="choice-grid is-three">
                    <Choice
                      group="theme"
                      label="Igual ao Windows"
                      hint={`Agora: ${windowsDark ? 'escuro' : 'claro'}.`}
                      checked={theme === 'system'}
                      disabled={false}
                      onChoose={() => chooseTheme('system')}
                    />
                    <Choice group="theme" label="Claro" hint="Fundo claro." checked={theme === 'light'} disabled={false} onChoose={() => chooseTheme('light')} />
                    <Choice group="theme" label="Escuro" hint="Fundo escuro." checked={theme === 'dark'} disabled={false} onChoose={() => chooseTheme('dark')} />
                  </div>

                  <h2>Janela</h2>
                  <div className="card-list">
                    <Toggle
                      label="Iniciar com o Windows"
                      hint="O entmoot abre sozinho quando você entra no Windows e fica na bandeja, pronto para transcrever."
                      checked={settings.autostart}
                      onChange={(autostart) => changeSettings({ autostart })}
                    />
                    <Toggle
                      label="Minimizar para a bandeja"
                      hint="Ao minimizar, a janela sai da barra de tarefas e fica só o ícone ao lado do relógio."
                      checked={settings.minimize_to_tray}
                      onChange={(minimize_to_tray) => changeSettings({ minimize_to_tray })}
                    />
                    <Toggle
                      label="Fechar para a bandeja"
                      hint="O X esconde a janela em vez de encerrar o app, e as reuniões continuam sendo transcritas. Para sair, use o menu do ícone na bandeja."
                      checked={settings.close_to_tray}
                      onChange={(close_to_tray) => changeSettings({ close_to_tray })}
                    />
                  </div>

                  <h2>Reuniões</h2>
                  <div>
                    <div className="card-list">
                      <div className="setting is-action">
                        <span className="setting-text">
                          <span className="setting-label">Exportar todas as reuniões</span>
                          <span className="setting-hint">
                            Salva todas as reuniões.
                          </span>
                        </span>
                        <button className="button" disabled={meetings.length === 0 || exporting} onClick={exportAll}>
                          <Icon d={ICON.download} size={16} />
                          Exportar todas
                        </button>
                      </div>
                      <div className="setting is-action">
                        <span className="setting-text">
                          <span className="setting-label">Apagar todas as reuniões</span>
                          <span className="setting-hint">
                            Remove as reuniões salvas e as transcrições delas deste computador. Não dá para desfazer.
                            {busy && ' A reunião em andamento fica.'}
                          </span>
                        </span>
                        <button className="button is-danger" disabled={removable === 0} onClick={removeAll}>
                          <Icon d={ICON.trash} size={16} />
                          Apagar tudo
                        </button>
                      </div>
                    </div>
                    {exported && (
                      <p className="settings-note is-below" role="status">
                        {exported}
                      </p>
                    )}
                  </div>

                  {settings.dev.enabled && (
                    <>
                      <h2 id="dev-section">Desenvolvedor</h2>
                      <p className="settings-state is-warning">
                        <Icon d={ICON.warning} size={16} />
                        Modo de desenvolvedor ligado.
                      </p>
                      <div className="card-list">
                        <Toggle
                          label="Salvar o dump completo"
                          hint="Guarda todas as mensagens que a extensão manda, inclusive os quadros brutos do Meet e do Teams, e passa a pedir à extensão todos os quadros, não só os primeiros de cada canal."
                          checked={settings.dev.dump_events}
                          onChange={(dump_events) => changeDev({ dump_events })}
                        />
                        <Toggle
                          label="Salvar o áudio"
                          hint="Guarda o áudio de cada faixa em um arquivo WAV, uns 2 MB por minuto de som."
                          checked={settings.dev.dump_audio}
                          onChange={(dump_audio) => changeDev({ dump_audio })}
                        />
                        <Toggle
                          label="Salvar as transcrições"
                          hint="Guarda ao lado do dump o que o entmoot entendeu: cada trecho transcrito, as legendas, os dados da reunião e quem falou em cada faixa de áudio. No fim, os arquivos são refeitos com os nomes que chegaram tarde."
                          checked={settings.dev.save_transcripts}
                          onChange={(save_transcripts) => changeDev({ save_transcripts })}
                        />
                        <div className="setting is-action">
                          <span className="setting-text">
                            <span className="setting-label">Pasta das gravações</span>
                            <span className="setting-hint">
                              {recordingsAt ?? 'Fica junto das reuniões salvas, na pasta de dados do entmoot.'}
                            </span>
                          </span>
                          <button className="button" onClick={() => void showRecordings()}>
                            Abrir a pasta
                          </button>
                        </div>
                        <div className="setting is-action">
                          <span className="setting-text">
                            <span className="setting-label">Desativar o modo de desenvolvedor</span>
                          </span>
                          <button className="button" onClick={() => changeDev({ enabled: false })}>
                            Desativar
                          </button>
                        </div>
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
      {pendingChange && (
        <div className="dialog-backdrop" onClick={() => setPendingChange(null)}>
          <div className="dialog" role="alertdialog" aria-modal="true" aria-labelledby="dialog-title" onClick={(e) => e.stopPropagation()}>
            <div className="dialog-head">
              <Icon d={ICON.warning} size={22} />
              <h2 id="dialog-title">
                {pendingChange.model
                  ? `Trocar para o modelo ${modelLabel(pendingChange.model)} agora?`
                  : `Passar o modelo para ${pendingChange.device === 'gpu' ? 'a placa de vídeo' : 'o processador'} agora?`}
              </h2>
            </div>
            {pendingChange.model && pendingChange.device === 'cpu' && (
              <p>
                Este modelo só roda no processador. Ao continuar, o entmoot passa também para o processador, mesmo que a placa de vídeo esteja
                escolhida.
              </p>
            )}
            {busy && (
              <>
                <p>
                  Há uma reunião em andamento. Enquanto o modelo é carregado, o que leva alguns segundos, a transcrição fica parada e as falas
                  desse intervalo podem aparecer com atraso ou ficar sem texto.
                </p>
                <p>A legenda da reunião continua normalmente.</p>
              </>
            )}
            <div className="dialog-actions">
              <button className="button" autoFocus onClick={() => setPendingChange(null)}>
                Cancelar
              </button>
              <button className="button is-primary" onClick={confirmChange}>
                Continuar e trocar
              </button>
            </div>
          </div>
        </div>
      )}
      {askDev && (
        <div className="dialog-backdrop" onClick={() => setAskDev(false)}>
          <div className="dialog" role="alertdialog" aria-modal="true" aria-labelledby="dev-title" onClick={(e) => e.stopPropagation()}>
            <div className="dialog-head">
              <Icon d={ICON.warning} size={22} />
              <h2 id="dev-title">Ativar o modo de desenvolvedor?</h2>
            </div>
            <p>
              O modo de desenvolvedor serve para investigar problemas. Com ele ligado, o entmoot pode guardar neste computador tudo o que a extensão manda
              durante as reuniões, inclusive o áudio e o texto do que foi dito. Isso ocupa muito espaço no disco e deve ser usado só quando necessário.
            </p>
            <p>Você escolhe o que guardar nas configurações, e pode desligar quando quiser. Nada sai deste computador.</p>
            <div className="dialog-actions">
              <button className="button" autoFocus onClick={() => setAskDev(false)}>
                Cancelar
              </button>
              <button className="button is-primary" onClick={turnOnDev}>
                Ativar
              </button>
            </div>
          </div>
        </div>
      )}
      {pendingDelete && (
        <div className="dialog-backdrop" onClick={() => setPendingDelete(null)}>
          <div className="dialog" role="alertdialog" aria-modal="true" aria-labelledby="delete-title" onClick={(e) => e.stopPropagation()}>
            <div className="dialog-head">
              <Icon d={ICON.warning} size={22} />
              <h2 id="delete-title">{pendingDelete.title}</h2>
            </div>
            <p>{pendingDelete.body}</p>
            <div className="dialog-actions">
              <button className="button" autoFocus onClick={() => setPendingDelete(null)}>
                Cancelar
              </button>
              <button className="button is-danger" onClick={confirmDelete}>
                <Icon d={ICON.trash} size={16} />
                {pendingDelete.action}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
