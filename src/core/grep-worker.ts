/** The worker `grepInWorker` starts: one search, posted back, then ended. */

import { grepTimelines, type GrepJob } from "./grep";

declare const self: Worker;

self.onmessage = async (e: MessageEvent<GrepJob>) => {
  self.postMessage(await grepTimelines(e.data));
};
