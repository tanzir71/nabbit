import { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Button } from "./Button";
import { IconButton } from "./IconButton";
import { Toggle } from "./Toggle";
import { Segmented } from "./Segmented";
import { PresetChip } from "./PresetChip";
import { Field } from "./Field";
import { Select } from "./Select";
import { NoteCard } from "./NoteCard";
import { ProgressRing } from "./ProgressRing";

function SwitchFixture() {
  const [checked, setChecked] = useState(false);
  return (
    <Toggle
      label="Clipboard capture"
      checked={checked}
      onChange={setChecked}
      description="Local history"
    />
  );
}
function SegmentsFixture() {
  const [value, setValue] = useState("first");
  return (
    <Segmented
      label="Mode"
      value={value}
      onChange={setValue}
      options={[
        { label: "First", value: "first" },
        { label: "Unavailable", value: "blocked", disabled: true },
        { label: "Last", value: "last" },
      ]}
    />
  );
}

describe("foundation interaction contracts", () => {
  it("buttons require an explicit submit type inside a form", async () => {
    const submit = vi.fn((event) => event.preventDefault());
    const user = userEvent.setup();
    render(
      <form onSubmit={submit}>
        <Button>Change preset</Button>
        <IconButton label="Menu">�</IconButton>
        <Button type="submit">Download</Button>
      </form>,
    );
    await user.click(screen.getByRole("button", { name: "Change preset" }));
    await user.click(screen.getByRole("button", { name: "Menu" }));
    expect(submit).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Download" }));
    expect(submit).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "Menu" })).toHaveAttribute("title", "Menu");
  });
  it("switches expose their label/description and respond to Space", async () => {
    const user = userEvent.setup();
    render(<SwitchFixture />);
    const control = screen.getByRole("switch", { name: "Clipboard capture" });
    expect(control).toHaveAccessibleDescription("Local history");
    await user.tab();
    expect(control).toHaveFocus();
    await user.keyboard(" ");
    expect(control).toHaveAttribute("aria-checked", "true");
  });
  it("disabled buttons, presets and switches cannot dispatch actions", async () => {
    const change = vi.fn();
    const user = userEvent.setup();
    render(
      <>
        <Button disabled onClick={change}>
          Download
        </Button>
        <PresetChip disabled onClick={change}>
          Best
        </PresetChip>
        <Toggle disabled checked={false} onChange={change} label="Capture" />
        <IconButton disabled label="Menu" onClick={change}>
          �
        </IconButton>
      </>,
    );
    for (const control of screen.getAllByRole("button")) await user.click(control);
    await user.click(screen.getByRole("switch"));
    expect(change).not.toHaveBeenCalled();
  });
  it("segmented arrow/Home/End navigation wraps and skips disabled choices", async () => {
    const user = userEvent.setup();
    render(<SegmentsFixture />);
    const first = screen.getByRole("button", { name: "First" });
    const last = screen.getByRole("button", { name: "Last" });
    first.focus();
    await user.keyboard("{ArrowRight}");
    expect(last).toHaveFocus();
    expect(last).toHaveAttribute("aria-pressed", "true");
    await user.keyboard("{ArrowRight}");
    expect(first).toHaveFocus();
    await user.keyboard("{End}");
    expect(last).toHaveFocus();
    await user.keyboard("{Home}");
    expect(first).toHaveFocus();
  });
  it("fields retain external descriptions, associate errors and generate unique IDs", async () => {
    const user = userEvent.setup();
    render(
      <>
        <span id="external">Filename rule</span>
        <Field label="Name" description="Local file" error="Required" aria-describedby="external" />
        <Field label="Folder" defaultValue="Downloads" />
      </>,
    );
    const name = screen.getByRole("textbox", { name: "Name" });
    expect(name).toHaveAccessibleDescription("Filename rule Local file Required");
    expect(name).toHaveAttribute("aria-invalid", "true");
    expect(name.id).not.toBe(screen.getByRole("textbox", { name: "Folder" }).id);
    await user.click(screen.getByText("Name", { selector: "label" }));
    expect(name).toHaveFocus();
  });
  it("native select options work with labels, descriptions and disabled choices", async () => {
    const user = userEvent.setup();
    render(
      <Select label="Format" description="Output container" defaultValue="mp4">
        <option value="mp4">MP4</option>
        <option value="mp3">MP3</option>
        <option value="blocked" disabled>
          Unavailable
        </option>
      </Select>,
    );
    const select = screen.getByRole("combobox", { name: "Format" });
    expect(select).toHaveAccessibleDescription("Output container");
    await user.selectOptions(select, "mp3");
    expect(select).toHaveValue("mp3");
  });
  it("checklist actions keep card-open actions separate and preserve IDs", async () => {
    const user = userEvent.setup();
    const open = vi.fn(),
      change = vi.fn();
    render(
      <NoteCard
        kind="checklist"
        title="Launch"
        items={[{ id: "dpi", text: "Verify DPI", checked: false }]}
        onOpen={open}
        onItemChange={change}
      />,
    );
    await user.click(screen.getByRole("checkbox", { name: "Verify DPI" }));
    expect(change).toHaveBeenCalledWith("dpi", true);
    expect(open).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Launch" }));
    expect(open).toHaveBeenCalledOnce();
  });
  it("readonly tasks do not expose editable checks and dynamic progress stays valid", () => {
    render(
      <>
        <NoteCard
          kind="task"
          title="Task"
          status="In progress"
          items={[{ id: "one", text: "Prepare release", checked: false }]}
        />
        <ProgressRing label="Over" value={120} />
        <ProgressRing label="Under" value={-3} />
        <ProgressRing label="Unknown" value={Number.NaN} />
      </>,
    );
    expect(screen.getByRole("checkbox")).toBeDisabled();
    expect(screen.getByRole("progressbar", { name: "Over" })).toHaveAttribute(
      "aria-valuenow",
      "100",
    );
    expect(screen.getByRole("progressbar", { name: "Under" })).toHaveAttribute(
      "aria-valuenow",
      "0",
    );
    expect(screen.getByRole("progressbar", { name: "Unknown" })).toHaveAttribute(
      "aria-valuenow",
      "0",
    );
  });
});
