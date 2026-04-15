const OPENAI_TRANSCRIPTIONS_ENDPOINT = 'https://api.openai.com/v1/audio/transcriptions';
const OPENAI_RESPONSES_ENDPOINT = 'https://api.openai.com/v1/responses';
const ASSEMBLYAI_BASE_URL = 'https://api.assemblyai.com';

const OPENAI_TRANSCRIPTION_MODELS = [
  'gpt-4o-transcribe',
  'gpt-4o-mini-transcribe',
  'whisper-1',
];
const DEFAULT_OPENAI_TRANSCRIPTION_MODEL = OPENAI_TRANSCRIPTION_MODELS[0];

export const TRANSCRIPTION_ENGINES = {
  assemblyai: 'assemblyai',
  openai: 'openai',
};

export const TRANSCRIPTION_ENGINE_LABELS = {
  [TRANSCRIPTION_ENGINES.assemblyai]: 'AssemblyAI',
  [TRANSCRIPTION_ENGINES.openai]: 'OpenAI',
};

export const POSTPROCESS_MODELS = [
  'gpt-5.4-mini',
  'gpt-5.4',
];

export const DEFAULT_POSTPROCESS_MODEL = POSTPROCESS_MODELS[0];
const DEFAULT_POSTPROCESS_PROMPT = 'Reescreva a transcrição em português do Brasil, com clareza, boa fluidez e preservando o sentido original. Retorne apenas o texto final.';
const OPENAI_REQUEST_TIMEOUT_MS = 5 * 60 * 1000;
const ASSEMBLYAI_REQUEST_TIMEOUT_MS = 10 * 60 * 1000;
const ASSEMBLYAI_POLL_INTERVAL_MS = 3_000;
const OPENAI_RETRYABLE_STATUS = new Set([401, 403, 404]);
const OPENAI_RETRYABLE_MESSAGE_RE = /(model|access|permission|available|not found|does not exist|unsupported)/i;

export const TRANSCRIPTION_OUTPUT_MODES = {
  plain: 'plain',
  timestamps: 'timestamps',
  diarized: 'diarized',
};

export const TRANSCRIPTION_OUTPUT_MODE_LABELS = {
  [TRANSCRIPTION_OUTPUT_MODES.plain]: 'Texto normal',
  [TRANSCRIPTION_OUTPUT_MODES.timestamps]: 'Segmentos com timestamp',
  [TRANSCRIPTION_OUTPUT_MODES.diarized]: 'Diarização',
};

export const TRANSCRIPTION_OUTPUT_MODE_SUFFIXES = {
  [TRANSCRIPTION_OUTPUT_MODES.plain]: '',
  [TRANSCRIPTION_OUTPUT_MODES.timestamps]: 'segmentos',
  [TRANSCRIPTION_OUTPUT_MODES.diarized]: 'diarizado',
};

class OpenAIRequestError extends Error {
  constructor(message, { status = null, model = '', requestId = '', cause = null } = {}) {
    super(message);
    this.name = 'OpenAIRequestError';
    this.status = status;
    this.model = model;
    this.requestId = requestId;
    if (cause) this.cause = cause;
  }
}

export class TranscriptionConfigError extends Error {
  constructor(message, { name = 'TranscriptionConfigError', title = 'Configuração obrigatória', engine = '' } = {}) {
    super(message);
    this.name = name;
    this.title = title;
    this.engine = engine;
  }
}

export class OpenAIConfigError extends TranscriptionConfigError {
  constructor(message) {
    super(message, {
      name: 'OpenAIConfigError',
      title: 'Chave da API da OpenAI obrigatória',
      engine: TRANSCRIPTION_ENGINES.openai,
    });
  }
}

export class AssemblyAIConfigError extends TranscriptionConfigError {
  constructor(message) {
    super(message, {
      name: 'AssemblyAIConfigError',
      title: 'Chave da API da AssemblyAI obrigatória',
      engine: TRANSCRIPTION_ENGINES.assemblyai,
    });
  }
}

function createRequestSignal(signal, timeoutMs) {
  const controller = new AbortController();
  let timeoutId = null;
  let timedOut = false;

  const forwardAbort = () => controller.abort();

  if (signal) {
    if (signal.aborted) {
      controller.abort();
    } else {
      signal.addEventListener('abort', forwardAbort, { once: true });
    }
  }

  if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
    timeoutId = globalThis.setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
  }

  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    cleanup() {
      if (timeoutId !== null) globalThis.clearTimeout(timeoutId);
      if (signal) signal.removeEventListener('abort', forwardAbort);
    },
  };
}

