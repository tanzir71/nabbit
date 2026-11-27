import { render, screen, cleanup } from "@testing-library/react";
import { afterEach, it, expect, vi } from "vitest";
import { CompactContent } from "./CompactContent";
import { PeekContent } from "./PeekContent";
import type { ActivityItem } from "../../lib/activity";
afterEach(cleanup);
const item = (
  percent: number | null,
  charging: boolean,
  pluggedIn: boolean | null,
): ActivityItem => ({
  id: "power",
  category: "power",
  alert: false,
  bubbleOnly: false,
  event: { kind: "powerChanged", percent, charging, pluggedIn },
});
it("renders the original charging icon, actual percentage and truthful power labels", () => {
  const { container, rerender } = render(
    <CompactContent item={item(82, true, true)} act={vi.fn()} />,
  );
  expect(screen.getByText("Charging")).toBeInTheDocument();
  expect(screen.getByText("82%")).toBeInTheDocument();
  expect(container.querySelector('[data-asset-slot="compact/iconBatteryCharging"]')).not.toBeNull();
  for (const [p, plugged, label] of [
    [100, true, "Plugged in"],
    [82, false, "On battery"],
    [20, false, "Battery low"],
    [82, null, "Battery"],
  ] as const) {
    rerender(<CompactContent item={item(p, false, plugged)} act={vi.fn()} />);
    expect(screen.getByText(label)).toBeInTheDocument();
  }
});
it("never invents a percentage for an unknown level", () => {
  render(<CompactContent item={item(null, true, true)} act={vi.fn()} />);
  expect(screen.getByText("—")).toHaveAttribute("title", "Battery level unavailable");
  expect(screen.queryByText(/255%|0%/)).not.toBeInTheDocument();
});
it("shows read-only pushed power details in Peek", () => {
  const { rerender } = render(<PeekContent item={item(20, false, false)} act={vi.fn()} />);
  expect(screen.getByText("Battery low")).toBeInTheDocument();
  expect(screen.getByText("20% battery remaining")).toBeInTheDocument();
  expect(screen.queryByRole("button")).not.toBeInTheDocument();
  rerender(<PeekContent item={item(null, true, true)} act={vi.fn()} />);
  expect(screen.getByText("Battery level unavailable")).toBeInTheDocument();
  expect(screen.queryByText("20% battery remaining")).not.toBeInTheDocument();
});
