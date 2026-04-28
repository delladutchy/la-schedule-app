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

export async function POST(req: Request) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
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

  const { file, env } = getConfig();

  // Pre-write check against the same snapshot model used by the app.
  const preflight = await buildAndPersistSnapshot();
  if (preflight.status !== "ok" || !preflight.snapshot) {
    return NextResponse.json(
      {
        error: "snapshot_unavailable",
        message: preflight.error ?? "Could not refresh snapshot before write.",
      },
      { status: 503 },
    );
  }

  const isAvailable = isDateRangeAvailableInSnapshot(
    preflight.snapshot,
    file.timezone,
    payload.startDate,
    payload.endDateInclusive,
  );
  if (!isAvailable) {
    return NextResponse.json(
      { error: "day_already_booked", message: "Day already booked." },
      { status: 409 },
    );
  }

  const eventId = buildAllDayGigEventId(
    env.GOOGLE_CALENDAR_ID,
    payload.startDate,
    payload.endDateInclusive,
  );

  try {
    const created = await createAllDayEvent({
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
        event: created,
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
      { status: 201 },
    );
  } catch (error) {
    if (error instanceof CalendarEventAlreadyExistsError) {
      return NextResponse.json(
        { error: "day_already_booked", message: "Day already booked." },
        { status: 409 },
      );
    }
    return NextResponse.json(
      {
        error: "google_create_failed",
        message: error instanceof Error ? error.message : "Google event create failed.",
      },
      { status: 502 },
    );
  }
}
