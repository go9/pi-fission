import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createFusionExtension } from "../src/extension.ts";

export default async function piFusion(pi: ExtensionAPI): Promise<void> {
  await createFusionExtension(pi);
}
