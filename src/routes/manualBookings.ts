import { Router } from "express";
import multer from "multer";
import { supabase } from "../lib/supabase.js";
import { getQuickSendEnv, quickSendSingleSms } from "../lib/quicksend.js";
import type { ManualBankDetails, ManualHoldRequest } from "../types.js";

const router = Router();

const HOLD_MS = 10 * 60 * 1000;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const ALLOWED_MIME = new Set(["image/jpeg", "image/png", "image/webp", "application/pdf"]);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_BYTES },
});

function generateReference(): string {
  const t = Date.now().toString(36).toUpperCase();
  const r = Math.random().toString(36).slice(2, 7).toUpperCase();
  return `BK-${t}-${r}`;
}

function readBankDetails(): ManualBankDetails {
  return {
    bankName: process.env.MANUAL_PAY_BANK_NAME ?? "",
    accountName: process.env.MANUAL_PAY_ACCOUNT_NAME ?? "",
    accountNumber: process.env.MANUAL_PAY_ACCOUNT_NUMBER ?? "",
    branch: process.env.MANUAL_PAY_BRANCH ?? "",
    instructions: process.env.MANUAL_PAY_INSTRUCTIONS || undefined,
  };
}

async function getUserFromBearer(req: { headers: { authorization?: string } }) {
  const h = req.headers.authorization;
  if (!h?.startsWith("Bearer ")) return null;
  const token = h.slice(7).trim();
  if (!token) return null;
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user) return null;
  return data.user;
}

async function getAdminFromBearer(req: { headers: { authorization?: string } }) {
  const user = await getUserFromBearer(req);
  if (!user) return null;
  const role = (user.app_metadata as Record<string, unknown> | undefined)?.role;
  return role === "admin" ? user : null;
}

function buildPendingSmsText(input: {
  reference: string;
  serviceDate: string;
  seats: string[];
  routeLabel?: string;
  depTime?: string;
}) {
  const seats = input.seats.length ? input.seats.join(", ") : "—";
  const route = input.routeLabel ? `${input.routeLabel}` : "your trip";
  const time = input.depTime ? ` ${input.depTime}` : "";
  return `Your seats (${seats}) are reserved for ${route} on ${input.serviceDate}${time}. Payment slip received. We will inform you after approval. Ref: ${input.reference}`;
}

function buildConfirmedSmsText(input: {
  reference: string;
  serviceDate: string;
  seats: string[];
  routeLabel?: string;
  depTime?: string;
  busLabel?: string;
  totalPrice?: number;
}) {
  const seats = input.seats.length ? input.seats.join(", ") : "—";
  const route = input.routeLabel ? `${input.routeLabel}` : "your trip";
  const time = input.depTime ? ` ${input.depTime}` : "";
  // Keep confirmation SMS short to avoid gateway length limits.
  return `Payment approved. Booking confirmed: ${route} on ${input.serviceDate}${time}. Seats: ${seats}. Ref: ${input.reference}`;
}

async function sendSmsToUserId(userId: string, msg: string) {
  const { data: prof, error } = await supabase
    .from("profiles")
    .select("phone")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) return { sent: false, skipped: true, reason: error.message };
  const phone = prof?.phone?.trim();
  if (!phone) return { sent: false, skipped: true, reason: "Missing user phone" };

  const env = getQuickSendEnv();
  const result = await quickSendSingleSms(phone, msg, env.senderId, {
    email: env.email,
    apiKey: env.apiKey,
  });

  if (result.ok) return { sent: true, skipped: false };

  const detail =
    result.status
      ? `HTTP ${result.status}${result.rawText ? ` - ${result.rawText.slice(0, 300)}` : ""}`
      : result.rawText
        ? result.rawText.slice(0, 300)
        : undefined;

  const reason = detail ? `${result.error ?? "QuickSend failed"} (${detail})` : (result.error ?? "QuickSend failed");
  console.error("QuickSend SMS failed:", { userId, phone, reason, fun: result.fun, status: result.status });
  return {
    sent: false,
    skipped: false,
    reason,
    gateway: { fun: result.fun, status: result.status, rawText: result.rawText, data: result.data },
  };
}

