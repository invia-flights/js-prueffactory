import type { Image } from "./toolset.ts";

// PinnedTool is a tool that runs from one official image: its name and release
// version for the Report, and the image it runs in.
export interface PinnedTool {
  readonly name: string;
  readonly version: string;
  readonly image: Image;
}
