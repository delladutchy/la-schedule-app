import { NextResponse } from "next/server";
import { getConfig } from "@/lib/config";
import { buildAndPersistSnapshot } from "@/lib/sync";
import { deleteCalendarEvent, updateAllDayEvent } from "@/lib/google";
import { GigCreateBodySchema, resolveAllDayRange } from "@/lib/gigs";

export const dynamic = "force-dynamic";

function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function isAuthorized(req: Request): boolean {
  try {
    const { env } = getConfig();
    const header = req.headers.get("authorization") ?? "";
    const match = header.match(/^Bearer\s+(.+)$/i);
    if (!match) return false;
    const presented = match[1]?.trim() ?? "";
    return constantTimeEquals(presented, env.EDITOR_TOKEN);
  } catch {
    return false;
  }
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

export async function PATCH(
  req: Request,
  context: { params: { eventId?: string } },
) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const eventId = resolveEventId(context.params.eventId);
  if (!eventId) {
    return NextResponse.json({ error: "invalid_event_id" }, { status: 400 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const payload = parsePayload(body);
  if (!payload.ok) {
    return NextResponse.json(
      { error: "invalid_payload", details: payload.error },
      { status: payload.status },
    );
  }

  const { env } = getConfig();
  try {
    const updated = await updateAllDayEvent({
      clientId: env.GOOGLE_CLIENT_ID,
      clientSecret: env.GOOGLE_CLIENT_SECRET,
      refreshToken: env.GOOGLE_REFRESH_TOKEN,
      calendarId: env.GOOGLE_CALENDAR_ID,
      eventId,
      summary: payload.summary,
      ...(payload.description ? { description: payload.description } : {}),
      startDate: payload.startDate,
      endDateExclusive: payload.endDateExclusive,
    });

    const postSync = await buildAndPersistSnapshot();

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
      return NextResponse.json(
        { error: "event_not_found", message: "Event not found in editor calendar." },
        { status: 404 },
      );
    }
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
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const eventId = resolveEventId(context.params.eventId);
  if (!eventId) {
    return NextResponse.json({ error: "invalid_event_id" }, { status: 400 });
  }

  const { env } = getConfig();
  try {
    await deleteCalendarEvent({
      clientId: env.GOOGLE_CLIENT_ID,
      clientSecret: env.GOOGLE_CLIENT_SECRET,
      refreshToken: env.GOOGLE_REFRESH_TOKEN,
      calendarId: env.GOOGLE_CALENDAR_ID,
      eventId,
    });

    const postSync = await buildAndPersistSnapshot();

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
      return NextResponse.json(
        { error: "event_not_found", message: "Event not found in editor calendar." },
        { status: 404 },
      );
    }
    return NextResponse.json(
      {
        error: "google_delete_failed",
        message: error instanceof Error ? error.message : "Google event delete failed.",
      },
      { status: 502 },
    );
  }
}

