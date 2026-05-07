// import "dotenv/config";
// import cors from "cors";
// import express from "express";
// import manualBookingsRoutes from "./routes/manualBookings.js";
// import smsRoutes from "./routes/sms.js";

// const app = express();
// const port = Number(process.env.PORT || 4000);
// const frontendOrigin = process.env.FRONTEND_ORIGIN || "*";

// app.use(
//   cors({
//     origin: frontendOrigin,
//   }),
// );
// app.use(express.json());
// app.use(express.urlencoded({ extended: true }));

// app.get("/health", (_req, res) => {
//   res.json({ ok: true, service: "journey-planner-server" });
// });

// app.use("/api/bookings", manualBookingsRoutes);
// app.use("/api/sms", smsRoutes);

// app.listen(port, () => {
//   console.log(`Server running at http://localhost:${port}`);
// });


import "dotenv/config";
import cors from "cors";
import express from "express";
import manualBookingsRoutes from "./routes/manualBookings.js";
import smsRoutes from "./routes/sms.js";

const app = express();
const port = Number(process.env.PORT || 4000);

const frontendOrigins = (process.env.FRONTEND_ORIGIN ||
  [
    "http://localhost:3000",
    "http://localhost:5173",
    "https://slbusbooking.lk",
    "https://www.slbusbooking.lk",
  ].join(","))
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const corsOptions: cors.CorsOptions = {
  origin: (origin, callback) => {
    // Allow non-browser requests (no Origin header)
    if (!origin) return callback(null, true);
    // Allow all if explicitly configured
    if (frontendOrigins.includes("*")) return callback(null, true);
    if (frontendOrigins.includes(origin)) return callback(null, true);
    return callback(new Error(`CORS blocked for origin: ${origin}`));
  },
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
};

app.use(
  cors(corsOptions),
);
app.options("*", cors(corsOptions));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "journey-planner-server" });
});

app.use("/api/bookings", manualBookingsRoutes);
app.use("/api/sms", smsRoutes);

app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});
