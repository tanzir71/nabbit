import type { ErrorKind } from "./activity";
// Same compact contract as Rust ErrorKind::compact_title; checked for every fixture.
export const downloadErrorTitle: Record<ErrorKind, string> = {
  SignInRequired: "YouTube wants you signed in",
  SiteChanged: "YouTube changed something",
  MissingJsRuntime: "The engine needs its helper",
  FormatUnavailable: "That quality isn’t offered",
  Drm: "This media is protected",
  Disk: "Check the download folder",
  Offline: "You’re offline",
  Live: "This is still live",
  Unknown: "Download failed",
};
