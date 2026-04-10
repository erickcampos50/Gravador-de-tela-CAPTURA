const TRANSCRIPTIONS_ENDPOINT = 'https://api.openai.com/v1/audio/transcriptions';
const RESPONSES_ENDPOINT = 'https://api.openai.com/v1/responses';
const DEFAULT_TRANSCRIPTION_MODEL = 'gpt-4o-transcribe';
const DEFAULT_POSTPROCESS_MODEL = 'gpt-5.4-mini';
const DEFAULT_POSTPROCESS_PROMPT = 'Reescreva a transcrição em português do Brasil, com clareza, boa fluidez e preservando o sentido original. Retorne apenas o texto final.';

export class OpenAIConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'OpenAIConfigError';
    this.title = 'Chave da API da OpenAI obrigatória';
  }
}

async function parseErrorMessage(response) {
  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    try {
      const data = await response.json();
      return data?.error?.message || data?.message || `A requisição para a OpenAI falhou com status ${response.status}.`;
    } catch (_) {
      // Ignore JSON parse failures and fall back to a generic message.
    }
  }

  const text = await response.text().catch(() => '');
  return text || `A requisição para a OpenAI falhou com status ${response.status}.`;
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

  async transcribeFile({ file, prompt = '', signal } = {}) {
    const apiKey = this.assertConfigured();
    if (!(file instanceof File)) {
      throw new Error('Nenhum arquivo de áudio foi enviado para transcrição.');
    }

    const formData = new FormData();
    formData.append('file', file, file.name || 'audio.webm');
    formData.append('model', DEFAULT_TRANSCRIPTION_MODEL);
    formData.append('response_format', 'text');
    if (prompt.trim()) formData.append('prompt', prompt.trim());

    const response = await fetch(TRANSCRIPTIONS_ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: formData,
      signal,
    });

    if (!response.ok) {
      throw new Error(await parseErrorMessage(response));
    }

    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      const data = await response.json();
      return typeof data?.text === 'string' ? data.text.trim() : '';
    }

    return (await response.text()).trim();
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