function isLikelyBrowserFetchError(error) {
  return error instanceof TypeError && /Failed to fetch/i.test(error.message || '');
}

function formatTimeoutLabel(timeoutMs) {
  const minutes = Math.max(1, Math.round(timeoutMs / 60_000));
  return `${minutes} minuto${minutes === 1 ? '' : 's'}`;
}

function extractResponseText(data) {
  if (typeof data?.output_text === 'string' && data.output_text.trim()) {
    return data.output_text.trim();
  }

  if (!Array.isArray(data?.output)) return '';

  const parts = [];
  data.output.forEach(item => {
    if (!Array.isArray(item?.content)) return;
    item.content.forEach(contentItem => {
      if (typeof contentItem?.text === 'string' && contentItem.text.trim()) {
        parts.push(contentItem.text.trim());
      }
    });
  });

  return parts.join('\n\n').trim();
}

function normalizeTranscriptionSegments(data) {
  if (!Array.isArray(data?.segments)) return [];

  return data.segments
    .map(segment => {
      const text = typeof segment?.text === 'string' ? segment.text.trim() : '';
      if (!text) return null;

      const start = Number(segment?.start);
      const end = Number(segment?.end);

      return {
        id: typeof segment?.id === 'string' ? segment.id : '',
        start: Number.isFinite(start) ? start : 0,
        end: Number.isFinite(end) ? end : 0,
        text,
        speaker: typeof segment?.speaker === 'string' ? segment.speaker.trim() : '',
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.start - b.start || a.end - b.end || a.text.localeCompare(b.text, undefined, { sensitivity: 'base' }));
}

async function parseOpenAiErrorMessage(response) {
  const contentType = response.headers.get('content-type') || '';
  const requestId = response.headers.get('x-request-id') || response.headers.get('openai-request-id') || '';
  if (contentType.includes('application/json')) {
    try {
      const data = await response.json();
      const message = data?.error?.message || data?.message || `A requisição para a OpenAI falhou com status ${response.status}.`;
      return requestId ? `${message} (request id: ${requestId})` : message;
    } catch (_) {
      // Ignore JSON parse failures and fall back to a generic message.
    }
  }

  const text = await response.text().catch(() => '');
  const message = text || `A requisição para a OpenAI falhou com status ${response.status}.`;
  return requestId ? `${message} (request id: ${requestId})` : message;
}

async function readOpenAiErrorResponse(response, model) {
  return new OpenAIRequestError(await parseOpenAiErrorMessage(response), {
    status: response.status,
    model,
    requestId: response.headers.get('x-request-id') || response.headers.get('openai-request-id') || '',
  });
}

function shouldRetryTranscriptionError(error, model, models) {
  if (!(error instanceof OpenAIRequestError)) return false;
  if (!OPENAI_RETRYABLE_STATUS.has(error.status)) return false;
  if (!OPENAI_RETRYABLE_MESSAGE_RE.test(error.message)) return false;
  return model !== models[models.length - 1];
}

async function parseAssemblyAiErrorMessage(response) {
  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    try {
      const data = await response.json();
      return data?.error || data?.message || `A requisição para a AssemblyAI falhou com status ${response.status}.`;
    } catch (_) {
      // Ignore JSON parse failures and fall back to a generic message.
    }
  }

  const text = await response.text().catch(() => '');
  return text || `A requisição para a AssemblyAI falhou com status ${response.status}.`;
}

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    const timeoutId = globalThis.setTimeout(() => {
      cleanup();
      resolve();
    }, ms);

    const onAbort = () => {
      cleanup();
      reject(new DOMException('A operação foi cancelada.', 'AbortError'));
    };

    const cleanup = () => {
      globalThis.clearTimeout(timeoutId);
      signal?.removeEventListener('abort', onAbort);
    };

    if (signal) {
      if (signal.aborted) {
        cleanup();
        reject(new DOMException('A operação foi cancelada.', 'AbortError'));
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

export class OpenAIClientManager {
  #apiKeyInput;

  engine = TRANSCRIPTION_ENGINES.openai;
  supportsPrompt = true;
  supportsStructuredTranscription = true;
  supportsPostProcess = true;
  supportedModes = new Set(Object.values(TRANSCRIPTION_OUTPUT_MODES));

  constructor(apiKeyInput) {
    this.#apiKeyInput = apiKeyInput;
  }

  getApiKey() {
    return this.#apiKeyInput?.value.trim() || '';
  }

  assertConfigured() {
    const apiKey = this.getApiKey();
    if (!apiKey) {
      throw new OpenAIConfigError('Preencha sua chave da API da OpenAI antes de usar a transcrição ou o pós-processamento.');
    }
    return apiKey;
  }

  async transcribeFile({ file, prompt = '', signal, model } = {}) {
    const apiKey = this.assertConfigured();
    if (!(file instanceof File)) {
      throw new Error('Nenhum arquivo de áudio foi enviado para transcrição.');
    }

    const models = [...new Set([model || DEFAULT_OPENAI_TRANSCRIPTION_MODEL, ...OPENAI_TRANSCRIPTION_MODELS])];
    let lastError = null;

    for (const candidateModel of models) {
      try {
        return await this.#transcribeFileOnce({
          apiKey,
          file,
          prompt,
          signal,
          model: candidateModel,
        });
      } catch (error) {
        lastError = error;
        if (!shouldRetryTranscriptionError(error, candidateModel, models)) {
          throw error;
        }
      }
    }

    if (lastError) throw lastError;
    throw new Error('Não foi possível transcrever o arquivo selecionado.');
  }

  async transcribeFileDetailed({ file, prompt = '', signal, mode = TRANSCRIPTION_OUTPUT_MODES.timestamps } = {}) {
    const apiKey = this.assertConfigured();
    if (!(file instanceof File)) {
      throw new Error('Nenhum arquivo de áudio foi enviado para transcrição.');
    }

    if (mode === TRANSCRIPTION_OUTPUT_MODES.timestamps) {
      return await this.#transcribeStructuredFileOnce({
        apiKey,
        file,
        prompt,
        signal,
        model: 'whisper-1',
        responseFormat: 'verbose_json',
        timestampGranularities: ['segment'],
      });
    }

    if (mode === TRANSCRIPTION_OUTPUT_MODES.diarized) {
      return await this.#transcribeStructuredFileOnce({
        apiKey,
        file,
        signal,
        model: 'gpt-4o-transcribe-diarize',
        responseFormat: 'diarized_json',
        chunkingStrategy: 'auto',
      });
    }

    throw new Error(`Modo de transcrição estruturada inválido: ${mode}.`);
  }

  async #transcribeFileOnce({ apiKey, file, prompt, signal, model }) {
    const formData = new FormData();
    formData.append('file', file, file.name || 'audio.webm');
    formData.append('model', model);
    if (prompt.trim()) formData.append('prompt', prompt.trim());

    const { signal: requestSignal, timedOut, cleanup } = createRequestSignal(signal, OPENAI_REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(OPENAI_TRANSCRIPTIONS_ENDPOINT, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
        body: formData,
        signal: requestSignal,
      });

      if (!response.ok) {
        throw await readOpenAiErrorResponse(response, model);
      }

      const contentType = response.headers.get('content-type') || '';
      if (contentType.includes('application/json')) {
        const data = await response.json();
        return typeof data?.text === 'string' ? data.text.trim() : '';
      }

      return (await response.text()).trim();
    } catch (error) {
      if (timedOut()) {
        throw new Error(`A transcrição com ${model} excedeu o tempo limite de ${formatTimeoutLabel(OPENAI_REQUEST_TIMEOUT_MS)}.`);
      }

      if (isLikelyBrowserFetchError(error)) {
        throw new Error(
          `Não foi possível conectar à OpenAI ao transcrever com ${model}. ` +
          'Verifique a chave, a conexão e se o navegador permite essa requisição a partir da origem local.'
        );
      }

      throw error;
    } finally {
      cleanup();
    }
  }

  async #transcribeStructuredFileOnce({
    apiKey,
    file,
    prompt = '',
    signal,
    model,
    responseFormat,
    timestampGranularities = [],
    chunkingStrategy = '',
  }) {
    const formData = new FormData();
    formData.append('file', file, file.name || 'audio.webm');
    formData.append('model', model);
    if (prompt.trim() && responseFormat !== 'diarized_json') formData.append('prompt', prompt.trim());
    if (responseFormat) formData.append('response_format', responseFormat);
    timestampGranularities.forEach(value => formData.append('timestamp_granularities[]', value));
    if (chunkingStrategy) formData.append('chunking_strategy', chunkingStrategy);

    const { signal: requestSignal, timedOut, cleanup } = createRequestSignal(signal, OPENAI_REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(OPENAI_TRANSCRIPTIONS_ENDPOINT, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
        body: formData,
        signal: requestSignal,
      });

      if (!response.ok) {
        throw await readOpenAiErrorResponse(response, model);
      }

      const contentType = response.headers.get('content-type') || '';
      if (!contentType.includes('application/json')) {
        const text = (await response.text()).trim();
        return { text, raw: null, segments: [], model };
      }

      const data = await response.json();
      const text = typeof data?.text === 'string'
        ? data.text.trim()
        : extractResponseText(data);

      return {
        text,
        raw: data,
        segments: normalizeTranscriptionSegments(data),
        model,
      };
    } catch (error) {
      if (timedOut()) {
        throw new Error(`A transcrição com ${model} excedeu o tempo limite de ${formatTimeoutLabel(OPENAI_REQUEST_TIMEOUT_MS)}.`);
      }

      if (isLikelyBrowserFetchError(error)) {
        throw new Error(
          `Não foi possível conectar à OpenAI ao transcrever com ${model}. ` +
          'Verifique a chave, a conexão e se o navegador permite essa requisição a partir da origem local.'
        );
      }

      throw error;
    } finally {
      cleanup();
    }
  }

  async postProcessText({ text, prompt = '', signal, model = DEFAULT_POSTPROCESS_MODEL } = {}) {
    const apiKey = this.assertConfigured();
    const transcriptText = text?.trim() || '';
    if (!transcriptText) {
      throw new Error('Não há texto de transcrição disponível para pós-processamento.');
    }

    const response = await fetch(OPENAI_RESPONSES_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        input: [
          {
            role: 'developer',
            content: [
              {
                type: 'input_text',
                text: 'Você reescreve transcrições. Retorne apenas o texto final reformulado, sem título, sem prefácio e sem comentários extras, exceto quando isso for solicitado.',
              },
            ],
          },
          {
            role: 'user',
            content: [
              {
                type: 'input_text',
                text: [
                  `Instrução:\n${prompt.trim() || DEFAULT_POSTPROCESS_PROMPT}`,
                  `Transcrição:\n${transcriptText}`,
                ].join('\n\n'),
              },
            ],
          },
        ],
      }),
      signal,
    });

    if (!response.ok) {
      throw new Error(await parseOpenAiErrorMessage(response));
    }

    const data = await response.json();
    const outputText = extractResponseText(data);
    if (!outputText) {
      throw new Error('A OpenAI retornou um resultado vazio no pós-processamento.');
    }

    return outputText;
  }
}

