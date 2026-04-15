import { Router } from "express";
import {
  getQuickSendEnv,
  quickSendCheckBalance,
  quickSendSingleSms,
  type QuickSendResponse,
} from "../lib/quicksend.js";

const router = Router();

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

function normalizePhone(to: string): string {
  // QuickSend examples use local format (07xxxxxxxx). We keep the given number,
  // only trimming whitespace to avoid accidental failures.
  return to.trim();
}

router.post("/send-single", async (req, res) => {
  try {
    const { to, msg, senderID } = (req.body ?? {}) as {
      to?: unknown;
      msg?: unknown;
      senderID?: unknown;
    };

    if (!isNonEmptyString(to) || !isNonEmptyString(msg)) {
      return res.status(400).json({ error: "Invalid payload. Required: { to: string, msg: string }" });
    }

    const env = getQuickSendEnv();
    const finalSenderId = isNonEmptyString(senderID) ? senderID.trim() : env.senderId;

    const result = await quickSendSingleSms(normalizePhone(to), msg, finalSenderId, {
      email: env.email,
      apiKey: env.apiKey,
    });

    const status = result.ok ? 200 : 502;
    return res.status(status).json(result satisfies QuickSendResponse);
  } catch (error) {
    return res.status(500).json({ error: error instanceof Error ? error.message : "Unknown error" });
  }
});

router.post("/balance", async (_req, res) => {
  try {
    const env = getQuickSendEnv();
    const result = await quickSendCheckBalance({ email: env.email, apiKey: env.apiKey });
    const status = result.ok ? 200 : 502;
    return res.status(status).json(result);
  } catch (error) {
    return res.status(500).json({ error: error instanceof Error ? error.message : "Unknown error" });
  }
});

export default router;

