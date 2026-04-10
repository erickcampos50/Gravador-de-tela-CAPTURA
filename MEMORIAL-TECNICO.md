# Memorial Técnico

## Visão geral

O projeto é uma aplicação web estática orientada a Chromium para captura de tela, mixagem de áudio, gravação em disco e transcrição com OpenAI. O design prioriza:

- operação local;
- ausência de backend próprio;
- separação clara entre fluxo de gravação e fluxo de transcrição;
- minimização de regressão nas funcionalidades já existentes.

## Objetivos técnicos

- Gravar com estabilidade sem acumular o arquivo inteiro em memória.
- Preservar o comportamento de sessão, pausa, retomada e finalização já existente.
- Acrescentar transcrição sem bloquear o encerramento da gravação.
- Permitir inspeção dos arquivos da pasta escolhida e das transcrições geradas.
- Tratar limites de upload da OpenAI de forma transparente.

## Arquitetura

### Camada de interface

Arquivo principal: `js/app.js`

Responsabilidades:

- montagem dos motores;
- binding de eventos de UI;
- sincronização da máquina de estados;
- gerenciamento da biblioteca de mídia;
- orquestração dos fluxos de transcrição manual e em tempo real.

### Camada de gravação

Arquivos principais:

- `js/recorder-api.js`
- `js/recorder-state-machine.js`
- `js/recorder-core.js`
- `js/audio-mixer.js`
- `js/compositor.js`
- `js/metronome.js`

Papel de cada módulo:

- `RecorderStateMachine`: define estados e transições do ciclo de gravação.
- `RecorderAPI`: concentra aquisição de streams, inicialização do encoder e finalização do arquivo.
- `RecorderCore`: adapta o pipeline de encoding/mux para escrita em stream.
- `AudioMixer`: monta o mix de microfone e áudio do sistema.
- `Compositor`: desenha preview, webcam e timestamp no canvas.
- `Metronome`: agenda os frames de forma estável para o encoder.

### Camada de armazenamento

Arquivo principal: `js/storage.js`

Responsabilidades:

- seleção da pasta via File System Access API;
- persistência do handle da pasta em IndexedDB;
- verificação de permissão;
- leitura e escrita de arquivos texto auxiliares;
- enumeração dos arquivos do diretório.

### Camada de biblioteca de mídia

Arquivo principal: `js/media-library.js`

Responsabilidades:

- identificar arquivos de mídia suportados;
- localizar transcripts relacionados;
- distinguir transcripts finais e transcripts ao vivo;
- abrir e salvar versões de transcript com nomenclatura consistente.

### Camada OpenAI

Arquivos principais:

- `js/openai-client.js`
- `js/transcription-controller.js`

Responsabilidades:

- obter a chave diretamente do campo de senha;
- chamar `POST /v1/audio/transcriptions` com `gpt-4o-transcribe`;
- segmentar o áudio ao vivo em WAVs independentes;
- comprimir e dividir arquivos grandes com `ffmpeg.wasm`;
- reconstruir a transcrição consolidada após vários segmentos.

## Fluxos principais

### 1. Gravação

1. O usuário escolhe a pasta.
2. A aplicação confirma permissão de escrita.
3. O `RecorderAPI` adquire tela, microfone e webcam conforme configuração.
4. O `AudioMixer` gera um `MediaStream` misto.
5. O `RecorderCore` inicia o encoder e escreve direto no arquivo via stream.
6. O `RecorderStateMachine` coordena `start`, `pause`, `resume`, `stop` e `end session`.

### 2. Live transcript

1. A gravação começa.
2. O `AudioMixer` expõe um clone do track de áudio misto.
3. O `TranscriptionController` cria uma sessão de transcrição ao vivo.
4. O áudio é capturado pelo Web Audio, convertido em PCM mono e empacotado em WAV por janela.
5. Cada WAV é enviado para a OpenAI com o prompt atual e contexto do trecho anterior.
6. O texto parcial é mesclado e exibido no painel `Live Transcript`.
7. Ao parar a gravação:
   - o transcript ao vivo acumulado é salvo como arquivo;
   - a transcrição final do arquivo salvo é gerada e também salva.

### 3. Transcrição de arquivo selecionado