export class AssemblyAIClientManager {
  #apiKeyInput;

  engine = TRANSCRIPTION_ENGINES.assemblyai;
  supportsPrompt = false;
  supportsStructuredTranscription = true;
  supportsPostProcess = false;
  supportedModes = new Set([
    TRANSCRIPTION_OUTPUT_MODES.plain,
    TRANSCRIPTION_OUTPUT_MODES.diarized,
  ]);

  constructor(apiKeyInput) {
    this.#apiKeyInput = apiKeyInput;
  }

  getApiKey() {
    return this.#apiKeyInput?.value.trim() || '';
  }

  assertConfigured() {
    const apiKey = this.getApiKey();
    if (!apiKey) {
      throw new AssemblyAIConfigError('Preencha sua chave da API da AssemblyAI antes de usar este motor de transcrição.');
    }
    return apiKey;
  }

  async transcribeFile({ file, signal } = {}) {
    if (!(file instanceof File)) {
      throw new Error('Nenhum arquivo de áudio foi enviado para transcrição.');
    }

    const result = await this.#runTranscription({ file, signal, speakerLabels: false });
    return typeof result?.text === 'string' ? result.text.trim() : '';
  }

  async transcribeFileDetailed({ file, signal, mode = TRANSCRIPTION_OUTPUT_MODES.diarized } = {}) {
    if (!(file instanceof File)) {
      throw new Error('Nenhum arquivo de áudio foi enviado para transcrição.');
    }
    if (mode !== TRANSCRIPTION_OUTPUT_MODES.diarized) {
      throw new Error(`Modo de transcrição estruturada inválido para AssemblyAI: ${mode}.`);
    }

    const result = await this.#runTranscription({ file, signal, speakerLabels: true });
    const utterances = Array.isArray(result?.utterances) ? result.utterances : [];
    const segments = utterances
      .map((utterance, index) => {
        const text = typeof utterance?.text === 'string' ? utterance.text.trim() : '';
        if (!text) return null;

        const start = Number(utterance?.start);
        const end = Number(utterance?.end);
        const speaker = typeof utterance?.speaker === 'string' && utterance.speaker.trim()
          ? `Speaker ${utterance.speaker.trim()}`
          : '';

        return {
          id: `utterance-${index + 1}`,
          start: Number.isFinite(start) ? start / 1000 : 0,
          end: Number.isFinite(end) ? end / 1000 : 0,
          text,
          speaker,
        };
      })
      .filter(Boolean);

    return {
      text: typeof result?.text === 'string' ? result.text.trim() : '',
      raw: result,
      segments,
      model: 'assemblyai-speaker-diarization',
    };
  }

