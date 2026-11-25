import { ShieldCheck } from "lucide-react";
import { Button } from "../components/Button";
import { useAppStore } from "../store/useAppStore";

export function FirstRunNotice() {
  const acknowledgeFirstRun = useAppStore((state) => state.acknowledgeFirstRun);

  return (
    <div className="fixed inset-0 z-30 grid place-items-center bg-island-bg/50 p-4">
      <section className="w-full max-w-md rounded-xl border border-subtle bg-surface p-5 shadow-popover">
        <div className="flex items-center gap-3">
          <div className="grid size-10 place-items-center rounded-lg bg-raised text-secondary">
            <ShieldCheck size={22} />
          </div>
          <div>
            <h2 className="font-semibold">Private by default</h2>
            <p className="text-sm text-secondary">
              One quick acknowledgement before Nabbit starts watching.
            </p>
          </div>
        </div>
        <div className="mt-4 space-y-3 text-sm leading-6 text-secondary">
          <p>
            Clipboard history is stored locally. Nabbit does not send clipboard contents or
            analytics anywhere.
          </p>
          <p>
            Downloads require your click. Use Nabbit only for content you have the right to download
            and do not use it to bypass DRM or protected services.
          </p>
        </div>
        <Button
          className="mt-5 w-full"
          variant="primary"
          onClick={() => void acknowledgeFirstRun()}
        >
          Acknowledge
        </Button>
      </section>
    </div>
  );
}