1. A aplicação lista os arquivos de mídia da raiz da pasta.
2. O usuário escolhe um item.
3. A UI carrega player de áudio ou vídeo.
4. A `MediaLibrary` procura transcripts relacionados.
5. Ao pedir transcrição:
   - se o arquivo for pequeno, ele é enviado diretamente;
   - se for grande, ele é comprimido e dividido;
   - ao final, o transcript é salvo ao lado do original.

## Estratégia para arquivos grandes

Limite relevante: a API de transcrição aceita arquivos de até 25 MB, então a aplicação trabalha com margem de segurança abaixo disso.

Estratégia:

1. tentar o arquivo original se ele estiver dentro do limite seguro;
2. se exceder, normalizar com `ffmpeg.wasm` para MP3 mono 24 kHz 64 kbps;
3. se ainda exceder, dividir em partes com pequena sobreposição;
4. enviar os segmentos em sequência;
5. usar o transcript anterior como contexto adicional do próximo segmento;
6. fundir o texto final removendo sobreposição redundante.

Essa abordagem é o equivalente em JavaScript ao padrão sugerido com PyDub em ambientes Python.

## Nomenclatura de arquivos

Para um arquivo base `X.ext`:

- transcript final principal:
  - `X-transcript.txt`
- transcript final versionado:
  - `X-transcript-<timestamp>.txt`
- live transcript principal:
  - `X-transcript-live.txt`
- live transcript versionado:
  - `X-transcript-live-<timestamp>.txt`

O timestamp segue o padrão seguro para nome de arquivo gerado por `dateStamp()`.

## Persistência

### `IndexedDB`

Usado para:

- guardar o handle da pasta escolhida.

### `localStorage`

Usado para:

- formato;
- qualidade;
- fps;
- áudio do sistema;
- webcam e microfone escolhidos;
- ganhos de áudio;
- posição do PiP;
- estado dos painéis;
- flag de live transcript;
- último prompt usado.

### Chave da OpenAI

A chave:

- não é persistida pela aplicação;
- é lida diretamente do campo `password`;
- pode ser lembrada pelo navegador via gerenciador de senhas.

## Compatibilidade

Alvos suportados:

- Chrome;
- Edge;
- outros Chromium compatíveis com:
  - File System Access API;
  - `getDisplayMedia`;
  - Service Worker;
  - Web Audio API.

Não é alvo atual:

- Firefox;
- Safari;
- navegação móvel como plataforma principal de uso.

## Service Worker

Arquivo principal: `sw.js`

Função:

- cache-first para assets locais;
- atualização versionada por mudança de `CACHE_NAME`;
- ativação controlada pelo usuário.

Impacto prático:

- mudanças em JS/CSS precisam de revisão da versão de cache para propagação confiável.

## Trade-offs

- Sem backend:
  - simplifica deploy em GitHub Pages;
  - expõe a integração com a OpenAI diretamente no navegador;
  - é aceitável aqui apenas pelo contexto de uso pessoal.

- Live transcript por WAV segmentado:
  - mais robusto para a API que depender de fragmentos sucessivos de `MediaRecorder`;
  - aumenta trabalho de CPU em comparação com um stream nativo mais direto.

- `ffmpeg.wasm` no navegador:
  - evita backend para compressão e chunking;
  - aumenta consumo de memória e tempo em arquivos longos.

## Riscos e pontos de atenção

- Atualizações da OpenAI podem exigir ajustes em mensagens de erro ou parâmetros.
- Arquivos muito longos podem ser lentos para processar em hardware fraco.
- O transcript ao vivo e a transcrição final podem divergir porque usam estratégias diferentes.
- O cache do Service Worker pode mascarar correções se o usuário não atualizar a versão instalada.

## Módulos mais importantes

- `js/app.js`: orquestração geral.
- `js/recorder-api.js`: aquisição de mídia e pipeline de gravação.
- `js/recorder-state-machine.js`: coordenação de estados.
- `js/storage.js`: pasta, permissões e escrita de texto.
- `js/audio-mixer.js`: mixagem e clone do track de áudio.
- `js/media-library.js`: listagem e transcripts relacionados.
- `js/openai-client.js`: chamadas à OpenAI.
- `js/transcription-controller.js`: live transcript, chunking e transcrição consolidada.

## Operação recomendada

- usar Chrome ou Edge atualizados;
- abrir via `https://` ou `localhost`;
- escolher a pasta antes de iniciar qualquer fluxo;
- validar a chave da OpenAI antes de usar live transcript;
- revisar o prompt quando o áudio tiver siglas, nomes próprios ou vocabulário específico.

