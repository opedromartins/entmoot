# Fase 0: spikes de viabilidade no Zen

Objetivo: descobrir, numa reunião real do Meet no Zen, o que a extensão consegue capturar, antes de construir o app.

## Como rodar

1. Na raiz do projeto, inicie o receptor (ele faz o papel do app):

   ```bash
   uv run tools/spike-receiver/receiver.py serve
   ```

2. No Zen, abra `about:debugging#/runtime/this-firefox`, clique em **Carregar extensão temporária** e escolha:

   ```
   <pasta do projeto>\extension\manifest.json
   ```

3. Em `about:addons`, abra a extensão "Transcritor (spike)" e confira na aba **Permissões** se o acesso a `meet.google.com` está ligado.
4. Entre numa reunião do Meet com pelo menos mais uma pessoa falando (uma segunda conta em outro aparelho serve). Fale também. Fique uns 2 minutos, **ligue as legendas (CC) por pelo menos 30 s** e saia.
5. Pare o receptor com Ctrl+C. A sessão fica em `recordings/<data-hora>/` na raiz do projeto.

Depois de qualquer mudança na extensão, clique em **Recarregar** em `about:debugging` e recarregue a aba do Meet.

Se o receptor não mostrar `connected`, abra o console da extensão em `about:debugging` (botão **Inspecionar**) e veja os erros.

## O que cada sessão contém

| Arquivo | Conteúdo |
|---|---|
| `stream-0.wav` | seu microfone |
| `stream-N.wav` | cada faixa de áudio remota |
| `audio-index.csv` | horário de cada quadro de áudio |
| `events.jsonl` | logs do hook, sinais de falante (`speakers`), quadros brutos dos data channels (`raw`) |

Para inspecionar os data channels (lista de participantes, legendas):

```bash
uv run tools/spike-receiver/receiver.py dump recordings/<sessão> --label collections
uv run tools/spike-receiver/receiver.py dump recordings/<sessão> --label captions
uv run tools/spike-receiver/receiver.py dump recordings/<sessão> --label media-session --dir out
```

## Critérios e resultados

### Primeira gravação:

| Spike | Pergunta | Resultado |
|---|---|---|
| S1 | O hook carrega antes do Meet e embrulha o WebRTC? | **Passou.** conexões, data channels e faixas de áudio observados. |
| S2 | Dá para saber quem fala? | **Passou.** Cada faixa remota informa o CSRC de quem está nela, com nível de áudio variando. O canal `collections` liga CSRC → aparelho → nome, e avisa quando a pessoa muta e desmuta. |
| S3 | O áudio sai limpo? | **Passou em parte.** AudioWorklet funcionou sob a CSP do Meet; microfone e faixa remota gravados sem falhas. |
| S4 | Parakeet v3 roda rápido? | **Passou** Modelo PT-BR em precisão cheia: mais rápido que o tempo real. |
| S6 | As legendas do Meet chegam? | **Passou com o CC ligado.** Chegam em `captions_v2` com texto, idioma e aparelho de quem falou, inclusive a própria fala. O canal `captions` que a extensão abre por conta própria não recebeu nada. |

#### O que a gravação ensinou

- O Meet entrega o áudio remoto em faixas por conexão. Uma faixa só produz amostras enquanto alguém está audível nela; o resto do tempo fica sem dados. Por isso os quadros passaram a ser carimbados pelo relógio de áudio.
- O Meet abre mais de uma conexão com faixas de áudio; só uma carregou som.
- O microfone é pedido várias vezes na entrada; cada pedido reinicia a faixa 0.
- Pedido de legendas, visto quando o CC foi ligado: quadro em `captions_v2` com `1 > 2 > { 1: id do pedido, 2 > 1 > { 2: "pt-BR", 3: "pt-BR" } }`. O cliente confirma cada revisão de legenda com `1 > 1 > { 1: messageId, 2: versão, 3: 1 }`. Isso é o que seria preciso reproduzir para ter legendas sem o CC.
- Um CSRC fixo de valor 42 aparece junto com o do participante; é ignorado.

