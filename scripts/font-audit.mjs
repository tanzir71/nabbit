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
    let { fonts } = await cdp.send("CSS.getPlatformFontsForNode", { nodeId });
    // Chromium paints form-control glyphs in its user-agent shadow tree.
    // Inspect those actual nodes instead of accepting a computed family name.
    if (!fonts.length) {
      const { node } = await cdp.send("DOM.describeNode", { nodeId, depth: -1, pierce: true });
      if (["INPUT", "TEXTAREA"].includes(node.nodeName)) {
        const visit = async (item) => {
          const { nodeIds } = await cdp.send("DOM.pushNodesByBackendIdsToFrontend", {
            backendNodeIds: [item.backendNodeId],
          });
          const result = await cdp.send("CSS.getPlatformFontsForNode", {
            nodeId: nodeIds[0],
          });
          fonts.push(...result.fonts);
          for (const child of [...(item.children ?? []), ...(item.shadowRoots ?? [])])
            await visit(child);
        };
        for (const shadow of node.shadowRoots ?? []) await visit(shadow);
      }
    }
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
