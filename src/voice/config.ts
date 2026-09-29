/** Voice mode's keys and knobs, from `<agentbox home>/voice.env`: KEY=value
 *  lines, the same shape as a .env. Read on every connection, so an edit
 *  takes effect on the next call without a restart. */

import { join } from "node:path";
import { agentboxHome } from "../core/paths";
import { readEnvFile } from "../core/envfile";

export interface VoiceConfig {
  deepgramKey: string;
  anthropicKey: string;
  /** The LLM behind the voice. */
  model: string;
  /** A Deepgram Aura voice. */
  voice: string;
  /** VOICE_SPEED: Aura's speaking rate, 0.7–1.5; unset is Deepgram's normal 1.0. */
  speed: number | null;
}

export const voiceEnvPath = (): string => join(agentboxHome(), "voice.env");

export function voiceConfig(): VoiceConfig | { missing: string } {
  const env = readEnvFile(voiceEnvPath());
  const deepgramKey = env.DEEPGRAM_API_KEY || process.env.DEEPGRAM_API_KEY || "";
  const anthropicKey = env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY || "";
  if (!deepgramKey) return { missing: `DEEPGRAM_API_KEY in ${voiceEnvPath()}` };
  if (!anthropicKey) return { missing: `ANTHROPIC_API_KEY in ${voiceEnvPath()}` };
  return {
    deepgramKey,
    anthropicKey,
    model: env.VOICE_MODEL || "claude-opus-5-5",
    voice: env.VOICE_TTS || "aura-2-pluto-en",
    speed: Number(env.VOICE_SPEED) >= 0.7 && Number(env.VOICE_SPEED) <= 1.5 ? Number(env.VOICE_SPEED) : null,
  };
}
