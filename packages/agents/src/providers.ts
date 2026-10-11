/**
 * Language-model providers behind one interface. Messages use Anthropic's shape
 * (text, tool_use and tool_result blocks); the OpenAI-compatible adapter translates,
 * so local models and organisation proxies work too. Keys go only to the endpoint
 * the user configured.
 */

import type { JsonSchema } from './schema.ts';

export type Block =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean };

export interface Message {
  role: 'user' | 'assistant';
  content: Block[];
}

export interface ToolSpec {
  name: string;
  description: string;
  input_schema: JsonSchema;
}

export interface CompletionRequest {
  system: string;
  messages: Message[];
  tools: ToolSpec[];
  maxTokens: number;
  signal?: AbortSignal;
}

export interface Completion {
  content: Block[];
  /** 'tool_use' when the model wants tools run, otherwise it has finished its turn. */
  stopReason: string;
}

export interface Provider {
  complete(req: CompletionRequest): Promise<Completion>;
}

export interface ProviderSettings {
  kind: 'anthropic' | 'openai';
  /** Full URL of the Messages or Chat Completions endpoint (or a proxy for it). */
  endpoint: string;
  model: string;
  apiKey?: string;
}

export const DEFAULT_SETTINGS: ProviderSettings = {
  kind: 'anthropic',
  endpoint: 'https://api.anthropic.com/v1/messages',
  model: 'claude-sonnet-5-5',
};

export class ProviderError extends Error {
  override name = 'ProviderError';
}

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

async function post(
  fetcher: Fetch,
  url: string,
  headers: Record<string, string>,
  body: unknown,
  signal?: AbortSignal,
) {
  let res: Response;
  try {
    res = await fetcher(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    });
  } catch (e) {
    throw new ProviderError(
      `Could not reach ${new URL(url).host}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  const text = await res.text();
  if (!res.ok) {
    let detail = text.slice(0, 300);
    try {
      const j = JSON.parse(text) as { error?: { message?: string } };
      detail = j.error?.message ?? detail;
    } catch {
      // Not JSON: keep the text.
    }
    throw new ProviderError(`${res.status} from ${new URL(url).host}: ${detail}`);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ProviderError('The provider answered with something that is not JSON.');
  }
}

export function anthropicProvider(s: ProviderSettings, fetcher: Fetch = fetch): Provider {
  return {
    async complete(req) {
      const headers: Record<string, string> = {
        'anthropic-version': '2023-06-01',
        // Calls go from the browser to the configured endpoint.
        'anthropic-dangerous-direct-browser-access': 'true',
      };
      if (s.apiKey) headers['x-api-key'] = s.apiKey;
      const j = (await post(
        fetcher,
        s.endpoint,
        headers,
        {
          model: s.model,
          max_tokens: req.maxTokens,
          system: req.system,
          messages: req.messages,
          tools: req.tools,
        },
        req.signal,
      )) as { content?: Block[]; stop_reason?: string };
      return {
        content: (j.content ?? []).filter((b) => b.type === 'text' || b.type === 'tool_use'),
        stopReason: j.stop_reason ?? 'end_turn',
      };
    },
  };
}

interface OpenAiMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}

export function toOpenAi(system: string, messages: Message[]): OpenAiMessage[] {
  const out: OpenAiMessage[] = [{ role: 'system', content: system }];
  for (const m of messages) {
    if (m.role === 'assistant') {
      const text = m.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n');
      const calls = m.content.flatMap((b) =>
        b.type === 'tool_use'
          ? [
              {
                id: b.id,
                type: 'function' as const,
                function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
              },
            ]
          : [],
      );
      out.push({ role: 'assistant', content: text || null, ...(calls.length ? { tool_calls: calls } : {}) });
    } else {
      for (const b of m.content) {
        if (b.type === 'tool_result')
          out.push({ role: 'tool', tool_call_id: b.tool_use_id, content: b.content });
      }
      const text = m.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n');
      if (text) out.push({ role: 'user', content: text });
    }
  }
  return out;
}

export function openAiProvider(s: ProviderSettings, fetcher: Fetch = fetch): Provider {
  return {
    async complete(req) {
      const headers: Record<string, string> = {};
      if (s.apiKey) headers['authorization'] = `Bearer ${s.apiKey}`;
      const j = (await post(
        fetcher,
        s.endpoint,
        headers,
        {
          model: s.model,
          max_tokens: req.maxTokens,
          messages: toOpenAi(req.system, req.messages),
          tools: req.tools.map((t) => ({
            type: 'function',
            function: { name: t.name, description: t.description, parameters: t.input_schema },
          })),
        },
        req.signal,
      )) as {
        choices?: {
          finish_reason?: string;
          message?: {
            content?: string | null;
            tool_calls?: { id: string; function: { name: string; arguments: string } }[];
          };
        }[];
      };
      const choice = j.choices?.[0];
      const msg = choice?.message;
      const content: Block[] = [];
      if (msg?.content) content.push({ type: 'text', text: msg.content });
      for (const c of msg?.tool_calls ?? []) {
        let input: unknown;
        try {
          input = JSON.parse(c.function.arguments || '{}');
        } catch {
          input = { _unparsed: c.function.arguments };
        }
        content.push({ type: 'tool_use', id: c.id, name: c.function.name, input });
      }
      return {
        content,
        stopReason: (msg?.tool_calls?.length ?? 0) > 0 ? 'tool_use' : (choice?.finish_reason ?? 'stop'),
      };
    },
  };
}

export function providerFor(s: ProviderSettings, fetcher?: Fetch): Provider {
  return s.kind === 'openai' ? openAiProvider(s, fetcher) : anthropicProvider(s, fetcher);
}
