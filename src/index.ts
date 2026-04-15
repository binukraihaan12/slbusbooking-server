import "dotenv/config";
import cors from "cors";
import express from "express";
import manualBookingsRoutes from "./routes/manualBookings.js";
import smsRoutes from "./routes/sms.js";

const app = express();
const port = Number(process.env.PORT || 4000);
const frontendOrigin = process.env.FRONTEND_ORIGIN || "*";

app.use(
  cors({
    origin: frontendOrigin,
  }),
);
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