- Esse pedido é feito automaticamente ao entrar (ver README). Detalhes vistos depois: o quadro é `{ 1: conteúdo }` ou, em legendas longas, `{ 2: gzip(conteúdo) }` (o decodificador perdia estas); a confirmação repete `messageId` e versão e põe `1` no campo que trazia o conteúdo (3 para legenda, 4 e 6 para entradas de controle). Não foi gravado o que o Meet envia ao desligar o CC, nem testado ao vivo se o Meet confirma legendas que ele não pediu.

### Segunda gravação

Feita ainda com a versão antiga da extensão (sem os eventos decodificados e sem o horário corrigido); os quadros brutos foram decodificados depois, com o decodificador da extensão, para um `decoded.jsonl` ao lado da gravação (o `replay` ainda o lê).

- Cada pessoa remota ficou numa faixa própria, com seu CSRC, e o canal `collections` deu o nome de cada uma.
- Depois que a pessoa desmuta pela primeira vez, a faixa passa a produzir áudio contínuo, inclusive silêncio.
- Reprocessada pelo núcleo em Rust: 47 trechos, nenhum com falante desconhecido. Dos 25 trechos remotos que coincidem no tempo com uma legenda do Meet, 22 têm o mesmo falante da legenda; os outros 3 são falas curtas que o Meet não legendou e que se sobrepõem à legenda de outra pessoa.
- O microfone gerou vários trechos sem texto (ruído ou eco), descartados.

#### Defeitos encontrados e corrigidos

- Os metadados das faixas remotas eram enviados como quadro de áudio vazio (campo `kind` sobrescrito).
- O horário dos quadros era contado desde o início da faixa, o que estaria errado para faixas com silêncio no meio.

## Teams (web, no Zen)

Objetivo: descobrir o que o Teams envia antes de decidir como dar suporte a ele. Durante o spike, nos domínios do Teams (`teams.microsoft.com`, `teams.cloud.microsoft`, `teams.live.com`), o `page-hook.js` tinha um modo de exploração: além do áudio e dos sinais de falante, encaminhava o que ainda não entendia. Esse modo foi retirado quando o suporte foi escrito (`page-teams.js` e `teams-decode.js`); para gravar de novo o que o Teams envia, ele precisa ser refeito. As gravações desta seção foram feitas com ele.

O que a exploração registrava em `events.jsonl`:

| Evento | Conteúdo |
|---|---|
| `raw` com rótulo do canal | quadros de todos os data channels, nos dois sentidos |
| `raw` com rótulo `ws:<endereço>` | quadros dos WebSockets abertos pela página, nos dois sentidos |
| `raw` com rótulo `http:<método endereço>` | respostas de pedidos que parecem tratar de chamada, lista ou legendas |
| `log` `http`, `socket`, `worker` | cada endereço pedido, cada socket e cada worker criado, uma vez |
| `log` `sdp` | as seções de mídia que o servidor descreve: faixas, SSRC, `msid` |
| `log` `inbound` | o que cada faixa remota recebe, a cada 2 s |
| `log` `dom-captions`, `dom-mic` | atributos e tamanhos de texto das legendas e do botão de microfone na tela; o texto em si não é copiado |
| `log` `location` | endereço da página, com só o começo de cada parâmetro |

Sockets e pedidos feitos dentro de um worker não eram vistos; o evento `worker` dizia se havia algum.

### Como foi gravado

Com o receptor no lugar do app. Uma reunião por tipo de conta (corporativa e pessoal), de alguns minutos, com pelo menos duas outras pessoas:

1. Todos falam, um de cada vez e depois ao mesmo tempo.
2. Alguém muta e desmuta; você também.
3. Alguém sai e volta.
4. Ligue as legendas por 30 s e desligue.
5. Saia da reunião sem fechar a aba, espere uns 10 s e pare o receptor.

As gravações podem conter tokens de sessão do Teams, além da conversa. Ficam em `recordings/`, como as outras.

Para ler:

```bash
uv run tools/spike-receiver/receiver.py dump recordings/<sessão> --label "ws:<endereço>"
```

### Perguntas

