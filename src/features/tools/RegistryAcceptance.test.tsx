import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import contract from "./catalog.fixture.json";
import { acceptsFiles } from "./api";
import { ToolActions } from "./ToolActions";
import FileDropContent from "../files/FileDropContent";
import SearchContent from "../../surfaces/island/SearchContent";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
beforeEach(() => {
  vi.clearAllMocks();
  Element.prototype.scrollIntoView = vi.fn();
  vi.mocked(listen).mockResolvedValue(vi.fn());
  vi.mocked(invoke).mockImplementation(async (command) => {
    switch (command) {
      case "tool_catalog":
        return contract.tools;
      case "tool_presets":
        return contract.presets;
      case "list_clipboard_entries":
      case "list_island_pins":
      case "files_pins":
      case "shelf_list":
        return [];
      case "get_notes_state":
        return { cards: [], scope: null };
      case "files_hints":
        return {};
      case "tool_suggest":
        return null;
      case "tool_open_media_sheet":
        return null;
      default:
        throw new Error(`Unexpected registry acceptance IPC: ${command}`);
    }
  });
});
afterEach(cleanup);
const noJobs = () =>
  expect(vi.mocked(invoke).mock.calls.some(([c]) => c === "tool_start")).toBe(false);

it("discovers every native registry entry in Search without starting work", async () => {
  render(
    <SearchContent
      query=""
      setQuery={vi.fn()}
      collapse={vi.fn()}
      fail={vi.fn()}
      openShelf={vi.fn()}
    />,
  );
  await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(contract.tools.length));
  for (const tool of contract.tools)
    expect(screen.getByRole("option", { name: new RegExp(tool.name) })).toBeInTheDocument();
  noJobs();
});

for (const tool of contract.tools) {
  it(`preserves all selected inputs when Shelf opens ${tool.id}`, async () => {
    const paths = [
      `C:\\Owned\\one.${tool.accepts.filetypes[0]}`,
      `C:\\Owned\\two.${tool.accepts.filetypes[0]}`,
    ];
    render(<ToolActions paths={paths} />);
    fireEvent.click(await screen.findByRole("button", { name: tool.name }));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("tool_open_media_sheet", {
        intent: expect.objectContaining({ toolId: tool.id, input: paths[0], inputs: paths }),
      }),
    );
    noJobs();
  });
}

const extensions = [...new Set(contract.tools.flatMap((t) => t.accepts.filetypes))];
for (const extension of [...extensions, "exe"]) {
  it(`offers exactly the accepted Shelf and drop actions for .${extension}`, async () => {
    const paths = [`C:\\Owned\\one.${extension.toUpperCase()}`, `C:\\Owned\\two.${extension}`];
    const expected = contract.tools.filter((t) => acceptsFiles(t, paths));
    const shelf = render(<ToolActions paths={paths} />);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("tool_catalog"));
    await waitFor(() => expect(screen.queryAllByRole("button")).toHaveLength(expected.length));
    expect(screen.queryAllByRole("button").map((b) => b.textContent)).toEqual(
      expected.map((t) => t.name),
    );
    shelf.unmount();
    const drop = render(
      <FileDropContent payload={{ files: paths }} over={null} setOver={vi.fn()} />,
    );
    await waitFor(() =>
      expect(drop.container.querySelectorAll('[data-drop-zone^="tool:"]')).toHaveLength(
        expected.length,
      ),
    );
    expect(
      [...drop.container.querySelectorAll('[data-drop-zone^="tool:"]')].map((e) =>
        e.getAttribute("data-drop-zone"),
      ),
    ).toEqual(expected.map((t) => `tool:${t.id}`));
    const details = drop.container.querySelector("details");
    if (details) {
      expect(details.open).toBe(false);
      fireEvent.dragEnter(details);
      expect(details.open).toBe(true);
    }
    noJobs();
  });
}

it("rejects empty selections and mixed unsupported inputs", () => {
  for (const tool of contract.tools) {
    expect(acceptsFiles(tool, [])).toBe(false);
    expect(acceptsFiles(tool, [`one.${tool.accepts.filetypes[0]}`, "two.exe"])).toBe(false);
  }
});
