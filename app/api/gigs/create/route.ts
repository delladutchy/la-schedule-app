import { NextResponse } from "next/server";
import { getConfig } from "@/lib/config";
import { createAllDayEvent, CalendarEventAlreadyExistsError } from "@/lib/google";
import { buildAndPersistSnapshot } from "@/lib/sync";
import {
  GigCreateBodySchema,
  resolveAllDayRange,
  isDateRangeAvailableInSnapshot,
} from "@/lib/gigs";
import { buildAllDayGigEventId } from "@/lib/gig-ids";
import { readCurrentSnapshot } from "@/lib/store";
import {
  authorizeEditorRequest,
  isSameOriginEditorMutation,
} from "@/lib/editor-auth";
import { appendAuditEvent, buildGigAuditFields } from "@/lib/audit-log";
import { sendCreateJobNotification } from "@/lib/notifications";
import {
  isMikeProfile,
  resolveEditorProfile,
  resolveProfileWriteCalendar,
} from "@/lib/editor-profiles";

export const dynamic = "force-dynamic";

interface RouteTimings {
  snapshotReadMs: number;
  preflightSyncMs: number;
  googleWriteMs: number;
  postSyncMs: number;
  retryPreflightSyncMs: number;
  retryGoogleWriteMs: number;
  retryPostSyncMs: number;
}

function createEmptyRouteTimings(): RouteTimings {
  return {
    snapshotReadMs: 0,
    preflightSyncMs: 0,
    googleWriteMs: 0,
    postSyncMs: 0,
    retryPreflightSyncMs: 0,
    retryGoogleWriteMs: 0,
    retryPostSyncMs: 0,
  };
}

function logCreateRouteTiming(
  outcome: string,
  editorId: string,
  routeStartedAt: number,
  timings: RouteTimings,
): void {
  const totalMs = Date.now() - routeStartedAt;
  console.info(
    `[gigs:create] ${outcome} editor=${editorId} ms snapshotRead=${timings.snapshotReadMs} preflightSync=${timings.preflightSyncMs} googleWrite=${timings.googleWriteMs} postSync=${timings.postSyncMs} retryPreflightSync=${timings.retryPreflightSyncMs} retryGoogleWrite=${timings.retryGoogleWriteMs} retryPostSync=${timings.retryPostSyncMs} total=${totalMs}`,
  );
}

function parsePayload(body: unknown) {
  const parsed = GigCreateBodySchema.safeParse(body);
  if (!parsed.success) {
    return {
      ok: false as const,
      status: 400,
      error: parsed.error.flatten().fieldErrors,
    };
  }

  try {
    return {
      ok: true as const,
      summary: parsed.data.summary.trim(),
      description: parsed.data.description?.trim(),
      ...resolveAllDayRange(parsed.data),
    };
  } catch (error) {
    return {
      ok: false as const,
      status: 400,
      error: error instanceof Error ? error.message : "Invalid booking range.",
    };
  }
}

