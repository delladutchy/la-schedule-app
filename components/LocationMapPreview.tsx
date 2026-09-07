'use client';

import 'leaflet/dist/leaflet.css';
import { createPortal } from 'react-dom';
import type { CircleMarker as LeafletCircleMarker, Map as LeafletMap } from 'leaflet';
import { useEffect, useRef, useState } from 'react';

type GeoCoords = { lat: number; lon: number };
// 'not-found'   — the geocoder ran and genuinely matched nothing.
// 'unavailable' — the geocoder never ran (billing off, key denied, network).
// These must stay distinct: only the first says anything about the place, and
// neither means the calendar's own location text is wrong or absent.
type GeoStatus = 'loading' | 'ok' | 'not-found' | 'unavailable';
type LocationSuggestion = {
  displayName?: string;
  shortName?: string;
  subtext?: string;
  lat?: number;
  lon?: number;
};
type LocationSearchResponse = {
  suggestions?: LocationSuggestion[];
  status?: 'ok' | 'unavailable';
};

export type GeocodeOutcome =
  | { status: 'ok'; coords: GeoCoords }
  | { status: 'not-found' }
  | { status: 'unavailable' };

// Module-level cache: avoids re-geocoding the same string within a session.
// Only successful lookups are cached — caching a failure would pin a
// transient outage (or a billing lapse) onto a valid location for the
// remainder of the session.
const geocodeCache = new Map<string, GeoCoords>();

export async function geocodeQuery(
  query: string,
  signal: AbortSignal,
): Promise<GeocodeOutcome> {
  const cached = geocodeCache.get(query);
  if (cached) return { status: 'ok', coords: cached };

  const params = new URLSearchParams({ q: query });
  const resp = await fetch(`/api/locations/search?${params}`, { signal });
  // Any non-2xx (503 not configured, 400 query too short, 5xx) means we never
  // got an answer about this place — not that the place is unknown.
  if (!resp.ok) return { status: 'unavailable' };

  const data = (await resp.json()) as LocationSearchResponse;
  if (data.status === 'unavailable') return { status: 'unavailable' };

  const first = data.suggestions?.[0];
  const lat = first?.lat;
  const lon = first?.lon;
  if (typeof lat !== 'number' || !Number.isFinite(lat)) return { status: 'not-found' };
  if (typeof lon !== 'number' || !Number.isFinite(lon)) return { status: 'not-found' };

  const result: GeoCoords = { lat, lon };
  geocodeCache.set(query, result);
  if (geocodeCache.size > 50) {
    const firstKey = geocodeCache.keys().next().value;
    if (firstKey !== undefined) geocodeCache.delete(firstKey);
  }
  return { status: 'ok', coords: result };
}

export interface LocationMapPreviewProps {
  location: string;
  /** Milliseconds to wait after the last location change before geocoding. */
  debounceMs?: number;
  /** Pre-resolved coordinates from a selected autocomplete suggestion. When
   *  provided the map snaps immediately without a geocoding round-trip. */
  coords?: { lat: number; lon: number } | null;
  /** When false, suppresses free-text geocoding (e.g. while autocomplete
   *  suggestions are visible). The map freezes at its last known position
   *  until this becomes true again. Has no effect when coords is provided. */
  geocodingEnabled?: boolean;
}

export function LocationMapPreview(props: LocationMapPreviewProps) {
  return <LocationMapPreviewInner {...props} />;
}

