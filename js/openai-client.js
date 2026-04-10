const TRANSCRIPTIONS_ENDPOINT = 'https://api.openai.com/v1/audio/transcriptions';
const RESPONSES_ENDPOINT = 'https://api.openai.com/v1/responses';
const TRANSCRIPTION_MODELS = [
  'gpt-4o-transcribe',
  'gpt-4o-mini-transcribe',
  'whisper-1',
];
const DEFAULT_TRANSCRIPTION_MODEL = TRANSCRIPTION_MODELS[0];
const DEFAULT_POSTPROCESS_MODEL = 'gpt-5.4-mini';
const DEFAULT_POSTPROCESS_PROMPT = 'Reescreva a transcrição em português do Brasil, com clareza, boa fluidez e preservando o sentido original. Retorne apenas o texto final.';
const TRANSCRIPTION_REQUEST_TIMEOUT_MS = 5 * 60 * 1000;
const TRANSCRIPTION_RETRYABLE_STATUS = new Set([401, 403, 404]);
const TRANSCRIPTION_RETRYABLE_MESSAGE_RE = /(model|access|permission|available|not found|does not exist|unsupported)/i;

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

export class OpenAIConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'OpenAIConfigError';
    this.title = 'Chave da API da OpenAI obrigatória';
  }
}

async function parseErrorMessage(response) {
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

async function readErrorResponse(response, model) {
  return new OpenAIRequestError(await parseErrorMessage(response), {
    status: response.status,
    model,
    requestId: response.headers.get('x-request-id') || response.headers.get('openai-request-id') || '',
  });
}

function shouldRetryTranscriptionError(error, model, models) {
  if (!(error instanceof OpenAIRequestError)) return false;
  if (!TRANSCRIPTION_RETRYABLE_STATUS.has(error.status)) return false;
  if (!TRANSCRIPTION_RETRYABLE_MESSAGE_RE.test(error.message)) return false;
  return model !== models[models.length - 1];
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

export class OpenAIClientManager {
  #apiKeyInput;

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

    const models = [...new Set([model || DEFAULT_TRANSCRIPTION_MODEL, ...TRANSCRIPTION_MODELS])];
    let lastError = null;

    for (const model of models) {
      try {
        return await this.#transcribeFileOnce({
          apiKey,
          file,
          prompt,
          signal,
          model,
        });
      } catch (error) {
        lastError = error;
        if (!shouldRetryTranscriptionError(error, model, models)) {
          throw error;
        }
      }
    }

    if (lastError) throw lastError;
    throw new Error('Não foi possível transcrever o arquivo selecionado.');
  }

  async #transcribeFileOnce({ apiKey, file, prompt, signal, model }) {
    const formData = new FormData();
    formData.append('file', file, file.name || 'audio.webm');
    formData.append('model', model);
    if (prompt.trim()) formData.append('prompt', prompt.trim());

    const { signal: requestSignal, timedOut, cleanup } = createRequestSignal(signal, TRANSCRIPTION_REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(TRANSCRIPTIONS_ENDPOINT, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
        body: formData,
        signal: requestSignal,
      });

      if (!response.ok) {
        throw await readErrorResponse(response, model);
      }

      const contentType = response.headers.get('content-type') || '';
      if (contentType.includes('application/json')) {
        const data = await response.json();
        return typeof data?.text === 'string' ? data.text.trim() : '';
      }

      return (await response.text()).trim();
    } catch (error) {
      if (timedOut()) {
        throw new Error(`A transcrição com ${model} excedeu o tempo limite de ${formatTimeoutLabel(TRANSCRIPTION_REQUEST_TIMEOUT_MS)}.`);
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

  async postProcessText({ text, prompt = '', signal } = {}) {
    const apiKey = this.assertConfigured();
    const transcriptText = text?.trim() || '';
    if (!transcriptText) {
      throw new Error('Não há texto de transcrição disponível para pós-processamento.');
    }

    const response = await fetch(RESPONSES_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: DEFAULT_POSTPROCESS_MODEL,
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
      throw new Error(await parseErrorMessage(response));
    }

    const data = await response.json();
    const outputText = extractResponseText(data);
    if (!outputText) {
      throw new Error('A OpenAI retornou um resultado vazio no pós-processamento.');
    }

    return outputText;
  }
}
