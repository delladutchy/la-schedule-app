'use client';

import { useEffect, useRef, useState } from 'react';

export interface LocationSuggestion {
  displayName: string;
  shortName: string;
  subtext: string;
  lat: number;
  lon: number;
}

const MIN_QUERY_LENGTH = 3;
const DEBOUNCE_MS = 700;

// Module-level cache shared across hook instances; key is trimmed query string.
const suggestionsCache = new Map<string, LocationSuggestion[]>();

function isLocationSuggestion(item: unknown): item is LocationSuggestion {
  if (typeof item !== 'object' || item === null) return false;
  const s = item as Record<string, unknown>;
  return (
    typeof s.displayName === 'string' &&
    typeof s.shortName === 'string' &&
    typeof s.subtext === 'string' &&
    typeof s.lat === 'number' &&
    typeof s.lon === 'number'
  );
}

/**
 * `unavailable` means the lookup never ran (billing off, key denied, network),
 * as opposed to running and matching nothing. Only the latter justifies
 * telling the user no such location exists.
 */
export interface SuggestionsResult {
  results: LocationSuggestion[];
  unavailable: boolean;
}

async function fetchSuggestions(
  query: string,
  signal: AbortSignal,
): Promise<SuggestionsResult> {
  const cached = suggestionsCache.get(query);
  if (cached) return { results: cached, unavailable: false };

  const params = new URLSearchParams({ q: query });
  const resp = await fetch(`/api/locations/search?${params}`, { signal });

  if (!resp.ok) return { results: [], unavailable: true };

  const data: unknown = await resp.json();
  if (
    typeof data !== 'object' ||
    data === null ||
    !Array.isArray((data as Record<string, unknown>).suggestions)
  ) {
    return { results: [], unavailable: true };
  }

  if ((data as Record<string, unknown>).status === 'unavailable') {
    return { results: [], unavailable: true };
  }

  const results = (
    (data as Record<string, unknown>).suggestions as unknown[]
  ).filter(isLocationSuggestion);

  // Only cache real answers — caching an outage would pin "no results" onto
  // a valid query for the rest of the session.
  suggestionsCache.set(query, results);
  if (suggestionsCache.size > 50) {
    const firstKey = suggestionsCache.keys().next().value;
    if (firstKey !== undefined) suggestionsCache.delete(firstKey);
  }

  return { results, unavailable: false };
}

export function useLocationAutocomplete(query: string) {
  const [suggestions, setSuggestions] = useState<LocationSuggestion[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isUnavailable, setIsUnavailable] = useState(false);
  // abortRef always holds the controller for the most recent query >= MIN_QUERY_LENGTH.
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const trimmed = query.trim();

    if (trimmed.length < MIN_QUERY_LENGTH) {
      abortRef.current?.abort();
      abortRef.current = null;
      setSuggestions([]);
      setIsUnavailable(false);
      setIsLoading(false);
      return;
    }

    // Abort any previous in-flight request before starting the debounce timer.
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setIsLoading(true);

    const timer = setTimeout(() => {
      void fetchSuggestions(trimmed, controller.signal)
        .then((outcome) => {
          if (controller.signal.aborted) return;
          setSuggestions(outcome.results);
          setIsUnavailable(outcome.unavailable);
          setIsLoading(false);
        })
        .catch((err: unknown) => {
          if ((err as { name?: string }).name === 'AbortError') return;
          // A thrown request tells us nothing about the query itself.
          setSuggestions([]);
          setIsUnavailable(true);
          setIsLoading(false);
        });
    }, DEBOUNCE_MS);

    return () => {
      clearTimeout(timer);
    };
  }, [query]);

  // Abort in-flight request on unmount.
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  const clear = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    setSuggestions([]);
    setIsUnavailable(false);
    setIsLoading(false);
  };

  return { suggestions, isLoading, isUnavailable, clear };
}
