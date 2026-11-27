import { render, screen, cleanup } from "@testing-library/react";
import { afterEach, describe, it, expect, vi } from "vitest";
import { CompactContent } from "./CompactContent";
import { PeekContent } from "./PeekContent";
import type { ActivityItem } from "../../lib/activity";
afterEach(cleanup);
const item = (mic: string[], camera: string[]): ActivityItem => ({
  id: "privacy",
  category: "privacy",
  alert: false,
  bubbleOnly: false,
  event: { kind: "privacyChanged", mic, camera },
});
describe("Mic/camera island", () => {
  it("keeps the original mic icon and amber dot with the app name and full tooltip", () => {
    const { container } = render(
      <CompactContent item={item(["Microsoft Teams"], [])} act={vi.fn()} />,
    );
    expect(screen.getByText("Microsoft Teams")).toHaveAttribute("title", "Microsoft Teams");
    expect(
      screen
        .getByRole("img", { name: "Microphone in use" })
        .querySelector('[data-asset-slot="compact/privacyDot"]'),
    ).not.toBeNull();
    expect(container.querySelector('[data-asset-slot="compact/iconMic"]')).not.toBeNull();
  });
  it("uses the original dot mask and a camera state for camera-only and combined use", () => {
    const { rerender } = render(
      <CompactContent item={item([], ["Virtual Camera Host"])} act={vi.fn()} />,
    );
    expect(
      screen.getByRole("img", { name: "Camera in use" }).querySelector(".island-camera-dot"),
    ).not.toBeNull();
    rerender(<CompactContent item={item(["Teams"], ["Teams"])} act={vi.fn()} />);
    expect(screen.getByRole("img", { name: "Microphone and camera in use" })).toBeInTheDocument();
    expect(screen.getByText("Teams")).toBeInTheDocument();
  });
  it("shows the current capability lists in Peek without actions or reads", () => {
    const { rerender } = render(
      <PeekContent item={item(["Recorder"], ["Virtual Camera Host"])} act={vi.fn()} />,
    );
    expect(screen.getByText("Microphone · Recorder")).toBeInTheDocument();
    expect(screen.getByText("Camera · Virtual Camera Host")).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    rerender(<PeekContent item={item([], ["Camera"])} act={vi.fn()} />);
    expect(screen.getByText("Camera in use")).toBeInTheDocument();
    expect(screen.queryByText(/Recorder/)).not.toBeInTheDocument();
  });
});
