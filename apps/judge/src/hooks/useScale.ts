import { useEffect, useState } from "react";

/**
 * VIEWPORT SCALE — Use layout width/height only — never the visual viewport
 * (which shrinks when keyboard opens). This means we only ever scale based on
 * the true screen dimensions, not the keyboard-adjusted view.
 * Returns a scale factor and updates :root font-size accordingly.
 */
export function useScale(): number {
  const [scale, setScale] = useState(1);
  useEffect(() => {
    function update() {
      // Read viewport (window.innerWidth/Height) instead of device screen so
      // resized windows and OBS browser sources scale correctly.
      const w = window.innerWidth;
      const h = window.innerHeight;
      // Use the smaller screen dimension as width (handles landscape correctly)
      const sw = Math.min(w, h);
      const sh = Math.max(w, h);
      const wScale = Math.min(sw / 480, 2.2);
      const hScale = Math.min(sh / 700, 2.0);
      const s = Math.min(wScale, hScale);
      const clamped = Math.max(0.7, Math.min(2.0, s));
      setScale(clamped);
      document.documentElement.style.fontSize = (16 * clamped) + "px";
    }
    update();
    // Debounce resize/orientation events by 100ms so dragging a window edge
    // doesn't thrash layout. Keyboard open on mobile normally fires `resize`
    // too, but the underlying viewport math still uses window.innerWidth/Height
    // which debounce smooths out without losing final values.
    let t: ReturnType<typeof setTimeout> | null = null;
    const scheduled = (): void => {
      if (t !== null) clearTimeout(t);
      t = setTimeout(update, 100);
    };
    // Listen to resize (window drag, OBS source resize) in addition to orientation change.
    window.addEventListener("resize", scheduled);
    window.addEventListener("orientationchange", scheduled);
    return () => {
      if (t !== null) clearTimeout(t);
      window.removeEventListener("resize", scheduled);
      window.removeEventListener("orientationchange", scheduled);
    };
  }, []);
  return scale;
}