async function getBookingSmsContextByReference(reference: string) {
  const { data, error } = await supabase
    .from("bookings")
    .select(
      `
      id,
      reference,
      user_id,
      service_date,
      total_price,
      schedules (
        departure_time,
        routes ( origin_name, destination_name ),
        buses ( operator, bus_number )
      ),
      booking_passengers ( seat_label )
    `,
    )
    .eq("reference", reference)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return null;

  const seats =
    (data.booking_passengers ?? [])
      .map((p: { seat_label: string | null }) => p.seat_label ?? "")
      .filter(Boolean) ?? [];

  // PostgREST can return related rows as objects or arrays depending on select shape.
  const sched = Array.isArray(data.schedules) ? data.schedules[0] : data.schedules;
  const routeRow = Array.isArray(sched?.routes) ? sched?.routes[0] : sched?.routes;
  const busRow = Array.isArray(sched?.buses) ? sched?.buses[0] : sched?.buses;

  const route = routeRow ? `${routeRow.origin_name} → ${routeRow.destination_name}` : undefined;
  const dep = sched?.departure_time?.slice(0, 5);
  const bus =
    busRow?.operator && busRow?.bus_number ? `${busRow.operator} ${busRow.bus_number}` : undefined;

  return {
    id: String(data.id),
    reference: String(data.reference),
    userId: data.user_id ? String(data.user_id) : null,
    serviceDate: String(data.service_date),
    totalPrice: data.total_price != null ? Number(data.total_price) : undefined,
    seats,
    routeLabel: route,
    depTime: dep,
    busLabel: bus,
  };
}

