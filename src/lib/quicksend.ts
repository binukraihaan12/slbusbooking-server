type JsonRecord = Record<string, unknown>;

export type QuickSendFun =
  | "SEND_SINGLE"
  | "SEND_BULK_SAME"
  | "SEND_BULK_DIFFERENT"
  | "CHECK_BALANCE";

export interface QuickSendClientOptions {
  email: string;
  apiKey: string;
  baseUrl?: string; // default: https://quicksend.lk/Client/api.php
  timeoutMs?: number; // default: 15000
}

export interface QuickSendSendSingleRequest {
  senderID: string;
  to: string;
  msg: string;
}

export interface QuickSendBulkSameRequest {
  senderID: string;
  to: string[];
  msg: string;
  check_cost?: boolean;
}

export interface QuickSendBulkDifferentRequest {
  senderID: string;
  msg_list: Array<{ to: string; msg: string }>;
}

export interface QuickSendResponse<T = unknown> {
  ok: boolean;
  status: number;
  fun: QuickSendFun;
  data?: T;
  rawText?: string;
  error?: string;
}

function basicAuthHeader(email: string, apiKey: string): string {
  const token = Buffer.from(`${email}:${apiKey}`, "utf8").toString("base64");
  return `Basic ${token}`;
}

async function postQuickSend<T>(
  fun: QuickSendFun,
  payload: JsonRecord | unknown,
  opts: QuickSendClientOptions,
): Promise<QuickSendResponse<T>> {
  const baseUrl = opts.baseUrl ?? "https://quicksend.lk/Client/api.php";
  const timeoutMs = opts.timeoutMs ?? 15000;

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const url = `${baseUrl}?FUN=${encodeURIComponent(fun)}`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: basicAuthHeader(opts.email, opts.apiKey),
        "Content-Type": "application/json",
        Accept: "application/json, text/plain;q=0.9, */*;q=0.8",
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    const text = await res.text();
    const contentType = res.headers.get("content-type") ?? "";

    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        fun,
        rawText: text,
        error: `QuickSend HTTP ${res.status}`,
      };
    }

    if (contentType.includes("application/json")) {
      try {
        const json = JSON.parse(text) as T;
        return { ok: true, status: res.status, fun, data: json };
      } catch {
        return {
          ok: true,
          status: res.status,
          fun,
          rawText: text,
          error: "QuickSend returned invalid JSON",
        };
      }
    }

    // Some gateways return plain text even on success.
    return { ok: true, status: res.status, fun, rawText: text };
  } catch (e) {
    const msg =
      e instanceof Error
        ? e.name === "AbortError"
          ? "QuickSend request timed out"
          : e.message
        : "Unknown error";
    return { ok: false, status: 0, fun, error: msg };
  } finally {
    clearTimeout(t);
  }
}

export function getQuickSendEnv() {
  const email = process.env.QUICKSEND_EMAIL;
  const apiKey = process.env.QUICKSEND_API_KEY;
  const senderId = process.env.QUICKSEND_SENDER_ID;

  if (!email || !apiKey) {
    throw new Error("Missing QUICKSEND_EMAIL or QUICKSEND_API_KEY");
  }
  if (!senderId) {
    throw new Error("Missing QUICKSEND_SENDER_ID");
  }

  return { email, apiKey, senderId };
}

export async function quickSendSingleSms(
  to: string,
  msg: string,
  senderID: string,
  opts: QuickSendClientOptions,
) {
  const payload: QuickSendSendSingleRequest = { senderID, to, msg };
  return postQuickSend("SEND_SINGLE", payload, opts);
}

export async function quickSendBulkSame(
  to: string[],
  msg: string,
  senderID: string,
  opts: QuickSendClientOptions,
  checkCost = false,
) {
  const payload: QuickSendBulkSameRequest = { senderID, to, msg, check_cost: checkCost };
  return postQuickSend("SEND_BULK_SAME", payload, opts);
}

export async function quickSendBulkDifferent(
  msg_list: Array<{ to: string; msg: string }>,
  senderID: string,
  opts: QuickSendClientOptions,
) {
  const payload: QuickSendBulkDifferentRequest = { senderID, msg_list };
  return postQuickSend("SEND_BULK_DIFFERENT", payload, opts);
}

export async function quickSendCheckBalance(opts: QuickSendClientOptions) {
  return postQuickSend("CHECK_BALANCE", {}, opts);
}

