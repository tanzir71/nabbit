import { useEffect, useState } from "react";
import { toolsApi, type ToolPreset } from "./api";
import { Field } from "../../components/Field";
import { Button } from "../../components/Button";
import { ContextSettings } from "../clipboard/ContextSettings";
export default function FilesSettings() {
  const [presets, setPresets] = useState<ToolPreset[]>([]),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [saved, setSaved] = useState(false);
  useEffect(() => {
    let active = true;
    void toolsApi
      .presets()
      .then((rows) => {
        if (active) setPresets(rows);
      })
      .catch((reason) => {
        if (active) setError(String(reason));
      });
    return () => {
      active = false;
    };
  }, []);
  return (
    <section className="mb-6 grid gap-3" aria-label="Files settings">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-secondary">Files</h2>
      <p className="text-sm text-secondary">
        Share limits in MB. Outlook is an alternative to the email preset.
      </p>
      {presets
        .filter((p) => p.maxMb !== null)
        .map((p) => (
          <Field
            key={p.id}
            type="number"
            label={p.name}
            min={1}
            max={100000}
            value={p.maxMb ?? ""}
            onChange={(e) => {
              setSaved(false);
              setPresets((old) =>
                old.map((row) =>
                  row.id === p.id ? { ...row, maxMb: Number(e.target.value) } : row,
                ),
              );
            }}
          />
        ))}
      <Button
        variant="secondary"
        disabled={
          busy ||
          !presets.length ||
          presets.some(
            (p) =>
              p.maxMb !== null && (!Number.isInteger(p.maxMb) || p.maxMb < 1 || p.maxMb > 100000),
          )
        }
        onClick={async () => {
          setBusy(true);
          setError("");
          setSaved(false);
          try {
            for (const preset of presets) await toolsApi.savePreset(preset);
            setSaved(true);
          } catch (reason) {
            setError(String(reason));
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? "Saving…" : "Save file presets"}
      </Button>
      {saved && (
        <p role="status" className="text-sm">
          File presets saved
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm">
          {error}
        </p>
      )}
      <ContextSettings />
    </section>
  );
}