function LocationMapPreviewInner({ location, debounceMs = 400, coords: propCoords, geocodingEnabled = true }: LocationMapPreviewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<LeafletMap | null>(null);
  const markerRef = useRef<LeafletCircleMarker | null>(null);

  const expandedContainerRef = useRef<HTMLDivElement>(null);
  const expandedMapRef = useRef<LeafletMap | null>(null);
  const expandedMarkerRef = useRef<LeafletCircleMarker | null>(null);

  const [coords, setCoords] = useState<GeoCoords | null>(null);
  const [status, setStatus] = useState<GeoStatus>('loading');
  const [expanded, setExpanded] = useState(false);

  // Geocoding priority:
  // 1. Pre-resolved coords from an autocomplete selection → snap map immediately.
  // 2. geocodingEnabled=false (suggestions panel open) → freeze map, skip geocoding.
  // 3. Free-text geocoding with US + Mid-Atlantic bias.
  useEffect(() => {
    if (propCoords) {
      setCoords(propCoords);
      setStatus('ok');
      return;
    }

    // Suggestions are visible — freeze the map rather than geocoding partial text.
    if (!geocodingEnabled) return;

    const trimmed = location.trim();
    if (!trimmed) return;

    setStatus('loading');
    const controller = new AbortController();

    const timer = setTimeout(() => {
      geocodeQuery(trimmed, controller.signal)
        .then((result) => {
          if (result.status === 'ok') {
            setCoords(result.coords);
            setStatus('ok');
          } else {
            setCoords(null);
            setStatus(result.status);
          }
        })
        .catch((err: unknown) => {
          if ((err as { name?: string }).name === 'AbortError') return;
          // A thrown request tells us nothing about the place itself.
          setCoords(null);
          setStatus('unavailable');
        });
    }, debounceMs);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [location, debounceMs, propCoords, geocodingEnabled]);

  // Initialize Leaflet map on first valid coords; pan/move marker on subsequent changes.
  // The `cancelled` flag prevents a stale async import from touching the map
  // after the effect has been superseded by a newer coords value.
  useEffect(() => {
    if (!coords || !containerRef.current) return;

    let cancelled = false;

    void import('leaflet').then((L) => {
      if (cancelled || !containerRef.current) return;

      if (!mapRef.current) {
        const map = L.map(containerRef.current, {
          zoomControl: false,
          attributionControl: true,
          dragging: true,
          touchZoom: true,
          scrollWheelZoom: false,
          doubleClickZoom: true,
          boxZoom: false,
          keyboard: false,
        }).setView([coords.lat, coords.lon], 13);

        L.control.zoom({ position: 'bottomright' }).addTo(map);

        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
          maxZoom: 19,
          attribution:
            '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a>',
        }).addTo(map);

        markerRef.current = L.circleMarker([coords.lat, coords.lon], {
          radius: 8,
          fillColor: '#007aff',
          color: '#ffffff',
          weight: 2.5,
          fillOpacity: 1,
        }).addTo(map);

        mapRef.current = map;

        // Two invalidateSize calls: first covers fast opens, second covers desktop
        // modal CSS transitions that may still be running at 150ms.
        setTimeout(() => { map.invalidateSize(); }, 150);
        setTimeout(() => { map.invalidateSize(); }, 350);
      } else {
        mapRef.current.setView([coords.lat, coords.lon], 13, { animate: true });
        markerRef.current?.setLatLng([coords.lat, coords.lon]);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [coords]);

  // ResizeObserver calls invalidateSize whenever the container dimensions change,
  // ensuring the map fills correctly when a modal animates open or resizes.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      if (mapRef.current) mapRef.current.invalidateSize();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Expanded map: initialise a fresh Leaflet instance in the overlay using the
  // already-known coords (no re-geocoding). Cleaned up on close or unmount.
  useEffect(() => {
    if (!expanded || !coords) return;

    const el = expandedContainerRef.current;
    if (!el) return;

    let cancelled = false;

    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setExpanded(false); };
    document.addEventListener('keydown', onKey);

    void import('leaflet').then((L) => {
      if (cancelled || !expandedContainerRef.current) return;

      const map = L.map(expandedContainerRef.current, {
        zoomControl: true,
        attributionControl: true,
        dragging: true,
        touchZoom: true,
        scrollWheelZoom: true,
        doubleClickZoom: true,
        boxZoom: true,
        keyboard: true,
      }).setView([coords.lat, coords.lon], 13);

      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution:
          '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a>',
      }).addTo(map);

      expandedMarkerRef.current = L.circleMarker([coords.lat, coords.lon], {
        radius: 10,
        fillColor: '#007aff',
        color: '#ffffff',
        weight: 2.5,
        fillOpacity: 1,
      }).addTo(map);

      expandedMapRef.current = map;
      setTimeout(() => { map.invalidateSize(); }, 150);
      setTimeout(() => { map.invalidateSize(); }, 350);
    });

    return () => {
      cancelled = true;
      document.removeEventListener('keydown', onKey);
      if (expandedMapRef.current) {
        expandedMapRef.current.remove();
        expandedMapRef.current = null;
        expandedMarkerRef.current = null;
      }
    };
  }, [expanded, coords]);

  // Destroy Leaflet map when the component unmounts.
  // Empty dependency array ensures this cleanup runs once, on unmount only.
  useEffect(() => {
    return () => {
      if (mapRef.current) {
        mapRef.current.remove();
        mapRef.current = null;
        markerRef.current = null;
      }
    };
  }, []);

  const canExpand = status === 'ok';

  return (
    <>
      <div
        className={`location-map-preview${canExpand ? ' location-map-preview--expandable' : ''}`}
        onClick={canExpand ? () => setExpanded(true) : undefined}
        role={canExpand ? 'button' : undefined}
        tabIndex={canExpand ? 0 : undefined}
        aria-label={canExpand ? 'View larger map' : undefined}
        onKeyDown={canExpand ? (e) => { if (e.key === 'Enter' || e.key === ' ') setExpanded(true); } : undefined}
      >
        <div ref={containerRef} className="location-map-preview__map" />
        {status !== 'ok' && (
          <div className={`location-map-preview__overlay${status === 'loading' ? ' location-map-preview__overlay--loading' : ''}`}>
            {status === 'loading' ? (
              'Finding location…'
            ) : (
              // The calendar's location is the source of truth. Geocoding only
              // enriches it with a map pin, so when the pin is unavailable we
              // show the real location text rather than implying it is missing.
              <>
                <span className="location-map-preview__overlay-location">{location.trim()}</span>
                <span className="location-map-preview__overlay-note">
                  {status === 'unavailable'
                    ? 'Map preview unavailable'
                    : 'No map match for this address'}
                </span>
              </>
            )}
          </div>
        )}
      </div>

      {expanded && createPortal(
        <div
          className="location-map-expanded-overlay"
          onClick={() => setExpanded(false)}
          role="dialog"
          aria-modal="true"
          aria-label="Full map view"
        >
          <div
            className="location-map-expanded-modal"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="location-map-expanded-header">
              <span className="location-map-expanded-title">{location}</span>
              <button
                type="button"
                className="location-map-expanded-close"
                onClick={() => setExpanded(false)}
                aria-label="Close map"
              >
                ✕
              </button>
            </div>
            <div ref={expandedContainerRef} className="location-map-expanded-map" />
            <div className="location-map-expanded-footer">
              <a
                href={`https://maps.apple.com/?q=${encodeURIComponent(location.trim())}`}
                target="_blank"
                rel="noreferrer"
                className="location-map-expanded-maps-link"
              >
                Open in Apple Maps
              </a>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
