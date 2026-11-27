import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Button } from "../../components/Button";
import { Badge } from "../../components/Badge";
import { Field } from "../../components/Field";
import { Toggle } from "../../components/Toggle";
import { IconButton } from "../../components/IconButton";
import { DesignIcon } from "../../components/DesignIcon";
import { tackAssets } from "./tackAssets";
import { tackApi, type TackConnection, type TackProfile } from "./tackApi";
import { tackError, validTackAddress } from "./tackErrors";
import "./tack.css";

type Stage = "server" | "signin" | "recovery" | "workspace";
function Icon({ name }: { name: keyof typeof tackAssets }) {
  return <DesignIcon asset={tackAssets[name]} />;
}
export function TackConnectionSheet({
  initial,
  profile,
  close,
  complete,
}: {
  initial: TackConnection;
  profile: TackProfile;
  close: () => void;
  complete: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null),
    password = useRef<HTMLInputElement | null>(null);
  const formId = useId(),
    headingId = useId();
  const [stage, setStage] = useState<Stage>(
    initial.ready ? "workspace" : initial.checked ? "signin" : "server",
  );
  const [connection, setConnection] = useState(initial),
    [address, setAddress] = useState(initial.baseUrl ?? profile.baseUrl ?? "");
  const [username, setUsername] = useState(initial.user?.username ?? profile.username);
  const [code, setCode] = useState<string | null>(null),
    [saved, setSaved] = useState(false),
    [copied, setCopied] = useState(false);
  const [workspace, setWorkspace] = useState(initial.workspace?.id ?? ""),
    [scope, setScope] = useState(profile.preferences);
  const [scopeReady, setScopeReady] = useState(false),
    [knownLabels, setKnownLabels] = useState(profile.labels);
  const [labelText, setLabelText] = useState(profile.preferences.labels.join(", "));
  const [upload, setUpload] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [cooling, setCooling] = useState(false),
    retryTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const alive = useRef(true),
    working = useRef(false),
    scopeGeneration = useRef(0);
  const selected = connection.workspaces.find((w) => w.id === workspace),
    readOnly = selected?.role === "guest";
  useEffect(() => {
    alive.current = true;
    const origin = document.activeElement;
    dialog.current?.showModal();
    return () => {
      alive.current = false;
      clearTimeout(retryTimer.current);
      if (origin instanceof HTMLElement && origin.isConnected) origin.focus();
    };
  }, []);
  const chooseScope = useCallback(async (id: string) => {
    const generation = ++scopeGeneration.current;
    setWorkspace(id);
    setScopeReady(false);
    setUpload(false);
    try {
      const next = await tackApi.workspaceProfile(id);
      if (alive.current && generation === scopeGeneration.current) {
        setScope(next.preferences);
        setLabelText(next.preferences.labels.join(", "));
        setKnownLabels(next.labels);
        setScopeReady(true);
      }
    } catch (reason) {
      if (alive.current && generation === scopeGeneration.current)
        setError(tackError(reason).message);
    }
  }, []);
  const opening = useRef(initial);
  useEffect(() => {
    if (opening.current.ready && opening.current.workspace)
      void chooseScope(opening.current.workspace.id);
    // A dialog owns its initial authentication snapshot; later events cannot
    // replace a draft or a recovery code. Start revalidates account and server.
  }, [chooseScope]);
  const run = async (action: () => Promise<void>) => {
    if (working.current || cooling) return;
    working.current = true;
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (reason) {
      if (alive.current) {
        const problem = tackError(reason);
        const recoveryExpired =
          stage === "recovery" &&
          typeof reason === "object" &&
          reason !== null &&
          "code" in reason &&
          ["conflict", "signedOut"].includes(String(reason.code));
        if (recoveryExpired) {
          setCode(null);
          setSaved(false);
          setCopied(false);
          setStage("signin");
          setError("This recovery code changed or expired. Sign in again to receive a new code.");
        } else setError(problem.message);
        if (problem.retryAfterMs) {
          setCooling(true);
          clearTimeout(retryTimer.current);
          retryTimer.current = setTimeout(() => {
            if (alive.current) setCooling(false);
          }, problem.retryAfterMs);
        }
      }
    } finally {
      working.current = false;
      if (alive.current) setBusy(false);
    }
  };
  const enterWorkspace = async (next: TackConnection) => {
    if (!alive.current) return;
    setConnection(next);
    setCode(null);
    setSaved(false);
    setCopied(false);
    setStage("workspace");
    if (next.workspace) await chooseScope(next.workspace.id);
  };
  const submit = async () => {
    if (working.current || cooling) return;
    if (stage === "server") {
      if (!validTackAddress(address)) {
        setError(tackError({ code: "invalidServer" }).message);
        return;
      }
      await run(async () => {
        const next = await tackApi.status(address.trim());
        if (!alive.current) return;
        setConnection(next);
        setAddress(next.baseUrl ?? address);
        if (next.ready) await enterWorkspace(next);
        else setStage("signin");
      });
    } else if (stage === "signin") {
      const field = password.current;
      if (!field || !connection.checked) return;
      const secret = field.value;
      field.value = "";
      await run(async () => {
        const reply = await tackApi.login(username, secret);
        if (!alive.current) return;
        setConnection(reply.connection);
        if (reply.recoveryCode) {
          setCode(reply.recoveryCode);
          setSaved(false);
          setCopied(false);
          setStage("recovery");
        } else await enterWorkspace(reply.connection);
      });
    } else if (stage === "recovery") {
      if (!saved || !code) return;
      await run(async () => {
        const next = await tackApi.confirmRecovery(code);
        if (alive.current) await enterWorkspace(next);
      });
    } else {
      if (!scopeReady || !workspace || (!scope.labels.length && scope.filterLabels)) return;
      await run(async () => {
        await tackApi.start(connection, workspace, scope, upload && !readOnly);
        if (alive.current) complete();
      });
    }
  };
  const back = () => {
    setError("");
    setCode(null);
    setSaved(false);
    setCopied(false);
    setStage(stage === "signin" ? "server" : "signin");
  };
  // Request inputs are kept in this mounted dialog only. Neither the password
  // nor recovery code is ever copied into shared state, hints, logs or events.
  return (
    <dialog
      ref={dialog}
      className="tack-dialog"
      aria-labelledby={headingId}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) close();
      }}
    >
      <form
        id={formId}
        className="tack-sheet"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
        aria-busy={busy}
      >
        <header className="tack-header">
          <h2 id={headingId}>
            {stage === "workspace"
              ? "Choose what to sync"
              : stage === "recovery"
                ? "Save your recovery code"
                : "Connect your Tack"}
          </h2>
          <IconButton label="Close Tack connection" disabled={busy} onClick={close}>
            <Icon name="close" />
          </IconButton>
        </header>
        <div className="tack-body">
          {stage !== "workspace" && stage !== "recovery" ? (
            <>
              <nav className="tack-steps" aria-label="Connection steps">
                <Badge
                  tone={stage === "server" ? "signal" : "neutral"}
                  aria-current={stage === "server" ? "step" : undefined}
                >
                  1 Server
                </Badge>
                <Badge
                  tone={stage === "signin" ? "signal" : "neutral"}
                  aria-current={stage === "signin" ? "step" : undefined}
                >
                  2 Sign in
                </Badge>
                <Badge>3 Workspace</Badge>
              </nav>
              <div className="tack-field tack-address">
                <Field
                  label="Tack address"
                  name="address"
                  type="url"
                  required
                  maxLength={2048}
                  placeholder="https://your-domain.com/tack"
                  value={address}
                  disabled={busy}
                  leading={<Icon name="globe" />}
                  onChange={(event) => {
                    setAddress(event.target.value);
                    setConnection({ ...connection, checked: false });
                    setStage("server");
                    setError("");
                  }}
                />
              </div>
              {connection.checked && stage === "signin" ? (
                <div className="tack-notice tack-notice--success" role="status">
                  <Icon name="check" />
                  <p>Found Tack · API v4 · HTTPS</p>
                </div>
              ) : (
                <p className="tack-help">
                  Use the address of your own Tack installation. HTTPS is required.
                </p>
              )}
              {stage === "signin" ? (
                <>
                  {connection.recoveryPending ? (
                    <p className="tack-notice">
                      Sign in again to receive a new recovery code. Sync stays paused until it is
                      saved.
                    </p>
                  ) : null}
                  <div className="tack-field">
                    <Field
                      label="Username"
                      name="username"
                      autoComplete="username"
                      required
                      minLength={3}
                      maxLength={32}
                      value={username}
                      disabled={busy}
                      leading={<Icon name="user" />}
                      onChange={(event) => setUsername(event.target.value)}
                    />
                  </div>
                  <label className="n-field tack-field">
                    <span className="n-field-label">Password</span>
                    <span className="n-input-with-icon">
                      <span className="n-input-leading">
                        <Icon name="lock" />
                      </span>
                      <input
                        ref={password}
                        className="n-input"
                        name="password"
                        type="password"
                        autoComplete="current-password"
                        required
                        minLength={10}
                        maxLength={72}
                        disabled={busy}
                      />
                    </span>
                  </label>
                  <div className="tack-session">
                    <Toggle
                      layout="control"
                      label="Keep me signed in on this PC"
                      checked
                      disabled
                      onChange={() => {}}
                    />
                    <div>
                      <p>Keep me signed in on this PC</p>
                      <p className="tack-help">
                        Tack sessions last 30 days. Nabbit stores the session in Windows Credential
                        Manager and never stores your password.
                      </p>
                    </div>
                  </div>
                </>
              ) : null}
              <div className="tack-alternatives">
                {connection.checked ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy || cooling}
                    onClick={() =>
                      void run(async () => {
                        await tackApi.open();
                      })
                    }
                  >
                    <Icon name="external" />
                    Create account in browser
                  </Button>
                ) : null}
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy || cooling}
                  onClick={() =>
                    void run(async () => {
                      await tackApi.localMode();
                      if (alive.current) complete();
                    })
                  }
                >
                  Use local notes only
                </Button>
              </div>
            </>
          ) : null}
          {stage === "recovery" ? (
            <>
              <p>
                Tack needs this code to reset your password. Save it somewhere secure before
                continuing.
              </p>
              <div className="tack-recovery">
                <div role="group" aria-label="Recovery code">
                  <code>{code}</code>
                </div>
                <Button
                  disabled={busy || cooling}
                  onClick={() =>
                    void run(async () => {
                      if (code) {
                        await tackApi.copyRecovery(code);
                        if (alive.current) setCopied(true);
                      }
                    })
                  }
                >
                  Copy recovery code
                </Button>
              </div>
              <p className="tack-help">
                The copy is excluded from Windows clipboard history and Nabbit’s clipboard list.
              </p>
              {copied ? <p role="status">Recovery code copied.</p> : null}
              <label className="tack-checkbox">
                <input
                  type="checkbox"
                  checked={saved}
                  onChange={(event) => setSaved(event.target.checked)}
                  disabled={busy}
                />
                <span>I saved my recovery code</span>
              </label>
            </>
          ) : null}
          {stage === "workspace" ? (
            <>
              <h3>Workspace</h3>
              <fieldset className="tack-workspaces">
                <legend className="sr-only">Choose a workspace</legend>
                {connection.workspaces.map((item) => (
                  <label
                    key={item.id}
                    className={`tack-workspace${workspace === item.id ? " is-selected" : ""}`}
                  >
                    <input
                      className="tack-radio-input"
                      type="radio"
                      name="workspace"
                      value={item.id}
                      checked={workspace === item.id}
                      disabled={busy}
                      onChange={() => void chooseScope(item.id)}
                    />
                    <img
                      alt=""
                      width={14}
                      height={14}
                      src={workspace === item.id ? tackAssets.radioOn.src : tackAssets.radioOff.src}
                      data-asset={
                        workspace === item.id ? tackAssets.radioOn.file : tackAssets.radioOff.file
                      }
                    />
                    <span>
                      <strong>{item.name}</strong>
                      <small>
                        {item.role === "owner"
                          ? "Owner"
                          : item.role === "guest"
                            ? "Guest · read only"
                            : "Member"}
                      </small>
                    </span>
                    {item.role === "guest" ? <Badge>Read only</Badge> : null}
                  </label>
                ))}
              </fieldset>
              <h3>Show in Nabbit</h3>
              <div className="tack-scope-row">
                <div>
                  <p>Notes, checklists and bookmarks</p>
                  <p className="tack-help">Tasks too, with their Inbox/Now/Next/Later priority</p>
                </div>
                <Toggle
                  layout="control"
                  label="Show Tack tasks too"
                  checked={scope.showTasks}
                  onChange={(showTasks) => setScope({ ...scope, showTasks })}
                  disabled={busy || !scopeReady}
                />
              </div>
              <Toggle
                label="Only cards with a label"
                description="Pick labels, e.g. #nabbit, #ideas"
                checked={scope.filterLabels}
                onChange={(filterLabels) => setScope({ ...scope, filterLabels })}
                disabled={busy || !scopeReady}
              />
              {scope.filterLabels ? (
                <Field
                  label="Labels to show"
                  description="Separate labels with commas. Matching any selected label shows the card."
                  value={labelText}
                  disabled={busy || !scopeReady}
                  onChange={(event) => {
                    setLabelText(event.target.value);
                    setScope({
                      ...scope,
                      labels: event.target.value
                        .split(",")
                        .map((s) => s.trim().replace(/^#/, ""))
                        .filter(Boolean),
                    });
                  }}
                  list={`${formId}-labels`}
                />
              ) : null}
              <datalist id={`${formId}-labels`}>
                {knownLabels.map((label) => (
                  <option key={label} value={label} />
                ))}
              </datalist>
              <Toggle
                label="Pinned cards on the desktop board"
                description="Uses the Tack pin flag · desktop board in v2.1"
                checked
                disabled
                onChange={() => {}}
              />
              <Toggle
                label="Log focus timers as Tack time"
                description="Uses Tack time records (v2.1)"
                checked={false}
                disabled
                onChange={() => {}}
              />
              <div className="tack-notice">
                <Icon name="offline" />
                <p>
                  {readOnly
                    ? "This workspace is read only. You can browse its cards; edits and uploads stay disabled."
                    : "Works offline. Edits queue locally and sync in batches of 50 when Tack is reachable."}
                </p>
              </div>
              {profile.localCount > 0 ? (
                <label className="tack-checkbox">
                  <input
                    type="checkbox"
                    checked={upload && !readOnly}
                    disabled={busy || !scopeReady || readOnly}
                    onChange={(event) => setUpload(event.target.checked)}
                  />
                  <span>
                    Upload {profile.localCount} local {profile.localCount === 1 ? "note" : "notes"}{" "}
                    to this workspace
                    <small>Creates new cards once. Leave unchecked to keep them on this PC.</small>
                  </span>
                </label>
              ) : null}
            </>
          ) : null}
          {error ? (
            <p role="alert" className="tack-error">
              {error}
            </p>
          ) : null}
          {cooling ? (
            <p role="status" className="tack-help">
              Tack’s retry delay is active. Actions will become available when it ends.
            </p>
          ) : null}
        </div>
        <footer className="tack-footer">
          <Button disabled={busy || cooling} onClick={stage === "server" ? close : back}>
            Back
          </Button>
          <Button
            variant="primary"
            type="submit"
            disabled={
              busy ||
              cooling ||
              (stage === "recovery" && !saved) ||
              (stage === "workspace" &&
                (!scopeReady || !workspace || (scope.filterLabels && !scope.labels.length)))
            }
          >
            {stage === "signin" ? (
              <Icon name="signIn" />
            ) : stage === "workspace" ? (
              <Icon name="sync" />
            ) : null}
            {busy
              ? "Working…"
              : stage === "server"
                ? "Check server"
                : stage === "signin"
                  ? "Sign in"
                  : stage === "recovery"
                    ? "I saved it — continue"
                    : "Start syncing"}
          </Button>
        </footer>
      </form>
    </dialog>
  );
}
