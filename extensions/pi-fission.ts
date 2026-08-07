import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createFissionExtension } from "../src/extension.ts";

export default async function piFission(pi: ExtensionAPI): Promise<void> {
  await createFissionExtension(pi);
}
