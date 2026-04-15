export interface InitiatePaymentRequest {
  userId: string;
  scheduleId: string;
  serviceDate: string;
  seats: Array<{ label: string; price: number }>;
  currency?: "LKR";
  customer: {
    firstName: string;
    lastName: string;
    email: string;
    phone: string;
    address?: string;
    city?: string;
  };
  route: {
    from: string;
    to: string;
  };
}

/** Manual bank transfer hold — user id comes from Authorization JWT only. */
export interface ManualHoldRequest {
  scheduleId: string;
  serviceDate: string;
  seats: Array<{ label: string; price: number }>;
}

export interface ManualBankDetails {
  bankName: string;
  accountName: string;
  accountNumber: string;
  branch: string;
  instructions?: string;
}

export interface PayHereCheckoutPayload {
  sandbox: boolean;
  merchant_id: string;
  return_url: string;
  cancel_url: string;
  notify_url: string;
  order_id: string;
  items: string;
  currency: "LKR";
  amount: string;
  first_name: string;
  last_name: string;
  email: string;
  phone: string;
  address: string;
  city: string;
  country: "Sri Lanka";
  hash: string;
}
