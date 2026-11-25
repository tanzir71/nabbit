import type { CSSProperties } from "react";
import { cn } from "../lib/cn";
import { Badge } from "./Badge";
import { DesignIcon } from "./DesignIcon";
export type NoteColor = "default" | "blue" | "purple" | "green" | "pink" | "gray";
export interface ChecklistItem {
  id: string;
  text: string;
  checked: boolean;
  disabled?: boolean;
}
type Content =
  | { kind: "note"; body: string }
  | { kind: "bookmark"; url: string }
  | {
      kind: "checklist" | "task";
      items: readonly ChecklistItem[];
      onItemChange?: (id: string, checked: boolean) => void;
    };
type NoteCardProps = Content & {
  title: string;
  color?: NoteColor;
  label?: string;
  reference?: string;
  status?: string;
  onOpen?: () => void;
  className?: string;
  style?: CSSProperties;
  id?: string;
};
export function NoteCard(props: NoteCardProps) {
  const {
    title,
    color = "default",
    label,
    reference,
    status,
    onOpen,
    className,
    style,
    id,
  } = props;
  return (
    <article
      id={id}
      style={style}
      aria-label={title}
      className={cn("n-note-card", className)}
      data-color={color}
      data-kind={props.kind}
    >
      <h3 className="n-note-title">
        {onOpen ? (
          <button type="button" className="n-note-open" onClick={onOpen}>
            {title}
          </button>
        ) : (
          title
        )}
      </h3>
      {props.kind === "note" && <p className="n-note-body">{props.body}</p>}
      {props.kind === "bookmark" && <p className="n-note-url">{props.url}</p>}
      {(props.kind === "checklist" || props.kind === "task") &&
        props.items.map((item) => (
          <label key={item.id} className={cn("n-check-row", item.checked && "is-checked")}>
            <span className="n-check-control">
              <input
                type="checkbox"
                checked={item.checked}
                disabled={item.disabled || !props.onItemChange}
                onChange={(event) => props.onItemChange?.(item.id, event.target.checked)}
              />
              <span className="n-check-box">{item.checked && <DesignIcon name="check" />}</span>
            </span>
            <span>{item.text}</span>
          </label>
        ))}
      {(label || reference || status) && (
        <div className="n-note-meta">
          {label && <span className="n-note-label">{label}</span>}
          {reference && <span className="n-note-reference">{reference}</span>}
          {status && <Badge>{status}</Badge>}
        </div>
      )}
    </article>
  );
}
