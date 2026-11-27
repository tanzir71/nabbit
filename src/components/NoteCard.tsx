import { Fragment, type CSSProperties, type ReactNode } from "react";
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
  labels?: readonly string[];
  reference?: string;
  status?: string;
  onOpen?: () => void;
  className?: string;
  style?: CSSProperties;
  id?: string;
  titlePrefix?: ReactNode;
  checkIcon?: (checked: boolean) => ReactNode;
  titleEditor?: ReactNode;
  bodyEditor?: ReactNode;
  itemEditor?: (item: ChecklistItem, index: number) => ReactNode;
  trailing?: ReactNode;
};
export function NoteCard(props: NoteCardProps) {
  const {
    title,
    color = "default",
    label,
    labels = label ? [label] : [],
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
      {props.titleEditor ? (
        <div className="n-note-title">{props.titleEditor}</div>
      ) : (
        <h3 className="n-note-title">
          {onOpen ? (
            <button type="button" className="n-note-open" onClick={onOpen}>
              {props.titlePrefix}
              {title}
            </button>
          ) : (
            <>
              {props.titlePrefix}
              {title}
            </>
          )}
        </h3>
      )}
      {props.bodyEditor ?? (props.kind === "note" && <p className="n-note-body">{props.body}</p>)}
      {props.kind === "bookmark" && (
        <p className="n-note-url" title={props.url}>
          {props.url
            .replace(/^https?:\/\//i, "")
            .replace(/\/$/, "")
            .split("/")
            .map((part, index) => (
              <Fragment key={index}>
                {index > 0 && (
                  <>
                    /<wbr />
                  </>
                )}
                {part}
              </Fragment>
            ))}
        </p>
      )}
      {(props.kind === "checklist" || props.kind === "task") &&
        props.items.map((item, index) => {
          const Row = props.itemEditor ? "div" : "label";
          return (
            <Row key={item.id} className={cn("n-check-row", item.checked && "is-checked")}>
              <span className="n-check-control">
                <input
                  type="checkbox"
                  checked={item.checked}
                  aria-label={
                    props.itemEditor ? `Complete ${item.text || `item ${index + 1}`}` : undefined
                  }
                  disabled={item.disabled || !props.onItemChange}
                  onChange={(event) => props.onItemChange?.(item.id, event.target.checked)}
                />
                <span className="n-check-box">
                  {props.checkIcon
                    ? props.checkIcon(item.checked)
                    : item.checked && <DesignIcon name="check" />}
                </span>
              </span>
              {props.itemEditor ? props.itemEditor(item, index) : <span>{item.text}</span>}
            </Row>
          );
        })}
      {props.trailing}
      {(labels.length > 0 || reference || status) && (
        <div className="n-note-meta">
          {labels.map((item) => (
            <span key={item} className="n-note-label">
              {item}
            </span>
          ))}
          {reference && <span className="n-note-reference">{reference}</span>}
          {status && <Badge>{status}</Badge>}
        </div>
      )}
    </article>
  );
}
