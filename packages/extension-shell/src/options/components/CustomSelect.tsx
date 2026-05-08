import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
  className?: string;
}

// Counter used to give every CustomSelect a stable unique listbox id so the
// trigger button's aria-controls / aria-activedescendant point at concrete
// elements. useId is React 18+ so a module-scoped counter is fine and keeps
// the markup deterministic across re-renders.
let CUSTOM_SELECT_ID_COUNTER = 0;

interface CustomSelectProps {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  className?: string;
  searchable?: boolean;
  searchPlaceholder?: string;
  /** Optional accessible name when the surrounding markup doesn't provide one. */
  ariaLabel?: string;
}

/**
 * Headless-ish select dropdown with full keyboard a11y:
 * - Arrow keys / Home / End for navigation, Enter to commit, Tab/Esc to dismiss.
 * - Type-ahead matching for non-searchable mode (mimics native `<select>`).
 * - Searchable mode shows a filter input that captures focus on open.
 * - Restores focus to the trigger when the menu closes.
 *
 * Styling is owned by global CSS (`.cs-*` classes) — this component is purely
 * structural so themes can override appearance without forking the JS.
 */
export function CustomSelect({
  value,
  options,
  onChange,
  className = "",
  searchable = false,
  searchPlaceholder = "搜索...",
  ariaLabel,
}: CustomSelectProps) {
  const [open, setOpen] = useState(false);
  const [focusIdx, setFocusIdx] = useState(-1);
  const [query, setQuery] = useState("");
  const wrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  // Type-ahead buffer: collects letters typed in quick succession so the user
  // can jump to "Brazil" by typing "br" without entering search mode. Reset
  // after 500ms of inactivity to mimic native <select> semantics.
  const typeAheadRef = useRef<{ buffer: string; timer: number | null }>({ buffer: "", timer: null });
  const idRef = useRef<string>("cs-" + ++CUSTOM_SELECT_ID_COUNTER);
  const listboxId = `${idRef.current}-listbox`;
  const optionId = (i: number) => `${idRef.current}-opt-${i}`;

  const selected = options.find((o) => o.value === value);

  const visibleOptions = useMemo(() => {
    if (!searchable || !query.trim()) return options;
    const q = query.trim().toLowerCase();
    return options.filter((o) => o.label.toLowerCase().includes(q));
  }, [options, query, searchable]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  useEffect(() => {
    if (open) {
      setQuery("");
      const idx = visibleOptions.findIndex((o) => o.value === value);
      setFocusIdx(idx >= 0 ? idx : findFirstEnabledIndex(visibleOptions, 0, 1));
      if (searchable) {
        requestAnimationFrame(() => searchRef.current?.focus());
      }
    } else {
      // Restore focus to the trigger when the menu closes — this is what
      // native <select> does and what screenreaders/keyboard users expect.
      // Skip when the close was triggered by clicking outside (focus already
      // moved away on its own).
      if (document.activeElement && wrapRef.current?.contains(document.activeElement)) {
        triggerRef.current?.focus();
      }
    }
  }, [open]);

  useEffect(() => {
    setFocusIdx(findFirstEnabledIndex(visibleOptions, 0, 1));
  }, [query]);

  useEffect(() => {
    if (open && listRef.current && focusIdx >= 0) {
      const el = listRef.current.children[focusIdx] as HTMLElement | undefined;
      el?.scrollIntoView({ block: "nearest" });
    }
  }, [focusIdx, open]);

  const stepFocus = useCallback(
    (delta: 1 | -1) => {
      setFocusIdx((current) => {
        const start = current < 0 ? (delta > 0 ? -1 : visibleOptions.length) : current;
        const next = findFirstEnabledIndex(visibleOptions, start + delta, delta);
        return next === -1 ? current : next;
      });
    },
    [visibleOptions],
  );

  const handleTypeAhead = useCallback(
    (char: string) => {
      const state = typeAheadRef.current;
      state.buffer += char.toLowerCase();
      if (state.timer !== null) window.clearTimeout(state.timer);
      state.timer = window.setTimeout(() => {
        state.buffer = "";
        state.timer = null;
      }, 500);
      // Search starting AFTER the current focus so repeated key presses cycle
      // through siblings ("ggg" cycles the G's) — matches native <select>.
      const startFrom = state.buffer.length === 1 ? focusIdx + 1 : focusIdx;
      const found = findIndexByPrefix(visibleOptions, state.buffer, startFrom) ??
        findIndexByPrefix(visibleOptions, state.buffer, 0);
      if (found !== null) setFocusIdx(found);
    },
    [focusIdx, visibleOptions],
  );

  const handleKey = useCallback(
    (e: React.KeyboardEvent) => {
      if (!open) {
        if (e.key === "Enter" || e.key === " " || e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault();
          setOpen(true);
        }
        return;
      }
      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          stepFocus(1);
          break;
        case "ArrowUp":
          e.preventDefault();
          stepFocus(-1);
          break;
        case "Home":
          e.preventDefault();
          setFocusIdx(findFirstEnabledIndex(visibleOptions, 0, 1));
          break;
        case "End":
          e.preventDefault();
          setFocusIdx(findFirstEnabledIndex(visibleOptions, visibleOptions.length - 1, -1));
          break;
        case "Enter":
          e.preventDefault();
          if (focusIdx >= 0 && focusIdx < visibleOptions.length && !visibleOptions[focusIdx].disabled) {
            onChange(visibleOptions[focusIdx].value);
            setOpen(false);
          }
          break;
        case "Tab":
          // Tab closes the menu without selection so focus moves to the next
          // form control naturally instead of getting trapped inside the popup.
          setOpen(false);
          break;
        case "Escape":
          e.preventDefault();
          setOpen(false);
          break;
        default:
          // Type-ahead: any single printable character. Skip when the search
          // box is focused — the input itself handles letters.
          if (!searchable && e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
            e.preventDefault();
            handleTypeAhead(e.key);
          }
      }
    },
    [open, focusIdx, visibleOptions, onChange, searchable, stepFocus, handleTypeAhead],
  );

  return (
    <div className={`cs-wrap ${className}`} ref={wrapRef} onKeyDown={handleKey}>
      <button
        ref={triggerRef}
        type="button"
        className={`cs-trigger ${open ? "is-open" : ""}`}
        onClick={() => setOpen(!open)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        aria-activedescendant={open && focusIdx >= 0 ? optionId(focusIdx) : undefined}
        aria-label={ariaLabel}
      >
        <span className="cs-trigger-text">{selected?.label ?? ""}</span>
        <svg className="cs-chevron" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
          <path fillRule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z" clipRule="evenodd" />
        </svg>
      </button>
      {open && (
        <div className="cs-menu" id={listboxId} role="listbox" aria-label={ariaLabel}>
          {searchable && (
            <div className="cs-search">
              <svg className="cs-search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                <circle cx="11" cy="11" r="8" />
                <line x1="21" y1="21" x2="16.65" y2="16.65" />
              </svg>
              <input
                ref={searchRef}
                className="cs-search-input"
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={searchPlaceholder}
                onClick={(e) => e.stopPropagation()}
                aria-label={searchPlaceholder}
              />
            </div>
          )}
          <div className="cs-options" ref={listRef}>
            {visibleOptions.length === 0 ? (
              <div className="cs-empty">无匹配结果</div>
            ) : (
              visibleOptions.map((opt, i) => (
                <div
                  key={opt.value}
                  id={optionId(i)}
                  role="option"
                  aria-selected={opt.value === value}
                  aria-disabled={opt.disabled || undefined}
                  className={`cs-option ${opt.value === value ? "is-selected" : ""} ${i === focusIdx ? "is-focused" : ""} ${opt.disabled ? "is-disabled" : ""} ${opt.className ?? ""}`}
                  onMouseEnter={() => setFocusIdx(i)}
                  onClick={() => {
                    if (opt.disabled) return;
                    onChange(opt.value);
                    setOpen(false);
                  }}
                >
                  {opt.label}
                  {opt.value === value && (
                    <svg className="cs-check" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                      <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                    </svg>
                  )}
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Find the first enabled option starting at `from` and walking in `direction`.
 * Returns -1 when no enabled option exists in the search direction.
 */
function findFirstEnabledIndex(
  options: SelectOption[],
  from: number,
  direction: 1 | -1,
): number {
  for (let i = from; i >= 0 && i < options.length; i += direction) {
    if (!options[i].disabled) return i;
  }
  return -1;
}

/**
 * Locate the next option whose label starts with `prefix`, beginning from
 * `from` and wrapping back to the start. Powers type-ahead navigation.
 */
function findIndexByPrefix(
  options: SelectOption[],
  prefix: string,
  from: number,
): number | null {
  if (!prefix) return null;
  for (let i = Math.max(0, from); i < options.length; i += 1) {
    const opt = options[i];
    if (!opt.disabled && opt.label.toLowerCase().startsWith(prefix)) return i;
  }
  return null;
}
