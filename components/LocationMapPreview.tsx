'use client';

import 'leaflet/dist/leaflet.css';
import type { CircleMarker as LeafletCircleMarker, Map as LeafletMap } from 'leaflet';
import { useEffect, useRef, useState } from 'react';

type GeoCoords = { lat: number; lon: number };
type GeoStatus = 'loading' | 'ok' | 'not-found' | 'error';

// Module-level cache: avoids re-geocoding the same string within a session.
const geocodeCache = new Map<string, GeoCoords>();

async function geocodeQuery(query: string, signal: AbortSignal): Promise<GeoCoords | null> {
  const cached = geocodeCache.get(query);
  if (cached) return cached;

  const params = new URLSearchParams({ q: query, format: 'json', limit: '1' });
  const resp = await fetch(
    `https://nominatim.openstreetmap.org/search?${params}`,
    { signal },
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
}

// Outer wrapper handles the feature flag — no hooks here, safe to return null early.
export function LocationMapPreview(props: LocationMapPreviewProps) {
  if (process.env.NEXT_PUBLIC_LOCATION_MAPS_ENABLED !== 'true') return null;
  return <LocationMapPreviewInner {...props} />;
}

function LocationMapPreviewInner({ location, debounceMs = 400 }: LocationMapPreviewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<LeafletMap | null>(null);
  const markerRef = useRef<LeafletCircleMarker | null>(null);
  const [coords, setCoords] = useState<GeoCoords | null>(null);
  const [status, setStatus] = useState<GeoStatus>('loading');

  // Debounced geocoding. AbortController cancels in-flight requests when
  // the location changes before the response arrives.
  useEffect(() => {
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
  }, [location, debounceMs]);

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
        }).setView([coords.lat, coords.lon], 14);

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

        // invalidateSize handles rendering inside a modal before the container has settled.
        setTimeout(() => { map.invalidateSize(); }, 50);
      } else {
        mapRef.current.setView([coords.lat, coords.lon], 14, { animate: true });
        markerRef.current?.setLatLng([coords.lat, coords.lon]);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [coords]);

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

  return (
    <div className="location-map-preview">
      <div ref={containerRef} className="location-map-preview__map" />
      {status !== 'ok' && (
        <div className={`location-map-preview__overlay${status === 'loading' ? ' location-map-preview__overlay--loading' : ''}`}>
          {status === 'loading' ? 'Finding location…' : 'Location not found'}
        </div>
      )}
    </div>
  );
}