  async #runTranscription({ file, signal, speakerLabels = false } = {}) {
    const apiKey = this.assertConfigured();
    const { signal: requestSignal, timedOut, cleanup } = createRequestSignal(signal, ASSEMBLYAI_REQUEST_TIMEOUT_MS);

    try {
      const audioUrl = await this.#uploadFile(file, apiKey, requestSignal);
      const transcriptId = await this.#createTranscript(audioUrl, apiKey, requestSignal, { speakerLabels });
      if (!transcriptId) {
        throw new Error('A AssemblyAI não retornou um identificador de transcrição.');
      }

      while (true) {
        const pollingData = await this.#pollTranscript(transcriptId, apiKey, requestSignal);
        if (pollingData?.status === 'completed') {
          return pollingData;
        }
        if (pollingData?.status === 'error') {
          throw new Error(`A AssemblyAI falhou ao transcrever: ${pollingData?.error || 'erro desconhecido.'}`);
        }
        await delay(ASSEMBLYAI_POLL_INTERVAL_MS, requestSignal);
      }
    } catch (error) {
      if (timedOut()) {
        throw new Error(`A transcrição com a AssemblyAI excedeu o tempo limite de ${formatTimeoutLabel(ASSEMBLYAI_REQUEST_TIMEOUT_MS)}.`);
      }

      if (isLikelyBrowserFetchError(error)) {
        throw new Error(
          'Não foi possível conectar à AssemblyAI. ' +
          'Verifique a chave, a conexão e se o navegador permite essa requisição a partir da origem local.'
        );
      }

      throw error;
    } finally {
      cleanup();
    }
  }

  async #uploadFile(file, apiKey, signal) {
    const uploadResponse = await fetch(`${ASSEMBLYAI_BASE_URL}/v2/upload`, {
      method: 'POST',
      headers: {
        authorization: apiKey,
      },
      body: file,
      signal,
    });

    if (!uploadResponse.ok) {
      throw new Error(await parseAssemblyAiErrorMessage(uploadResponse));
    }

    const uploadData = await uploadResponse.json();
    const audioUrl = typeof uploadData?.upload_url === 'string' ? uploadData.upload_url : '';
    if (!audioUrl) {
      throw new Error('A AssemblyAI não retornou uma URL de upload válida.');
    }

    return audioUrl;
  }

  async #createTranscript(audioUrl, apiKey, signal, { speakerLabels = false } = {}) {
    const transcriptResponse = await fetch(`${ASSEMBLYAI_BASE_URL}/v2/transcript`, {
      method: 'POST',
      headers: {
        authorization: apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        audio_url: audioUrl,
        language_detection: true,
        speech_models: ['universal-3-pro', 'universal-2'],
        ...(speakerLabels ? { speaker_labels: true } : {}),
      }),
      signal,
    });

    if (!transcriptResponse.ok) {
      throw new Error(await parseAssemblyAiErrorMessage(transcriptResponse));
    }

    const transcriptData = await transcriptResponse.json();
    return typeof transcriptData?.id === 'string' ? transcriptData.id : '';
  }

  async #pollTranscript(transcriptId, apiKey, signal) {
    const pollingResponse = await fetch(`${ASSEMBLYAI_BASE_URL}/v2/transcript/${transcriptId}`, {
      method: 'GET',
      headers: {
        authorization: apiKey,
      },
      signal,
    });

    if (!pollingResponse.ok) {
      throw new Error(await parseAssemblyAiErrorMessage(pollingResponse));
    }

    return pollingResponse.json();
  }
}
