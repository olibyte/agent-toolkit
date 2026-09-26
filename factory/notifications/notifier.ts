import type { FactoryEvent } from "./events.ts";

export interface Notifier {
  notify(event: FactoryEvent): Promise<void>;
}

export function fanout(
  notifiers: readonly Notifier[],
  onError: (error: unknown, event: FactoryEvent) => void
): Notifier {
  return {
    async notify(event) {
      await Promise.all(
        notifiers.map(async (notifier) => {
          try {
            await notifier.notify(event);
          } catch (error) {
            onError(error, event);
          }
        })
      );
    },
  };
}

export function jsonLinesNotifier(write: (line: string) => void): Notifier {
  return {
    async notify(event) {
      write(`${JSON.stringify(event)}\n`);
    },
  };
}
