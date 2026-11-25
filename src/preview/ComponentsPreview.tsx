import { useState } from "react";
import { BrandMark } from "../components/BrandMark";
import { Badge } from "../components/Badge";
import { Button } from "../components/Button";
import { DesignIcon } from "../components/DesignIcon";
import { Field } from "../components/Field";
import { IconButton } from "../components/IconButton";
import { Kbd } from "../components/Kbd";
import { NoteCard, type NoteColor, type ChecklistItem } from "../components/NoteCard";
import { PresetChip } from "../components/PresetChip";
import { ProgressRing } from "../components/ProgressRing";
import { Segmented } from "../components/Segmented";
import { Select } from "../components/Select";
import { Tab } from "../components/Tab";
import { Toggle } from "../components/Toggle";
const colours: NoteColor[] = ["default", "blue", "purple", "green", "pink", "gray"];
const tray16 = new URL("../assets/brand/tray-16.svg", import.meta.url).href;
const tray24 = new URL("../assets/brand/tray-24.svg", import.meta.url).href;
const initialItems: ChecklistItem[] = [
  { id: "dpi", text: "Verify island at 150% DPI", checked: true },
  { id: "demo", text: "Record demo GIF", checked: false },
  { id: "release", text: "Write release notes", checked: false },
];

export function ComponentsPreview() {
  const [theme, setTheme] = useState(document.documentElement.dataset.theme ?? "light");
  const [on, setOn] = useState(true),
    [off, setOff] = useState(false);
  const [lightPreset, setLightPreset] = useState(1),
    [islandPreset, setIslandPreset] = useState(0);
  const [tab, setTab] = useState(0),
    [segment, setSegment] = useState("video");
  const [items, setItems] = useState(initialItems);
  const [folder, setFolder] = useState("Downloads/Nabbit"),
    [format, setFormat] = useState("mp4");
  const [progress, setProgress] = useState(38),
    [actions, setActions] = useState(0);
  const act = () => setActions((count) => count + 1);
  const changeItem = (id: string, checked: boolean) =>
    setItems((rows) => rows.map((row) => (row.id === id ? { ...row, checked } : row)));
  return (
    <main className="component-preview">
      <header className="preview-toolbar">
        <div>
          <h1 className="type-title">Nabbit components</h1>
          <p className="type-caption">Foundations � local preview</p>
        </div>
        <Segmented
          label="Preview appearance"
          value={theme}
          options={[
            { label: "Light", value: "light" },
            { label: "Dark", value: "dark" },
          ]}
          onChange={(value) => {
            document.documentElement.dataset.theme = value;
            setTheme(value);
          }}
        />
        <output role="status">{actions} preview actions</output>
      </header>
      <div className="preview-boards">
        <section id="brand-foundations" aria-label="Logo and mark" data-figma-node="12:478">
          <BrandMark size={16} />
          <BrandMark size={24} />
          <BrandMark size={32} />
          <BrandMark size={64} />
          <BrandMark size={128} />
          <img src={tray16} width={16} height={16} alt="" className="preview-tray-glyph" />
          <img src={tray24} width={24} height={24} alt="" className="preview-tray-glyph" />
        </section>
        <section id="core-foundations" aria-label="Core components" data-figma-node="5:408">
          <div className="foundation-set foundation-buttons">
            {(
              [
                ["primary", "secondary"],
                ["ghost", "danger"],
              ] as const
            ).map((row, rowIndex) => (
              <div className="foundation-row" key={rowIndex}>
                {row.flatMap((variant) =>
                  (["md", "sm"] as const).map((size) => (
                    <Button
                      key={variant + size}
                      data-variant={variant}
                      size={size}
                      variant={variant}
                      style={{
                        width: (size === "md" ? 108 : 104) + (variant === "secondary" ? 2 : 0),
                      }}
                      onClick={act}
                    >
                      <DesignIcon
                        name={
                          variant === "primary"
                            ? "downloadPrimary"
                            : variant === "danger"
                              ? "downloadDanger"
                              : "download"
                        }
                      />
                      Download
                    </Button>
                  )),
                )}
              </div>
            ))}
          </div>
          <div className="foundation-set foundation-icons foundation-row">
            {(["ghost", "subtle", "island"] as const).flatMap((variant) =>
              ([32, 28] as const).map((size) => (
                <IconButton
                  key={variant + size}
                  size={size}
                  variant={variant}
                  label={`${variant} menu ${size}`}
                  onClick={act}
                >
                  <DesignIcon
                    name={
                      variant === "island"
                        ? size === 32
                          ? "moreIsland18"
                          : "moreIsland16"
                        : size === 32
                          ? "more18"
                          : "more16"
                    }
                  />
                </IconButton>
              )),
            )}
          </div>
          <div className="foundation-set foundation-presets">
            {(["light", "island"] as const).map((surface) => (
              <div
                key={surface}
                role="group"
                aria-label={`${surface} presets`}
                className="foundation-row"
              >
                {[0, 1].map((index) => (
                  <PresetChip
                    key={index}
                    surface={surface}
                    meta="1080p"
                    selected={(surface === "light" ? lightPreset : islandPreset) === index}
                    onClick={() =>
                      surface === "light" ? setLightPreset(index) : setIslandPreset(index)
                    }
                    style={{ width: surface === "light" && index === 0 ? 128 : 126 }}
                  >
                    Best MP4
                  </PresetChip>
                ))}
              </div>
            ))}
          </div>
          <div className="foundation-set foundation-switches foundation-row">
            <Toggle label="Enabled example" checked={on} onChange={setOn} layout="control" />
            <Toggle
              label="Disabled-state example"
              checked={off}
              onChange={setOff}
              layout="control"
            />
          </div>
          <Kbd style={{ width: 41 }}>Ctrl</Kbd>
          <div className="foundation-set foundation-badges foundation-row">
            {(["neutral", "signal", "danger", "warning"] as const).map((tone) => (
              <Badge tone={tone} key={tone} style={{ width: 56 }}>
                Synced
              </Badge>
            ))}
          </div>
          <div
            className="foundation-set foundation-tabs foundation-row"
            role="group"
            aria-label="Standalone tabs"
          >
            {[0, 1].map((index) => (
              <Tab
                key={index}
                selected={tab === index}
                onClick={() => setTab(index)}
                style={{ width: 67 }}
              >
                <DesignIcon name={index === 0 ? "tabDownload" : "tabDownloadMuted"} />
                Nab
              </Tab>
            ))}
          </div>
        </section>
        <div className="preview-right">
          <section id="note-foundations" aria-label="Note card variants" data-figma-node="12:511">
            <NoteCard
              kind="note"
              title="Island idea"
              body="Scroll on the pill to change volume; middle-click toggles play."
              label="Ideas"
              reference="tck-31"
              onOpen={act}
            />
            <NoteCard
              kind="checklist"
              title="Launch checklist"
              items={items}
              onItemChange={changeItem}
              label="Build"
              reference="tck-24"
              onOpen={act}
            />
            <NoteCard
              kind="bookmark"
              title="Tauri window docs"
              url="v2.tauri.app/reference/javascript/api"
              label="Ideas"
              reference="tck-31"
              onOpen={act}
            />
          </section>
          <section id="control-states" aria-label="Control states" className="preview-panel">
            <h2 className="type-heading">Inputs, selection and progress</h2>
            <div className="preview-inputs">
              <Field
                label="Output folder"
                value={folder}
                onChange={(e) => setFolder(e.target.value)}
                description="Saved on this device."
                className="font-mono font-medium"
              />
              <Select label="Format" value={format} onChange={(e) => setFormat(e.target.value)}>
                <option value="mp4">MP4</option>
                <option value="mp3">MP3</option>
                <option value="mkv">MKV</option>
              </Select>
              <Field label="Invalid filename" defaultValue="" error="Enter a filename." />
              <Select label="Unavailable format" disabled defaultValue="mp4">
                <option value="mp4">MP4</option>
              </Select>
              <Field
                label="Read-only reference"
                value="tck-24"
                readOnly
                className="font-mono font-medium"
              />
              <Field label="Unavailable field" disabled defaultValue="Unavailable" />
            </div>
            <Segmented
              label="Capture type"
              value={segment}
              options={[
                { label: "Video", value: "video" },
                { label: "Unavailable", value: "blocked", disabled: true },
                { label: "Audio", value: "audio" },
              ]}
              onChange={setSegment}
            />
            <Toggle
              checked={true}
              onChange={act}
              disabled
              label="Unavailable switch"
              description="Disabled controls do not change preview state."
            />
            <div className="preview-disabled" aria-label="Disabled buttons">
              {(["primary", "secondary", "ghost", "danger"] as const).map((variant) => (
                <Button key={variant} variant={variant} disabled onClick={act}>
                  {variant}
                </Button>
              ))}
              <IconButton label="Unavailable menu" disabled onClick={act}>
                <DesignIcon name="more18" />
              </IconButton>
              <PresetChip disabled onClick={act}>
                Unavailable preset
              </PresetChip>
            </div>
            <div className="preview-progress">
              <ProgressRing label="Queued download" value={0} />
              <ProgressRing label="Live download" value={progress} />
              <ProgressRing label="Complete download" value={100} />
              <span className="type-mono">{progress}%</span>
              <label className="type-caption">
                Progress
                <input
                  aria-label="Preview progress"
                  type="range"
                  min="0"
                  max="100"
                  value={progress}
                  onChange={(e) => setProgress(Number(e.target.value))}
                />
              </label>
            </div>
          </section>
          <section id="note-colours" aria-label="Tack note colours" className="preview-panel">
            <h2 className="type-heading">Tack note colours</h2>
            <div className="preview-note-grid">
              {colours.map((color) => (
                <NoteCard
                  key={color}
                  kind="note"
                  color={color}
                  title={color}
                  body="Kept on this device."
                  reference="tck-31"
                  onOpen={act}
                />
              ))}
            </div>
            <NoteCard
              kind="task"
              title="Release task"
              status="In progress"
              items={[{ id: "one", text: "Prepare release", checked: false }]}
            />
          </section>
        </div>
      </div>
    </main>
  );
}
