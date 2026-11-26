import assert from "node:assert/strict";

// Resolve axe's indeterminate contrast checks without disabling a rule or
// excluding content. Gradients use a conservative per-channel bound; the three
// overlapping illustration captions use their own opaque backdrop. No live UI
// text may silently enter the illustration-overlap exception.
export async function reviewContrast(page, incomplete) {
  const reviews = [];
  const overlapNodes = new Set(["I49:1266;10:326", "I49:1266;10:332", "I49:1266;10:340"]);
  for (const rule of incomplete) {
    assert.equal(rule.id, "color-contrast", `Unresolved axe check: ${rule.id}`);
    for (const node of rule.nodes) {
      assert.equal(node.target.length, 1);
      const selector = node.target[0];
      const value = await page.locator(selector).evaluate((element) => {
        const rgba = (color) => {
          const numbers = color.match(/[\d.]+/g)?.map(Number);
          if (!color.startsWith("rgb") || !numbers || numbers.length < 3)
            throw new Error(`Unsupported contrast color: ${color}`);
          return [...numbers.slice(0, 3), numbers[3] ?? 1];
        };
        const foreground = rgba(globalThis.getComputedStyle(element).color);
        let backdrop;
        for (let parent = element; parent; parent = parent.parentElement) {
          const style = globalThis.getComputedStyle(parent);
          if (Number(style.opacity) !== 1 || style.filter !== "none")
            throw new Error("Contrast proof requires opaque, unfiltered ancestors");
          if (backdrop) continue;
          if (style.backgroundImage !== "none") {
            if (!style.backgroundImage.startsWith("linear-gradient("))
              throw new Error("Unsupported contrast image");
            const stops = [...style.backgroundImage.matchAll(/rgba?\([^)]+\)/g)].map((match) =>
              rgba(match[0]),
            );
            if (stops.length < 2 || stops.some((stop) => stop[3] !== 1))
              throw new Error("Contrast proof requires opaque gradient stops");
            backdrop = {
              kind: "gradient-bound",
              stops,
              lower: [0, 1, 2].map((channel) => Math.min(...stops.map((stop) => stop[channel]))),
              upper: [0, 1, 2].map((channel) => Math.max(...stops.map((stop) => stop[channel]))),
            };
          } else {
            const color = rgba(style.backgroundColor);
            if (color[3] === 1)
              backdrop = { kind: "solid", lower: color.slice(0, 3), upper: color.slice(0, 3) };
            else if (color[3] !== 0) throw new Error("Unsupported translucent backdrop");
          }
        }
        return {
          foreground,
          backdrop,
          nodeId: element.getAttribute("data-node-id"),
          illustrated: Boolean(element.closest('[role="img"][aria-label]')),
        };
      });
      assert.equal(value.foreground[3], 1);
      assert(value.backdrop, `Missing backdrop for ${selector}`);
      const luminance = (channels) =>
        channels
          .slice(0, 3)
          .map((channel) => {
            const value = channel / 255;
            return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
          })
          .reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index], 0);
      const fg = luminance(value.foreground),
        lower = luminance(value.backdrop.lower),
        upper = luminance(value.backdrop.upper);
      assert(fg < lower || fg > upper, "Foreground overlaps the gradient luminance range");
      const minimum = fg < lower ? (lower + 0.05) / (fg + 0.05) : (fg + 0.05) / (upper + 0.05);
      assert(minimum >= 4.5, `${selector}: contrast lower bound ${minimum}`);
      if (value.backdrop.kind === "solid") {
        assert(
          value.illustrated && overlapNodes.has(value.nodeId),
          `Unreviewed overlap: ${selector}`,
        );
      }
      reviews.push({
        selector,
        ...value,
        minimumContrastRatio: minimum,
        requiredContrastRatio: 4.5,
        resolution:
          value.backdrop.kind === "solid"
            ? "Visible portions retain this opaque illustration backdrop; other portions are occluded by opaque preview cards"
            : "Every interpolated gradient channel lies within these conservative RGB bounds",
      });
    }
  }
  return reviews;
}
