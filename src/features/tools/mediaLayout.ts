/** Include scrollable content when the native viewport still has its loading height. */
export function desiredReviewHeight(root: HTMLElement) {
  const review = root.querySelector<HTMLElement>(".media-review");
  if (!review) return Math.ceil(root.getBoundingClientRect().height);
  const overflow = [...review.children].reduce(
    (sum, child) => sum + Math.max(0, child.scrollHeight - child.clientHeight),
    0,
  );
  return Math.ceil(review.getBoundingClientRect().height + overflow);
}
