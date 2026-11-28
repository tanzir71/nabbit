import { expect, it } from "vitest";
import { desiredReviewHeight } from "./mediaLayout";
it("requests the loaded content height when a loading-sized viewport clips the scrollable body", () => {
  const root = document.createElement("main");
  root.innerHTML =
    '<section class="media-review"><header></header><div class="trim-body"></div><footer></footer></section>';
  const review = root.firstElementChild as HTMLElement,
    body = review.children[1];
  review.getBoundingClientRect = () => ({ height: 225.25 }) as DOMRect;
  Object.defineProperties(body, {
    scrollHeight: { value: 190, configurable: true },
    clientHeight: { value: 100, configurable: true },
  });
  expect(desiredReviewHeight(root)).toBe(316);
  review.getBoundingClientRect = () => ({ height: 315.25 }) as DOMRect;
  Object.defineProperty(body, "clientHeight", { value: 190 });
  expect(desiredReviewHeight(root)).toBe(316);
});
it("keeps natural height when content fits and supports the initial host", () => {
  const root = document.createElement("main");
  root.getBoundingClientRect = () => ({ height: 20 }) as DOMRect;
  expect(desiredReviewHeight(root)).toBe(20);
  root.innerHTML =
    '<section class="media-review"><header></header><div></div><footer></footer></section>';
  (root.firstElementChild as HTMLElement).getBoundingClientRect = () =>
    ({ height: 533 }) as DOMRect;
  expect(desiredReviewHeight(root)).toBe(533);
});
