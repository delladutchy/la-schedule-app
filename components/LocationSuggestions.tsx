'use client';

import type { LocationSuggestion } from '@/lib/useLocationAutocomplete';

const MIN_QUERY_LENGTH = 3;

interface LocationSuggestionsProps {
  listboxId: string;
  query: string;
  suggestions: LocationSuggestion[];
  isLoading: boolean;
  activeIndex: number;
  onSelect: (suggestion: LocationSuggestion) => void;
}

export function LocationSuggestions({
  listboxId,
  query,
  suggestions,
  isLoading,
  activeIndex,
  onSelect,
}: LocationSuggestionsProps) {
  if (query.trim().length < MIN_QUERY_LENGTH) return null;

  if (isLoading) {
    return (
      <div className="location-suggestions" role="status" aria-live="polite">
        <div className="location-suggestions__status location-suggestions__status--loading">
          Finding locations…
        </div>
      </div>
    );
  }

  if (suggestions.length === 0) {
    return (
      <div className="location-suggestions" role="status" aria-live="polite">
        <div className="location-suggestions__status">No locations found</div>
      </div>
    );
  }

  return (
    <ul
      id={listboxId}
      className="location-suggestions"
      role="listbox"
      aria-label="Location suggestions"
    >
      {suggestions.map((s, i) => (
        <li
          key={`${s.lat},${s.lon}`}
          id={`${listboxId}-${i}`}
          role="option"
          aria-selected={i === activeIndex}
          className={`location-suggestions__item${i === activeIndex ? ' location-suggestions__item--active' : ''}`}
          // preventDefault prevents the input from blurring before onClick fires.
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onSelect(s)}
        >
          <span className="location-suggestions__name">{s.shortName}</span>
          {s.subtext ? <span className="location-suggestions__sub">{s.subtext}</span> : null}
        </li>
      ))}
    </ul>
  );
}
