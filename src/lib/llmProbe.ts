import { callLLM } from '../ai/categorize';

export type ProbeResult = { ok: boolean; detail: string };

/** Ping the active LLM config with a one-token call; returns provider error detail on failure. */
export function probeLlm(cfg: Parameters<typeof callLLM>[0]): Promise<ProbeResult> {
  return callLLM(cfg, 'Reply with exactly: OK', 'ping', []).then(
    (out) => (out.trim() ? { ok: true, detail: 'Connected' } : { ok: false, detail: 'Empty response from the model' }),
    (e: unknown) => ({ ok: false, detail: e instanceof Error ? e.message : String(e) }),
  );
}
