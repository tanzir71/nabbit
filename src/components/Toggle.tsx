import { useId, type ButtonHTMLAttributes, type CSSProperties } from "react";
import { cn } from "../lib/cn";
import { componentAssets } from "../assets/components/assets";
interface ToggleProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onChange"> {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  description?: string;
  layout?: "row" | "control";
}
export function Toggle({
  checked,
  onChange,
  label,
  description,
  layout = "row",
  className,
  disabled,
  ...props
}: ToggleProps) {
  const id = useId();
  const asset = componentAssets[checked ? "toggleOn" : "toggleOff"];
  // Recolour the original export in dark mode without changing its geometry.
  // Flood colours react directly to shared tokens, without a theme observer.
  const luminance = checked
    ? (23 * 0.2126 + 23 * 0.7152 + 26 * 0.0722) / 255
    : (207 * 0.2126 + 206 * 0.7152 + 201 * 0.0722) / 255;
  const filterId = `${id}-switch`;
  return (
    <div className={cn("n-toggle", layout === "row" && "n-toggle--row", className)}>
      {layout === "row" && (
        <span className="n-toggle-label">
          <span id={id}>{label}</span>
          {description && (
            <span id={`${id}-help`} className="n-help">
              {description}
            </span>
          )}
        </span>
      )}
      <button
        {...props}
        type="button"
        className="n-switch"
        role="switch"
        aria-checked={checked}
        aria-label={layout === "control" ? label : undefined}
        aria-labelledby={layout === "row" ? id : undefined}
        aria-describedby={description && layout === "row" ? `${id}-help` : undefined}
        disabled={disabled}
        onClick={() => onChange(!checked)}
      >
        <img
          src={asset.src}
          width={34}
          height={20}
          alt=""
          draggable={false}
          data-asset={asset.file}
          style={{ "--switch-filter": `url("#${filterId}")` } as CSSProperties}
        />
      </button>
      <svg width="0" height="0" aria-hidden="true" className="n-filter-defs">
        <defs>
          <filter
            id={filterId}
            colorInterpolationFilters="sRGB"
            x="0"
            y="0"
            width="100%"
            height="100%"
          >
            <feColorMatrix in="SourceGraphic" type="luminanceToAlpha" />
            <feComponentTransfer result="thumb-mask">
              <feFuncA
                type="linear"
                slope={1 / (1 - luminance)}
                intercept={-luminance / (1 - luminance)}
              />
            </feComponentTransfer>
            <feFlood
              floodColor={checked ? "var(--action-on-primary)" : "var(--bg-surface)"}
              result="thumb-colour"
            />
            <feComposite in="thumb-colour" in2="thumb-mask" operator="in" result="thumb" />
            <feFlood
              floodColor={checked ? "var(--action-primary)" : "var(--border-strong)"}
              result="track-colour"
            />
            <feComposite in="track-colour" in2="SourceAlpha" operator="in" result="track" />
            <feMerge>
              <feMergeNode in="track" />
              <feMergeNode in="thumb" />
            </feMerge>
          </filter>
        </defs>
      </svg>
    </div>
  );
}
