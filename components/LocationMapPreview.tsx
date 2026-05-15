'use client';

import 'leaflet/dist/leaflet.css';
import { createPortal } from 'react-dom';
import type { CircleMarker as LeafletCircleMarker, Map as LeafletMap } from 'leaflet';
import { useEffect, useRef, useState } from 'react';

type GeoCoords = { lat: number; lon: number };
type GeoStatus = 'loading' | 'ok' | 'not-found' | 'error';

// Soft geographic bias matching the autocomplete hook — Delaware + Mid-Atlantic coast.
// bounded=0 means US-wide results still appear; in-area results rank first.
// Keep in sync with BIAS_VIEWBOX in lib/useLocationAutocomplete.ts.
const GEOCODE_BIAS_VIEWBOX = '-76.5,40.2,-74.5,37.8';

// Module-level cache: avoids re-geocoding the same string within a session.
const geocodeCache = new Map<string, GeoCoords>();

async function geocodeQuery(query: string, signal: AbortSignal): Promise<GeoCoords | null> {
  const cached = geocodeCache.get(query);
  if (cached) return cached;

  const params = new URLSearchParams({
    q: query,
    format: 'json',
    limit: '1',
    countrycodes: 'us',
    viewbox: GEOCODE_BIAS_VIEWBOX,
    bounded: '0',
  });
  const resp = await fetch(
    `https://nominatim.openstreetmap.org/search?${params}`,
    { signal, headers: { 'Accept-Language': 'en' } },
  );
  if (!resp.ok) return null;

  const data: unknown = await resp.json();
  if (!Array.isArray(data) || data.length === 0) return null;

  const first = data[0] as { lat?: string; lon?: string };
  const lat = parseFloat(first.lat ?? '');
  const lon = parseFloat(first.lon ?? '');
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

  const result: GeoCoords = { lat, lon };
  geocodeCache.set(query, result);
  if (geocodeCache.size > 50) {
    const firstKey = geocodeCache.keys().next().value;
    if (firstKey !== undefined) geocodeCache.delete(firstKey);
  }
  return result;
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

// Outer wrapper handles the feature flag — no hooks here, safe to return null early.
export function LocationMapPreview(props: LocationMapPreviewProps) {
  if (process.env.NEXT_PUBLIC_LOCATION_MAPS_ENABLED !== 'true') return null;
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
          if (result) {
            setCoords(result);
            setStatus('ok');
          } else {
            setCoords(null);
            setStatus('not-found');
          }
        })
        .catch((err: unknown) => {
          if ((err as { name?: string }).name === 'AbortError') return;
          setCoords(null);
          setStatus('error');
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
            {status === 'loading' ? 'Finding location…' : 'Location not found'}
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
