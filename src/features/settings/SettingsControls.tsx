import { useSettings } from "./context";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import type { SettingsPatch } from "../../lib/types";
import { Toggle } from "../../components/Toggle";
import { Field } from "../../components/Field";
import { PresetChip } from "../../components/PresetChip";
import { settingsAssets } from "./assets";

export function SettingsAsset({
  name,
  className,
}: {
  name: keyof typeof settingsAssets;
  className?: string;
}) {
  const asset = settingsAssets[name];
  return (
    <img
      src={asset.src}
      width={asset.width}
      height={asset.height}
      alt=""
      draggable={false}
      className={className}
      data-settings-asset={asset.file}
    />
  );
}
export function SettingsSection({
  title,
  children,
  card = true,
}: {
  title: string;
  children: ReactNode;
  card?: boolean;
}) {
  const id = useId();
  return (
    <section className="settings-section" aria-labelledby={id}>
      <h2 id={id}>{title}</h2>
      {card ? <div className="settings-card">{children}</div> : children}
    </section>
  );
}
export function SettingsRow({
  title,
  help,
  children,
}: {
  title: string;
  help?: string;
  children: ReactNode;
}) {
  return (
    <div className="settings-row">
      <div className="settings-row-copy">
        <p>{title}</p>
        {help && <span>{help}</span>}
      </div>
      {children}
    </div>
  );
}
export function SettingsToggle({
  label,
  help,
  checked,
  change,
}: {
  label: string;
  help?: string;
  checked: boolean;
  change: (checked: boolean) => SettingsPatch;
}) {
  const { busy, patch } = useSettings();
  return (
    <SettingsRow title={label} help={help}>
      <Toggle
        layout="control"
        label={label}
        checked={checked}
        disabled={busy}
        onChange={(checked) => void patch(change(checked))}
      />
    </SettingsRow>
  );
}
export function SettingsChoices<T extends string | number>({
  label,
  help,
  value,
  options,
  change,
}: {
  label: string;
  help?: string;
  value: T;
  options: ReadonlyArray<{ label: string; value: T }>;
  change: (value: T) => SettingsPatch;
}) {
  const { patch, busy } = useSettings();
  return (
    <SettingsRow title={label} help={help}>
      <div className="settings-choices" role="group" aria-label={label}>
        {options.map((option) => (
          <PresetChip
            key={option.value}
            selected={value === option.value}
            disabled={busy}
            onClick={() => void patch(change(option.value))}
          >
            {option.label}
          </PresetChip>
        ))}
      </div>
    </SettingsRow>
  );
}
export function SettingsField({
  label,
  value,
  change,
  help,
  min,
  max,
  placeholder,
}: {
  label: string;
  value: string | number;
  change: (value: string) => SettingsPatch;
  help?: string;
  min?: number;
  max?: number;
  placeholder?: string;
}) {
  const { busy, patch } = useSettings();
  const [draft, setDraft] = useState(String(value));
  const [focused, setFocused] = useState(false);
  const [failed, setFailed] = useState(false),
    [invalid, setInvalid] = useState("");
  const cancelBlur = useRef(false);
  useEffect(() => {
    if (!focused && !busy && !failed) setDraft(String(value));
  }, [value, focused, busy, failed]);
  const save = async (input: HTMLInputElement) => {
    if (!input.checkValidity()) {
      setInvalid(input.validationMessage);
      setFailed(true);
      return;
    }
    if (draft !== String(value)) {
      // Hold the draft before awaiting: the shared busy flag can settle one
      // render before this continuation receives a failed result.
      setFailed(true);
      setFailed(!(await patch(change(draft))));
    }
  };
  return (
    <div className="settings-field-row">
      <Field
        label={label}
        description={help}
        error={invalid || undefined}
        value={draft}
        placeholder={placeholder}
        type={typeof value === "number" ? "number" : "text"}
        min={min}
        max={max}
        required={typeof value === "number"}
        disabled={busy}
        onFocus={() => {
          setFocused(true);
          setFailed(false);
        }}
        onChange={(event) => {
          setDraft(event.target.value);
          setInvalid("");
        }}
        onBlur={(event) => {
          setFocused(false);
          if (cancelBlur.current) cancelBlur.current = false;
          else void save(event.currentTarget);
        }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
          if (event.key === "Enter") {
            event.preventDefault();
            event.currentTarget.blur();
          }
          if (event.key === "Escape") {
            cancelBlur.current = true;
            setFailed(false);
            setInvalid("");
            setDraft(String(value));
            event.currentTarget.blur();
          }
        }}
      />
    </div>
  );
}
