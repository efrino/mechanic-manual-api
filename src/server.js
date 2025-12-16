require("dotenv").config();
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const compression = require("compression");
const rateLimit = require("express-rate-limit");
const path = require("path");

const authRoutes = require("./routes/auth.routes");
const moduleRoutes = require("./routes/module.routes");
const mecaAidRoutes = require("./routes/mecaAid.routes");
const animationRoutes = require("./routes/animation.routes");
const errorCodeRoutes = require("./routes/errorCode.routes");
const activityRoutes = require("./routes/activity.routes");
const syncRoutes = require("./routes/sync.routes");

const errorHandler = require("./middleware/errorHandler");
const { authenticateToken } = require("./middleware/auth");

const app = express();
const PORT = process.env.PORT || 3000;

// Security Middleware
app.use(helmet());
app.use(compression());

// CORS Configuration
const corsOptions = {
  origin: process.env.CORS_ORIGINS?.split(",") || "*",
  methods: ["GET", "POST", "PUT", "DELETE", "PATCH"],
  allowedHeaders: [
    "Content-Type",
    "Authorization",
    "X-Device-ID",
    "X-App-Version",
  ],
  credentials: true,
};
app.use(cors(corsOptions));

// Rate Limiting
const limiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000,
  max: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) || 100,
  message: {
    success: false,
    message: "Too many requests, please try again later.",
  },
});
app.use("/api/", limiter);

// Body Parser
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

// Logging
if (process.env.NODE_ENV !== "production") {
  app.use(morgan("dev"));
} else {
  app.use(morgan("combined"));
}

// Static Files
app.use("/uploads", express.static(path.join(__dirname, "../uploads")));

// Health Check
app.get("/health", (req, res) => {
  res.json({ status: "OK", timestamp: new Date().toISOString() });
});

// API Routes
app.use("/api/auth", authRoutes);
app.use("/api/modules", authenticateToken, moduleRoutes);
app.use("/api/meca-aid", authenticateToken, mecaAidRoutes);
app.use("/api/animations", authenticateToken, animationRoutes);
app.use("/api/error-codes", authenticateToken, errorCodeRoutes);
app.use("/api/activities", authenticateToken, activityRoutes);
app.use("/api/sync", authenticateToken, syncRoutes);

// API Documentation
app.get("/api", (req, res) => {
  res.json({
    name: "Mechanic Manual API",
    version: "1.0.0",
    endpoints: {
      auth: "/api/auth",
      modules: "/api/modules",
      mecaAid: "/api/meca-aid",
      animations: "/api/animations",
      errorCodes: "/api/error-codes",
      activities: "/api/activities",
      sync: "/api/sync",
    },
  });
});

// 404 Handler
app.use((req, res) => {
  res.status(404).json({ success: false, message: "Endpoint not found" });
});

// Error Handler
app.use(errorHandler);

// Start Server
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📚 API Documentation: http://localhost:${PORT}/api`);
  console.log(`💊 Health Check: http://localhost:${PORT}/health`);
});

module.exports = app;
