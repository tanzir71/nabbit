import assert from "node:assert/strict";

// Axe cannot determine a partly occluded card's background. Resolve only this
// exact case: an opaque Notes view menu, no shadows/filters, solid card fills.
// Every default axe rule remains active; all other incomplete results fail.
export async function reviewNotesMenuContrast(page, incomplete) {
  const proof = [];
  for (const rule of incomplete) {
    assert.equal(rule.id, "color-contrast");
    for (const node of rule.nodes) {
      assert.equal(node.target.length, 1);
      const selector = node.target[0];
      const value = await page.locator(selector).evaluate((element) => {
        if (!element.closest(".notes-card-wrap"))
          throw new Error("Unreviewed non-card contrast result");
        const menu = globalThis.document.querySelector(".notes-view-menu[open] .notes-menu");
        if (!menu) throw new Error("No open Notes view menu");
        const rgba = (color) => {
          if (!color.startsWith("rgb")) throw new Error(`Unsupported colour: ${color}`);
          const n = color.match(/[\d.]+/g).map(Number);
          return [...n.slice(0, 3), n[3] ?? 1];
        };
        const check = (el) => {
          const s = globalThis.getComputedStyle(el);
          if (
            Number(s.opacity) !== 1 ||
            s.filter !== "none" ||
            s.backgroundImage !== "none" ||
            s.boxShadow !== "none" ||
            s.textShadow !== "none"
          )
            throw new Error("Contrast proof requires unfiltered solid colours without shadows");
          return s;
        };
        const overlay = rgba(check(menu).backgroundColor);
        if (overlay[3] !== 1) throw new Error("Notes menu must be opaque");
        const a = element.getBoundingClientRect(),
          b = menu.getBoundingClientRect();
        if (!(a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top))
          throw new Error("Unreviewed contrast overlap");
        const foreground = rgba(check(element).color);
        let backdrop;
        for (let el = element; el; el = el.parentElement) {
          const s = globalThis.getComputedStyle(el);
          if (Number(s.opacity) !== 1 || s.filter !== "none")
            throw new Error("Translucent/filtered ancestor");
          if (backdrop) continue;
          check(el);
          const bg = rgba(s.backgroundColor);
          if (bg[3] === 1) backdrop = bg;
          else if (bg[3] !== 0) throw new Error("Translucent text backdrop");
        }
        return { foreground, backdrop, overlay, overlapWithOpaqueViewMenu: true };
      });
      assert.equal(value.foreground[3], 1);
      assert(value.backdrop);
      assert.equal(value.backdrop[3], 1);
      const luminance = (c) =>
        c
          .slice(0, 3)
          .map((v) => v / 255)
          .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
          .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
      const a = luminance(value.foreground),
        b = luminance(value.backdrop),
        ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
      assert(ratio >= 4.5, `${selector}: contrast ${ratio}`);
      proof.push({
        selector,
        ...value,
        minimumContrastRatio: ratio,
        requiredContrastRatio: 4.5,
        resolution:
          "Uncovered glyphs retain the proven opaque card backdrop; covered portions are occluded by the opaque, shadow-free menu. Menu text is checked by axe.",
      });
    }
  }
  return proof;
}
