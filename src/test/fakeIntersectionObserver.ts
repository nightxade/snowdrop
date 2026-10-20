import { vi } from 'vitest';

/** Controllable IntersectionObserver stand-in for jsdom. */
export class FakeIO {
  static instances: FakeIO[] = [];
  observed = new Set<Element>();
  disconnected = false;
  constructor(private readonly cb: IntersectionObserverCallback) {
    FakeIO.instances.push(this);
  }
  observe(el: Element) {
    this.observed.add(el);
  }
  disconnect() {
    this.disconnected = true;
    this.observed.clear();
  }
  unobserve() {}
  takeRecords() {
    return [];
  }
  emit(isIntersecting: boolean) {
    this.cb(
      [...this.observed].map((target) => ({ isIntersecting, target }) as IntersectionObserverEntry),
      this as unknown as IntersectionObserver,
    );
  }
}

export function installFakeIO(): void {
  FakeIO.instances = [];
  vi.stubGlobal('IntersectionObserver', FakeIO);
}