router.post("/manual/hold", async (req, res) => {
  try {
    const user = await getUserFromBearer(req);
    if (!user) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const body = req.body as ManualHoldRequest;
    if (
      !body?.scheduleId ||
      !body?.serviceDate ||
      !Array.isArray(body?.seats) ||
      body.seats.length === 0
    ) {
      return res.status(400).json({ error: "Invalid request payload" });
    }

    const total = body.seats.reduce((sum, s) => sum + Number(s.price || 0), 0);
    if (total <= 0) {
      return res.status(400).json({ error: "Invalid amount" });
    }

    const reference = generateReference();
    const holdExpiresAt = new Date(Date.now() + HOLD_MS).toISOString();

    const { data: booking, error: bookingError } = await supabase
      .from("bookings")
      .insert({
        reference,
        schedule_id: body.scheduleId,
        user_id: user.id,
        service_date: body.serviceDate,
        total_price: total,
        status: "awaiting_payment",
        payment_provider: "manual",
        hold_expires_at: holdExpiresAt,
      })
      .select("id, reference")
      .single();

    if (bookingError || !booking) {
      const msg = bookingError?.message ?? "Failed to create booking";
      if (msg.includes("duplicate") || msg.includes("unique")) {
        return res.status(409).json({ error: "One or more seats are no longer available." });
      }
      return res.status(500).json({ error: msg });
    }

    const passengers = body.seats.map((s) => ({
      booking_id: booking.id,
      seat_label: s.label,
      seat_price: Number(s.price),
    }));

    const { error: passengerError } = await supabase.from("booking_passengers").insert(passengers);
    if (passengerError) {
      await supabase.from("bookings").delete().eq("id", booking.id);
      return res.status(500).json({ error: passengerError.message });
    }

    const holds = body.seats.map((s) => ({
      schedule_id: body.scheduleId,
      service_date: body.serviceDate,
      seat_label: s.label,
      booking_id: booking.id,
    }));

    const { error: holdError } = await supabase.from("schedule_seat_holds").insert(holds);
    if (holdError) {
      await supabase.from("bookings").delete().eq("id", booking.id);
      if (holdError.code === "23505" || holdError.message.includes("duplicate")) {
        return res.status(409).json({ error: "One or more seats are no longer available." });
      }
      return res.status(500).json({ error: holdError.message });
    }

    const bankDetails = readBankDetails();
    return res.json({
      bookingId: booking.id,
      reference: booking.reference,
      expiresAt: holdExpiresAt,
      totalPrice: total,
      bankDetails,
    });
  } catch (error) {
    return res.status(500).json({
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

router.post("/manual/:reference/submit-proof", upload.single("file"), async (req, res) => {
  try {
    const user = await getUserFromBearer(req);
    if (!user) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const reference = req.params.reference;
    if (!reference) {
      return res.status(400).json({ error: "Missing reference" });
    }

    const file = req.file;
    if (!file?.buffer || !file.mimetype) {
      return res.status(400).json({ error: "Missing file (field name: file)" });
    }

    if (!ALLOWED_MIME.has(file.mimetype)) {
      return res.status(400).json({ error: "Invalid file type. Use JPEG, PNG, WebP, or PDF." });
    }

    const { data: booking, error: fetchErr } = await supabase
      .from("bookings")
      .select("id, user_id, status, hold_expires_at, payment_proof_path")
      .eq("reference", reference)
      .maybeSingle();

    if (fetchErr || !booking) {
      return res.status(404).json({ error: "Booking not found" });
    }

    if (booking.user_id !== user.id) {
      return res.status(403).json({ error: "Forbidden" });
    }

    if (booking.status !== "awaiting_payment") {
      return res.status(400).json({ error: "Booking is not awaiting payment proof." });
    }

    const expires = booking.hold_expires_at ? new Date(booking.hold_expires_at).getTime() : 0;
    if (!expires || Date.now() > expires) {
      return res.status(400).json({ error: "Payment window has expired." });
    }

    if (booking.payment_proof_path) {
      return res.status(400).json({ error: "Payment proof already submitted." });
    }

    const ext =
      file.mimetype === "image/jpeg"
        ? "jpg"
        : file.mimetype === "image/png"
          ? "png"
          : file.mimetype === "image/webp"
            ? "webp"
            : "pdf";
    const safeName = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
    const storagePath = `${user.id}/${reference}/${safeName}`;

    const { error: upErr } = await supabase.storage.from("payment-proofs").upload(storagePath, file.buffer, {
      contentType: file.mimetype,
      upsert: false,
    });

    if (upErr) {
      return res.status(500).json({ error: upErr.message });
    }

    const submittedAt = new Date().toISOString();
    const { error: updErr } = await supabase
      .from("bookings")
      .update({
        payment_proof_path: storagePath,
        status: "pending",
        payment_submitted_at: submittedAt,
      })
      .eq("id", booking.id)
      .eq("status", "awaiting_payment");

    if (updErr) {
      await supabase.storage.from("payment-proofs").remove([storagePath]);
      return res.status(500).json({ error: updErr.message });
    }

    // Fire-and-forget style (but awaited so caller gets sms status for debugging)
    let sms: unknown = { skipped: true, reason: "Not attempted" };
    try {
      const ctx = await getBookingSmsContextByReference(reference);
      if (ctx?.userId) {
        const text = buildPendingSmsText({
          reference: ctx.reference,
          serviceDate: ctx.serviceDate,
          seats: ctx.seats,
          routeLabel: ctx.routeLabel,
          depTime: ctx.depTime,
        });
        sms = await sendSmsToUserId(ctx.userId, text);
      } else {
        sms = { skipped: true, reason: "Missing booking user_id" };
      }
    } catch (e) {
      sms = { skipped: true, reason: e instanceof Error ? e.message : "SMS error" };
    }

    return res.json({ ok: true, reference, paymentProofPath: storagePath, sms });
  } catch (error) {
    return res.status(500).json({
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

// Admin confirms a pending manual payment booking
router.post("/admin/confirm/:id", async (req, res) => {
  try {
    const admin = await getAdminFromBearer(req);
    if (!admin) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const id = req.params.id;
    if (!id) return res.status(400).json({ error: "Missing booking id" });

    const now = new Date().toISOString();
    const { data: updated, error: updErr } = await supabase
      .from("bookings")
      .update({ status: "confirmed", paid_at: now })
      .eq("id", id)
      .eq("status", "pending")
      .select("reference, user_id, service_date, total_price")
      .maybeSingle();

    if (updErr) return res.status(500).json({ error: updErr.message });
    if (!updated) return res.status(409).json({ error: "Booking not in pending state (or not found)." });

    let sms: unknown = { skipped: true, reason: "Not attempted" };
    try {
      const ctx = await getBookingSmsContextByReference(String(updated.reference));
      if (ctx?.userId) {
        const text = buildConfirmedSmsText({
          reference: ctx.reference,
          serviceDate: ctx.serviceDate,
          seats: ctx.seats,
          routeLabel: ctx.routeLabel,
          depTime: ctx.depTime,
          busLabel: ctx.busLabel,
          totalPrice: ctx.totalPrice,
        });
        sms = await sendSmsToUserId(ctx.userId, text);
      } else {
        sms = { skipped: true, reason: "Missing booking user_id" };
      }
    } catch (e) {
      sms = { skipped: true, reason: e instanceof Error ? e.message : "SMS error" };
    }

    return res.json({ ok: true, id, reference: updated.reference, sms });
  } catch (error) {
    return res.status(500).json({ error: error instanceof Error ? error.message : "Unknown error" });
  }
});

export default router;
