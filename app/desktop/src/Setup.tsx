import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, type Device, type HardwareReport, type Mode, type ModelInfo, type Settings } from './api';
import logo from './assets/logo.svg';
import { memory, MODEL_TEXT, modelLabel, size } from './format';

type Theme = 'system' | 'light' | 'dark';

const STEPS = ['Aparência', 'Transcrição', 'Início'] as const;

/** The scan is quick; showing it for at least this long keeps it from flashing past. */
const SCAN_MIN_MS = 900;

function Check() {
  return (
    <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 12.5l4.5 4.5L19 7.5" />
    </svg>
  );
}

/** A radio that looks like a card; the same markup the settings use. */
function Option(props: {
  group: string;
  label: ReactNode;
  hint: ReactNode;
  checked: boolean;
  disabled?: boolean;
  onChoose: () => void;
  aside?: ReactNode;
}) {
  return (
    <label className={`setting${props.disabled ? ' is-disabled' : ''}`}>
      <input type="radio" name={props.group} checked={props.checked} disabled={props.disabled} onChange={props.onChoose} />
      <span className="setting-text">
        <span className="setting-label">{props.label}</span>
        <span className="setting-hint">{props.hint}</span>
      </span>
      {props.aside && <span className="setting-aside">{props.aside}</span>}
    </label>
  );
}

