/**
 * LEGACY: PayHere sandbox integration — not mounted by default.
 * To re-enable: import this router in ../index.ts and mount at /api/payments,
 * and set PAYHERE_* env vars. Requires ../lib/payhere.ts (hash helpers).
 */
import { Router } from "express";
import { supabase } from "../../lib/supabase.js";
import { buildCheckoutHash, formatAmount, verifyNotifyHash } from "../../lib/payhere.js";
import type { InitiatePaymentRequest, PayHereCheckoutPayload } from "../../types.js";

const router = Router();

const merchantId = process.env.PAYHERE_MERCHANT_ID;
const merchantSecret = process.env.PAYHERE_MERCHANT_SECRET;
const notifyUrl = process.env.PAYHERE_NOTIFY_URL;
const returnUrl = process.env.PAYHERE_RETURN_URL;
const cancelUrl = process.env.PAYHERE_CANCEL_URL;
const sandbox = String(process.env.PAYHERE_SANDBOX).toLowerCase() === "true";

if (!merchantId || !merchantSecret || !notifyUrl || !returnUrl || !cancelUrl) {
  throw new Error("Missing PayHere env vars");
}

function generateReference(): string {
  const t = Date.now().toString(36).toUpperCase();
  const r = Math.random().toString(36).slice(2, 7).toUpperCase();
  return `BK-${t}-${r}`;
}

router.post("/payhere/initiate", async (req, res) => {
  try {
    const body = req.body as InitiatePaymentRequest;

    if (
      !body?.userId ||
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
    const amount = formatAmount(total);

    const { data: booking, error: bookingError } = await supabase
      .from("bookings")
      .insert({
        reference,
        schedule_id: body.scheduleId,
        user_id: body.userId,
        service_date: body.serviceDate,
        total_price: total,
        status: "pending",
        payment_provider: "payhere",
      })
      .select("id, reference")
      .single();

    if (bookingError || !booking) {
      return res.status(500).json({ error: bookingError?.message || "Failed to create booking" });
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
      return res.status(500).json({ error: holdError.message });
    }

    const hash = buildCheckoutHash({
      merchantId,
      orderId: booking.reference,
      amount,
      currency: "LKR",
      merchantSecret,
    });

    const payload: PayHereCheckoutPayload = {
      sandbox,
      merchant_id: merchantId,
      return_url: returnUrl,
      cancel_url: cancelUrl,
      notify_url: notifyUrl,
      order_id: booking.reference,
      items: `Bus Ticket ${body.route.from} to ${body.route.to}`,
      currency: "LKR",
      amount,
      first_name: body.customer.firstName,
      last_name: body.customer.lastName,
      email: body.customer.email,
      phone: body.customer.phone,
      address: body.customer.address || "N/A",
      city: body.customer.city || "N/A",
      country: "Sri Lanka",
      hash,
    };

    return res.json({
      bookingId: booking.id,
      reference: booking.reference,
      payhere: payload,
    });
  } catch (error) {
    return res.status(500).json({
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

router.post("/payhere/notify", async (req, res) => {
  try {
    const {
      merchant_id,
      order_id,
      payhere_amount,
      payhere_currency,
      status_code,
      md5sig,
      payment_id,
      status_message,
    } = req.body ?? {};

    if (!merchant_id || !order_id || !payhere_amount || !payhere_currency || !status_code || !md5sig) {
      return res.status(400).send("Invalid notify payload");
    }

    const valid = verifyNotifyHash({
      merchantId: String(merchant_id),
      orderId: String(order_id),
      payhereAmount: String(payhere_amount),
      payhereCurrency: String(payhere_currency),
      statusCode: String(status_code),
      receivedMd5sig: String(md5sig),
      merchantSecret,
    });

    if (!valid) {
      return res.status(400).send("Invalid signature");
    }

    const { data: booking, error: bookingError } = await supabase
      .from("bookings")
      .select("id, status")
      .eq("reference", String(order_id))
      .maybeSingle();

    if (bookingError || !booking) {
      return res.status(404).send("Booking not found");
    }

    if (booking.status === "confirmed") {
      return res.status(200).send("OK");
    }

    const paid = String(status_code) === "2";
    const nextStatus = paid ? "confirmed" : "cancelled";

    const { error: updateError } = await supabase
      .from("bookings")
      .update({
        status: nextStatus,
        payment_reference: payment_id ? String(payment_id) : null,
        payment_message: status_message ? String(status_message) : null,
        paid_at: paid ? new Date().toISOString() : null,
      })
      .eq("id", booking.id);

    if (updateError) {
      return res.status(500).send(updateError.message);
    }

    return res.status(200).send("OK");
  } catch {
    return res.status(500).send("Server error");
  }
});

router.post("/payhere/confirm-return", async (req, res) => {
  try {
    const { reference, paymentId, message } = req.body ?? {};
    if (!reference) {
      return res.status(400).json({ error: "Missing reference" });
    }

    const { data: booking, error: bookingError } = await supabase
      .from("bookings")
      .select("id, status")
      .eq("reference", String(reference))
      .maybeSingle();

    if (bookingError || !booking) {
      return res.status(404).json({ error: "Booking not found" });
    }

    if (booking.status === "confirmed") {
      return res.json({ ok: true, alreadyConfirmed: true });
    }

    const { error: updateError } = await supabase
      .from("bookings")
      .update({
        status: "confirmed",
        payment_reference: paymentId ? String(paymentId) : null,
        payment_message: message ? String(message) : "Confirmed from return redirect (dev mode)",
        paid_at: new Date().toISOString(),
      })
      .eq("id", booking.id);

    if (updateError) {
      return res.status(500).json({ error: updateError.message });
    }

    return res.json({ ok: true, confirmed: true });
  } catch (error) {
    return res.status(500).json({ error: error instanceof Error ? error.message : "Server error" });
  }
});

router.get("/:reference/status", async (req, res) => {
  const reference = req.params.reference;
  const { data, error } = await supabase
    .from("bookings")
    .select("id, reference, status, payment_reference, payment_message, paid_at")
    .eq("reference", reference)
    .maybeSingle();

  if (error) {
    return res.status(500).json({ error: error.message });
  }
  if (!data) {
    return res.status(404).json({ error: "Booking not found" });
  }
  return res.json(data);
});

export default router;
