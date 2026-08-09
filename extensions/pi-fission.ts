import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createFissionExtension } from "../src/extension.ts";

// Pi loads this module at startup and has no recovery path of its own: a thrown
// or rejected init leaves the host in whatever state it was mid-load. Swallow
// and log instead, so a broken config or provider degrades to "fission is off"
// rather than taking Pi down with it.
export default async function piFission(pi: ExtensionAPI): Promise<void> {
  await createFissionExtension(pi).catch((error) => {
    process.stderr.write(`[pi-fission] initialization failed: ${error instanceof Error ? error.message : "unknown error"}\n`);
  });
}
