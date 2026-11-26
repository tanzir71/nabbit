(() => {
  const document = globalThis.document;
  const mobile = globalThis.matchMedia("(max-width: 600px)");
  const menu = document.querySelector(".nav-menu");
  const roadmap = document.querySelector(".progress-more");
  const responsive = () => {
    menu.open = !mobile.matches;
    roadmap.open = !mobile.matches;
  };
  responsive();
  mobile.addEventListener("change", responsive);
  menu.querySelectorAll("a").forEach((link) =>
    link.addEventListener("click", () => {
      if (mobile.matches) menu.open = false;
    }),
  );
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && mobile.matches && menu.open) {
      menu.open = false;
      menu.querySelector("summary").focus();
    }
  });
  const bookmarklet = document.querySelector("[data-bookmarklet]");
  const status = document.querySelector(".bookmarklet-status");
  bookmarklet.addEventListener("click", async (event) => {
    event.preventDefault();
    try {
      await globalThis.navigator.clipboard.writeText(bookmarklet.getAttribute("href"));
      status.textContent = "Bookmarklet copied. Add it as a bookmark, then use it on a video page.";
    } catch {
      status.textContent =
        "Copy is unavailable. Drag Send to Nabbit to your bookmarks bar instead.";
    }
  });
  // Only resize events drive these fixed-dimension design replicas; no timers.
  const observer = new globalThis.ResizeObserver((entries) => {
    for (const { target, contentRect } of entries) {
      if (!contentRect.width) continue;
      const replica = target.querySelector(":scope > .replica");
      const nativeWidth =
        target.classList.contains("live-replica") || target.classList.contains("mode-replica")
          ? 1120
          : 596;
      const scale = Math.min(1, contentRect.width / nativeWidth);
      target.style.setProperty(nativeWidth === 1120 ? "--wide-scale" : "--files-scale", scale);
      target.style.height = `${replica.offsetHeight * scale}px`;
    }
  });
  document
    .querySelectorAll(".live-replica,.mode-replica,.feature-files .feature-visual.desktop-only")
    .forEach((element) => observer.observe(element));
})();
