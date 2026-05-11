// One voice controller for the whole session. createVoice() returns
// null on unsupported browsers; we cache that result so callers don't
// re-probe every time.

import { createVoice, type VoiceController } from "./voice";

let cached: VoiceController | null | undefined;

export function getVoice(): VoiceController | null {
  if (cached === undefined) cached = createVoice();
  return cached;
}
