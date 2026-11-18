# entmoot

Aplicativo Windows (Tauri 2) que transcreve reuniões do Google Meet e do Microsoft Teams (web) localmente, alimentado por uma extensão de Firefox. Visão geral e instruções de uso estão no README.md.

## Mapa

- `app/core/`: crate Rust `transcritor-core` (lib `transcritor_core`, binário `transcritor`). O nome antigo do projeto ficou no crate; o produto se chama entmoot.
  - `server.rs`: WebSocket em `127.0.0.1:17865`, uma conexão por vez, e a thread de transcrição, que carrega o modelo quando a extensão conecta e o descarrega depois de 5 minutos sem reunião. Emite `Event` para quem mostra a reunião.
  - `session.rs`: estado de uma reunião (participantes, faixas, falas abertas, legendas). Síncrono e sem I/O; o servidor e o `replay` o conduzem do mesmo jeito.
  - `protocol.rs`: formato das mensagens da extensão. `vad.rs`, `attribution.rs`, `echo.rs`: corte em falas, quem falou, eco.
  - `asr/`: Parakeet sobre ONNX Runtime (`ort` fixado em `=2.0.0-rc.10`). `models.rs`: modelos e download.
  - `db.rs`: SQLite, com migrações em ordem. `export.rs`: Markdown.
  - `recorder.rs`: modo de desenvolvedor. Uma pasta por reunião em `recordings/` (dentro da pasta de dados do app, ao lado do banco) com `events.jsonl`, `stream-N.wav`, `audio-index.csv` `meeting.json`, `transcript.jsonl` e `captions.jsonl`; estes três vão sendo escritos durante a reunião (um trecho por vez, as legendas a cada 5 s) e são refeitos do banco no fim. O áudio gravado pula silêncios longos (o microfone manda zeros sem parar; sobram 700 ms de cada lado de um som), então todas as faixas têm intervalos, e `audio-index.csv` e `runs` dizem onde. `speakers.json` (refeito a cada 5 s) diz quem esteve na chamada, quanto cada um falou e em quais faixas, e onde o áudio de cada `stream-N.wav` é contínuo (`runs`); cada linha do `transcript.jsonl` tem `stream` e `others` (quem mais estava audível na faixa durante a fala; `null` quando não se sabe). O formato é o que `replay` e `tools/replay/` leem, o mesmo do antigo `tools/spike-receiver`.
  - `gpu.rs`, `memory.rs`: só Windows.
- `app/desktop/src-tauri/src/main.rs`: comandos Tauri, bandeja, preferências, laço que reinicia o motor quando as configurações mudam.
- `app/desktop/src/`: React 18 e TypeScript, sem biblioteca de componentes nem roteador. `App.tsx` concentra as telas; `api.ts` espelha os comandos e tipos do Rust; `styles.css` é o único CSS.
- `extension/src/`: `page-hook.js` (mundo da página, embrulha o WebRTC; comum às plataformas), `page-meet.js` e `page-teams.js` (o que é de cada plataforma; carregam antes do `page-hook.js`, que os chama), `content.js` (retransmite, lembra o estado da chamada e aplica as configurações), `settings.js` e `popup.html`/`popup.js` (configurações e o menu do botão da extensão), `background.js` (WebSocket), `meet-decode.js` (protobuf do Meet sem esquema), `teams-decode.js` (JSON do Teams), `tap-worklet.js` (cópia do AudioWorklet para o Teams, que recusa o feito de blob).
- `tools/`: reprodução de sessões gravadas e testes da extensão.
- `.github/workflows/release.yml`: ao receber uma etiqueta `v*`, compila o instalador, assina a extensão na Mozilla e publica a versão.

## Comandos

```powershell
cargo test --manifest-path app/core/Cargo.toml       # testes do núcleo
cd app\desktop; npm run build                        # tsc --noEmit e build do Vite
cd app\desktop; npm run tauri dev                    # app em desenvolvimento
cd app\desktop; npm run tauri build                  # instalador NSIS
powershell -ExecutionPolicy Bypass -File extension\build.ps1   # extension\dist\entmoot.xpi
node tools/replay/extension-test.js recordings/<sessão>        # precisa de uma gravação local
node tools/replay/captions-test.js recordings/<sessão>
node tools/replay/teams-test.js recordings/<sessão do Teams>
```

