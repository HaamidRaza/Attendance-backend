require("dotenv").config();
const express = require("express");
const cors = require("cors");
const connectDB = require("./config/db");
const routes = require("./routes");
const { errors } = require("./middleware");

async function start() {
  await connectDB();
  const app = express();

  const allowed = (process.env.CLIENT_URL || "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);

  app.use(
    cors({
      origin: (origin, cb) =>
        !origin || allowed.length === 0 || allowed.includes(origin)
          ? cb(null, true)
          : cb(new Error("CORS origin denied")),
    }),
  );

  app.use(express.json({ limit: "1mb" }));
  app.get("/api/health", (req, res) =>
    res.json({ success: true, message: "API is healthy" }),
  );
  
  app.use("/api", routes);
  app.use((req, res) =>
    res.status(404).json({ success: false, message: "Route not found" }),
  );
  
  app.use(errors);
  
  const port = process.env.PORT || 5000;
  app.listen(port, () => console.log(`API listening on ${port}`));
}
start().catch((err) => {
  console.error("Unable to start server:", err.message);
  process.exit(1);
});
