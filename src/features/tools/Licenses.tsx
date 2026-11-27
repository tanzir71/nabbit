import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
interface Notices {
  components: Array<{
    name: string;
    version: string;
    license: string;
    repository: string;
    texts: Array<{ name: string; text: string }>;
  }>;
  ffmpeg: {
    sourceOffer: string;
    gpl: string;
    builds: Array<{ target: string; configuration: string; sha256: string; url: string }>;
  };
}
export default function Licenses() {
  const [notices, setNotices] = useState<Notices | null>(null),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(false);
  return (
    <details
      onToggle={async (e) => {
        if (!e.currentTarget.open || notices || loading) return;
        setLoading(true);
        try {
          setNotices(await invoke<Notices>("third_party_licenses"));
        } catch (reason) {
          setError(String(reason));
        } finally {
          setLoading(false);
        }
      }}
    >
      <summary>Third-party licences</summary>
      {loading && <p role="status">Loading licences…</p>}
      {error && <p role="alert">{error}</p>}
      {notices && (
        <div className="grid gap-3">
          <h3>FFmpeg · separate GPL executable</h3>
          <pre className="whitespace-pre-wrap break-words text-xs">
            {notices.ffmpeg.sourceOffer}
          </pre>
          {notices.ffmpeg.builds.map((build) => (
            <details key={build.target}>
              <summary>{build.target}</summary>
              <p className="break-all">{build.url}</p>
              <p className="break-all">SHA-256: {build.sha256}</p>
              <pre className="whitespace-pre-wrap break-words text-xs">{build.configuration}</pre>
            </details>
          ))}
          <details>
            <summary>GNU General Public License</summary>
            <pre className="whitespace-pre-wrap break-words text-xs">{notices.ffmpeg.gpl}</pre>
          </details>
          {notices.components.map((component) => (
            <details key={component.name + component.version}>
              <summary>
                {component.name} {component.version} · {component.license}
              </summary>
              <p className="break-all">{component.repository}</p>
              {component.texts.map((text, index) => (
                <pre key={text.name + index} className="whitespace-pre-wrap break-words text-xs">
                  {text.text}
                </pre>
              ))}
            </details>
          ))}
        </div>
      )}
    </details>
  );
}
