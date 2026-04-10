const TRANSCRIPTIONS_ENDPOINT = 'https://api.openai.com/v1/audio/transcriptions';
const DEFAULT_TRANSCRIPTION_MODEL = 'gpt-4o-transcribe';

export class OpenAIConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'OpenAIConfigError';
    this.title = 'OpenAI API Key Required';
  }
}

async function parseErrorMessage(response) {
  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    try {
      const data = await response.json();
      return data?.error?.message || data?.message || `OpenAI request failed with status ${response.status}.`;
    } catch (_) {
      // Ignore JSON parse failures and fall back to a generic message.
    }
  }

  const text = await response.text().catch(() => '');
  return text || `OpenAI request failed with status ${response.status}.`;
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
      throw new OpenAIConfigError('Fill in your OpenAI API key before starting a transcription.');
    }
    return apiKey;
  }

  async transcribeFile({ file, prompt = '', signal } = {}) {
    const apiKey = this.assertConfigured();
    if (!(file instanceof File)) {
      throw new Error('No audio file was provided for transcription.');
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
}
