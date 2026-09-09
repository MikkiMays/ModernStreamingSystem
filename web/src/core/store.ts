export class Store<T> {
  private listeners = new Set<() => void>();
  constructor(private value: T) {}
  get = () => this.value;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  set(value: T) {
    if (Object.is(value, this.value)) return;
    this.value = value;
    for (const listener of this.listeners) listener();
  }
  update(updater: (current: T) => T) {
    this.set(updater(this.value));
  }
}
