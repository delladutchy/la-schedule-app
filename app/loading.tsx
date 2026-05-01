export default function Loading() {
  return (
    <div className="page" aria-busy="true">
      <header className="header">
        <h1 className="title">
          <span>Availability</span>
          <span className="title-muted"> · Jeff Ulsh</span>
        </h1>
      </header>

      <div className="route-loading" role="status" aria-live="polite">
        <span className="route-loading-spinner" aria-hidden="true" />
        <span>Loading schedule...</span>
      </div>
    </div>
  );
}
