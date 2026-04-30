import { NextResponse } from "next/server";
import { getConfig } from "@/lib/config";
import { buildAndPersistSnapshot } from "@/lib/sync";
import { deleteCalendarEvent, updateAllDayEvent } from "@/lib/google";
import {
  GigCreateBodySchema,
  resolveAllDayRange,
  isDateRangeAvailableForEditInSnapshot,
} from "@/lib/gigs";
import type { Snapshot } from "@/lib/types";
import { readCurrentSnapshot } from "@/lib/store";
import {
  authorizeEditorRequest,
  canEditorModifyEventOwner,
  isSameOriginEditorMutation,
  resolveEditorRole,
} from "@/lib/editor-auth";
import { appendAuditEvent, buildGigAuditFields } from "@/lib/audit-log";

export const dynamic = "force-dynamic";

interface RouteTimings {
  snapshotReadMs: number;
  preflightSyncMs: number;
  googleWriteMs: number;
  postSyncMs: number;
}

function createEmptyRouteTimings(): RouteTimings {
  return {
    snapshotReadMs: 0,
    preflightSyncMs: 0,
    googleWriteMs: 0,
    postSyncMs: 0,
  };
}

function logGigRouteTiming(
  action: "patch" | "delete",
  outcome: string,
  editorId: string,
  routeStartedAt: number,
  timings: RouteTimings,
): void {
  const totalMs = Date.now() - routeStartedAt;
  console.info(
    `[gigs:${action}] ${outcome} editor=${editorId} ms snapshotRead=${timings.snapshotReadMs} preflightSync=${timings.preflightSyncMs} googleWrite=${timings.googleWriteMs} postSync=${timings.postSyncMs} total=${totalMs}`,
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

function extractHttpStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || !error) return undefined;
  if ("status" in error && typeof (error as { status?: unknown }).status === "number") {
    return (error as { status: number }).status;
  }
  const response = (error as { response?: { status?: unknown } }).response;
  if (response && typeof response.status === "number") {
    return response.status;
  }
  return undefined;
}

function resolveEventId(param: string | undefined): string | null {
  if (!param) return null;
  const eventId = decodeURIComponent(param).trim();
  if (!eventId) return null;
  if (!/^[A-Za-z0-9._-]+$/.test(eventId)) return null;
  return eventId;
}

function normalizeOwnerEditor(ownerEditor: string | undefined): string | undefined {
  if (!ownerEditor) return undefined;
  const normalized = ownerEditor.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{1,31}$/.test(normalized)) return undefined;
  return normalized;
}

function findOwnedEditorEvent(
  snapshot: Snapshot | null,
  eventId: string,
  editorCalendarId: string,
): { ownerEditor?: string; summary?: string; startUtc?: string; endUtc?: string; description?: string } | null {
  if (!snapshot) return null;
  const match = snapshot.namedEvents?.find((event) =>
    event.eventId === eventId && event.calendarId === editorCalendarId);
  if (!match) return null;
  return {
    ownerEditor: normalizeOwnerEditor(match.ownerEditor),
    summary: match.summary,
    startUtc: match.startUtc,
    endUtc: match.endUtc,
    description: match.description,
  };
}

function forbiddenOwnerResponse() {
  return NextResponse.json(
    { error: "forbidden", message: "Only the creator can edit this booking." },
    { status: 403 },
  );
}