| | Pergunta | Resultado |
|---|---|---|
| T1 | O hook carrega antes do Teams, inclusive em iframe, e vê as conexões? | **Passou.** Carregou na página de entrada, em `/v2/` e num iframe de login. 2 conexões (uma usada), 1 data channel, 1 WebSocket. Há workers, mas a sinalização passa pela página. |
| T2 | Quantas faixas de áudio remoto? Uma por pessoa, algumas para os mais altos, ou tudo misturado? | **Tudo misturado**: uma única faixa de áudio, mais 11 de vídeo. |
| T3 | As faixas trazem CSRC ou SSRC com nível de áudio que mude com quem fala? | **Passou em parte.** A faixa traz um CSRC por pessoa audível, sem nível de áudio. O horário do último pacote de cada CSRC só avança enquanto a pessoa fala: conferido contra as legendas, o CSRC de quem foi legendado estava ativo em todas as 10 falas remotas. |
| T4 | De onde vem a lista de participantes, e existe um id que ligue a fonte de áudio ao nome? Qual é o do próprio usuário? | **Passou.** A resposta HTTP de entrada traz todos; quem muda depois chega pelo WebSocket. Cada pessoa tem nome e, por aparelho, um `sourceId` de áudio igual ao CSRC. O próprio aparelho é o que a página nomeia no pedido de entrada. |
| T5 | As legendas chegam pela rede ou só na tela? Só com elas ligadas? Dizem quem falou? | **Passou.** Chegam no data channel, em JSON, com id e nome de quem falou, inclusive a própria fala. Chegam mesmo com as legendas desligadas neste aparelho, desde que alguém na reunião as tenha ligado. |
| T6 | O mudo aparece nas estatísticas de envio como no Meet? Qual o botão na tela? | **Passou, de outro jeito.** Com o AudioWorklet, a faixa do microfone não produz amostra nenhuma enquanto o Teams está no mudo. A lista também informa o mudo de cada aparelho. Botão: `#microphone-button`, com o estado em `data-state`. |
| T7 | O que identifica a reunião (endereço, título) e o fim dela? | **Passou.** O número da reunião está no endereço só ao carregar (`#/meet/<número>`); depois some. O título da aba é "Reunião com <organizador> | Microsoft Teams", com "Ingresso na reunião | " na frente nos primeiros segundos. O fim: a faixa remota termina e o data channel fecha; a página não descarrega. |
| T8 | Conta corporativa e pessoal se comportam igual? | **Passou.** Mesma faixa única, mesmo CSRC, mesmo canal, mesmo WebSocket, mesmo formato de lista, de legendas e de pedido de entrada. Muda o endereço do serviço de chamadas, e o número da reunião não aparece no endereço da página. |

### Gravação de conta corporativa

**Áudio.** Uma faixa remota (`mid` 0) com todos misturados, contínua. O AudioWorklet não carregou (`AbortError`, provavelmente a CSP do Teams); a captura caiu no ScriptProcessor e gravou as duas faixas inteiras.

**Quem fala.** `getContributingSources()` devolve um CSRC por pessoa audível na mistura, sem `audioLevel`. O `timestamp` de cada um só avança em alguns trechos. Nas legendas de pessoas remotas, o CSRC da pessoa legendada esteve ativo no trecho da fala; na maioria foi o único ou o mais ativo, e a outra é uma fala sobreposta à de outra pessoa. Hoje o `SpeakerTimeline` descarta relatos sem nível, então nada seria atribuído sem mudança. A própria fala não aparece na mistura.

**Canal `main-channel`** (aberto pela página). Cada quadro tem um cabeçalho binário curto e depois JSON:

- `[{ "type": "dsh", "history": [sourceId, ...] }]`: histórico de falante dominante, o mais recente primeiro; inclui o próprio usuário. Só 10 quadros na reunião: serve de conferência, não de linha do tempo.
- `heartbeat`, `bwe`, `syn`, `ack`: controle.
- `{ "version", "recognitionResults": [...] }`: legendas. Cada resultado traz `userId`, `displayName`, `id` (`<sessão>/<n>`, um por revisão), `text`, `isFinal`, `spokenLanguage`, `timestampAudioSent` e `duration`. Uma fala é revisada por resultados sucessivos até um com `isFinal: true`.
- `{ "version", "events": [...] }`: avisos como `LanguageMismatch`.

