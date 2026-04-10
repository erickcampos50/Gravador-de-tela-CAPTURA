# Gravador de Reuniões

Aplicação web estática para gravação de tela, áudio e webcam com salvamento direto em disco e suporte a transcrição via OpenAI.
O projeto foi inspirado no excelente [Captura Web Recorder](https://mathewsachin.github.io/) do Mathew Sachin e também no NamoradaGPT.

## O que a ferramenta faz

- Grava tela com overlay opcional de webcam.
- Mistura áudio do sistema e microfone com controle de ganho.
- Salva gravações diretamente na pasta escolhida pelo usuário.
- Lista os arquivos de áudio e vídeo da pasta selecionada.
- Permite reproduzir o arquivo selecionado e visualizar suas transcrições relacionadas.
- Gera transcrição do arquivo selecionado.
- Gera transcrição com timestamps por segmento ou diarização com speaker labels em texto legível.
- Gera transcrição em tempo real durante a gravação.
- Salva o transcript ao vivo e a transcrição final ao lado do arquivo original.
- Permite copiar ou salvar o resultado reformulado da transcrição.
- Divide arquivos grandes automaticamente antes de enviar para a API da OpenAI.

## Requisitos

- Chrome ou Edge recentes.
- Ambiente seguro para o navegador:
  - `https://` em hospedagem;
  - `http://localhost` em desenvolvimento.
- Chave da OpenAI para usar as transcrições.

## Como executar localmente

Como a aplicação usa módulos ES, Service Worker e File System Access API, abra por um servidor estático, não por `file://`.

Exemplo:

```bash
python3 -m http.server 4173
```

Depois acesse:

```text
http://localhost:4173
```

## Como usar

### Gravação

1. Clique em `Choose Folder`.
2. Escolha a pasta onde as gravações e transcripts serão salvos.
3. Configure webcam, microfone, formato e qualidade.
4. Clique em `Start Recording`.
5. Use `Pause`, `Resume`, `Stop` e `End Session` conforme necessário.

### Transcrição de arquivo

1. Expanda o painel `OpenAI Key`.
2. Informe sua chave da OpenAI no campo de senha.
3. Opcionalmente preencha `Transcription prompt`.
4. Em `Modo de transcrição`, escolha entre:
   - `Texto normal`;
   - `Segmentos com timestamp`;
   - `Diarização`.
5. Na lista `Files In Chosen Folder`, selecione um arquivo.
6. Use `Transcribe Selected File` para gerar a primeira transcrição.
7. Use `Generate New Version` para criar uma nova versão sem sobrescrever a anterior.
8. No bloco `Resultado reformulado`, copie ou salve o texto com os botões discretos ao lado do título.

### Live transcript

1. Preencha a chave da OpenAI.
2. Ative `Enable live transcription while recording`.
3. Inicie a gravação.
4. O texto parcial aparece em `Live Transcript`.
5. Ao encerrar a gravação, a aplicação salva:
   - o transcript ao vivo acumulado;
   - a transcrição final do arquivo gravado.

## Prompt complementar

O campo `Transcription prompt` existe para melhorar a qualidade da transcrição com contexto adicional, por exemplo:

- assunto esperado do áudio;
- grafia correta de nomes, siglas e termos técnicos;
- instruções de pontuação;
- preservação de palavras de preenchimento;
- estilo linguístico desejado.

O último prompt fica salvo no navegador em `localStorage`.

## Como os arquivos são salvos

Para um arquivo `recording-2026-04-10T10-00-00.webm`, os arquivos de transcript podem ser:

- `recording-2026-04-10T10-00-00-transcript.txt`
- `recording-2026-04-10T10-00-00-transcript-segmentos.txt`
- `recording-2026-04-10T10-00-00-transcript-diarizado.txt`
- `recording-2026-04-10T10-00-00-transcript-live.txt`
- `recording-2026-04-10T10-00-00-transcript-reformulado.txt`
- `recording-2026-04-10T10-00-00-transcript-2026-04-10T10-15-00.txt`
- `recording-2026-04-10T10-00-00-transcript-live-2026-04-10T10-15-00.txt`
- `recording-2026-04-10T10-00-00-transcript-reformulado-2026-04-10T10-15-00.txt`

Regras:

- a primeira transcrição final usa `-transcript.txt`;
- timestamps e diarização usam sufixos descritivos antes da versão timestampada;
- o live transcript usa `-transcript-live.txt`;
- o resultado reformulado usa `-transcript-reformulado.txt`;
- novas versões recebem timestamp;
- todos os arquivos ficam na mesma pasta do original.

## Segurança da chave da OpenAI

- A chave é digitada no formulário da própria aplicação.
- A aplicação não salva a chave em `localStorage` nem em `IndexedDB`.
- O Chrome pode lembrar a chave usando o gerenciador de senhas do navegador.
- Quando você usa a transcrição, o áudio é enviado diretamente do navegador para a API da OpenAI.

Isso é adequado para o cenário atual de uso pessoal, mas não para um produto público sem backend.

## Limitações conhecidas

- A aplicação depende de APIs específicas de navegadores Chromium.
- Firefox não suporta o fluxo atual de gravação em disco.
- O live transcript pode apresentar diferenças em relação à transcrição final do arquivo salvo.
- Arquivos grandes podem levar tempo extra por causa da compressão e divisão local no navegador.
- A listagem de mídia considera apenas a raiz da pasta escolhida.

## Estrutura principal

```text
index.html
recorder.css
sw.js
js/app.js
js/recorder-api.js
js/recorder-state-machine.js
js/storage.js
js/audio-mixer.js
js/media-library.js
js/openai-client.js
js/transcription-controller.js
```

## Rodapé

<details>
<summary>Guia rápido de transcrição e revisão</summary>

- `Texto normal`: é a transcrição mais simples e direta. Use quando o objetivo for leitura corrida.
- `Segmentos com timestamp`: divide o texto em blocos com início e fim. É melhor para revisar trechos e localizar falas.
- `Diarização`: tenta identificar quem falou em cada segmento. É o mais útil em reuniões com várias pessoas.

Recomendação prática:

- avalie o resultado final de cada modo antes de escolher o que vai arquivar;
- quando a reunião tiver participantes múltiplos, compare a diarização com o modo de timestamp;
- quando o áudio for limpo e o objetivo for registro rápido, o modo normal costuma ser suficiente.

</details>

## Documentação adicional

- Memorial técnico: [MEMORIAL-TECNICO.md](./MEMORIAL-TECNICO.md)
