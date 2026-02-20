import { useEffect, useState } from "react";
import type { RefObject } from "react";

export function useElementHeight(
  ref: RefObject<HTMLElement | null>,
  enabled: boolean,
  defaultHeight: number,
): number {
  const [height, setHeight] = useState(defaultHeight);

  useEffect(() => {
    if (!enabled) {
      return;
    }

    const element = ref.current;
    if (!element) {
      return;
    }

    const updateHeight = () => {
      const nextHeight = element.clientHeight;
      if (nextHeight > 0) {
        setHeight((prev) => (prev === nextHeight ? prev : nextHeight));
      }
    };

    updateHeight();

    if (typeof ResizeObserver === "undefined") {
      return;
    }

    const observer = new ResizeObserver(() => {
      updateHeight();
    });
    observer.observe(element);

    return () => {
      observer.disconnect();
    };
  }, [enabled]);

  return height;
}