**Lista de participantes.** Vem da resposta de `POST .../api/v2/epconv` e de `POST .../conv/<id>` (em `api.flightproxy.teams.microsoft.com`), em `roster.participants`, um objeto cuja chave é o id da pessoa (`8:orgid:<guid>` para conta corporativa, `8:live:...` para pessoal, `28:...` para robôs):

```
details.displayName
endpoints.<id>.call.mediaStreams[] : { type: "audio", sourceId, direction, serverMuted }
endpoints.<id>.endpointState.state.isMuted
state : "active" | "inactive"
```

As mudanças chegam pelo WebSocket `go.trouter.teams.microsoft.com/v4/c`, em quadros `3:::{json}` que imitam um pedido HTTP; os de URL terminada em `conversation/rosterUpdate/` têm no `body` um JSON em gzip e base64 com `participants` no mesmo formato (`type: "Delta"`). A página responde a cada um; a extensão só escuta.

- Uma pessoa pode ter mais de um aparelho, cada um com seu `sourceId`.
- Quem está na sala de espera aparece com `endpoints.<id>.lobby` em vez de `call`, sem `sourceId`.
- Quem sai fica com `state: "inactive"` e sem aparelhos.
- Ligar as legendas faz entrar um robô (`28:...`, áudio `recvonly`) e marca `endpointMetadata.transcriptionPrefs.closedCaptions` no aparelho de quem ligou. Os primeiros resultados chegaram 30 s depois, aparentemente na primeira fala.
- `callEnd` chega pelo mesmo WebSocket ao sair.

**Na tela.** As legendas ficam em `[data-tid="closed-caption-renderer-wrapper"]`, numa lista virtual; não é preciso lê-las dali, já que chegam pela rede. O botão que as liga é `#closed-captions-button`.

**Defeitos do modo de exploração vistos na gravação.** Depois de sair da reunião, o título da aba seguinte foi enviado como se fosse o da reunião: `inCall` nunca volta a falso no Teams. O `code` da reunião vai vazio.

**Segunda rodada.** Para os pontos abaixo, o modo de exploração passou a gravar também: o corpo dos pedidos que a página faz ao serviço de chamadas (`raw` com `dir: "out"` e rótulo `http:`), cada amostra de `mic-sending` com o estado do botão de microfone, e a tentativa de carregar o AudioWorklet de um arquivo da extensão quando o blob falha (`worklet` com `via`). O número da reunião é lido do endereço ao carregar, e `call-end` marca o fim da faixa remota.

### Segunda gravação

**AudioWorklet.** O blob falhou de novo com `AbortError`; o arquivo da extensão (`tap-worklet.js`, em `web_accessible_resources`) carregou. Com o worklet, as faixas só produzem amostras quando há som: 63 s na remota e 100 s no microfone.

**O próprio aparelho.** Os pedidos da página ao serviço de chamadas (`POST .../epconv`, `POST .../conv/<id>`, `updateEndpointState`, `leave`) levam `participants.from` (ou `from`) com `id` e `endpointId`. Esse `endpointId` é a chave do aparelho em `endpoints` na lista, e dali sai o `sourceId` próprio, que nunca aparece como CSRC.

**Mudo.** O microfone gravou 100 s, a soma exata dos trechos em que a lista dava o aparelho como aberto; nos trechos em mudo não chegou nenhum quadro, e não há legenda do usuário neles. Aberto e em silêncio, os pacotes enviados têm de 0 a 2 ou de 17 a 29 bytes; com voz, quase sempre 50 ou mais. A página avisa cada mudança em `updateEndpointState`, com `endpointState.state.isMuted`. Na primeira gravação, com ScriptProcessor, a faixa do microfone era contínua: a garantia depende do worklet.

**Legendas.** A reunião já tinha as legendas ligadas por outro aparelho (o robô `28:...` estava na lista de entrada). Este aparelho as teve desligadas por dois minutos (`transcriptionPrefs.closedCaptions: false`) e os resultados continuaram chegando no `main-channel`. Ligar e desligar aqui é um `PUT .../conv/<id>/<...>` com essa preferência. Não foi visto o que acontece quando ninguém mais as tem ligadas.

**Quem fala.** A mistura listou no máximo 2 CSRC ao mesmo tempo. Com duas pessoas falando juntas por 12 s, os dois CSRC avançaram juntos. Em todas as 20 legendas de pessoas remotas o CSRC de quem falou estava ativo no trecho.

