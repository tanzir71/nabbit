import { useEffect, useId, useRef, useState } from "react";
import { Button } from "../../components/Button";
import { IconButton } from "../../components/IconButton";
import { SheetIcon } from "../downloads/SheetIcon";
import { Field } from "../../components/Field";
import { shelfApi } from "../shelf/api";
import { toolsApi, acceptsFile, type Tool } from "./api";
import { documentApi, pageGroups } from "./documentApi";
import "./documents.css";
import chevron from "../../assets/components/chevron-down-14.svg?url";
const name = (path: string) => path.split(/[\\/]/).pop() ?? path;
export function DocumentReview({
  tool,
  inputs,
  close,
}: {
  tool: Tool;
  inputs: string[];
  close: () => void;
}) {
  const pageChoice = useId();
  const multiple = ["merge-pdf", "images-pdf"].includes(tool.id),
    paged = ["split-pdf", "pdf-png"].includes(tool.id);
  const [paths, setPaths] = useState(
    inputs.filter((p) => acceptsFile(tool, p)).slice(0, multiple ? 64 : 1),
  );
  const [shelf, setShelf] = useState<string[]>([]),
    [count, setCount] = useState(0),
    [every, setEvery] = useState(true),
    [ranges, setRanges] = useState("");
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const working = useRef(false),
    requests = useRef(new Map<string, string>());
  useEffect(() => {
    let active = true;
    void shelfApi
      .list()
      .then((items) => {
        if (active)
          setShelf(
            items.filter((i) => i.available && acceptsFile(tool, i.path)).map((i) => i.path),
          );
      })
      .catch((e) => {
        if (active) setError(String(e));
      });
    return () => {
      active = false;
    };
  }, [tool]);
  const first = paths[0] ?? "";
  useEffect(() => {
    let active = true;
    setCount(0);
    if (paged && first)
      void documentApi
        .pages(first)
        .then((n) => {
          if (active) setCount(n);
        })
        .catch((e) => {
          if (active) setError(String(e));
        });
    return () => {
      active = false;
    };
  }, [paged, first]);
  const add = (path: string) =>
    setPaths((old) => (multiple ? [...old.filter((p) => p !== path), path] : [path]));
  const reorder = (index: number, direction: number) =>
    setPaths((old) => {
      const next = [...old];
      [next[index], next[index + direction]] = [next[index + direction], next[index]];
      return next;
    });
  const run = async () => {
    if (working.current) return;
    working.current = true;
    setBusy(true);
    setError("");
    try {
      let groups = paged ? pageGroups(ranges, count, every) : [[]];
      if (tool.id === "pdf-png") groups = groups.flatMap((g) => g.map((p) => [p]));
      if (groups.length > 64) throw new Error("Choose at most 64 output files at a time");
      for (const pages of groups) {
        const options = { inputs: paths.slice(1), pages },
          key = JSON.stringify([tool.id, paths, options]);
        let id = requests.current.get(key);
        if (!id) {
          id = crypto.randomUUID();
          requests.current.set(key, id);
        }
        await documentApi.start(id, tool.id, paths[0], tool.presets[0], options);
      }
      close();
    } catch (e) {
      setError(String(e));
    } finally {
      working.current = false;
      setBusy(false);
    }
  };
  return (
    <section
      className="media-review document-review"
      aria-label={`${tool.name} options`}
      onKeyDown={(e) => {
        if (e.key === "Escape" && !busy) close();
      }}
    >
      <header className="media-header" data-tauri-drag-region>
        <div>
          <h1>{tool.name}</h1>
          <p>
            {paths.length
              ? `${paths.length} ${paths.length === 1 ? "file" : "files"} selected`
              : "Choose files from the Shelf"}
          </p>
        </div>
        <IconButton label="Close document options" size={28} disabled={busy} onClick={close}>
          <SheetIcon name="close" />
        </IconButton>
      </header>
      <div className="media-body">
        <ol className="document-inputs">
          {paths.map((p, i) => (
            <li key={p}>
              <span title={p}>{name(p)}</span>
              {multiple && (
                <>
                  <IconButton
                    label={`Move ${name(p)} up`}
                    size={28}
                    disabled={busy || i === 0}
                    onClick={() => reorder(i, -1)}
                  >
                    <img className="document-up" src={chevron} width={14} height={14} alt="" />
                  </IconButton>
                  <IconButton
                    label={`Move ${name(p)} down`}
                    size={28}
                    disabled={busy || i === paths.length - 1}
                    onClick={() => reorder(i, 1)}
                  >
                    <img src={chevron} width={14} height={14} alt="" />
                  </IconButton>
                </>
              )}
              <IconButton
                label={`Remove ${name(p)}`}
                size={28}
                disabled={busy}
                onClick={() => setPaths((old) => old.filter((v) => v !== p))}
              >
                <SheetIcon name="close" />
              </IconButton>
            </li>
          ))}
        </ol>
        {(multiple || !paths.length) && (
          <>
            <label className="media-caption">
              From Shelf
              <select
                aria-label="Add document from Shelf"
                value=""
                disabled={busy || paths.length >= 64}
                onChange={(e) => add(e.target.value)}
              >
                <option value="" disabled>
                  Choose a file
                </option>
                {shelf
                  .filter((p) => !paths.includes(p))
                  .map((p) => (
                    <option value={p} key={p}>
                      {name(p)}
                    </option>
                  ))}
              </select>
            </label>
            <Button
              variant="secondary"
              disabled={busy || paths.length >= 64}
              onClick={async () => {
                try {
                  const p = await toolsApi.pick(tool.id);
                  if (p) add(p);
                } catch (e) {
                  setError(String(e));
                }
              }}
            >
              Choose file…
            </Button>
          </>
        )}
        {multiple && (
          <p className="media-caption">
            Pages follow the order above. Use the arrow buttons to reorder files.
          </p>
        )}
        {paged && (
          <fieldset>
            <legend>{count ? `${count} pages` : "Reading page count…"}</legend>
            <label>
              <input
                type="radio"
                name={pageChoice}
                checked={every}
                disabled={busy}
                onChange={() => setEvery(true)}
              />
              Every page
            </label>
            <label>
              <input
                type="radio"
                checked={!every}
                disabled={busy}
                onChange={() => setEvery(false)}
              />
              Page ranges
            </label>
            {!every && (
              <Field
                label="Ranges"
                placeholder="1-3, 5-7"
                value={ranges}
                disabled={busy}
                onChange={(e) => setRanges(e.target.value)}
              />
            )}
            <p className="media-caption">
              {tool.id === "split-pdf"
                ? "Each range creates a separate PDF. Every page creates one PDF per page."
                : "Each selected page creates a PNG at 144 DPI."}
            </p>
          </fieldset>
        )}
        {tool.id === "image-text" && (
          <p className="media-caption">
            Reads text using your Windows language preferences and saves a UTF-8 text file. If no
            text is found, no output is created.
          </p>
        )}
        {tool.id === "decode-qr" && (
          <p className="media-caption">Saves QR contents as UTF-8 text. Links stay as text.</p>
        )}
        {tool.id === "encode-qr" && (
          <p className="media-caption">
            Choose a UTF-8 .txt file with the text or link to encode (up to 8 KB). Creates a PNG
            with a quiet border.
          </p>
        )}
        <details>
          <summary>Advanced</summary>
          <p className="media-caption">
            New files are saved next to the first input, with its original created and modified
            dates. Existing files are kept. Encrypted PDFs, forms and portfolios need an
            unencrypted, flat export first.
          </p>
        </details>
        {error && <p role="alert">{error}</p>}
      </div>
      <footer className="media-footer">
        <span className="media-caption">Saved next to the originals · dates kept</span>
        <Button
          variant="primary"
          disabled={busy || !paths.length || (paged && (!count || (!every && !ranges.trim())))}
          onClick={() => void run()}
        >
          {busy ? "Adding to queue…" : tool.name}
        </Button>
      </footer>
    </section>
  );
}