export async function PATCH(
  req: Request,
  context: { params: { eventId?: string } },
) {
  const routeStartedAt = Date.now();
  const timings = createEmptyRouteTimings();
  const { file, env } = getConfig();
  const auth = authorizeEditorRequest(req, env);
  const editorId = auth.ok ? auth.editorId : "unknown";

  if (!auth.ok) {
    logGigRouteTiming("patch", "unauthorized", editorId, routeStartedAt, timings);
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (auth.source === "cookie" && !isSameOriginEditorMutation(req)) {
    logGigRouteTiming("patch", "forbidden_origin", editorId, routeStartedAt, timings);
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const eventId = resolveEventId(context.params.eventId);
  if (!eventId) {
    logGigRouteTiming("patch", "invalid_event_id", editorId, routeStartedAt, timings);
    return NextResponse.json({ error: "invalid_event_id" }, { status: 400 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    logGigRouteTiming("patch", "invalid_json", editorId, routeStartedAt, timings);
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const payload = parsePayload(body);
  if (!payload.ok) {
    logGigRouteTiming("patch", "invalid_payload", editorId, routeStartedAt, timings);
    return NextResponse.json(
      { error: "invalid_payload", details: payload.error },
      { status: payload.status },
    );
  }

  const snapshotReadStartedAt = Date.now();
  let validationSnapshot = await readCurrentSnapshot(env.BLOBS_STORE_NAME);
  timings.snapshotReadMs = Date.now() - snapshotReadStartedAt;
  if (!validationSnapshot) {
    const preflightStartedAt = Date.now();
    const preflight = await buildAndPersistSnapshot();
    timings.preflightSyncMs = Date.now() - preflightStartedAt;
    if (preflight.status !== "ok" || !preflight.snapshot) {
      logGigRouteTiming("patch", "snapshot_unavailable_prewrite", editorId, routeStartedAt, timings);
      return NextResponse.json(
        {
          error: "snapshot_unavailable",
          message: preflight.error ?? "Could not refresh snapshot before update.",
        },
        { status: 503 },
      );
    }
    validationSnapshot = preflight.snapshot;
  }

  const editableEvent = findOwnedEditorEvent(validationSnapshot, eventId, env.GOOGLE_CALENDAR_ID);
  const ownerEditor = editableEvent?.ownerEditor;
  if (!canEditorModifyEventOwner(editorId, ownerEditor)) {
    logGigRouteTiming("patch", "forbidden_owner", editorId, routeStartedAt, timings);
    return forbiddenOwnerResponse();
  }

  const isAvailable = isDateRangeAvailableForEditInSnapshot(
    validationSnapshot,
    file.timezone,
    payload.startDate,
    payload.endDateInclusive,
    {
      eventId,
      editorCalendarId: env.GOOGLE_CALENDAR_ID,
    },
  );
  if (!isAvailable) {
    logGigRouteTiming("patch", "day_already_booked_prewrite", editorId, routeStartedAt, timings);
    return NextResponse.json(
      { error: "day_already_booked", message: "Day already booked." },
      { status: 409 },
    );
  }

  try {
    const googleWriteStartedAt = Date.now();
    const updated = await updateAllDayEvent({
      clientId: env.GOOGLE_CLIENT_ID,
      clientSecret: env.GOOGLE_CLIENT_SECRET,
      refreshToken: env.GOOGLE_REFRESH_TOKEN,
      calendarId: env.GOOGLE_CALENDAR_ID,
      eventId,
      summary: payload.summary,
      ...(payload.description ? { description: payload.description } : {}),
      ...(ownerEditor ? { ownerEditor } : {}),
      startDate: payload.startDate,
      endDateExclusive: payload.endDateExclusive,
    });
    timings.googleWriteMs = Date.now() - googleWriteStartedAt;

    const postSyncStartedAt = Date.now();
    const postSync = await buildAndPersistSnapshot();
    timings.postSyncMs = Date.now() - postSyncStartedAt;

    if (postSync.status === "ok") {
      try {
        await appendAuditEvent(env.BLOBS_STORE_NAME, {
          editorId,
          action: "edit",
          status: "success",
          eventId: updated.id,
          ...buildGigAuditFields({
            summary: payload.summary,
            startDate: payload.startDate,
            endDate: payload.endDateInclusive,
            description: payload.description,
          }),
        });
      } catch (auditError) {
        const msg = auditError instanceof Error ? auditError.message : String(auditError);
        console.error("[audit] append failed after edit:", msg);
      }
    }
    logGigRouteTiming("patch", "ok", editorId, routeStartedAt, timings);

    return NextResponse.json(
      {
        status: "ok",
        event: updated,
        gig: {
          summary: payload.summary,
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
      { status: 200 },
    );
  } catch (error) {
    const status = extractHttpStatus(error);
    if (status === 404) {
      logGigRouteTiming("patch", "event_not_found", editorId, routeStartedAt, timings);
      return NextResponse.json(
        { error: "event_not_found", message: "Event not found in editor calendar." },
        { status: 404 },
      );
    }
    logGigRouteTiming("patch", "google_update_failed", editorId, routeStartedAt, timings);
    return NextResponse.json(
      {
        error: "google_update_failed",
        message: error instanceof Error ? error.message : "Google event update failed.",
      },
      { status: 502 },
    );
  }
}

export async function DELETE(
  req: Request,
  context: { params: { eventId?: string } },
) {
  const routeStartedAt = Date.now();
  const timings = createEmptyRouteTimings();
  const { env } = getConfig();
  const auth = authorizeEditorRequest(req, env);
  const editorId = auth.ok ? auth.editorId : "unknown";

  if (!auth.ok) {
    logGigRouteTiming("delete", "unauthorized", editorId, routeStartedAt, timings);
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (auth.source === "cookie" && !isSameOriginEditorMutation(req)) {
    logGigRouteTiming("delete", "forbidden_origin", editorId, routeStartedAt, timings);
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const eventId = resolveEventId(context.params.eventId);
  if (!eventId) {
    logGigRouteTiming("delete", "invalid_event_id", editorId, routeStartedAt, timings);
    return NextResponse.json({ error: "invalid_event_id" }, { status: 400 });
  }

  const snapshotReadStartedAt = Date.now();
  let deleteAuditSource = await readCurrentSnapshot(env.BLOBS_STORE_NAME);
  timings.snapshotReadMs = Date.now() - snapshotReadStartedAt;
  if (!deleteAuditSource && resolveEditorRole(editorId) === "limited") {
    const preflightStartedAt = Date.now();
    const preflight = await buildAndPersistSnapshot();
    timings.preflightSyncMs = Date.now() - preflightStartedAt;
    if (preflight.status !== "ok" || !preflight.snapshot) {
      logGigRouteTiming("delete", "snapshot_unavailable_prewrite", editorId, routeStartedAt, timings);
      return NextResponse.json(
        {
          error: "snapshot_unavailable",
          message: preflight.error ?? "Could not refresh snapshot before delete.",
        },
        { status: 503 },
      );
    }
    deleteAuditSource = preflight.snapshot;
  }

  const deleteAuditEvent = findOwnedEditorEvent(deleteAuditSource, eventId, env.GOOGLE_CALENDAR_ID);
  if (!canEditorModifyEventOwner(editorId, deleteAuditEvent?.ownerEditor)) {
    logGigRouteTiming("delete", "forbidden_owner", editorId, routeStartedAt, timings);
    return forbiddenOwnerResponse();
  }

  try {
    const googleWriteStartedAt = Date.now();
    await deleteCalendarEvent({
      clientId: env.GOOGLE_CLIENT_ID,
      clientSecret: env.GOOGLE_CLIENT_SECRET,
      refreshToken: env.GOOGLE_REFRESH_TOKEN,
      calendarId: env.GOOGLE_CALENDAR_ID,
      eventId,
    });
    timings.googleWriteMs = Date.now() - googleWriteStartedAt;

    const postSyncStartedAt = Date.now();
    const postSync = await buildAndPersistSnapshot();
    timings.postSyncMs = Date.now() - postSyncStartedAt;

    if (postSync.status === "ok") {
      try {
        await appendAuditEvent(env.BLOBS_STORE_NAME, {
          editorId,
          action: "delete",
          status: "success",
          eventId,
          ...buildGigAuditFields({
            summary: deleteAuditEvent?.summary,
            startDate: deleteAuditEvent?.startUtc?.slice(0, 10),
            endDate: deleteAuditEvent?.endUtc
              ? new Date(Date.parse(deleteAuditEvent.endUtc) - 1).toISOString().slice(0, 10)
              : undefined,
            description: deleteAuditEvent?.description,
          }),
        });
      } catch (auditError) {
        const msg = auditError instanceof Error ? auditError.message : String(auditError);
        console.error("[audit] append failed after delete:", msg);
      }
    }
    logGigRouteTiming("delete", "ok", editorId, routeStartedAt, timings);

    return NextResponse.json(
      {
        status: "ok",
        deleted: { id: eventId },
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
      { status: 200 },
    );
  } catch (error) {
    const status = extractHttpStatus(error);
    if (status === 404) {
      logGigRouteTiming("delete", "event_not_found", editorId, routeStartedAt, timings);
      return NextResponse.json(
        { error: "event_not_found", message: "Event not found in editor calendar." },
        { status: 404 },
      );
    }
    logGigRouteTiming("delete", "google_delete_failed", editorId, routeStartedAt, timings);
    return NextResponse.json(
      {
        error: "google_delete_failed",
        message: error instanceof Error ? error.message : "Google event delete failed.",
      },
      { status: 502 },
    );
  }
}