export function Setup(props: {
  settings: Settings;
  models: ModelInfo[];
  theme: Theme;
  windowsDark: boolean;
  onTheme: (theme: Theme) => void;
  /** Saves the choices; rejects with what went wrong. */
  onFinish: (settings: Settings) => Promise<void>;
}) {
  const [step, setStep] = useState(0);
  const [draft, setDraft] = useState<Settings>(props.settings);
  const [hardware, setHardware] = useState<HardwareReport | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The setup always starts by following Windows, whatever an earlier run left behind.
  // Only once: `onTheme` is a new function on every render, so listing it would undo each choice.
  useEffect(() => {
    props.onTheme('system');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Look for the card as soon as the setup opens, so the answer is ready by the second step.
  useEffect(() => {
    let stale = false;
    const started = Date.now();
    const done = (apply: () => void) => setTimeout(() => stale || apply(), Math.max(0, SCAN_MIN_MS - (Date.now() - started)));
    api.hardware().then(
      (report) =>
        done(() => {
          setHardware(report);
          // Start from what suits this computer; the user may change it.
          setDraft((d) => ({ ...d, device: report.recommended_device, model: report.recommended_model }));
        }),
      (e) => done(() => setScanError(String(e))),
    );
    return () => {
      stale = true;
    };
  }, []);

  const scanning = hardware === null && scanError === null;
  const gpu = hardware?.gpus[0] ?? null;
  const gpuUsable = hardware ? hardware.gpus.length > 0 : true; // unknown: leave the choice open
  const local = draft.mode === 'local';
  const chosenModel = props.models.find((m) => m.name === draft.model);
  const gpuModels = props.models.filter((m) => m.gpu);

  const change = (patch: Partial<Settings>) => setDraft((d) => ({ ...d, ...patch }));

  const chooseDevice = (device: Device) => {
    // The compact model runs on the processor only, so it cannot come along to the card.
    const model = device === 'gpu' && chosenModel && !chosenModel.gpu ? (hardware?.recommended_model ?? gpuModels[0]?.name ?? draft.model) : draft.model;
    change({ device, model });
  };

  const chooseModel = (name: string) => {
    const m = props.models.find((x) => x.name === name);
    change({ model: name, device: m && !m.gpu ? 'cpu' : draft.device });
  };

  const download = useMemo(() => (local && chosenModel && !chosenModel.downloaded ? chosenModel.size_bytes : 0), [local, chosenModel]);

  const last = step === STEPS.length - 1;
  const finish = () => {
    setSaving(true);
    setError(null);
    props.onFinish({ ...draft, setup_done: true }).catch((e) => {
      setError(String(e));
      setSaving(false);
    });
  };

  const gpuHint = !gpuUsable
    ? 'Nenhuma placa de vídeo foi encontrada.'
    : gpu
      ? [gpu.vendor, gpu.integrated ? (gpu.vram > 0 ? `${memory(gpu.vram)} de VRAM` : 'memória compartilhada') : `${memory(gpu.vram)} de VRAM`, gpu.driver && `driver ${gpu.driver}`]
          .filter(Boolean)
          .join(' · ')
      : 'Deixa o processador livre durante a reunião.';
  const cpuHint = hardware ? `${hardware.cpu_threads} threads${hardware.ram_total ? ` · ${memory(hardware.ram_total)} de RAM` : ''}` : 'Funciona em qualquer computador.';

  const summary: [string, string][] = [
    ['Aparência', props.theme === 'system' ? `Igual ao Windows (agora ${props.windowsDark ? 'escuro' : 'claro'})` : props.theme === 'dark' ? 'Escuro' : 'Claro'],
    ['Transcrição', local ? 'Neste computador' : 'Só as legendas da reunião'],
    ...(local
      ? ([
          ['Roda em', draft.device === 'gpu' ? `Placa de vídeo${gpu ? ` (${gpu.name})` : ''}` : 'Processador (CPU)'],
          ['Modelo', modelLabel(draft.model)],
        ] as [string, string][])
      : []),
    ['Iniciar com o Windows', draft.autostart ? 'Sim, na bandeja' : 'Não'],
  ];

  return (
    <div className="setup" data-tauri-drag-region>
      <div className="setup-card" role="dialog" aria-modal="true" aria-labelledby="setup-title">
        <header className="setup-head">
          <img className="setup-logo" src={logo} alt="" />
          <div>
            <h1 id="setup-title">Bem-vindo ao entmoot</h1>
            <p className="setup-sub">Vamos deixar tudo pronto em poucos passos. Os Ents não têm pressa.</p>
          </div>
        </header>

        <ol className="setup-steps" aria-label="Passos">
          {STEPS.map((label, i) => (
            <li key={label} className={i === step ? 'is-current' : i < step ? 'is-done' : ''} aria-current={i === step ? 'step' : undefined}>
              <span className="setup-step-dot">{i < step ? <Check /> : i + 1}</span>
              <span className="setup-step-label">{label}</span>
            </li>
          ))}
        </ol>

        <div className="setup-body">
          {step === 0 && (
            <section className="setup-section">
              <h2>Como você prefere o visual?</h2>
              <p className="setup-lead">A mudança aparece na hora. Dá para trocar depois em Configurações.</p>
              <div className="choice-grid is-three">
                <Option
                  group="theme"
                  label="Igual ao Windows"
                  hint={`Agora: ${props.windowsDark ? 'escuro' : 'claro'}.`}
                  checked={props.theme === 'system'}
                  onChoose={() => props.onTheme('system')}
                  aside={<span className="badge">Padrão</span>}
                />
                <Option group="theme" label="Claro" hint="Fundo claro." checked={props.theme === 'light'} onChoose={() => props.onTheme('light')} />
                <Option group="theme" label="Escuro" hint="Fundo escuro." checked={props.theme === 'dark'} onChoose={() => props.onTheme('dark')} />
              </div>
            </section>
          )}

          {step === 1 && (
            <section className="setup-section">
              <h2>Como transcrever?</h2>
              <div className="card-list">
                <Option
                  group="mode"
                  label="Neste computador"
                  hint="Um modelo de voz (Parakeet) roda aqui. Funciona sem enviar áudio a ninguém e guarda o texto de cada pessoa."
                  checked={local}
                  onChoose={() => change({ mode: 'local' as Mode })}
                />
                <Option
                  group="mode"
                  label="Só as legendas da reunião"
                  hint="Não baixa nenhum modelo e usa quase nada do computador. O texto é o das legendas do próprio Meet ou Teams, que precisam estar ligadas."
                  checked={!local}
                  onChoose={() => change({ mode: 'captions' as Mode })}
                />
              </div>

              {local && (
                <>
                  <h3>Onde rodar</h3>
                  {scanning && (
                    <div className="setup-scan" role="status">
                      <span className="eq" aria-hidden="true">
                        <i />
                        <i />
                        <i />
                        <i />
                        <i />
                      </span>
                      Procurando sua placa de vídeo…
                    </div>
                  )}
                  {scanError && <p className="settings-note">Não foi possível ler as informações do computador. Escolha à mão.</p>}
                  {!scanning && (
                    <>
                      <div className="choice-grid">
                        <Option
                          group="device"
                          label="Processador (CPU)"
                          hint={cpuHint}
                          checked={draft.device === 'cpu'}
                          onChoose={() => chooseDevice('cpu')}
                          aside={hardware?.recommended_device === 'cpu' && <span className="badge">Recomendado</span>}
                        />
                        <Option
                          group="device"
                          label={gpu ? gpu.name : 'Placa de vídeo (GPU)'}
                          hint={gpuHint}
                          checked={draft.device === 'gpu'}
                          disabled={!gpuUsable}
                          onChoose={() => chooseDevice('gpu')}
                          aside={hardware?.recommended_device === 'gpu' && <span className="badge">Recomendado</span>}
                        />
                      </div>
                      {hardware && (
                        <p className="setup-lead">
                          {hardware.reason}
                          {hardware.gpus.length > 1 && ` Há outras ${hardware.gpus.length - 1} placa(s) no computador; o entmoot usa a principal.`}
                        </p>
                      )}
                    </>
                  )}

                  <h3>Modelo</h3>
                  <div className="card-list">
                    {props.models.map((m) => (
                      <Option
                        key={m.name}
                        group="model"
                        label={modelLabel(m.name)}
                        hint={MODEL_TEXT[m.name]?.hint ?? ''}
                        checked={draft.model === m.name}
                        onChoose={() => chooseModel(m.name)}
                        aside={
                          <>
                            <span>{size(m.size_bytes)}</span>
                            {m.downloaded ? <span className="badge">Baixado</span> : m.name === hardware?.recommended_model && <span className="badge">Recomendado</span>}
                          </>
                        }
                      />
                    ))}
                  </div>
                  {draft.device === 'gpu' && chosenModel && !chosenModel.gpu && <p className="settings-note is-below">Esse modelo só roda no processador.</p>}
                  {download > 0 && <p className="settings-note is-below">O modelo tem {size(download)} e é baixado assim que você concluir. Dá para usar o app enquanto isso.</p>}
                </>
              )}
              {!local && <p className="settings-note is-below">Dá para passar para um modelo local depois, em Configurações.</p>}
            </section>
          )}

          {step === 2 && (
            <section className="setup-section">
              <h2>Quando abrir o entmoot?</h2>
              <div className="card-list">
                <label className="setting is-switch">
                  <span className="setting-text">
                    <span className="setting-label">Iniciar com o Windows</span>
                    <span className="setting-hint">O entmoot abre sozinho quando você entra no Windows e fica na bandeja, pronto para transcrever.</span>
                  </span>
                  <input className="switch" type="checkbox" role="switch" checked={draft.autostart} onChange={(e) => change({ autostart: e.target.checked })} />
                </label>
              </div>

              <h3>Resumo</h3>
              <dl className="stats">
                {summary.map(([k, v]) => (
                  <div key={k}>
                    <dt>{k}</dt>
                    <dd>{v}</dd>
                  </div>
                ))}
              </dl>
              {download > 0 && <p className="stats-note">Ao concluir, o modelo ({size(download)}) começa a ser baixado.</p>}
              {error && (
                <div className="alert" role="alert">
                  <div className="alert-body">
                    <strong>Não foi possível salvar</strong>
                    <p>{error}</p>
                  </div>
                </div>
              )}
            </section>
          )}
        </div>

        <footer className="setup-foot">
          <button className="button" onClick={() => setStep(step - 1)} disabled={step === 0 || saving}>
            Voltar
          </button>
          <span className="setup-count">
            {step + 1} de {STEPS.length}
          </span>
          {last ? (
            <button className="button is-primary" onClick={finish} disabled={saving}>
              {saving ? 'Salvando…' : 'Concluir e começar'}
            </button>
          ) : (
            <button className="button is-primary" onClick={() => setStep(step + 1)} disabled={step === 1 && local && scanning}>
              Continuar
            </button>
          )}
        </footer>
      </div>
    </div>
  );
}
