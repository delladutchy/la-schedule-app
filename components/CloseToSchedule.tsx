/**
 * Top-right × that returns to the main schedule.
 *
 * A plain link to "/" — navigation only. It performs no fetch and touches no
 * cookie, so closing the page never clears the Bank PIN unlock. "Lock Bank"
 * remains the only action that does that.
 *
 * Server component: shared by the invoices page, the Bank PIN screen, and the
 * unlocked Bank dashboard so placement is identical everywhere.
 */
export function CloseToSchedule() {
  return (
    <a href="/" className="admin-close" aria-label="Close" title="Back to Schedule">
      <span aria-hidden="true">×</span>
    </a>
  );
}