export async function POST(req: Request) {
  const routeStartedAt = Date.now();
  const timings = createEmptyRouteTimings();
  const { file, env } = getConfig();
  const auth = authorizeEditorRequest(req, env);
  const editorId = auth.ok ? auth.editorId : "unknown";

  if (!auth.ok) {
    logCreateRouteTiming("unauthorized", editorId, routeStartedAt, timings);
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (auth.source === "cookie" && !isSameOriginEditorMutation(req)) {
    logCreateRouteTiming("forbidden_origin", editorId, routeStartedAt, timings);
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const editorProfile = resolveEditorProfile(editorId);
  const writeCalendar = resolveProfileWriteCalendar(editorProfile, env);
  if (!writeCalendar.ok) {
    logCreateRouteTiming(writeCalendar.error, editorId, routeStartedAt, timings);
    return NextResponse.json(
      {
        error: writeCalendar.error,
        message: writeCalendar.message,
      },
      { status: 503 },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    logCreateRouteTiming("invalid_json", editorId, routeStartedAt, timings);
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const payload = parsePayload(body);
  if (!payload.ok) {
    logCreateRouteTiming("invalid_payload", editorId, routeStartedAt, timings);
    return NextResponse.json(
      { error: "invalid_payload", details: payload.error },
      { status: payload.status },
    );
  }

  const summary = isMikeProfile(editorProfile) ? "Overture Booking" : payload.summary;

  // Pre-write check against the same snapshot model used by the app.
  const snapshotReadStartedAt = Date.now();
  let validationSnapshot = await readCurrentSnapshot(env.BLOBS_STORE_NAME);
  timings.snapshotReadMs = Date.now() - snapshotReadStartedAt;
  if (!validationSnapshot) {
    const preflightStartedAt = Date.now();
    const preflight = await buildAndPersistSnapshot();
    timings.preflightSyncMs = Date.now() - preflightStartedAt;
    if (preflight.status !== "ok" || !preflight.snapshot) {
      logCreateRouteTiming("snapshot_unavailable_prewrite", editorId, routeStartedAt, timings);
      return NextResponse.json(
        {
          error: "snapshot_unavailable",
          message: preflight.error ?? "Could not refresh snapshot before write.",
        },
        { status: 503 },
      );
    }
    validationSnapshot = preflight.snapshot;
  }

  const isAvailable = isDateRangeAvailableInSnapshot(
    validationSnapshot,
    file.timezone,
    payload.startDate,
    payload.endDateInclusive,
  );
  if (!isAvailable) {
    logCreateRouteTiming("day_already_booked_prewrite", editorId, routeStartedAt, timings);
    return NextResponse.json(
      { error: "day_already_booked", message: "Day already booked." },
      { status: 409 },
    );
  }

  const eventId = buildAllDayGigEventId(
    writeCalendar.calendarId,
    payload.startDate,
    payload.endDateInclusive,
  );

  const createEvent = (eventIdOverride?: string) => createAllDayEvent({
    clientId: env.GOOGLE_CLIENT_ID,
    clientSecret: env.GOOGLE_CLIENT_SECRET,
    refreshToken: env.GOOGLE_REFRESH_TOKEN,
    calendarId: writeCalendar.calendarId,
    ownerEditor: editorId,
    ...(eventIdOverride ? { eventId: eventIdOverride } : {}),
    summary,
    ...(payload.description ? { description: payload.description } : {}),
    startDate: payload.startDate,
    endDateExclusive: payload.endDateExclusive,
  });

  const auditFields = buildGigAuditFields({
    summary,
    startDate: payload.startDate,
    endDate: payload.endDateInclusive,
    description: payload.description,
  });

  try {
    const googleWriteStartedAt = Date.now();
    const created = await createEvent(eventId);
    timings.googleWriteMs = Date.now() - googleWriteStartedAt;

    const postSyncStartedAt = Date.now();
    const postSync = await buildAndPersistSnapshot();
    timings.postSyncMs = Date.now() - postSyncStartedAt;

    if (postSync.status === "ok") {
      let appendedAudit = false;
      try {
        await appendAuditEvent(env.BLOBS_STORE_NAME, {
          editorId,
          action: "create",
          status: "success",
          eventId: created.id,
          ...auditFields,
        });
        appendedAudit = true;
      } catch (auditError) {
        const msg = auditError instanceof Error ? auditError.message : String(auditError);
        console.error("[audit] append failed after create:", msg);
      }
      if (appendedAudit) {
        try {
          await sendCreateJobNotification(env, {
            editorId,
            jobNumber: auditFields.jobNumber,
            jobTitle: auditFields.jobTitle,
            startDate: auditFields.startDate,
            endDate: auditFields.endDate,
            callTime: auditFields.callTime,
          });
        } catch (notifyError) {
          const msg = notifyError instanceof Error ? notifyError.message : String(notifyError);
          console.error(`[notify] create email failed editor=${editorId}:`, msg);
        }
      }
    }

    logCreateRouteTiming("ok", editorId, routeStartedAt, timings);

    return NextResponse.json(
      {
        status: "ok",
        event: created,
        gig: {
          summary,
          startDate: payload.startDate,
          endDate: payload.endDateInclusive,
        },
        snapshot: {
          status: postSync.status,
          ...(postSync.status === "ok"
            ? {
                generatedAtUtc: postSync.snapshot?.generatedAtUtc,
                busyBlocks: postSync.snapshot?.busy.length ?? 0,
              }
            : {
                error: postSync.error,
                erroredCalendarIds: postSync.erroredCalendarIds ?? [],
              }),
        },
      },
      { status: 201 },
    );
  } catch (error) {
    if (error instanceof CalendarEventAlreadyExistsError) {
      // A deterministic id collision can happen even when the slot is now free.
      // Re-sync + re-check availability first, then retry once without custom id.
      const retryPreflightStartedAt = Date.now();
      const refreshed = await buildAndPersistSnapshot();
      timings.retryPreflightSyncMs = Date.now() - retryPreflightStartedAt;
      if (refreshed.status !== "ok" || !refreshed.snapshot) {
        logCreateRouteTiming("snapshot_unavailable_after_conflict", editorId, routeStartedAt, timings);
        return NextResponse.json(
          {
            error: "snapshot_unavailable",
            message: refreshed.error ?? "Could not refresh snapshot after conflict.",
          },
          { status: 503 },
        );
      }

      const stillUnavailable = !isDateRangeAvailableInSnapshot(
        refreshed.snapshot,
        file.timezone,
        payload.startDate,
        payload.endDateInclusive,
      );
      if (stillUnavailable) {
        logCreateRouteTiming("day_already_booked_after_conflict", editorId, routeStartedAt, timings);
        return NextResponse.json(
          { error: "day_already_booked", message: "Day already booked." },
          { status: 409 },
        );
      }

      try {
        const retryGoogleWriteStartedAt = Date.now();
        const created = await createEvent();
        timings.retryGoogleWriteMs = Date.now() - retryGoogleWriteStartedAt;
        const retryPostSyncStartedAt = Date.now();
        const postSync = await buildAndPersistSnapshot();
        timings.retryPostSyncMs = Date.now() - retryPostSyncStartedAt;

        if (postSync.status === "ok") {
          let appendedAudit = false;
          try {
            await appendAuditEvent(env.BLOBS_STORE_NAME, {
              editorId,
              action: "create",
              status: "success",
              eventId: created.id,
              ...auditFields,
            });
            appendedAudit = true;
          } catch (auditError) {
            const msg = auditError instanceof Error ? auditError.message : String(auditError);
            console.error("[audit] append failed after create retry:", msg);
          }
          if (appendedAudit) {
            try {
              await sendCreateJobNotification(env, {
                editorId,
                jobNumber: auditFields.jobNumber,
                jobTitle: auditFields.jobTitle,
                startDate: auditFields.startDate,
                endDate: auditFields.endDate,
                callTime: auditFields.callTime,
              });
            } catch (notifyError) {
              const msg = notifyError instanceof Error ? notifyError.message : String(notifyError);
              console.error(`[notify] create email failed editor=${editorId}:`, msg);
            }
          }
        }
        logCreateRouteTiming("ok_retry_without_event_id", editorId, routeStartedAt, timings);

        return NextResponse.json(
          {
            status: "ok",
            event: created,
            gig: {
              summary,
              startDate: payload.startDate,
              endDate: payload.endDateInclusive,
            },
            snapshot: {
              status: postSync.status,
              ...(postSync.status === "ok"
                ? {
                    generatedAtUtc: postSync.snapshot?.generatedAtUtc,
                    busyBlocks: postSync.snapshot?.busy.length ?? 0,
                  }
                : {
                    error: postSync.error,
                    erroredCalendarIds: postSync.erroredCalendarIds ?? [],
                  }),
            },
          },
          { status: 201 },
        );
      } catch (retryError) {
        if (retryError instanceof CalendarEventAlreadyExistsError) {
          logCreateRouteTiming("day_already_booked_retry_conflict", editorId, routeStartedAt, timings);
          return NextResponse.json(
            { error: "day_already_booked", message: "Day already booked." },
            { status: 409 },
          );
        }
        logCreateRouteTiming("google_create_failed_retry", editorId, routeStartedAt, timings);
        return NextResponse.json(
          {
            error: "google_create_failed",
            message: retryError instanceof Error
              ? retryError.message
              : "Google event create failed.",
          },
          { status: 502 },
        );
      }
    }

    logCreateRouteTiming("google_create_failed", editorId, routeStartedAt, timings);
    return NextResponse.json(
      {
        error: "google_create_failed",
        message: error instanceof Error ? error.message : "Google event create failed.",
      },
      { status: 502 },
    );
  }
}
