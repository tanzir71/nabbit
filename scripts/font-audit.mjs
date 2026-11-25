import assert from "node:assert/strict";

// CDP reports the face actually used for glyphs, including custom-font status.
// A computed font-family string alone also succeeds when a font failed to load.
export async function auditFont(page, selector, family) {
  await page.evaluate(() => globalThis.document.fonts.ready);
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send("DOM.enable");
    await cdp.send("CSS.enable");
    const { root } = await cdp.send("DOM.getDocument");
    const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector });
    assert(nodeId, `Missing font audit node ${selector}`);
    const { fonts } = await cdp.send("CSS.getPlatformFontsForNode", { nodeId });
    assert(fonts.length > 0, `${selector}: no rendered glyphs`);
    for (const font of fonts) {
      assert.equal(font.familyName, family, `${selector}: fallback face`);
      assert.equal(font.isCustomFont, true, `${selector}: installed face`);
      assert(font.glyphCount > 0);
    }
    return fonts;
  } finally {
    await cdp.detach();
  }
}
