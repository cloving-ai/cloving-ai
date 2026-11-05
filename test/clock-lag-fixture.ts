export function laggingClock(milliseconds: number): () => void {
  const real = performance.now.bind(performance);
  const installed = real();
  Object.defineProperty(performance, "now", {
    configurable: true,
    value: () => Math.max(installed, real() - milliseconds),
  });
  return () => {
    Reflect.deleteProperty(performance, "now");
  };
}