**Para o desenho.** O título mais longo é o provisório ("Ingresso na reunião | ..."), e `session.rs` hoje fica com o mais longo. Uma pessoa com dois aparelhos tem um id só e dois `sourceId`.

### Terceira gravação (conta pessoal)

O arquivo também traz, no começo, eventos de uma aba anterior que estavam na fila da extensão; a análise usou só os da aba da reunião.

- **Igual à conta corporativa:** uma faixa remota misturada, CSRC igual ao `sourceId` da lista, `main-channel` com `dsh` e `bwe`, o WebSocket `go.trouter.teams.microsoft.com` com `rosterUpdate`, o formato de `roster.participants` com `endpointState.state.isMuted`, o botão `#microphone-button` e o AudioWorklet (blob recusado, arquivo da extensão aceito).
- **Diferente:** o serviço de chamadas fica em `api.flightproxy.skype.com/api/v2/cp/...` (`cpconv` em vez de `epconv`). Os ids são `8:live:...` para a conta e `8:guest:...` para convidado. O título da aba é "Reunir | Meeting with <nome> | Microsoft Teams", com "Reunir | Ingresso na reunião | Reunião do Microsoft Teams | ..." antes.

### Quarta gravação (conta pessoal)

Fecha o que a terceira deixou em aberto.

- **Legendas:** mesmo formato da conta corporativa, no `main-channel`. Nas 3 legendas da pessoa remota o CSRC dela estava ativo.
- **O próprio aparelho:** os pedidos a `api.flightproxy.skype.com` levam `participants.from` com `id` e `endpointId`, como na conta corporativa.
- **Ligar as legendas**, visto por inteiro: a página faz um `POST .../v2/oncommand/<...>` (com `action`, `mode` e `processingModes`), o robô `28:...` entra na lista com `closedCaptions.state` passando de `Inactive` a `Active`, e a página marca a própria preferência com o `PUT`. A primeira legenda chegou 2 s depois.
- **Mudo:** `updateEndpointState` com `isMuted` a cada mudança, e a lista reflete em menos de 1 s.

### As gravações pelo núcleo inteiro

Com o suporte escrito, três gravações foram convertidas para o que a extensão enviaria hoje e passadas por `transcritor replay` (modelo `parakeet-v3-int8`, na CPU):

| Gravação | Trechos | Falante desconhecido | Trechos remotos com legenda no mesmo instante | Mesmo falante da legenda |
|---|---|---|---|---|
| primeira (corporativa) | 51 | 0 | 10 | 10 |
| segunda (corporativa) | 33 | 0 | 14 | 14 |
| quarta (pessoal) | 5 | 0 | 3 | 3 |

Na segunda e na quarta, as falas do microfone saíram com o nome do usuário, tirado do pedido de entrada. A primeira não tem esse pedido gravado. A conversão foi feita por um script avulso, que não está no repositório.

### Primeira reunião ao vivo com sala de espera

Nenhuma gravação tinha sala de espera. Na primeira reunião real com uma, os diagnósticos do app mostraram que o Teams troca de conexão quando o usuário é admitido: a espera acontece numa conexão, com faixa de áudio remota e microfone próprios, e a chamada em outra, criada cerca de 2 s antes de a primeira fechar. A faixa remota da espera termina só depois de a nova chegar, e a faixa do microfone antigo continua viva sem produzir amostras.

A extensão tratava o fim da primeira faixa como fim da chamada e mantinha o microfone na conexão fechada: a reunião seguia no app sem plataforma nem título, e as falas do usuário não eram transcritas. Agora a chamada só termina quando a última faixa remota termina, e o microfone passa para a conexão que estiver aberta. O `teams-test.js` cobre a troca com um cenário montado à mão, não com uma gravação.

## Decisões que saem daqui

- Qual sinal de falante vira o principal (CSRC, destaque no DOM, ou os dois).
- Se dá para transcrever cada faixa remota separadamente.
- Formato real das legendas e da lista de participantes no Firefox, para escrever os decodificadores.
- Se é preciso pedir as legendas ativamente (o que o Meet envia em `media-session` quando o CC é ligado mostra como).