Não há linter nem formatador configurado. `npm run build` é a checagem de tipos da interface.

## Convenções

- Comentários e identificadores em inglês; todo texto que o usuário vê em português do Brasil.
- Comentários dizem o porquê, em frases curtas. Siga o tom dos que já existem.
- Mudou um comando Tauri, `Status`, `Settings` ou `Event`? Atualize `main.rs` do desktop e `api.ts` juntos: os tipos são mantidos à mão dos dois lados.
- Mudou uma mensagem da extensão? Atualize `protocol.rs`, quem a envia em `extension/src/` e os testes em `tools/replay/`.
- Mudança de esquema no banco é uma nova entrada na lista de migrações de `db.rs`, nunca a edição de uma existente.
- `meet-decode.js` e `teams-decode.js` devolvem lista vazia quando um quadro não encaixa, em vez de lançar erro: o Meet e o Teams mudam o formato sem aviso. O que se sabe dos formatos está em `docs/spikes.md`.
- O modo de desenvolvedor é do app, não da extensão: o usuário o liga com F12 dentro do app (`Prefs.dev`, que chega ao servidor por um `watch` sem reiniciar o motor). Com "dump completo" ligado, o servidor manda `{"kind":"dev","full":true}` à extensão; o `background.js` repassa ao `content.js`, que avisa o `page-hook.js` (`hook.dump()`), e as plataformas deixam de limitar os quadros brutos. A extensão não tem opção própria para isso. Mexeu em `DevSettings`? Atualize `recorder.rs`, `main.rs` do desktop e `api.ts` juntos.
- Uma plataforma nova é um arquivo `page-<nome>.js` que define `window.__mtPlatform`, um decodificador e as entradas no `manifest.json`. O `page-hook.js` não deve saber de plataforma nenhuma.
- No Teams a extensão só escuta. Ligar as legendas clicando no botão da página (`page-teams.js`) é uma opção do menu, desligada de fábrica porque ainda não foi conferida ao vivo. Não envie pedidos ao Teams nem leia cabeçalhos: eles levam as credenciais do usuário. Da lista de participantes só saem da página nomes e fontes de áudio.
- Uma opção nova da extensão entra em `settings.js` (valor de fábrica) e em `popup.html`. A página lê as configurações uma vez, ao carregar: o `content.js` as repassa ao `page-hook.js`, que não lê o armazenamento. Com a plataforma desligada, o `content.js` não retransmite nada.
- O usuário local tem `speaker_key` igual a `me`; participantes usam o `deviceId` do Meet (um por aparelho) ou o id da pessoa no Teams (um por pessoa, com uma fonte de áudio por aparelho).
- A reunião termina na mensagem `meeting_end`, e o servidor a fecha e abre outra na mesma conexão: no Teams a página continua aberta depois da chamada, e no Meet a aba fecha mas a conexão é de todas as abas. Quando uma aba em chamada fecha sem avisar, o `background.js` manda o `meeting_end` por ela; quando a última aba fecha, ele fecha o socket. No Meet, sair da chamada com a aba aberta é o fechamento do canal `collections` (`page-meet.js`). Entrar de novo na mesma reunião (mesma plataforma e mesmo `code`) em até 5 minutos continua a reunião salva em vez de criar outra (`REJOIN_WITHIN` em `server.rs`).
- A versão está em cinco arquivos (`extension/manifest.json`, `tauri.conf.json`, `package.json` do desktop e os dois `Cargo.toml`) e muda em todos juntos: o fluxo de lançamento recusa a etiqueta que não bate com eles. A Mozilla assina cada número uma única vez.
- A janela não tem barra de título do Windows (`decorations: false`); os botões estão em `WindowControls.tsx` e as permissões em `capabilities/default.json`.

## Cuidados

- `recordings/`, `data/` e `models/` são locais e ignorados pelo git. As duas primeiras contêm reuniões reais: não copie o conteúdo delas para código, testes, documentação ou imagens.
- As imagens de `docs/screenshots/` usam dados fictícios. Ao refazê-las, use dados fictícios também.
- A porta `17865` e o token `dev` estão fixos no desktop (`main.rs`) e na extensão (`background.js`); mudam juntos.
- O servidor só aceita origens `moz-extension://` e `chrome-extension://`. Não afrouxe isso: qualquer página consegue abrir um socket para localhost.
