export interface Provider {
  id: string;
  label: string;
  baseUrl: string;
  needsKey: boolean;
  hint?: string;
}

export const PROVIDERS: Provider[] = [
  { id: "openai", label: "OpenAI", baseUrl: "https://api.openai.com/v1", needsKey: true },
  { id: "openrouter", label: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", needsKey: true },
  { id: "venice", label: "Venice", baseUrl: "https://api.venice.ai/api/v1", needsKey: true },
  { id: "groq", label: "Groq", baseUrl: "https://api.groq.com/openai/v1", needsKey: true },
  {
    id: "ollama",
    label: "Ollama (local)",
    baseUrl: "http://host.docker.internal:11434/v1",
    needsKey: false,
    hint: "host.docker.internal reaches the host from inside the container",
  },
  { id: "other", label: "Other OpenAI-compatible", baseUrl: "", needsKey: true },
];

export function providerById(id: string): Provider | undefined {
  return PROVIDERS.find((p) => p.id === id);
}
